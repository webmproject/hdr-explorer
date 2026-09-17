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

// @ts-ignore
import * as plotly from 'plotly.js-dist-min';
import {Data, Layout} from 'plotly.js';
import {AgtmMetadata} from '../color_helpers/agtm';
import {agtmAdapt} from '../color_helpers/agtm_adapt';
import {logGainToLinear} from '../color_helpers/gain_curve';
import {exp2} from '../color_helpers/math_helpers';
import {PiecewiseCubic} from '../color_helpers/piecewise_cubic';
import {findSampleIndexForTime} from '../media_parser';
import {Renderer} from './renderer';

/**
 * Default upper bound for the Y axis (input linear luminance in SDR-relative
 * units, where 1.0 = SDR reference white).
 */
const DEFAULT_MAX_INPUT_Y = 16;

/**
 * Number of sample points along the input Y axis used to discretize each
 * piecewise-cubic AGTM curve column on the 3D surface.
 */
const NUM_Y_POINTS = 65;

/**
 * Wraps an axis or colorbar title string in a `{text: string}` object required
 * by Plotly v3+ at runtime, cast to `string` to satisfy the older
 * `@types/plotly.js` TypeScript definitions.
 */
function plotlyTitle(text: string): string {
  return {text} as unknown as string;
}

/**
 * Renders all AGTM (SMPTE ST 2094-50) curves of a video over time as an
 * interactive 3D surface using Plotly.
 *
 * Axes:
 * - X axis ("time"): Video timestamp in seconds, formatted as `000.000` to
 *   match the video timestamp input in the toolbar (`#TimeSliderValue`).
 * - Y axis ("Input (SDR-rel)"): Input linear luminance (SDR-relative).
 * - Z axis ("Output (SDR-rel)" or "Gain (log2)"): Output linear luminance or
 *   log2 gain when `showGainCurve` is enabled.
 *
 * Also renders a 3D line (`scatter3d`) highlighting the curve at the video's
 * current playback timestamp and allows clicking anywhere on the 3D surface
 * to seek the video to that timestamp.
 */
export class Curves3dRenderer implements Renderer {
  /** DOM element hosting the Plotly 3D scene. */
  private readonly container: HTMLElement;

  /** Checkbox inside the 3D panel for toggling log2 gain display. */
  private readonly showGainCurveCheckbox: HTMLInputElement;

  /** Callback invoked when the user clicks a timestamp on the 3D surface. */
  private readonly onTimeSelectedCallback: (timeSec: number) => void;

  /** Callback invoked when the panel's "Show gain curve" checkbox changes. */
  private readonly onShowGainCurveChangedCallback: (show: boolean) => void;

  /** Event listener reference for cleaning up showGainCurveCheckbox on destroy. */
  private readonly showGainCurveChangeHandler: () => void;

  /** Presentation timestamps (in seconds) for each frame in the video. */
  private frameTimes: number[] = [0];

  /** Per-frame AGTM metadata list (with UI overrides applied). */
  private metadataList: AgtmMetadata[] = [];

  /** Current playback timestamp of the video in seconds. */
  private currentTime = 0;

  /** Total duration of the video in seconds (0 for still images). */
  private videoDuration = 0;

  /** Target display HDR headroom in log2 units used for curve adaptation. */
  private headroomLog2 = 0;

  /**
   * Whether the Z axis displays the log2 gain curve (`true`) or the linear
   * SDR-relative tone-mapping curve (`false`).
   */
  private showGainCurve = false;

  /** Ensures the `plotly_click` event listener is attached only once. */
  private isClickInitialized = false;

  /** Handles clicking on the 3D surface to seek the video timestamp. */
  private readonly onPlotlyClick = (eventData: any) => {
    if (eventData?.points?.length > 0) {
      const clickedX = eventData.points[0].x;
      if (typeof clickedX === 'number' && isFinite(clickedX)) {
        // Add a small positive epsilon when seeking to a frame start time
        // so the browser media pipeline does not round down to the previous frame.
        const targetTime =
          clickedX > 0
            ? Math.min(
                clickedX + 1e-4,
                this.videoDuration > 0 ? this.videoDuration : clickedX + 1e-4,
              )
            : 0;
        this.onTimeSelectedCallback(targetTime);
      }
    }
  };

