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

import {AgtmMetadata, Altr, Point2} from '../color_helpers/agtm';
import {
  agtmAdapt,
  getComponentMixValue,
  getGainApplicationPrimaries,
} from '../color_helpers/agtm_adapt';
import {
  getPrimariesName,
  primariesConvert,
} from '../color_helpers/color_functions';
import {
  logGainToLinear,
  logGainToLinearGrad,
} from '../color_helpers/gain_curve';
import {
  Mat2,
  clamp,
  exp2,
  mat2Mm,
  mat2Mvm,
  newtonSolve,
  vec2Add,
  vec2Dist,
  vec2Sub,
} from '../color_helpers/math_helpers';
import {PiecewiseCubic} from '../color_helpers/piecewise_cubic';
import {CdfBin, getPercentile} from '../image_stats';
import {Base2dGraphRenderer} from './base_renderer';

const kPointSelectMaxDist = 12 * 12;

export class CurveEditor extends Base2dGraphRenderer {
  curve: PiecewiseCubic | null = null;
  modelChangedCallback: (metadata: AgtmMetadata) => void;
  gainCurveMixHistogram: CdfBin[] | null = null;
  metadata: AgtmMetadata | null = null;
  altrIndex = 0;
  viewScale: Point2;
  private readonly graphMaxXValue = 16;
  private readonly graphMaxYValue = 16;
  private readonly defaultViewScale: Point2;
  private dragIndex: number | null = null;
  private showGainCurve = false;
  private showControlPoints = true;
  private selectedPixelRgbNits: [number, number, number] | null = null;
  private readonly pixelInfoEl: HTMLElement;

