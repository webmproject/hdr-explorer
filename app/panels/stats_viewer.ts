/**
 * Copyright 2026 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {Point2} from '../color_helpers/agtm';
import {rec2020Luma} from '../color_helpers/color_functions';
import {ComputedStats, getPercentile} from '../image_stats';
import {Base2dGraphRenderer} from './base_renderer';

type StatsMode = 'cdf' | 'histogram' | 'percentile';

export class StatsViewer extends Base2dGraphRenderer {
  statsTextContainer: HTMLElement;
  stats: ComputedStats | null = null;
  statsMode: StatsMode = 'cdf';
  logNits = false;
  logPercent = false;
  private readonly selectedPixelInfoContainer: HTMLElement;
  private selectedPixelCoords: Point2 | null = null;
  private selectedPixelRgbNits: [number, number, number] | null = null;

  constructor(
    canvas: HTMLCanvasElement,
    statsTextContainer: HTMLElement,
    selectedPixelInfoContainer: HTMLElement,
    statsModes: HTMLElement,
    logNitsEl: HTMLInputElement,
    logPercentEl: HTMLInputElement,
  ) {
    super(canvas);
    this.statsTextContainer = statsTextContainer;
    this.selectedPixelInfoContainer = selectedPixelInfoContainer;

    statsModes.querySelectorAll('input[name="stats_mode"]').forEach((e) => {
      e.addEventListener('change', (e) => {
        this.statsMode = (e.target as HTMLInputElement).value as StatsMode;
        this.draw();
      });
    });

    logNitsEl.addEventListener('change', () => {
      this.logNits = logNitsEl.checked;
      this.draw();
    });

    logPercentEl.addEventListener('change', () => {
      this.logPercent = logPercentEl.checked;
      this.draw();
    });
  }

  override getVersion(): string {
    // Version doesn't matter since this is not a tone mapper.
    return 'v0.0.0';
  }

  setStats(stats: ComputedStats | null) {
    this.stats = stats;
  }

  setSelectedPixel(
    coords: Point2 | null,
    rgbNits: [number, number, number] | null,
  ) {
    this.selectedPixelCoords = coords;
    this.selectedPixelRgbNits = rgbNits;
    this.draw();
  }

  render() {
    this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.drawGrid();
    this.drawGraph();
    this.drawStatsLines();
    this.drawSelectedPixelInfo();
    this.statsText();
  }

  private isLogX(): boolean {
    return (
      this.logNits &&
      (this.statsMode === 'cdf' || this.statsMode === 'histogram')
    );
  }

  private isLogY(): boolean {
    return this.logNits && this.statsMode === 'percentile';
  }

  private isLogPercentX(): boolean {
    return this.logPercent && this.statsMode === 'percentile';
  }

  private isLogPercentY(): boolean {
    return (
      this.logPercent &&
      (this.statsMode === 'cdf' || this.statsMode === 'histogram')
    );
  }

  private xToView(value: number): number {
    const p0 = this.graphBottomLeft;
    const pMax = this.graphTopRight;
    const graphWidth = pMax.x - p0.x;
    if (this.statsMode === 'percentile') {
      // X axis is percentile 0-1, not nits.
      if (this.isLogPercentX()) {
        const epsilon = 0.001; // 0.1%
        const logMin = Math.log(epsilon);
        const logMax = Math.log(1); // 0
        const logValue = Math.log(value * (1 - epsilon) + epsilon);
        const normalized = (logValue - logMin) / (logMax - logMin);
        return p0.x + normalized * graphWidth;
      }
      return p0.x + value * graphWidth;
    }

    if (this.isLogX()) {
      const maxX = this.maxXValue();
      if (maxX <= 0) return p0.x;
      const logMax = Math.log1p(maxX);
      if (logMax === 0) return p0.x;
      const logValue = Math.log1p(value);
      const normalized = logValue / logMax;
      return p0.x + normalized * graphWidth;
    } else {
      return p0.x + value * this.scaleX();
    }
  }

  private yToView(value: number): number {
    const p0 = this.graphBottomLeft;
    const pMax = this.graphTopRight;
    const graphHeight = pMax.y - p0.y; // This is negative
    let normalized: number;

    if (this.statsMode === 'cdf') {
      // value is 0-1
      normalized = value;
      if (this.isLogPercentY()) {
        const epsilon = 0.001; // 0.1%
        const logMin = Math.log(epsilon);
        const logMax = Math.log(1); // 0
        const logValue = Math.log(value * (1 - epsilon) + epsilon);
        normalized = (logValue - logMin) / (logMax - logMin);
      }
    } else if (this.statsMode === 'histogram') {
      if (!this.stats || this.stats.bins.length === 0) return p0.y;
      const maxDensity = this.stats.bins[0].maxDensity;
      if (maxDensity <= 0) return p0.y;
      normalized = value / maxDensity;
      if (this.isLogPercentY()) {
        const epsilon = 0.001; // 0.1%
        const logMin = Math.log(epsilon);
        const logMax = Math.log(1); // 0
        const logValue = Math.log(normalized * (1 - epsilon) + epsilon);
        normalized = (logValue - logMin) / (logMax - logMin);
      }
    } else {
      // percentile
      const maxX = this.maxXValue();
      if (maxX <= 0) return p0.y;
      if (this.isLogY()) {
        const logValue = Math.log1p(value);
        const logMax = Math.log1p(maxX);
        if (logMax === 0) return p0.y;
        normalized = logValue / logMax;
      } else {
        normalized = value / maxX;
      }
    }
    return p0.y + normalized * graphHeight;
  }

  maxXValue() {
    if (this.stats == null) {
      return 0;
    }
    return this.stats.bins[this.stats.bins.length - 1].binMax;
  }

  scaleX() {
    return (this.graphTopRight.x - this.graphBottomLeft.x) / this.maxXValue();
  }

  drawGrid() {
    this.context.save();
    const p0 = this.graphBottomLeft;
    const pMax = this.graphTopRight;
    this.context.font = '20px monospace';

    this.context.lineWidth = 4;
    this.context.strokeStyle = 'black';
    this.context.beginPath();
    this.context.moveTo(p0.x, p0.y + 20);
    this.context.lineTo(p0.x, pMax.y);
    this.context.moveTo(p0.x - 20, p0.y);
    this.context.lineTo(pMax.x, p0.y);
    this.context.stroke();

    // Style for inner grid lines.
    this.context.strokeStyle = '#0003';
    this.context.lineWidth = 1;
    this.context.fillStyle = 'black';

    if (this.statsMode === 'percentile') {
      const xMaxValue = this.maxXValue();
      if (this.isLogY()) {
        for (let p = 0; p < 5; ++p) {
          for (const m of [1, 2, 5]) {
            const value = m * 10 ** p;
            if (value > xMaxValue) break;
            if (value < 0.1) continue;
            const y = this.yToView(value);
            this.context.beginPath();
            this.context.moveTo(p0.x, y);
            this.context.lineTo(pMax.x, y);
            this.context.stroke();
            this.context.fillText(
              value < 1 ? value.toFixed(1) : value.toFixed(0),
              p0.x - 60,
              y + 5,
            );
          }
        }
      } else {
        let interval = 250;
        if (xMaxValue < interval) {
          interval /= 10;
        }
        if (xMaxValue / interval > 10) {
          interval *= 2;
        }
        for (let i = 0; i <= xMaxValue; i += interval) {
          const y = this.yToView(i);
          this.context.beginPath();
          this.context.moveTo(p0.x, y);
          this.context.lineTo(pMax.x, y);
          this.context.stroke();
          this.context.fillStyle = 'black';
          this.context.fillText(i.toFixed(0), p0.x - 60, y + 5);
        }
      }

      if (this.isLogPercentX()) {
        for (let p = -3; p <= 0; ++p) {
          for (const m of [1, 2, 5]) {
            const value = m * 10 ** p;
            if (value > 1) break;
            const x = this.xToView(value);
            this.context.beginPath();
            this.context.moveTo(x, p0.y);
            this.context.lineTo(x, pMax.y);
            this.context.stroke();
            this.context.fillStyle = 'black';
            this.context.textAlign = 'center';
            const percent = value * 100;
            const label = percent < 1 ? percent.toFixed(1) : percent.toFixed(0);
            this.context.fillText(label + '%', x, p0.y + 20);
            if (this.stats && this.stats.bins.length > 0) {
              const lumaValue = getPercentile(value, this.stats.bins, 3);
              this.context.fillText(`(${lumaValue.toFixed(0)})`, x, p0.y + 40);
            }
          }
        }
      } else {
        for (let i = 0; i <= 10; ++i) {
          const x = this.xToView(i / 10);
          this.context.beginPath();
          this.context.moveTo(x, p0.y);
          this.context.lineTo(x, pMax.y);
          this.context.stroke();
          this.context.fillStyle = 'black';
          this.context.textAlign = 'center';
          const percentile = i / 10;
          this.context.fillText(
            ((i * 100) / 10).toFixed(0) + '%',
            x,
            p0.y + 20,
          );
          if (this.stats && this.stats.bins.length > 0) {
            const value = getPercentile(percentile, this.stats.bins, 3);
            this.context.fillText(`(${value.toFixed(0)})`, x, p0.y + 40);
          }
        }
      }
      // Y-axis label
      this.context.save();
      this.context.translate(p0.x - 10, p0.y - (p0.y - pMax.y) / 2);
      this.context.rotate(-Math.PI / 2);
      this.context.textAlign = 'center';
      this.context.fillText('nits', 0, 0);
      this.context.restore();

      this.context.fillText(
        'percentile (and corresponding luma value in nits)',
        p0.x + (pMax.x - p0.x) / 2,
        p0.y + 65,
      );
      this.context.textAlign = 'start';
    } else {
      if (this.statsMode === 'histogram') {
        if (!this.stats || this.stats.bins.length === 0) {
          return;
        }
        const maxDensity = this.stats.bins[0].maxDensity;

        if (this.isLogPercentY()) {
          for (let p = -3; p <= 0; ++p) {
            for (const m of [1, 2, 5]) {
              const normalizedValue = m * 10 ** p;
              if (normalizedValue > 1) break;
              const densityValue = normalizedValue * maxDensity;
              const y = this.yToView(densityValue);
              this.context.beginPath();
              this.context.moveTo(p0.x, y);
              this.context.lineTo(pMax.x, y);
              this.context.stroke();
              this.context.fillStyle = 'black';
              this.context.fillText(
                (densityValue * 100).toPrecision(2) + '%',
                p0.x - 80,
                y + 5,
              );
            }
          }
        } else {
          for (let i = 0; i <= 10; ++i) {
            const y = this.yToView((i / 10) * maxDensity);
            const densityValue = (i / 10) * maxDensity;
            this.context.beginPath();
            this.context.moveTo(p0.x, y);
            this.context.lineTo(pMax.x, y);
            this.context.stroke();
            this.context.fillStyle = 'black';
            this.context.fillText(
              (densityValue * 100).toPrecision(2) + '%',
              p0.x - 80,
              y + 5,
            );
          }
        }
        // Y-axis label
        this.context.save();
        this.context.translate(p0.x - 10, p0.y - (p0.y - pMax.y) / 2);
        this.context.rotate(-Math.PI / 2);
        this.context.textAlign = 'center';
        this.context.fillText('density', 0, 0);
        this.context.restore();
      } else {
        // cdf
        if (this.isLogPercentY()) {
          for (let p = -3; p <= 0; ++p) {
            for (const m of [1, 2, 5]) {
              const value = m * 10 ** p;
              if (value > 1) break;
              const y = this.yToView(value);
              this.context.beginPath();
              this.context.moveTo(p0.x, y);
              this.context.lineTo(pMax.x, y);
              this.context.stroke();
              this.context.fillStyle = 'black';
              const percent = value * 100;
              const label =
                percent < 1 ? percent.toFixed(1) : percent.toFixed(0);
              this.context.fillText(label + '%', p0.x - 60, y + 5);
              if (this.stats && this.stats.bins.length > 0) {
                const lumaValue = getPercentile(value, this.stats.bins, 3);
                this.context.fillText(
                  `(${lumaValue.toFixed(0)})`,
                  p0.x - 60,
                  y + 25,
                );
              }
            }
          }
        } else {
          for (let i = 0; i <= 10; ++i) {
            const y = this.yToView(i / 10);
            this.context.beginPath();
            this.context.moveTo(p0.x, y);
            this.context.lineTo(pMax.x, y);
            this.context.stroke();
            this.context.fillStyle = 'black';
            this.context.fillText(
              ((i * 100) / 10).toFixed(0) + '%',
              p0.x - 60,
              y + 5,
            );
            if (this.stats && this.stats.bins.length > 0) {
              const percentile = i / 10;
              const value = getPercentile(percentile, this.stats.bins, 3);
              this.context.fillText(`(${value.toFixed(0)})`, p0.x - 60, y + 25);
            }
          }
        }
      }
      const xMaxValue = this.maxXValue();
      if (this.isLogX()) {
        for (let p = 0; p < 5; ++p) {
          for (const m of [1, 2, 5]) {
            const value = m * 10 ** p;
            if (value > xMaxValue) break;
            if (value < 0.1) continue;
            const x = this.xToView(value);
            if (x > pMax.x) continue;
            this.context.lineWidth = value === 1 ? 2 : 1;
            this.context.beginPath();
            this.context.moveTo(x, p0.y);
            this.context.lineTo(x, pMax.y);
            this.context.stroke();
            this.context.fillStyle = 'black';
            this.context.textAlign = 'center';
            this.context.fillText(
              value < 1 ? value.toFixed(1) : value.toFixed(0),
              x,
              p0.y + 20,
            );
          }
        }
      } else {
        let interval = 250;
        if (xMaxValue < interval) {
          interval /= 10;
        }
        if (xMaxValue / interval > 10) {
          interval *= 2;
        }
        for (let i = 0; i <= xMaxValue; i += interval) {
          const x = this.xToView(i);
          if (x > pMax.x) continue;
          this.context.lineWidth = i === 1 ? 2 : 1;
          this.context.beginPath();
          this.context.moveTo(x, p0.y);
          this.context.lineTo(x, pMax.y);
          this.context.stroke();
          this.context.fillStyle = 'black';
          this.context.textAlign = 'center';

          const xOffset = i === 0 ? 10 : 0;
          this.context.fillText(i.toFixed(0), x + xOffset, p0.y + 20);
        }
      }
      // Label for the max X value.
      this.context.textAlign = 'left';
      this.context.fillText(xMaxValue.toFixed(0), pMax.x, p0.y + 20);

      this.context.fillText('nits', p0.x + (pMax.x - p0.x) / 2, p0.y + 45);
      this.context.textAlign = 'start';
    }

    this.context.restore();
    this.context.setLineDash([]);
  }

  private setChannelStyle(c: number) {
    this.context.setLineDash([]);
    if (c === 0) {
      this.context.strokeStyle = '#FF202020';
      this.context.fillStyle = '#FF202020';
    } else if (c === 1) {
      this.context.strokeStyle = '#20FF2020';
      this.context.fillStyle = '#20FF2020';
    } else if (c === 2) {
      this.context.strokeStyle = '#2020FF20';
      this.context.fillStyle = '#2020FF20';
    } else if (c === 3) {
      // Luma
      this.context.strokeStyle = '#202020FF';
      this.context.fillStyle = '#00000000';
      this.context.setLineDash([10, 1]);
    }
  }

  drawGraph() {
    if (this.stats == null) {
      return;
    }
    this.context.save();
    this.context.globalCompositeOperation = 'lighter';

    if (this.statsMode === 'percentile') {
      const bins = this.stats.percentileBins;
      for (let c = 0; c < 4; ++c) {
        this.setChannelStyle(c);
        this.context.beginPath();
        this.context.lineWidth = 2;
        this.context.moveTo(this.xToView(0), this.yToView(0));
        for (let b = 0; b < bins.length; ++b) {
          const y0 = this.yToView(bins[b].valueMin[c]);
          const y1 = this.yToView(bins[b].valueMax[c]);
          const x0 = this.xToView(bins[b].cdfMin);
          const x1 = this.xToView(bins[b].cdfMax);
          this.context.lineTo(x0, y0);
          this.context.lineTo(x1, y1);
        }
        if (bins.length > 0) {
          this.context.lineTo(
            this.xToView(bins[bins.length - 1].cdfMax),
            this.graphBottomLeft.y,
          );
        }
        this.context.lineTo(this.xToView(0), this.graphBottomLeft.y);
        this.context.closePath();
        this.context.fill();
        this.context.stroke();
      }
    } else {
      const bins = this.stats.bins;
      if (this.statsMode === 'histogram') {
        // First, do all the fills with 'lighter' compositing.
        for (let c = 0; c < 4; ++c) {
          this.setChannelStyle(c);
          for (let b = 0; b < bins.length; ++b) {
            const y = this.yToView(bins[b].density[c]);
            const x0 = this.xToView(bins[b].binMin);
            const x1 = this.xToView(bins[b].binMax);
            this.context.fillRect(x0, y, x1 - x0, this.graphBottomLeft.y - y);
          }
        }
        // Then, do all the strokes with 'source-over' to avoid bright
        // artifacts on overlapping lines.
        this.context.save();
        this.context.globalCompositeOperation = 'source-over';
        this.context.lineWidth = 1;
        for (let c = 0; c < 4; ++c) {
          this.setChannelStyle(c);
          for (let b = 0; b < bins.length; ++b) {
            const y = this.yToView(bins[b].density[c]);
            const x0 = this.xToView(bins[b].binMin);
            const x1 = this.xToView(bins[b].binMax);
            this.context.strokeRect(x0, y, x1 - x0, this.graphBottomLeft.y - y);
          }
        }
        this.context.restore();
      } else {
        for (let c = 0; c < 4; ++c) {
          this.setChannelStyle(c);
          this.context.beginPath();
          this.context.lineWidth = 2;
          this.context.moveTo(this.xToView(0), this.yToView(0));
          for (let b = 0; b < bins.length; ++b) {
            const y0 = this.yToView(bins[b].cdfMin[c]);
            const y1 = this.yToView(bins[b].cdfMax[c]);
            const x0 = this.xToView(bins[b].binMin);
            const x1 = this.xToView(bins[b].binMax);
            this.context.lineTo(x0, y0);
            this.context.lineTo(x1, y1);
            if (b === bins.length - 1) {
              this.context.lineTo(x1, this.graphBottomLeft.y);
            }
          }
          this.context.lineTo(this.graphBottomLeft.x, this.graphBottomLeft.y);
          this.context.closePath();
          this.context.fill();
          this.context.stroke();
        }
      }
    }
    this.context.globalCompositeOperation = 'source-over';
    this.context.restore();
  }

  private drawLine(
    value: number,
    color: string,
    label: string,
    textOffset = 0,
    dash: number[] = [],
  ) {
    const p0 = this.graphBottomLeft;
    const pMax = this.graphTopRight;
    const text = `${label}: ${Math.round(value)}`;
    this.context.setLineDash(dash);
    this.context.strokeStyle = color;
    this.context.lineWidth = 2;
    this.context.beginPath();

    let textTranslateX: number;
    let textTranslateY: number;
    let textX: number;
    let textY: number;

    if (this.statsMode === 'percentile') {
      const y = this.yToView(value);
      if (y > p0.y || y < pMax.y) return;
      this.context.moveTo(p0.x, y);
      this.context.lineTo(pMax.x, y);
      textTranslateX = p0.x;
      textTranslateY = y;
      textX = textOffset * 5;
      textY = -5;
    } else {
      const x = this.xToView(value);
      if (x > pMax.x || x < p0.x) return;
      this.context.moveTo(x, p0.y);
      this.context.lineTo(x, pMax.y);
      textTranslateX = x;
      textTranslateY = pMax.y;
      textX = -50;
      textY = 10 + textOffset;
    }

    this.context.stroke();
    this.context.setLineDash([]);

    this.context.fillStyle = 'white';
    this.context.font = 'bold 16px monospace';
    this.context.save();
    this.context.translate(textTranslateX, textTranslateY);
    this.context.strokeStyle = color;
    this.context.lineWidth = 4;
    this.context.lineJoin = 'bevel';
    this.context.strokeText(text, textX, textY);
    this.context.fillText(text, textX, textY);
    this.context.restore();
  }

  drawStatsLines() {
    if (this.stats == null) {
      return;
    }
    this.context.save();

    const s = this.stats;

    // Max values (solid lines)
    let offset = 0;
    this.drawLine(s.maxPerChannel[0], 'red', 'MaxR', (offset += 20));
    this.drawLine(s.maxPerChannel[1], 'green', 'MaxG', (offset += 20));
    this.drawLine(s.maxPerChannel[2], 'blue', 'MaxB', (offset += 20));
    this.drawLine(s.maxMaxRgb, 'grey', 'MaxMaxRGB', (offset += 20));
    this.drawLine(s.maxPerChannel[3], 'grey', 'MaxLuma', (offset += 20));
    this.drawLine(s.minMaxRgb, 'darkgrey', 'MinMaxRGB', (offset += 20));

    // Avg values (dashed lines)
    offset = 0;
    const dash = [5, 5];
    this.drawLine(s.avgPerChannel[0], 'red', 'AvgR', (offset += 20), dash);
    this.drawLine(s.avgPerChannel[1], 'green', 'AvgG', (offset += 20), dash);
    this.drawLine(s.avgPerChannel[2], 'blue', 'AvgB', (offset += 20), dash);
    this.drawLine(s.avgMaxRgb, 'grey', 'AvgMaxRGB', (offset += 20), dash);
    this.drawLine(s.avgPerChannel[3], 'grey', 'AvgLuma', (offset += 20), dash);

    this.context.restore();
  }

  drawSelectedPixelInfo() {
    if (this.selectedPixelRgbNits && this.selectedPixelCoords) {
      const [r, g, b] = this.selectedPixelRgbNits;
      const luma = rec2020Luma(this.selectedPixelRgbNits);
      const coords = this.selectedPixelCoords;
      this.selectedPixelInfoContainer.textContent = `Selected pixel at (${
        coords.x
      }, ${coords.y}): R=${r.toFixed(2)}, G=${g.toFixed(2)}, B=${b.toFixed(
        2,
      )}, Luma=${luma.toFixed(2)} nits`;

      this.context.save();
      const dash = [2, 2];
      let offset = 140;
      this.drawLine(r, 'red', 'R', (offset += 20), dash);
      this.drawLine(g, 'green', 'G', (offset += 20), dash);
      this.drawLine(b, 'blue', 'B', (offset += 20), dash);
      this.drawLine(luma, 'grey', 'Luma', (offset += 20), dash);
      this.context.restore();
    } else {
      this.selectedPixelInfoContainer.textContent =
        'Click on a rendered image to select a pixel and see its value.';
    }
  }

  statsText() {
    this.statsTextContainer.textContent = '';
    if (this.stats == null) {
      return;
    }
    this.statsTextContainer.textContent = `MaxR: ${this.stats.maxPerChannel[0].toFixed(2)} MaxG: ${this.stats.maxPerChannel[1].toFixed(2)} MaxB: ${this.stats.maxPerChannel[2].toFixed(2)} MaxLuma: ${this.stats.maxPerChannel[3].toFixed(2)}\n`;
    this.statsTextContainer.textContent += `AvgR: ${this.stats.avgPerChannel[0].toFixed(2)} AvgG: ${this.stats.avgPerChannel[1].toFixed(2)} AvgB: ${this.stats.avgPerChannel[2].toFixed(2)} AvgLuma: ${this.stats.avgPerChannel[3].toFixed(2)}\n`;
    this.statsTextContainer.textContent += `MaxMaxRgb: ${this.stats.maxMaxRgb.toFixed(2)} MinMaxRgb: ${this.stats.minMaxRgb.toFixed(2)} AvgMaxRgb: ${this.stats.avgMaxRgb.toFixed(2)}\n`;
    this.statsTextContainer.textContent += '\n';

    const percentiles = [1, 5, 10, 25, 50, 75, 90, 95, 99, 99.5, 100];
    for (const percentile of percentiles) {
      const value = getPercentile(percentile / 100, this.stats.bins, 3);
      this.statsTextContainer.textContent += `${percentile}%: ${value.toFixed(2)} nits\n`;
    }
    // Print th histogram bins:
    this.statsTextContainer.textContent += '\nLuma Histogram:\n';
    for (const bin of this.stats.bins) {
      this.statsTextContainer.textContent += `[${Math.round(bin.binMin)}, ${Math.round(bin.binMax)}] `;
      const c = 3; // luma channel
      this.statsTextContainer.textContent += `${(bin.freq[c] * 100).toFixed(2)}% ${bin.count[c]} `;
      if (this.selectedPixelRgbNits) {
        const luma = rec2020Luma(this.selectedPixelRgbNits);
        if (bin.binMin <= luma && luma <= bin.binMax) {
          this.statsTextContainer.textContent += '<== selected pixel';
        }
      }
      this.statsTextContainer.textContent += '\n';
    }
  }
}