  /**
   * Key summarizing the inputs that determine the 3D surface geometry
   * (frame count, duration, metadata source, and UI overrides). Used to avoid
   * recomputing the 2D Z matrix when only `currentTime` changes during playback.
   */
  private surfaceCacheKey = '';

  /**
   * Cached 3D surface mesh coordinates:
   * - `x`: 1D array of frame timestamps (length M >= 2).
   * - `y`: 1D array of input SDR-relative values (length N = `NUM_Y_POINTS`).
   * - `z`: 2D matrix of dimensions [N][M] (`z[yi][xi]`), as required by Plotly.
   * - `maxY`: Upper bound of the Y axis range.
   */
  private cachedSurface: {
    x: number[];
    y: number[];
    z: number[][];
    maxY: number;
  } | null = null;

  /**
   * Persistent Plotly layout object passed across `plotly.react()` calls so
   * that user 3D camera rotation, zoom, and pan state are preserved across
   * frame updates.
   *
   * The X axis is labeled "time" and uses `07.3f` formatting (`000.000`) for
   * both axis ticks and hover spike coordinates so that displayed coordinates
   * match the video timestamp display (`#TimeSliderValue`).
   */
  private readonly layout: Partial<Layout> = {
    showlegend: true,
    legend: {
      x: 0.02,
      y: 0.98,
      bgcolor: 'rgba(255, 255, 255, 0.7)',
    },
    title: {text: '2094-50 Curves over Time'},
    scene: {
      xaxis: {
        title: plotlyTitle('time'),
        tickformat: '07.3f',
        hoverformat: '07.3f',
        autorange: true,
      },
      yaxis: {
        title: plotlyTitle('Input (SDR-rel)'),
        range: [0, DEFAULT_MAX_INPUT_Y],
      },
      zaxis: {
        title: plotlyTitle('Output (SDR-rel)'),
        autorange: true,
      },
      camera: {eye: {x: 1.6, y: -1.6, z: 1.1}},
    },
    paper_bgcolor: 'rgba(0,0,0,0)',
    autosize: true,
    margin: {
      l: 0,
      r: 0,
      b: 0,
      t: 35,
    },
  };

  /**
   * @param container DOM element where Plotly renders the 3D surface.
   * @param showGainCurveCheckbox Checkbox element to sync gain mode.
   * @param onTimeSelectedCallback Callback triggered on surface click.
   * @param onShowGainCurveChangedCallback Callback triggered when the
   *     gain curve checkbox is toggled.
   */
  constructor(
    container: HTMLElement,
    showGainCurveCheckbox: HTMLInputElement,
    onTimeSelectedCallback: (timeSec: number) => void,
    onShowGainCurveChangedCallback: (show: boolean) => void,
  ) {
    this.container = container;
    this.showGainCurveCheckbox = showGainCurveCheckbox;
    this.onTimeSelectedCallback = onTimeSelectedCallback;
    this.onShowGainCurveChangedCallback = onShowGainCurveChangedCallback;

    this.showGainCurveChangeHandler = () => {
      const checked = this.showGainCurveCheckbox.checked;
      this.setShowGainCurve(checked);
      this.onShowGainCurveChangedCallback(checked);
      this.draw();
    };
    this.showGainCurveCheckbox.addEventListener(
      'change',
      this.showGainCurveChangeHandler,
    );
  }

  /**
   * Cleans up the Plotly instance and removes DOM event listeners when the
   * renderer is destroyed.
   */
  destroy() {
    this.showGainCurveCheckbox.removeEventListener(
      'change',
      this.showGainCurveChangeHandler,
    );
    (this.container as any).off?.('plotly_click', this.onPlotlyClick);
    plotly.purge(this.container);
  }

  isPicture(): boolean {
    return false;
  }