  constructor(canvas: HTMLCanvasElement, pixelInfoEl: HTMLElement) {
    super(canvas);
    this.pixelInfoEl = pixelInfoEl;
    this.canvas.style.touchAction = 'none';
    this.canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
    });

    this.modelChangedCallback = (param) => {};

    this.defaultViewScale = {
      x:
        (this.defaultGraphTopRight.x - this.defaultGraphBottomLeft.x) /
        this.graphMaxXValue,
      y:
        (this.defaultGraphTopRight.y - this.defaultGraphBottomLeft.y) /
        this.graphMaxYValue,
    };

    this.graphBottomLeft = {...this.defaultGraphBottomLeft};
    this.viewScale = {...this.defaultViewScale};
  }

  override getVersion(): string {
    // Version doesn't matter since this is not a tone mapper.
    return 'v0.0.0';
  }

  private getGridLines(
    viewScale: number,
    viewOffset: number,
    viewDimension: number,
  ): number[] {
    const modelMin = (0 - viewOffset) / viewScale;
    const modelMax = (viewDimension - viewOffset) / viewScale;

    const minVisible = Math.min(modelMin, modelMax);
    const maxVisible = Math.max(modelMin, modelMax);

    if (maxVisible - minVisible <= 0) {
      return [];
    }

    const minSpacingPixels = 50;
    const modelMinSpacing = minSpacingPixels / Math.abs(viewScale);

    const power = Math.pow(10, Math.floor(Math.log10(modelMinSpacing)));
    let step: number;
    if (power >= modelMinSpacing) {
      step = power;
    } else if (power * 2 >= modelMinSpacing) {
      step = power * 2;
    } else if (power * 5 >= modelMinSpacing) {
      step = power * 5;
    } else {
      step = power * 10;
    }

    const start = Math.floor(minVisible / step) * step;
    const end = Math.ceil(maxVisible / step) * step;

    const lines = [];
    for (let i = start; i <= end; i += step) {
      lines.push(parseFloat(i.toPrecision(15)));
    }
    return lines;
  }

  setSelectedPixel(rgbNits: [number, number, number] | null) {
    this.selectedPixelRgbNits = rgbNits;
    this.draw();
  }

  private getPixelInfoString(): string {
    const metadata = this.metadata;
    if (!this.selectedPixelRgbNits || !metadata) {
      return '';
    }
    const rgbNits = this.selectedPixelRgbNits;
    const sdrRelative = rgbNits.map((c) => c / metadata.hdr_reference_white);
    const rgbGainSpace = primariesConvert(
      sdrRelative,
      this.contentPrimaries,
      getGainApplicationPrimaries(metadata),
    );

    const mixValues = getComponentMixValue(
      sdrRelative,
      this.contentPrimaries,
      metadata,
      metadata.altr[this.altrIndex], // Assume they're all identical anyway.
    );

    const adaptation = agtmAdapt(metadata, this.headroomLog2);
    const curveI = new PiecewiseCubic(adaptation.altrI.curve);
    const curveJ = new PiecewiseCubic(adaptation.altrJ.curve);
    const logGainsI = mixValues.map((mix) => curveI.evaluate(mix).y);
    const logGainsJ = mixValues.map((mix) => curveJ.evaluate(mix).y);
    const logGains = logGainsI.map(
      (gI, i) => adaptation.weightI * gI + adaptation.weightJ * logGainsJ[i],
    );
    const gainMultipliers = logGains.map((lg) => exp2(lg));

    const tonemappedRgbGainSpace = rgbGainSpace.map(
      (c, i) => c * gainMultipliers[i],
    );
    const tonemappedRgbContentSpace = primariesConvert(
      tonemappedRgbGainSpace,
      getGainApplicationPrimaries(metadata),
      this.contentPrimaries,
    );
    const tonemappedRgbContentSpaceNits = tonemappedRgbContentSpace.map(
      (c) => c * metadata.hdr_reference_white,
    );

    const fmt = (x: number) => x.toFixed(2);
    const fmt3 = (x: number[]) => `[${x.map(fmt).join(', ')}]`;

    const contentPrimariesStr = getPrimariesName(this.contentPrimaries);
    const gainPrimariesStr = getPrimariesName(
      getGainApplicationPrimaries(metadata),
    );

    return (
      `Pixel values in nits (${contentPrimariesStr}): ${fmt3(rgbNits)}\n` +
      `Normalized values (${contentPrimariesStr}): ${fmt3(sdrRelative)}\n` +
      `Gain space values (${gainPrimariesStr}): ${fmt3(rgbGainSpace)}\n` +
      `Mix values: ${fmt3(mixValues)}\n` +
      `Gain multipliers: ${fmt3(gainMultipliers)}\n` +
      `Tone mapped values (${gainPrimariesStr}): ${fmt3(tonemappedRgbGainSpace)}\n` +
      `Tone mapped values (${contentPrimariesStr}): ${fmt3(tonemappedRgbContentSpace)}\n` +
      `Tone mapped values in nits (${contentPrimariesStr}): ${fmt3(tonemappedRgbContentSpaceNits)}`
    );
  }

  setMetadata(metadata: AgtmMetadata) {
    this.metadata = structuredClone(metadata);
    this.altrIndex = Math.min(this.altrIndex, this.metadata.altr.length - 1);
    const points =
      this.altrIndex >= 0
        ? metadata.altr[this.altrIndex].curve
        : [{x: 0, y: 0}];
    this.curve = new PiecewiseCubic(points);
  }

  setAltrIndex(index: number) {
    this.altrIndex = index;
  }

  setShowGainCurve(show: boolean) {
    this.showGainCurve = show;
  }

  setShowControlPoints(show: boolean) {
    this.showControlPoints = show;
  }

  //////////////////////////////////////////////////////////////////////////////
  // Conversion from the model (gain this.curve) to the view (tone map this.curve).
  linearToViewGrad() {
    return {
      xx: this.viewScale.x,
      xy: 0,
      yx: 0,
      yy: this.viewScale.y,
    };
  }
  linearToView(p: Point2): Point2 {
    const viewX = this.graphBottomLeft.x + this.viewScale.x * p.x;
    const viewY = this.graphBottomLeft.y + this.viewScale.y * p.y;
    if (p.m !== undefined) {
      const dXY = mat2Mvm(this.linearToViewGrad(), {x: 1, y: p.m});
      return {x: viewX, y: viewY, m: dXY.y / dXY.x};
    }
    return {x: viewX, y: viewY};
  }

  modelToViewGrad(p: Point2): Mat2 {
    if (this.showGainCurve) {
      return this.linearToViewGrad();
    }
    return mat2Mm(this.linearToViewGrad(), logGainToLinearGrad(p));
  }

  modelToView(p: Point2, clampVal?: number): Point2 {
    if (this.showGainCurve) {
      return this.linearToView(p);
    }
    return this.linearToView(logGainToLinear(p, clampVal));
  }

  viewToModel(x: number, y?: number, m?: number, pModelGuess?: Point2): Point2 {
    if (this.showGainCurve) {
      const modelX = (x - this.graphBottomLeft.x) / this.viewScale.x;
      const modelY =
        y !== undefined ? (y - this.graphBottomLeft.y) / this.viewScale.y : 0;
      const modelM =
        m === undefined ? undefined : (m * this.viewScale.x) / this.viewScale.y;
      return {x: modelX, y: modelY, m: modelM};
    }
    // The x coordinate may be computed analytically.
    let pModel: Point2 = {
      x: (x - this.graphBottomLeft.x) / this.viewScale.x,
      y: 0,
    };

    // Use Newton iteration to solve for the Y coordinate.
    if (y !== undefined) {
      pModel.y = pModelGuess ? pModelGuess.y : 0;
      pModel = newtonSolve(
        (x) => this.modelToView(x),
        (x) => this.modelToViewGrad(x),
        {x, y, m},
        pModel,
      );
    }

    return pModel;
  }

  //////////////////////////////////////////////////////////////////////////////
  // Drawing functions.
  drawGrid() {
    this.context.save();

    const graphAreaTopY = 40;
    const graphAreaBottomY = this.canvas.height - 100;
    const graphAreaLeftX = this.defaultGraphBottomLeft.x;
    const graphAreaRightX = this.canvas.width - 100;
    const p0 = this.linearToView({x: 0, y: 0});

    // Axis titles
    this.context.fillStyle = 'black';
    this.context.font = '20px sans-serif';
    this.context.textAlign = 'center';
    this.context.fillText(
      'Input (SDR-relative)',
      graphAreaLeftX + (graphAreaRightX - graphAreaLeftX) / 2,
      this.canvas.height - 40,
    );

    this.context.save();
    this.context.translate(
      30,
      graphAreaTopY + (graphAreaBottomY - graphAreaTopY) / 2,
    );
    this.context.rotate(-Math.PI / 2);
    this.context.textAlign = 'center';
    this.context.fillText(
      this.showGainCurve ? 'log2(Gain)' : 'Output (SDR-relative)',
      0,
      0,
    );
    this.context.restore();

    this.context.save(); // for clipping
    this.context.beginPath();
    this.context.rect(
      graphAreaLeftX,
      graphAreaTopY,
      graphAreaRightX - graphAreaLeftX,
      graphAreaBottomY - graphAreaTopY,
    );
    this.context.clip();

    // Draw dark axes.
    {
      this.context.lineWidth = 4;
      this.context.strokeStyle = 'black';
      this.context.beginPath();
      // The Y axis is now a permanent fixture on the left. The line for x=0 is
      // drawn as a grid line.
      this.context.moveTo(graphAreaLeftX, graphAreaBottomY);
      this.context.lineTo(graphAreaLeftX, graphAreaTopY);
      this.context.moveTo(graphAreaLeftX, p0.y);
      this.context.lineTo(graphAreaRightX, p0.y);
      this.context.stroke();
    }

    // X-axis grid
    const xLines = this.getGridLines(
      this.viewScale.x,
      this.graphBottomLeft.x,
      this.canvas.width,
    );
    for (const i of xLines) {
      if (i < 0) continue;
      const pi = this.linearToView({x: i, y: 0});
      this.context.strokeStyle = '#0008';
      this.context.lineWidth =
        Math.abs(i) < 1e-9 || Math.abs(i - 1) < 1e-9 ? 2 : 1;
      this.context.beginPath();
      this.context.moveTo(pi.x, graphAreaBottomY);
      this.context.lineTo(pi.x, graphAreaTopY);
      this.context.stroke();
    }

    // Y-axis grid
    const yLines = this.getGridLines(
      this.viewScale.y,
      this.graphBottomLeft.y,
      this.canvas.height,
    );
    for (const i of yLines) {
      if (i < 0 && !this.showGainCurve) continue;
      if (Math.abs(i) < 1e-9) continue;
      const pi = this.linearToView({x: 0, y: i});
      this.context.strokeStyle = '#0008';
      this.context.lineWidth = Math.abs(i - 1) < 1e-9 ? 2 : 1;
      this.context.beginPath();
      this.context.moveTo(graphAreaLeftX, pi.y);
      this.context.lineTo(graphAreaRightX, pi.y);
      this.context.stroke();
    }
    this.context.restore(); // end clipping

    // X-axis labels
    this.context.textAlign = 'start';
    this.context.font = '20px monospace';
    this.context.fillStyle = 'black';
    for (const i of xLines) {
      if (i < 0) continue;
      if (Math.abs(i) < 1e-9) continue;
      const pi = this.linearToView({x: i, y: 0});
      const label = Number.isInteger(i) ? i.toFixed(0) : i.toFixed(1);
      this.context.fillText(label, pi.x - 5, p0.y + 20);
    }

    // Y-axis labels
    for (const i of yLines) {
      if (i < 0 && !this.showGainCurve) continue;
      if (Math.abs(i) < 1e-9) continue;
      const pi = this.linearToView({x: 0, y: i});
      const label = Number.isInteger(i) ? i.toFixed(0) : i.toFixed(1);
      this.context.fillText(label, graphAreaLeftX - 40, pi.y + 5);
    }

    if (!this.metadata) {
      this.context.restore();
      return;
    }

    this.context.textAlign = 'center';

    {
      const p = this.linearToView({x: 1, y: 0});
      let text = this.metadata.hdr_reference_white.toFixed(0) + ' nits';

      this.context.fillText(text, p.x - 20, p.y + 40);
      if (p.x > this.canvas.width / 2) {
        const drawNits = (tt: CurveEditor, nits: number) => {
          const x = nits / tt.metadata!.hdr_reference_white;
          const p = tt.linearToView({x, y: 0});
          text = nits.toString() + ' nits';
          tt.context.fillText(text, p.x, p.y + 40);

          tt.context.beginPath();
          tt.context.moveTo(p.x, p.y);
          tt.context.lineTo(p.x, p.y + 10);
          tt.context.stroke();
        };
        drawNits(this, 1);
        drawNits(this, 5);
        drawNits(this, 10);
        drawNits(this, 25);
        drawNits(this, 50);
      }
    }
    this.context.restore();
    this.context.setLineDash([]);
  }
  drawIdentity() {
    this.context.save();
    this.context.setLineDash([10, 10]);
    this.context.lineWidth = 2;
    this.context.strokeStyle = '#0008';

    this.context.beginPath();
    if (this.showGainCurve) {
      const p0 = this.linearToView({x: 0, y: 0});
      const p1 = this.linearToView({x: 16, y: 0});
      this.context.moveTo(p0.x, p0.y);
      this.context.lineTo(p1.x, p1.y);
    } else {
      const p0 = this.linearToView({x: 0, y: 0});
      const p1 = this.linearToView({x: 16, y: 16});
      this.context.moveTo(p0.x, p0.y);
      this.context.lineTo(p1.x, p1.y);
    }
    this.context.stroke();

    this.context.restore();
  }
  drawHistogram() {
    if (this.gainCurveMixHistogram == null) {
      return;
    }
    this.context.globalCompositeOperation = 'lighter';
    const scaleY = -this.graphBottomLeft.y + 20;

    const bins = this.gainCurveMixHistogram;
    for (let c = 0; c < 3; ++c) {
      this.context.beginPath();
      this.context.lineWidth = 2;
      if (c == 0) {
        this.context.strokeStyle = '#FF202020';
        this.context.fillStyle = '#FF202020';
      } else if (c == 1) {
        this.context.strokeStyle = '#20FF2020';
        this.context.fillStyle = '#20FF2020';
      } else if (c == 2) {
        this.context.strokeStyle = '#2020FF20';
        this.context.fillStyle = '#2020FF20';
      }

      this.context.moveTo(this.graphBottomLeft.x, this.graphBottomLeft.y);
      for (let b = 0; b < bins.length; ++b) {
        const y0 = this.graphBottomLeft.y + scaleY * bins[b].cdfMin[c];
        const y1 = this.graphBottomLeft.y + scaleY * bins[b].cdfMax[c];
        const x0 = this.graphBottomLeft.x + this.viewScale.x * bins[b].binMin;
        const x1 = this.graphBottomLeft.x + this.viewScale.x * bins[b].binMax;
        this.context.lineTo(x0, y0);
        this.context.lineTo(x1, y1);
        if (b == bins.length - 1) {
          this.context.lineTo(x1, this.graphBottomLeft.y);
        }
      }
      this.context.lineTo(this.graphBottomLeft.x, this.graphBottomLeft.y);
      this.context.closePath();
      this.context.fill();
      this.context.stroke();
    }
    this.context.globalCompositeOperation = 'source-over';

    this.context.strokeStyle = '#FFFFFF80';
    const percentiles = [0.5, 0.75, 0.9, 0.95, 0.99];
    for (let i = 0; i < percentiles.length; ++i) {
      for (let c = 0; c < 3; ++c) {
        const y = percentiles[i];
        const x = getPercentile(y, bins);

        const y0 = this.graphBottomLeft.y + scaleY * y;
        const y1 = this.graphBottomLeft.y + 0.0;
        const x0 = this.graphBottomLeft.x + this.viewScale.x * x;

        this.context.beginPath();
        this.context.lineWidth = 2;
        this.context.moveTo(x0, y0);
        this.context.lineTo(x0, y1);
        this.context.stroke();

        this.context.fillStyle = 'black';
        this.context.font = '20px monospace';
        this.context.fillText((100 * y).toFixed(0) + '%', x0 - 15, y0);
      }
    }
  }
  drawCurve(
    altrMin: Altr,
    wMin: number,
    altrMax: Altr | null,
    wMax: number,
    headroom: number | null,
    color: string,
  ) {
    if (altrMax == null) {
      headroom = altrMin.headroom;
    }

    const curveMin = new PiecewiseCubic(altrMin.curve);
    const curveMax = altrMax ? new PiecewiseCubic(altrMax.curve) : null;

    this.context.save();

    // Draw control points only if a single curve was requested.
    if (altrMax == null && this.showControlPoints) {
      this.context.strokeStyle = color + 'FF';
      this.context.fillStyle = color + 'FF';
      for (let i = 0; i < curveMin.getControlPoints().length; ++i) {
        const xym = this.modelToView(curveMin.getControlPoints()[i]);

        this.context.beginPath();
        this.context.arc(xym.x, xym.y, 8, 0, 2 * Math.PI);
        this.context.fill();
        this.context.lineWidth = 0;
        this.context.stroke();

        this.context.beginPath();
        this.context.lineWidth = 4;
        this.context.moveTo(xym.x - 25, xym.y - 25 * (xym.m ?? 0));
        this.context.lineTo(xym.x + 25, xym.y + 25 * (xym.m ?? 0));
        this.context.stroke();
      }
    }

    // Draw the curve itself (potentially interpolating between curveMin and curveMax).
    {
      this.context.beginPath();
      this.context.lineWidth = 4;
      this.context.strokeStyle = color + 'A0';
      for (let vX = this.graphBottomLeft.x; vX < this.canvas.width; vX += 2) {
        const x = this.viewToModel(vX).x;
        let y = wMin * curveMin.evaluate(x).y!;
        if (altrMax != null) {
          y += wMax * curveMax!.evaluate(x).y!;
        }
        const clampVal = undefined; // Clamping disabled for now. Otherwise would be: exp2(headroom!)
        const p = this.modelToView({x, y}, clampVal);
        if (x === 0) {
          this.context.moveTo(p.x, p.y);
        } else {
          this.context.lineTo(p.x, p.y);
        }
      }
      this.context.stroke();
    }

    // Draw the headroom we are targeting.
    if (!this.showGainCurve) {
      {
        const x0 = this.graphBottomLeft.x;
        const x1 = this.canvas.width;
        const y = this.graphBottomLeft.y + this.viewScale.y * exp2(headroom!);
        this.context.setLineDash([10, 10]);
        this.context.beginPath();
        this.context.moveTo(x0, y);
        this.context.lineTo(x1, y);
        this.context.stroke();
      }
    }
    this.context.restore();
  }
  drawInterpolatedCurve(headroom: number, color: string) {
    if (!this.metadata) return;
    const adaptation = agtmAdapt(this.metadata, headroom);
    this.drawCurve(
      adaptation.altrI,
      adaptation.weightI,
      adaptation.altrJ,
      adaptation.weightJ,
      headroom,
      color,
    );
  }

  protected override constrainView() {
    this.graphTopRight = {
      x: this.graphBottomLeft.x + this.viewScale.x * this.graphMaxXValue,
      y: this.graphBottomLeft.y + this.viewScale.y * this.graphMaxYValue,
    };
    super.constrainView();
    this.viewScale = {
      x: (this.graphTopRight.x - this.graphBottomLeft.x) / this.graphMaxXValue,
      y: (this.graphTopRight.y - this.graphBottomLeft.y) / this.graphMaxYValue,
    };
  }

  private drawSelectedPixelLine() {
    const metadata = this.metadata;
    if (!this.selectedPixelRgbNits || !metadata) return;

    const xValues = getComponentMixValue(
      this.selectedPixelRgbNits.map((x) => x / metadata.hdr_reference_white),
      this.contentPrimaries,
      metadata,
      metadata.altr[0],
    );

    const p0 = this.graphBottomLeft;
    const pMax = {x: this.canvas.width - 100, y: 40};

    const drawLine = (xValue: number, color: string) => {
      const x = this.linearToView({x: xValue, y: 0}).x;
      if (x > pMax.x || x < p0.x) return;

      this.context.save();
      this.context.setLineDash([5, 5]);
      this.context.strokeStyle = color;
      this.context.lineWidth = 2;
      this.context.beginPath();
      this.context.moveTo(x, p0.y);
      this.context.lineTo(x, pMax.y);
      this.context.stroke();
      this.context.restore();
    };

    const mix = metadata.altr[0].mix;
    if (mix.channel && mix.channel > 1e-6) {
      const colors = ['red', 'green', 'blue'];
      for (let i = 0; i < 3; ++i) {
        drawLine(xValues[i], colors[i]);
      }
    } else {
      drawLine(xValues[0], 'purple');
    }
  }
  render() {
    this.pixelInfoEl.innerText = this.getPixelInfoString();
    this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);

    const graphTopY = 40;
    const graphBottomY = this.canvas.height - 100;
    if (this.showGainCurve && this.metadata) {
      let minY = Infinity;
      let maxY = -Infinity;
      for (const altr of this.metadata.altr) {
        for (const point of altr.curve) {
          minY = Math.min(minY, point.y);
          maxY = Math.max(maxY, point.y);
        }
      }
      if (maxY <= 0.1) {
        // All points are at or below y=0. Move the origin up.
        this.graphBottomLeft.y = graphTopY;
      } else if (minY < -0.1) {
        // Curve crosses y=0. Center the origin.
        this.graphBottomLeft.y = graphTopY + (graphBottomY - graphTopY) / 2;
      } else {
        // All points are above y=0. Origin at bottom.
        this.graphBottomLeft.y = graphBottomY;
      }
    } else {
      // Default for tone map view.
      this.graphBottomLeft.y = graphBottomY;
    }

    this.drawGrid();
    this.drawHistogram();
    this.drawIdentity();
    this.drawSelectedPixelLine();
    if (this.metadata) {
      for (let i = 0; i < this.metadata.altr.length; ++i) {
        this.drawCurve(
          this.metadata.altr[i],
          1.0,
          null,
          0.0,
          null,
          i == this.altrIndex ? '#FF0000' : '#808080',
        );
      }
      if (this.headroomLog2 != null) {
        this.drawInterpolatedCurve(this.headroomLog2, '#00FF00');
      }
    }
  }

  //////////////////////////////////////////////////////////////////////////////
  // Event handling
  onModelChanged() {
    if (!this.metadata || !this.curve) return;
    this.metadata.altr[this.altrIndex].curve = this.curve.getControlPoints();
    this.modelChangedCallback(this.metadata);
  }

  getControlPointIndex(viewPoint: Point2): number | null {
    let bestDist: number | null = null;
    let bestIndex: number | null = null;
    for (let i = 0; i < this.curve!.getControlPoints().length; ++i) {
      const viewPointI = this.modelToView(this.curve!.getControlPoints()[i]);
      const dist = vec2Dist(viewPointI, viewPoint);
      if (bestDist == null || dist < bestDist) {
        bestIndex = i;
        bestDist = dist;
      }
    }
    if (!bestDist || bestDist > kPointSelectMaxDist) {
      return null;
    }
    return bestIndex;
  }
  override mouseDown(e: MouseEvent) {
    if (!this.curve) return;
    const viewPoint = this.getViewPoint(e);

    // Right click to delete
    if (e.button === 2) {
      const index = this.getControlPointIndex(viewPoint);
      if (index !== null) {
        this.curve.remove(index);
        this.onModelChanged();
        this.draw();
      }
      return;
    }

    if (e.button !== 0) return;

    let index = this.getControlPointIndex(viewPoint);

    // If not near a point, try to add one.
    if (index === null) {
      const modelX = this.viewToModel(viewPoint.x).x;
      const curveModelPoint = this.curve.evaluate(modelX);
      const curveViewPoint = this.modelToView(curveModelPoint);
      const dist = vec2Dist(viewPoint, curveViewPoint);

      if (dist < kPointSelectMaxDist) {
        const newPoint = this.viewToModel(
          viewPoint.x,
          viewPoint.y,
          curveViewPoint.m,
          curveModelPoint,
        );
        const cp = this.curve.getControlPoints();
        let insertIndex = cp.length;
        for (let i = 0; i < cp.length; ++i) {
          if (newPoint.x < cp[i].x) {
            insertIndex = i;
            break;
          }
        }
        cp.splice(insertIndex, 0, newPoint);
        index = insertIndex;
        this.onModelChanged();
      }
    }

    // If we have a point (existing or new), start dragging it.
    if (index !== null) {
      this.dragIndex = index;
    }
    this.dragViewPoint = viewPoint;
  }

  override mouseMove(e: MouseEvent) {
    if (!this.curve) return;
    const oldViewPoint = this.dragViewPoint;
    this.dragViewPoint = this.getViewPoint(e);
    if (!oldViewPoint) {
      return;
    }
    const viewDelta = vec2Sub(this.dragViewPoint, oldViewPoint);
    if (e.buttons !== 1) {
      return;
    }
    if (this.dragIndex == null) {
      this.graphBottomLeft.x += viewDelta.x;
      this.graphBottomLeft.y += viewDelta.y;
      this.constrainView();
      this.draw();
      return;
    }
    if (this.dragIndex == null) {
      return;
    }

    if (this.showGainCurve) {
      const modelOld = this.curve.getControlPoints()[this.dragIndex];
      const modelNew = structuredClone(modelOld);
      const modelDeltaX = viewDelta.x / this.viewScale.x;
      const modelDeltaY = viewDelta.y / this.viewScale.y;
      if (e.shiftKey) {
        modelNew.m! +=
          (0.01 * viewDelta.y * this.viewScale.x) / this.viewScale.y;
      } else if (e.altKey) {
        modelNew.y += modelDeltaY;
      } else {
        modelNew.x += modelDeltaX;
        modelNew.y += modelDeltaY;
      }
      this.curve.getControlPoints()[this.dragIndex] = modelNew;
    } else {
      const modelOld = this.curve.getControlPoints()[this.dragIndex];
      const viewOld = this.modelToView(modelOld);
      let viewNew = viewOld;

      if (e.shiftKey) {
        viewNew = structuredClone(viewOld);
        viewNew.m! += 0.01 * viewDelta.y;
      } else if (e.altKey) {
        viewNew = structuredClone(viewOld);
        viewNew.y += viewDelta.y;
      } else {
        viewNew = vec2Add(viewOld, viewDelta);
        viewNew.m = viewOld.m;
      }
      // Prevent dragging points too close to the axes, which can cause
      // viewToModel to return NaN coordinates.
      const kMinPixelDist = 1;
      viewNew.x = Math.max(viewNew.x, this.graphBottomLeft.x + kMinPixelDist);
      viewNew.y = Math.min(viewNew.y, this.graphBottomLeft.y - kMinPixelDist);

      if (
        viewNew.x !== viewOld.x ||
        viewNew.y !== viewOld.y ||
        viewNew.m !== viewOld.m
      ) {
        const modelNew = this.viewToModel(
          viewNew.x,
          viewNew.y,
          viewNew.m,
          modelOld,
        );
        this.curve.getControlPoints()[this.dragIndex] = modelNew;
      }
    }

    // Re-order control points if necessary.
    const cp = this.curve.getControlPoints();
    let newIdx = this.dragIndex;
    // Bubble left.
    while (newIdx > 0 && cp[newIdx].x < cp[newIdx - 1].x) {
      [cp[newIdx], cp[newIdx - 1]] = [cp[newIdx - 1], cp[newIdx]];
      newIdx--;
    }
    // Bubble right.
    while (newIdx < cp.length - 1 && cp[newIdx].x > cp[newIdx + 1].x) {
      [cp[newIdx], cp[newIdx + 1]] = [cp[newIdx + 1], cp[newIdx]];
      newIdx++;
    }
    this.dragIndex = newIdx;

    this.onModelChanged();
    this.draw();
  }
  override wheel(e: WheelEvent) {
    e.preventDefault();
    const viewPoint = this.getViewPoint(e);

    let zoomX = 1.0;
    let zoomY = 1.0;

    if (e.ctrlKey) {
      zoomY = exp2(e.deltaY * 0.01);
    } else if (e.shiftKey) {
      zoomX = exp2(e.deltaX * -0.01);
    } else {
      const zoom = exp2(e.deltaY * -0.01);
      zoomX = zoom;
      zoomY = zoom;
    }

    // Pan to keep mouse location fixed
    this.graphBottomLeft.x =
      viewPoint.x - (viewPoint.x - this.graphBottomLeft.x) * zoomX;
    this.graphBottomLeft.y =
      viewPoint.y - (viewPoint.y - this.graphBottomLeft.y) * zoomY;

    // Apply zoom
    this.viewScale.x *= zoomX;
    this.viewScale.y *= zoomY;

    this.constrainView();

    this.draw();
  }
  override mouseUpOrLeave() {
    this.dragIndex = null;
    this.dragViewPoint = null;
  }
}
