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

  /** Optional per-frame smoothed AGTM metadata list. */
  private smoothedMetadataList: AgtmMetadata[] | null = null;

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

  /** Ensures Plotly event listeners are attached only once. */
  private isClickInitialized = false;

  /** Currently hovered surface grid indices `{xi, yi}`, if any. */
  private hoverIndices: {xi: number; yi: number} | null = null;

  /** Last valid hovered grid indices `{xi, yi}` before any unhover event. */
  private lastHoverIndices: {xi: number; yi: number} | null = null;

  /**
   * Surface grid indices `{xi, yi}` pinned by clicking on the surface. When
   * non-null, the slice curves stay locked at these indices during zoom/pan
   * and hover/unhover.
   */
  private pinnedIndices: {xi: number; yi: number} | null = null;

  /** Pointer-down client coordinates used to distinguish a click from a 3D drag. */
  private pointerDownPos: {x: number; y: number} | null = null;

  /** Indices in `data` of the hover slice `scatter3d` traces. */
  private hoverTraceIndices: number[] = [];

  /** Pending `requestAnimationFrame` handle for coalesced hover updates. */
  private hoverRafId: number | null = null;

  /** Keydown handler to allow unpinning the slice curves with Escape. */
  private readonly onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && this.pinnedIndices !== null) {
      this.pinnedIndices = null;
      this.scheduleHoverFlush();
    }
  };

  /** Records pointer-down coordinates on the 3D container. */
  private readonly onPointerDown = (e: PointerEvent) => {
    if (e.button === 0) {
      this.pointerDownPos = {x: e.clientX, y: e.clientY};
    }
  };

  /**
   * Detects a click (pointerup within 5px of pointerdown) on the 3D scene and
   * toggles pinning the slice curves on the surface.
   */
  private readonly onPointerUp = (e: PointerEvent) => {
    if (e.button !== 0 || !this.pointerDownPos) {
      return;
    }
    const dist = Math.hypot(
      e.clientX - this.pointerDownPos.x,
      e.clientY - this.pointerDownPos.y,
    );
    this.pointerDownPos = null;
    if (dist >= 5) {
      // User dragged to rotate/pan the 3D camera; do not change pin state.
      return;
    }

    if (this.pinnedIndices !== null) {
      // Unpin so the slice curves follow mouse hover again.
      this.pinnedIndices = null;
      this.scheduleHoverFlush();
      return;
    }

    const targetIndices = this.hoverIndices ?? this.lastHoverIndices;
    if (targetIndices && this.cachedSurface) {
      this.pinnedIndices = {...targetIndices};
      this.hoverIndices = {...targetIndices};
      this.scheduleHoverFlush();

      const clickedX = this.cachedSurface.x[targetIndices.xi];
      if (typeof clickedX === 'number' && isFinite(clickedX)) {
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
   * Finds the closest `{xi, yi}` grid indices on `cachedSurface` for the given
   * surface coordinates `(xVal, yVal)`.
   */
  private findGridIndices(
    xVal: unknown,
    yVal: unknown,
  ): {xi: number; yi: number} | null {
    const surface = this.cachedSurface;
    if (
      !surface ||
      typeof xVal !== 'number' ||
      !isFinite(xVal) ||
      typeof yVal !== 'number' ||
      !isFinite(yVal)
    ) {
      return null;
    }

    let xi = 0;
    let bestDx = Infinity;
    for (let i = 0; i < surface.x.length; ++i) {
      const dx = Math.abs(surface.x[i] - xVal);
      if (dx < bestDx) {
        bestDx = dx;
        xi = i;
      }
    }

    let yi = 0;
    let bestDy = Infinity;
    for (let i = 0; i < surface.y.length; ++i) {
      const dy = Math.abs(surface.y[i] - yVal);
      if (dy < bestDy) {
        bestDy = dy;
        yi = i;
      }
    }

    return {xi, yi};
  }

  /**
   * Updates `lastHoverIndices` if Plotly emits `plotly_click` with point coords.
   */
  private readonly onPlotlyClick = (eventData: any) => {
    if (eventData?.points?.length > 0) {
      const pt = eventData.points[0];
      const clickedIndices = this.findGridIndices(pt.x, pt.y);
      if (clickedIndices) {
        this.lastHoverIndices = clickedIndices;
      }
    }
  };

  /**
   * Finds the index of the frame active at `this.currentTime`. Uses a 1ms
   * tolerance so timestamps quantized to 0.001s (from `#TimeSlider`) match
   * their corresponding frame presentation timestamp.
   */
  private getFrameIndexForCurrentTime(): number {
    return findSampleIndexForTime(this.frameTimes, this.currentTime, 1e-3) ?? 0;
  }

  /**
   * Synchronizes the timestamp index (`xi`) of any active or pinned slice with
   * `this.currentTime` when the video frame changes (e.g. via prev/next frame
   * buttons or timeline scrubbing).
   */
  private syncTimeIndexWithCurrentTime() {
    const frameIdx = this.getFrameIndexForCurrentTime();
    if (this.pinnedIndices !== null) {
      this.pinnedIndices = {xi: frameIdx, yi: this.pinnedIndices.yi};
    }
    if (this.hoverIndices !== null) {
      this.hoverIndices = {xi: frameIdx, yi: this.hoverIndices.yi};
    }
    if (this.lastHoverIndices !== null) {
      this.lastHoverIndices = {xi: frameIdx, yi: this.lastHoverIndices.yi};
    }
  }

  /**
   * Flushes the pending hover/pinned slice update outside Plotly's synchronous
   * `plotly_hover` dispatch loop so internal WebGL trace references stay valid.
   */
  private readonly flushHoverUpdate = () => {
    this.hoverRafId = null;
    const surface = this.cachedSurface;
    if (!surface || !this.hoverTraceIndices.length) {
      return;
    }

    const activeIndices = this.pinnedIndices ?? this.hoverIndices;
    const hasYSlice =
      activeIndices !== null &&
      activeIndices.xi < surface.x.length &&
      activeIndices.yi < surface.y.length;
    const xi = hasYSlice
      ? activeIndices!.xi
      : Math.min(this.getFrameIndexForCurrentTime(), surface.x.length - 1);
    const yi = hasYSlice ? activeIndices!.yi : 0;

    const hx = surface.x[xi] ?? 0;
    const hy = surface.y[yi] ?? 0;
    const xConst = surface.y.map(() => hx);
    const yConst = surface.x.map(() => hy);
    const sliceAlongInput = surface.y.map((_, r) => surface.z[r][xi]);
    const sliceAlongTime = surface.z[yi];

    const hasSmoothed =
      surface.zSmoothed !== null && this.hoverTraceIndices.length === 4;
    if (hasSmoothed) {
      const smoothedAlongInput = surface.y.map(
        (_, r) => surface.zSmoothed![r][xi],
      );
      const smoothedAlongTime = surface.zSmoothed![yi];
      plotly.restyle(
        this.container,
        {
          x: [xConst, surface.x, xConst, surface.x],
          y: [surface.y, yConst, surface.y, yConst],
          z: [
            sliceAlongInput,
            sliceAlongTime,
            smoothedAlongInput,
            smoothedAlongTime,
          ],
          visible: [true, hasYSlice, true, hasYSlice],
        } as any,
        this.hoverTraceIndices,
      );
      return;
    }
    plotly.restyle(
      this.container,
      {
        x: [xConst, surface.x],
        y: [surface.y, yConst],
        z: [sliceAlongInput, sliceAlongTime],
        visible: [true, hasYSlice],
      } as any,
      this.hoverTraceIndices,
    );
  };

  /** Schedules a single `requestAnimationFrame` to apply hover slice updates. */
  private scheduleHoverFlush() {
    if (this.hoverRafId === null) {
      this.hoverRafId = requestAnimationFrame(this.flushHoverUpdate);
    }
  }

  /** Handles hovering on either 3D surface to update the slice curves. */
  private readonly onPlotlyHover = (eventData: any) => {
    if (!eventData?.points?.length || !this.hoverTraceIndices.length) {
      return;
    }
    const pt = eventData.points[0];
    const indices = this.findGridIndices(pt.x, pt.y);
    if (!indices) {
      return;
    }
    this.lastHoverIndices = indices;

    if (this.pinnedIndices !== null) {
      return;
    }

    if (
      this.hoverIndices &&
      this.hoverIndices.xi === indices.xi &&
      this.hoverIndices.yi === indices.yi
    ) {
      return;
    }
    this.hoverIndices = indices;
    this.scheduleHoverFlush();
  };

  /** Hides the slice curves when the pointer leaves the 3D surface (unless pinned). */
  private readonly onPlotlyUnhover = () => {
    if (this.pinnedIndices !== null) {
      return;
    }
    if (!this.hoverIndices || !this.hoverTraceIndices.length) {
      return;
    }
    this.hoverIndices = null;
    this.scheduleHoverFlush();
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
    zSmoothed: number[][] | null;
    maxY: number;
  } | null = null;

  /**
   * Preserves per-trace visibility across `plotly.react` updates when toggled
   * via the legend.
   */
  private readonly traceVisibility = new Map<string, boolean | 'legendonly'>();

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
    uirevision: 'true',
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
  } as Partial<Layout>;

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
    this.container.addEventListener('pointerdown', this.onPointerDown, true);
    this.container.addEventListener('pointerup', this.onPointerUp, true);
    window.addEventListener('keydown', this.onKeyDown);
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
    this.container.removeEventListener('pointerdown', this.onPointerDown, true);
    this.container.removeEventListener('pointerup', this.onPointerUp, true);
    window.removeEventListener('keydown', this.onKeyDown);
    if (this.hoverRafId !== null) {
      cancelAnimationFrame(this.hoverRafId);
      this.hoverRafId = null;
    }
    (this.container as any).off?.('plotly_click', this.onPlotlyClick);
    (this.container as any).off?.('plotly_hover', this.onPlotlyHover);
    (this.container as any).off?.('plotly_unhover', this.onPlotlyUnhover);
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
      if (Math.abs(imageBitmapSource.currentTime - this.currentTime) > 1e-5) {
        this.currentTime = imageBitmapSource.currentTime;
        this.syncTimeIndexWithCurrentTime();
      }
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
    smoothedMetadataList: AgtmMetadata[] | null = null,
  ) {
    const timeChanged = Math.abs(currentTime - this.currentTime) > 1e-5;
    this.currentTime = currentTime;
    this.videoDuration = videoDuration;

    const newCacheKey = JSON.stringify({
      frameTimes,
      metadataList,
      smoothedMetadataList,
      videoDuration,
    });
    if (this.cachedSurface === null || newCacheKey !== this.surfaceCacheKey) {
      if (frameTimes.length !== this.frameTimes.length) {
        this.pinnedIndices = null;
      }
      this.surfaceCacheKey = newCacheKey;
      this.frameTimes = frameTimes.length > 0 ? frameTimes : [0];
      this.metadataList = metadataList;
      this.smoothedMetadataList = smoothedMetadataList;
      this.cachedSurface = null;
    }
    if (timeChanged) {
      this.syncTimeIndexWithCurrentTime();
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
    const effectiveSmoothedMetadata: Array<AgtmMetadata | undefined> = [];
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
      if (this.smoothedMetadataList && this.smoothedMetadataList.length > 0) {
        const smMeta =
          i < this.smoothedMetadataList.length
            ? this.smoothedMetadataList[i]
            : this.smoothedMetadataList[this.smoothedMetadataList.length - 1];
        effectiveSmoothedMetadata.push(smMeta);
      }
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
        if (effectiveSmoothedMetadata.length > 0) {
          effectiveSmoothedMetadata.push(effectiveSmoothedMetadata[0]);
        }
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

    let zSmoothedSurface: number[][] | null = null;
    if (effectiveSmoothedMetadata.length > 0) {
      zSmoothedSurface = Array.from({length: NUM_Y_POINTS}, () =>
        new Array<number>(xCoords.length).fill(0),
      );
      for (let xi = 0; xi < xCoords.length; ++xi) {
        const meta = effectiveSmoothedMetadata[xi];
        if (meta) {
          const colZ = this.evaluateCurveAt(meta, yCoords);
          for (let yi = 0; yi < NUM_Y_POINTS; ++yi) {
            zSmoothedSurface[yi][xi] = colZ[yi];
          }
        } else {
          for (let yi = 0; yi < NUM_Y_POINTS; ++yi) {
            zSmoothedSurface[yi][xi] = this.showGainCurve ? 0 : yCoords[yi];
          }
        }
      }
    }

    this.cachedSurface = {
      x: xCoords,
      y: yCoords,
      z: zSurface,
      zSmoothed: zSmoothedSurface,
      maxY,
    };
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

    const existingTraces = (this.container as any).data as any[] | undefined;
    if (existingTraces) {
      for (const trace of existingTraces) {
        if (trace?.uid) {
          this.traceVisibility.set(trace.uid, trace.visible ?? true);
        }
      }
    }

    const hoverLabel = this.showGainCurve ? 'Gain' : 'Output';
    const baseName = this.showGainCurve
      ? 'Gain Curve (log2)'
      : 'Tone Map Curve';
    const hasSmoothed = surface.zSmoothed !== null;

    const data: Data[] = [
      {
        uid: 'curve_surface',
        visible: this.traceVisibility.get('curve_surface') ?? true,
        x: surface.x,
        y: surface.y,
        z: surface.z,
        type: 'surface',
        name: hasSmoothed ? `Unsmoothed ${baseName}` : baseName,
        showlegend: true,
        colorscale: 'Viridis',
        opacity: hasSmoothed ? 0.55 : 0.9,
        showscale: !hasSmoothed,
        'contours': {
          'x': {'highlight': false},
          'y': {'highlight': false},
          'z': {'highlight': false},
        },
        colorbar: {
          title: plotlyTitle(this.showGainCurve ? 'Gain (log2)' : 'Output'),
          thickness: 15,
          len: 0.75,
        },
        hovertemplate:
          'time: %{x:07.3f}<br>Input: %{y:.3f}<br>' +
          hoverLabel +
          ': %{z:.3f}<extra>' +
          (hasSmoothed ? 'Unsmoothed' : '') +
          '</extra>',
      } as any,
    ];

    if (surface.zSmoothed) {
      data.push({
        uid: 'smoothed_surface',
        visible: this.traceVisibility.get('smoothed_surface') ?? true,
        x: surface.x,
        y: surface.y,
        z: surface.zSmoothed,
        type: 'surface',
        name: `Smoothed ${baseName}`,
        showlegend: true,
        colorscale: 'Plasma',
        opacity: 0.85,
        showscale: true,
        'contours': {
          'x': {'highlight': false},
          'y': {'highlight': false},
          'z': {'highlight': false},
        },
        colorbar: {
          title: plotlyTitle(this.showGainCurve ? 'Gain (log2)' : 'Output'),
          thickness: 15,
          len: 0.75,
        },
        hovertemplate:
          'time: %{x:07.3f}<br>Input: %{y:.3f}<br>' +
          hoverLabel +
          ': %{z:.3f}<extra>Smoothed</extra>',
      } as any);
    }

    // Add hover/pinned slice curves along Input and Time/Output axes.
    const activeIndices = this.pinnedIndices ?? this.hoverIndices;
    const hasYSlice =
      activeIndices !== null &&
      activeIndices.xi < surface.x.length &&
      activeIndices.yi < surface.y.length;
    const hxi = hasYSlice
      ? activeIndices!.xi
      : Math.min(this.getFrameIndexForCurrentTime(), surface.x.length - 1);
    const hyi = hasYSlice ? activeIndices!.yi : 0;
    const hx = surface.x[hxi] ?? 0;
    const hy = surface.y[hyi] ?? 0;
    const xConst = surface.y.map(() => hx);
    const yConst = surface.x.map(() => hy);
    const sliceAlongInput = surface.y.map((_, r) => surface.z[r][hxi]);
    const sliceAlongTime = surface.z[hyi];

    const firstHoverTraceIdx = data.length;
    data.push(
      {
        uid: 'hover_slice_input',
        visible: true,
        x: xConst,
        y: surface.y,
        z: sliceAlongInput,
        type: 'scatter3d',
        mode: 'lines',
        line: {color: '#00ff00', width: 5},
        hoverinfo: 'none',
        showlegend: false,
      } as any,
      {
        uid: 'hover_slice_output',
        visible: hasYSlice,
        x: surface.x,
        y: yConst,
        z: sliceAlongTime,
        type: 'scatter3d',
        mode: 'lines',
        line: {color: '#00ff00', width: 5},
        hoverinfo: 'none',
        showlegend: false,
      } as any,
    );

    this.hoverTraceIndices = [firstHoverTraceIdx, firstHoverTraceIdx + 1];
    if (hasSmoothed) {
      const smoothedAlongInput = surface.y.map(
        (_, r) => surface.zSmoothed![r][hxi],
      );
      const smoothedAlongTime = surface.zSmoothed![hyi];
      data.push(
        {
          uid: 'hover_smoothed_input',
          visible: true,
          x: xConst,
          y: surface.y,
          z: smoothedAlongInput,
          type: 'scatter3d',
          mode: 'lines',
          line: {color: '#ff2222', width: 5},
          hoverinfo: 'none',
          showlegend: false,
        } as any,
        {
          uid: 'hover_smoothed_output',
          visible: hasYSlice,
          x: surface.x,
          y: yConst,
          z: smoothedAlongTime,
          type: 'scatter3d',
          mode: 'lines',
          line: {color: '#ff2222', width: 5},
          hoverinfo: 'none',
          showlegend: false,
        } as any,
      );
      this.hoverTraceIndices.push(
        firstHoverTraceIdx + 2,
        firstHoverTraceIdx + 3,
      );
    }

    plotly.react(this.container, data, this.layout, {responsive: true});

    // Attach click and hover listeners once.
    if (!this.isClickInitialized) {
      this.isClickInitialized = true;
      (this.container as any).on('plotly_click', this.onPlotlyClick);
      (this.container as any).on('plotly_hover', this.onPlotlyHover);
      (this.container as any).on('plotly_unhover', this.onPlotlyUnhover);
    }
  }
}