  getCanvas(): HTMLCanvasElement {
    return new HTMLCanvasElement();
  }

  getVersion(): string {
    return '0.0.0';
  }

  resizeFramebuffer(width: number, height: number, evenIfNotPicture?: boolean) {
    if (evenIfNotPicture) {
      this.container.style.width = `${width}px`;
      this.container.style.height = `${height}px`;
    }
  }

  /**
   * Called whenever a new image or video frame is rendered. Updates
   * `this.currentTime` from the video element so that the current-frame
   * highlight curve stays synchronized during playback and scrubbing.
   */
  setImage(
    imageBitmapSource: HTMLImageElement | HTMLVideoElement,
    imageBitmap: ImageBitmap,
    contentTransfer: number,
    contentPrimaries: number,
  ): void {
    if (imageBitmapSource instanceof HTMLVideoElement) {
      this.currentTime = imageBitmapSource.currentTime;
    }
  }

  getImageData(
    scale: number,
    xInDst: number,
    yInDst: number,
    dst: Uint8Array,
    dstStride: number,
  ): void {}

  /**
   * Formats a timestamp in seconds to match the `000.000` format displayed in
   * the hdrscope video timestamp input (`#TimeSliderValue`).
   */
  private formatTimestamp(timeSec: number): string {
    return timeSec.toLocaleString('fullwide', {
      minimumFractionDigits: 3,
      maximumFractionDigits: 3,
      minimumIntegerDigits: 3,
    });
  }

  /**
   * Updates the target display HDR headroom and invalidates the cached surface
   * so adapted curves are recomputed on the next draw.
   */
  setHeadroomLog2(headroomLog2: number, nits: number) {
    if (this.headroomLog2 !== headroomLog2) {
      this.headroomLog2 = headroomLog2;
      this.cachedSurface = null;
    }
  }

  /**
   * Sets whether to plot log2 gain (`true`) or linear tone-mapped output
   * (`false`), syncing the panel checkbox and invalidating the surface cache.
   */
  setShowGainCurve(show: boolean) {
    if (this.showGainCurve !== show) {
      this.showGainCurve = show;
      if (this.showGainCurveCheckbox.checked !== show) {
        this.showGainCurveCheckbox.checked = show;
      }
      this.cachedSurface = null;
    }
  }

  /**
   * Updates the time series and metadata inputs for the 3D curve surface.
   *
   * If only `currentTime` has changed since the last call (e.g. during video
   * playback or timeline scrubbing), `cachedSurface` is preserved so that only
   * the 3D highlight trace needs to be re-evaluated.
   */
  setCurvesData(
    frameTimes: number[],
    metadataList: AgtmMetadata[],
    currentTime: number,
    videoDuration: number,
  ) {
    this.currentTime = currentTime;
    this.videoDuration = videoDuration;

    const newCacheKey = JSON.stringify({
      frameTimes,
      metadataList,
      videoDuration,
    });
    if (this.cachedSurface === null || newCacheKey !== this.surfaceCacheKey) {
      this.surfaceCacheKey = newCacheKey;
      this.frameTimes = frameTimes.length > 0 ? frameTimes : [0];
      this.metadataList = metadataList;
      this.cachedSurface = null;
    }
  }

  /**
   * Evaluates the adapted AGTM curve for `meta` at each input value in
   * `yValues` for the current display headroom (`this.headroomLog2`).
   *
   * @return Array of Z values (either log2 gain or linear SDR-relative output).
   */
  private evaluateCurveAt(meta: AgtmMetadata, yValues: number[]): number[] {
    const adaptation = agtmAdapt(meta, this.headroomLog2);
    const curveI = new PiecewiseCubic(adaptation.altrI.curve);
    const curveJ = new PiecewiseCubic(adaptation.altrJ.curve);
    return yValues.map((yVal) => {
      const logGain =
        adaptation.weightI * curveI.evaluate(yVal).y +
        adaptation.weightJ * curveJ.evaluate(yVal).y;
      if (this.showGainCurve) {
        return logGain;
      }
      return logGainToLinear({x: yVal, y: logGain}).y;
    });
  }

  /**
   * Computes and caches the 2D surface grid (`x`, `y`, `z[yi][xi]`) across all
   * video frame timestamps and input luminance samples.
   */
  private computeSurface() {
    const numFrames = Math.max(1, this.frameTimes.length);

    const effectiveMetadata: Array<AgtmMetadata | undefined> = [];
    const xCoords: number[] = [];

    // Always populate X coordinates for every video frame timestamp so that
    // hovering anywhere on the 3D surface displays the exact frame timestamp.
    for (let i = 0; i < numFrames; ++i) {
      const t = this.frameTimes[i] ?? i;
      const prevT = xCoords.length > 0 ? xCoords[xCoords.length - 1] : -1;
      xCoords.push(t <= prevT ? prevT + 1e-4 : t);
      const meta =
        i < this.metadataList.length
          ? this.metadataList[i]
          : this.metadataList[this.metadataList.length - 1];
      effectiveMetadata.push(meta);
    }

    // If only 1 frame timestamp is available (e.g. still image or unparsed
    // video), generate columns spanning [0, videoDuration] so Plotly renders a
    // 2D surface mesh with hoverable timestamps across the video duration.
    if (xCoords.length === 1) {
      const t0 = xCoords[0];
      const endT =
        this.videoDuration > t0 ? this.videoDuration : Math.max(1, t0 + 1);
      const numSteps =
        this.videoDuration > 0
          ? Math.min(200, Math.max(2, Math.ceil(this.videoDuration * 30)))
          : 2;
      for (let step = 1; step < numSteps; ++step) {
        const t = t0 + ((endT - t0) * step) / (numSteps - 1);
        xCoords.push(t);
        effectiveMetadata.push(effectiveMetadata[0]);
      }
    }

    // Determine the upper bound of the input Y axis from the maximum baseline
    // HDR headroom across all frames (clamped to 64x SDR white).
    let maxY = DEFAULT_MAX_INPUT_Y;
    for (const meta of effectiveMetadata) {
      if (meta && meta.baseline_hdr_headroom != null) {
        maxY = Math.max(maxY, Math.min(64, exp2(meta.baseline_hdr_headroom)));
      }
    }

    // Uniformly sample the input luminance range [0, maxY].
    const yCoords: number[] = [];
    for (let yi = 0; yi < NUM_Y_POINTS; ++yi) {
      yCoords.push((yi / (NUM_Y_POINTS - 1)) * maxY);
    }

    // Plotly surface expects `z` indexed as `z[y_index][x_index]`.
    const zSurface: number[][] = Array.from({length: NUM_Y_POINTS}, () =>
      new Array<number>(xCoords.length).fill(0),
    );

    for (let xi = 0; xi < xCoords.length; ++xi) {
      const meta = effectiveMetadata[xi];
      if (meta) {
        const colZ = this.evaluateCurveAt(meta, yCoords);
        for (let yi = 0; yi < NUM_Y_POINTS; ++yi) {
          zSurface[yi][xi] = colZ[yi];
        }
      } else {
        // Identity fallback (0 log2 gain or output == input).
        for (let yi = 0; yi < NUM_Y_POINTS; ++yi) {
          zSurface[yi][xi] = this.showGainCurve ? 0 : yCoords[yi];
        }
      }
    }

    this.cachedSurface = {
      x: xCoords,
      y: yCoords,
      z: zSurface,
      maxY,
    };
  }

  /**
   * Finds the index of the frame active at `this.currentTime`. Uses a 1ms
   * tolerance so timestamps quantized to 0.001s (from `#TimeSlider`) match
   * their corresponding frame presentation timestamp.
   */
  private getFrameIndexForCurrentTime(): number {
    return findSampleIndexForTime(this.frameTimes, this.currentTime, 1e-3) ?? 0;
  }

  /**
   * Returns the AGTM metadata active at `this.currentTime`.
   */
  private getMetadataForCurrentTime(): AgtmMetadata | undefined {
    if (this.metadataList.length === 0) {
      return undefined;
    }
    const idx = Math.min(
      this.getFrameIndexForCurrentTime(),
      this.metadataList.length - 1,
    );
    return this.metadataList[idx];
  }

  draw() {
    this.render();
  }

  /**
   * Renders or updates the Plotly 3D surface and the current-frame highlight
   * curve using `plotly.react`.
   */
  render() {
    if (!this.cachedSurface) {
      this.computeSurface();
    }
    const surface = this.cachedSurface!;

    // Update axis titles and ranges in-place on `this.layout.scene` so camera
    // orientation state stored inside `this.layout` is preserved.
    const scene = this.layout.scene;
    if (scene && scene.xaxis && scene.yaxis && scene.zaxis) {
      scene.xaxis.title = plotlyTitle('time');
      scene.xaxis.tickformat = '07.3f';
      scene.xaxis.hoverformat = '07.3f';
      if (this.videoDuration > 0) {
        scene.xaxis.range = [0, this.videoDuration];
        scene.xaxis.autorange = false;
      } else {
        scene.xaxis.autorange = true;
      }
      scene.yaxis.title = plotlyTitle('Input (SDR-rel)');
      scene.yaxis.range = [0, surface.maxY];
      scene.yaxis.autorange = false;
      scene.zaxis.title = plotlyTitle(
        this.showGainCurve ? 'Gain (log2)' : 'Output (SDR-rel)',
      );
      scene.zaxis.autorange = true;
    }

    const hoverLabel = this.showGainCurve ? 'Gain' : 'Output';
    const data: Data[] = [
      {
        x: surface.x,
        y: surface.y,
        z: surface.z,
        type: 'surface',
        name: this.showGainCurve ? 'Gain Curve (log2)' : 'Tone Map Curve',
        colorscale: 'Viridis',
        opacity: 0.9,
        showscale: true,
        colorbar: {
          title: plotlyTitle(this.showGainCurve ? 'Gain (log2)' : 'Output'),
          thickness: 15,
          len: 0.75,
        },
        hovertemplate:
          'time: %{x:07.3f}<br>Input: %{y:.3f}<br>' +
          hoverLabel +
          ': %{z:.3f}<extra></extra>',
      } as any,
    ];

    // Overlay a 3D line trace along the surface at the current video timestamp
    // to highlight the active video frame's curve.
    const currentMeta = this.getMetadataForCurrentTime();
    if (currentMeta) {
      const frameIdx = this.getFrameIndexForCurrentTime();
      // If currentTime is within 1ms of the frame's presentation timestamp,
      // snap the highlight X coordinate to the surface column so the 3D line
      // lies flush on the surface mesh without floating due to sub-ms rounding.
      const frameTime =
        surface.x[Math.min(frameIdx, surface.x.length - 1)] ?? 0;
      const highlightTime =
        Math.abs(this.currentTime - frameTime) <= 1e-3
          ? frameTime
          : this.currentTime;
      const highlightZ = this.evaluateCurveAt(currentMeta, surface.y);
      const highlightX = surface.y.map(() => highlightTime);
      data.push({
        x: highlightX,
        y: surface.y,
        z: highlightZ,
        type: 'scatter3d',
        mode: 'lines',
        name: `Current (${this.formatTimestamp(highlightTime)})`,
        line: {
          color: '#00ff00',
          width: 7,
        },
        hovertemplate:
          'time: %{x:07.3f}<br>Input: %{y:.3f}<br>' +
          hoverLabel +
          ': %{z:.3f}<extra>Current Frame</extra>',
        showlegend: true,
      } as any);
    }

    plotly.react(this.container, data, this.layout, {responsive: true});

    // Attach click listener once to support seeking the video by clicking on
    // any point on the 3D surface.
    if (!this.isClickInitialized) {
      this.isClickInitialized = true;
      (this.container as any).on('plotly_click', this.onPlotlyClick);
    }
  }
}
