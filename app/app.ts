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

import {objectUrlFromSafeSource} from 'safevalues/dom';

import {getAgtm, getStatsForAgtm, needsStats,} from './agtm_generator';
import {AgtmMetadataType, kAgtmMetadataTypeNames, kDefaultAgtmMetadataType,} from './agtm_metadata_types';
import {makeAgtmPayload, muxAgtmMetadata} from './agtm_muxer';
import {kDefaultMetadata} from './builtin_agtm';
import {DEFAULT_FILE, TEST_FILES} from './test_files';

import {AgtmMetadata, ComponentMix} from './color_helpers/agtm';
import {LutInputColorSpaceMode, LutOptions, LutType, SamplingType,} from './color_helpers/agtm_adapt';
import {getChromaticities, kPrimariesRec2020, kPrimariesSRGB, kTransferPQ, kTransferSrgb,} from './color_helpers/color_functions';
import {Hdr10pMetadata} from './color_helpers/hdr10p';
import {exp2} from './color_helpers/math_helpers';
import {basenameWithoutExtension, download, downloadApng, downloadBlob,} from './download';
import {ScreenDetailed} from './global_interfaces';
import {averageStats, ComputedStats, ImageStats} from './image_stats';
import {jsonToMetadata, metadataListToJson, metadataToJson} from './json';
import {createImageBitmapSource, DecodedMedia, decodeMediaWithCallback, getMediaInfoString} from './load_media';
import {findTrackSampleIndexForTime, getAverageFramerate, getFirstVideoTrack} from './media_parser';
import {AgtmRenderer} from './panels/agtm_renderer';
import {Base2dRenderer, BaseWebgl2Renderer} from './panels/base_renderer';
import {CanvasSdrRenderer} from './panels/canvas_sdr_renderer';
import {CurveEditor} from './panels/curve_editor';
import {Hdr10pRenderer} from './panels/hdr10p_renderer';
import {HdrRenderer} from './panels/hdr_renderer';
import {LumaMode, LumaRenderer} from './panels/luma_renderer';
import {Renderer} from './panels/renderer';
import {StatsViewer} from './panels/stats_viewer';

function getSelectElement(id: string): HTMLSelectElement {
  return document.getElementById(id) as HTMLSelectElement;
}
function getInputElement(id: string): HTMLInputElement {
  return document.getElementById(id) as HTMLInputElement;
}
function getButtonElement(id: string): HTMLButtonElement {
  return document.getElementById(id) as HTMLButtonElement;
}
function getCanvasElement(id: string): HTMLCanvasElement {
  return document.getElementById(id) as HTMLCanvasElement;
}
function getHTMLElement(id: string): HTMLElement {
  return document.getElementById(id) as HTMLElement;
}
function getHTMLImageElement(id: string): HTMLImageElement {
  return document.getElementById(id) as HTMLImageElement;
}
function getHTMLVideoElement(id: string): HTMLVideoElement {
  return document.getElementById(id) as HTMLVideoElement;
}

interface PanelInfo<T extends Renderer> {
  // For panel 'foo', the DOM should contain 'FooPanel' and 'ToggleFoo' elements
  name: string;
  defaultChecked: boolean;
  // Factory function that creates and initializes a renderer. It should init
  // all the state needed by the renderer, except the image data.
  rendererFactory?: () => T;
  renderer?: T;
}

function createCanvas(
  id: string,
  addZoomPan = true,
  styles?: Partial<CSSStyleDeclaration>,
): HTMLCanvasElement {
  const container = getHTMLElement(id + 'Container');
  container.textContent = '';
  const canvas = document.createElement('canvas');
  canvas.id = id;
  if (styles) {
    Object.assign(canvas.style, styles);
  }
  container.appendChild(canvas);
  if (addZoomPan) {
    addZoomPanListeners(canvas, true, handleCanvasClick);
  }
  return canvas;
}

function getLutOptions(): LutOptions {
  const lutType = agtmLutTypeSelectEl.value as LutType;
  const samplingType = agtmSamplingTypeSelectEl.value as SamplingType;
  const inputColorSpaceMode =
    agtmLutInputColorSpaceSelectEl.value as LutInputColorSpaceMode;
  const lut3dSize = lutType === '1donly' ? 0 : Number(agtmLutSizeInputEl.value);
  const lut1dSize =
    lutType === '3donly' || lutType === '3dgamma'
      ? 0
      : Number(agtm1dLutSizeInputEl.value);
  return {
    lut1dSize,
    lut3dSize,
    lutType,
    samplingType,
    inputColorSpaceMode,
  };
}

const statsModesEl = getHTMLElement('StatsModes');
const logNitsEl = getInputElement('StatsLogNits');
const logPercentEl = getInputElement('StatsLogPercent');

let contentTransfer: number = kTransferPQ;
let contentPrimaries: number = kPrimariesRec2020;

interface Zoomable {
  setZoomPan(zoom: number, panX: number, panY: number): void;
}
function setRendererZoomPan(renderer: Zoomable) {
  renderer.setZoomPan(currentZoom, currentPanX, currentPanY);
}

function setRendererHeadroom(renderer: Renderer) {
  const headroomLog2 = Number(headroomSliderEl.value);
  const headroomLinear = Math.pow(2, headroomLog2);
  const nits = getDisplayMaxNits();
  const simulatedHeadroomLinear =
    1 + Math.max(0, headroomLinear - nativeHeadroomLinear);
  const simulatedHeadroomLog2 = Math.log2(simulatedHeadroomLinear);
  renderer.setHeadroomLog2(headroomLog2, nits);
  if (renderer.setSimulatedHeadroomLog2) {
    renderer.setSimulatedHeadroomLog2(simulatedHeadroomLog2);
  }
}

const rendererPanelInfos: Array<PanelInfo<Renderer>> = [
  {name: 'native', defaultChecked: false},
  {
    name: 'sdr',
    defaultChecked: false,
    rendererFactory: () => {
      const renderer = new CanvasSdrRenderer(createCanvas('SdrPreview'));
      setRendererZoomPan(renderer);
      return renderer;
    },
  },
  {
    name: 'agtm',
    defaultChecked: true,
    rendererFactory: () => {
      const renderer = new AgtmRenderer(createCanvas('AgtmPreview'));
      setRendererZoomPan(renderer);
      setRendererHeadroom(renderer);
      renderer.setMetadata(agtmMetadata);
      renderer.setShowClamped(showClampedToggle.checked);
      return renderer;
    },
  },
  {
    name: 'agtm_lut',
    defaultChecked: false,
    rendererFactory: () => {
      const renderer = new AgtmRenderer(createCanvas('AgtmLutPreview'));
      setRendererZoomPan(renderer);
      renderer.setMetadata(agtmMetadata);
      setRendererHeadroom(renderer);
      renderer.setShowClamped(showClampedToggle.checked);
      renderer.setLutOptions(getLutOptions());
      return renderer;
    },
  },
  {
    name: 'hdr10plus',
    defaultChecked: false,
    rendererFactory: () => {
      const renderer = new Hdr10pRenderer(
        createCanvas('Hdr10PlusPreview'),
        /* displayCurves= */ false,
      );
      setRendererZoomPan(renderer);
      renderer.setMetadata(hdr10pMetadata);
      setRendererHeadroom(renderer);
      renderer.setShowClamped(showClampedToggle.checked);
      return renderer;
    },
  },
  {
    name: 'hdr',
    defaultChecked: false,
    rendererFactory: () => {
      const renderer = new HdrRenderer(
        createCanvas('HdrPreview'),
        /* displayCurves= */ false,
      );
      setRendererZoomPan(renderer);
      setRendererHeadroom(renderer);
      renderer.setShowClamped(showClampedToggle.checked);
      return renderer;
    },
  },
  {
    name: 'luma',
    defaultChecked: false,
    rendererFactory: () => {
      const renderer = new LumaRenderer(createCanvas('LumaPreview'));
      setRendererZoomPan(renderer);
      renderer.setMetadata(agtmMetadata);
      renderer.setMode(lumaModeSelectEl.value as LumaMode);
      return renderer;
    },
  },
];

const fullSizeCanvasStyles: Partial<CSSStyleDeclaration> = {
  maxWidth: '100%',
  maxHeight: '100%',
};
const reducedSizeCanvasStyles: Partial<CSSStyleDeclaration> = {
  maxWidth: '90%',  // Leave some space for scrolling
  maxHeight: '60vh',  // Make sure the canvas is fully visible
};

const miscPanelInfos: Array<PanelInfo<Renderer>> = [
  {
    name: 'curves',
    defaultChecked: true,
    rendererFactory: () => {
      const renderer = new CurveEditor(
        createCanvas('CurveEditorCanvas', false, reducedSizeCanvasStyles),
        getHTMLElement('CurveEditorPixelInfo'),
      );
      renderer.modelChangedCallback = (editorMetadata) => {
        agtmMetadata = editorMetadata;
        curvePointsOverridden = true;
        onMetadataChanged();
        renderVisiblePanels();
      };
      renderer.setMetadata(agtmMetadata);
      renderer.setAltrIndex(Number(altrIndexEl.value));
      renderer.setShowGainCurve(showGainCurveEl.checked);
      renderer.setShowControlPoints(showControlPointsEl.checked);
      setRendererHeadroom(renderer);
      return renderer;
    },
  },
  {
    name: 'hdr10pcurves',
    defaultChecked: false,
    rendererFactory: () => {
      const renderer = new Hdr10pRenderer(
        createCanvas('Hdr10PlusCurvesPreview', false, fullSizeCanvasStyles),
        /* displayCurves= */ true,
      );
      renderer.setMetadata(hdr10pMetadata);
      setRendererHeadroom(renderer);
      renderer.setShowClamped(showClampedToggle.checked);
      return renderer;
    },
  },
  {
    name: 'hdrcurves',
    defaultChecked: false,
    rendererFactory: () => {
      const renderer = new HdrRenderer(
        createCanvas('HdrCurvesPreview', false, fullSizeCanvasStyles),
        /* displayCurves= */ true,
      );
      setRendererHeadroom(renderer);
      renderer.setShowClamped(showClampedToggle.checked);
      return renderer;
    },
  },
  {
    name: 'stats',
    defaultChecked: false,
    rendererFactory: () => {
      const renderer = new StatsViewer(
        createCanvas('StatsCanvas', false, reducedSizeCanvasStyles),
        getHTMLElement('StatsTextContainer'),
        getHTMLElement('SelectedPixelInfoContainer'),
        statsModesEl,
        logNitsEl,
        logPercentEl,
      );
      renderer.setStats(computedStats);
      return renderer;
    },
  },
  {name: 'smpte209440', defaultChecked: false},
  {name: 'json', defaultChecked: false},
];

interface Panel<T extends Renderer> {
  toggle: HTMLInputElement;
  panelEl: HTMLElement;
  hashName: string;
  defaultChecked: boolean;
  renderer: T | null;
  rendererFactory?: () => T;
}

// DOM Elements
const altrIndexEl = getSelectElement('AltrIndex');
const contentSelectEl = getSelectElement('Content');
const gainApplicationSpacePrimariesSelectEl = getSelectElement(
  'GainApplicationSpacePrimariesSelect',
);
const hdrReferenceWhiteSliderEl = getInputElement('HdrReferenceWhiteSlider');
const hdrReferenceWhiteValueEl = getHTMLElement('HdrReferenceWhiteValue');
const resetHdrReferenceWhiteButtonEl = getButtonElement(
  'ResetHdrReferenceWhiteButton',
);
const baselineHeadroomSliderEl = getInputElement(
  'BaselineHeadroomLinearSlider',
);
const baselineHeadroomLinearValueEl = getHTMLElement(
  'BaselineHeadroomLinearValue',
);
const resetBaselineHeadroomLinearButtonEl = getButtonElement(
  'ResetBaselineHeadroomLinearButton',
);
const resetGainApplicationSpacePrimariesButtonEl = getButtonElement(
  'ResetGainApplicationSpacePrimariesButton',
);
const resetAllButtonEl = getButtonElement('ResetAllButton');
const showGainCurveEl = getInputElement('ShowGainCurve');
const showControlPointsEl = getInputElement('ShowControlPoints');
const metadataSelectEl = getSelectElement('Metadata');
const agtmLutSizeInputEl = getInputElement('AgtmLutSize');
const agtm1dLutSizeInputEl = getInputElement('Agtm1dLutSize');
const agtmLutTypeSelectEl = getSelectElement('AgtmLutType');
const agtmSamplingTypeSelectEl = getSelectElement('AgtmSamplingType');
const agtmLutInputColorSpaceSelectEl = getSelectElement(
  'AgtmLutInputColorSpace',
);
const myImageEl = getHTMLImageElement('MyImage');
const lumaModeSelectEl = getSelectElement('LumaMode');
const myVideoEl = getHTMLVideoElement('MyVideo');
const flipButton = getInputElement('FlipButton');
const sdrBloatToggle = getInputElement('ToggleSdrBloat');
const sdrBloatEls = Array.from(
  document.getElementsByClassName('sdr-bloat'),
) as HTMLElement[];
const sdrBloatImgEls = Array.from(
  document.querySelectorAll('.sdr-bloat img'),
) as HTMLElement[];
const sdrBloatParentEls = Array.from(
  document.getElementsByClassName('sdr-bloat-parent'),
) as HTMLElement[];
const playPauseEl = getButtonElement('PlayPause');
const loopButtonEl = getButtonElement('LoopButton');
const nativeHeadroomSliderEl = getHTMLElement('NativeHeadroomArrow');
const nativeHeadroomLinearEl = getHTMLElement('NativeHeadroomLinear');
const nativeHeadroomLog2El = getHTMLElement('NativeHeadroomLog2');
const nativeNitsEl = getInputElement('NativeNits');
const nativeNitsPresetsEl = getSelectElement('NativeNitsPresets');
const nativeNitsSuffixEl = getHTMLElement('NativeNitsSuffix');
const headroomNitsEl = getHTMLElement('HeadroomNits');
const signalPrimariesEl = getSelectElement('SignalPrimaries');
const signalTransferEl = getSelectElement('SignalTransfer');
const headroomSliderEl = getInputElement('HeadroomSlider');
const headroomLinearEl = getHTMLElement('HeadroomLinear');
const headroomLog2El = getHTMLElement('HeadroomLog2');
const headroomStatusEl = getHTMLElement('HeadroomStatus');
const setHeadroomToNativeButton = getButtonElement('SetHeadroomToNativeButton');
const timeSliderEl = getInputElement('TimeSlider');
const timeSliderTableEl = getHTMLElement('TimeSliderTable');
const timeSliderValueEl = getInputElement('TimeSliderValue');
const uploadButtonEl = getInputElement('UploadButton');
const uploadButtonFakeEl = getButtonElement('UploadButtonFake');
const warningsEl = getHTMLElement('Warnings');
const settingsEl = getHTMLElement('Settings');
const showClampedToggle = getInputElement('ShowClamped');
const componentMixSelectEl = getSelectElement('ComponentMix');
const panelDisplayModeEl = getSelectElement('PanelDisplayMode');
const hideUiButton = getButtonElement('HideUi');
const saveStaticAgtmButtonEl = getButtonElement('SaveStaticAgtmButton');
const saveDynamicAgtmButtonEl = getButtonElement('SaveDynamicAgtmButton');
const cancelDynamicAgtmButtonEl = getButtonElement('CancelDynamicAgtmButton');
const saveAgtmDropdownButtonEl = getButtonElement('SaveAgtmDropdownButton');
const saveAllJsonButtonEl = getButtonElement('SaveAllJsonButton');
const saveJsonDropdownButtonEl = getButtonElement('SaveJsonDropdownButton');
const saveCurrentBinaryAgtmButtonEl = getButtonElement(
  'SaveCurrentBinaryAgtmButton',
);
const cancelDynamicJsonButtonEl = getButtonElement('CancelDynamicJsonButton');
const dynamicAgtmEl = getSelectElement('DynamicAgtm');
const dynamicAgtmProgressEl = getHTMLElement('DynamicAgtmProgress');
const pauseResumeDynamicAgtmButtonEl = getButtonElement(
  'PauseResumeDynamicAgtmButton',
);
const onlyNativeWarnings = Array.from(
  document.getElementsByClassName('warning-native'),
) as HTMLElement[];

const simWarnings = Array.from(
  document.getElementsByClassName('warning-sim'),
) as HTMLElement[];

const permissionDialogEl = document.getElementById('PermissionDialog') as HTMLDialogElement;
const permissionButtonEl = getButtonElement('PermissionButton');
const permissionStep2El = getHTMLElement('PermissionStep2');
const closePermissionDialogEl = getButtonElement('ClosePermissionDialog');

const browseContentButtonEl = getButtonElement('BrowseContentButton');
const showMediaInfoButtonEl = getButtonElement('ShowMediaInfoButton');
const contentBrowserEl = getHTMLElement('ContentBrowser');
const closeContentBrowserEl = getButtonElement('CloseContentBrowser');
const contentGridEl = getHTMLElement('ContentGrid');
const jsonUploadEl = getInputElement('JsonUpload');
const mediaInfoDialogEl = document.getElementById('MediaInfoDialog') as HTMLDialogElement;
const closeMediaInfoDialogEl = getButtonElement('CloseMediaInfoDialog');

function snakeToPascal(s: string): string {
  return s
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

function createPanel<T extends Renderer>(info: PanelInfo<T>): Panel<T> {
  const pascalName = snakeToPascal(info.name);
  return {
    toggle: getInputElement(`Toggle${pascalName}`),
    panelEl: getHTMLElement(`${pascalName}Panel`),
    hashName: info.name,
    defaultChecked: info.defaultChecked,
    rendererFactory: info.rendererFactory,
    renderer: null,
  };
}

const rendererPanels: Array<Panel<Renderer>> =
  rendererPanelInfos.map(createPanel);
const miscPanels: Array<Panel<Renderer>> = miscPanelInfos.map(createPanel);
const allPanels: Array<Panel<Renderer>> = [...rendererPanels, ...miscPanels];

function getRenderer<T extends Renderer>(
  hashName: string,
  rendererTypeConstructor: new (...args: never[]) => T,
): T | null {
  const panel = allPanels.find((panel) => panel.hashName === hashName);
  if (!panel) {
    throw new Error(`Panel with hash name ${hashName} not found`);
  }
  if (!panel.renderer) {
    return null;
  }
  if (!(panel.renderer instanceof rendererTypeConstructor)) {
    throw new Error(
      `Panel with hash name ${hashName} is not of type ${rendererTypeConstructor.name}`,
    );
  }
  return panel.renderer;
}

function getPanelEl(hashName: string): HTMLElement {
  const panel = allPanels.find((panel) => panel.hashName === hashName);
  if (!panel) {
    throw new Error(`Panel with hash name ${hashName} not found`);
  }
  return panel.panelEl;
}

let flipModeVisiblePanel: HTMLInputElement | null = null;

let currentZoom = 1.0;
let currentPanX = 0.0;
let currentPanY = 0.0;

function setFlipPanel(panel: HTMLInputElement | null) {
  flipModeVisiblePanel = panel;
}

function setZoomPan(zoom: number, panX: number, panY: number) {
  currentZoom = Math.max(1.0, zoom);
  currentPanX = panX;
  currentPanY = panY;

  if (currentZoom === 1.0) {
    currentPanX = 0;
    currentPanY = 0;
  } else {
    // Limit pan to keep image in view
    const limit = 0.5 - 0.5 / currentZoom;
    currentPanX = Math.max(-limit, Math.min(limit, currentPanX));
    currentPanY = Math.max(-limit, Math.min(limit, currentPanY));
  }

  for (const panel of rendererPanels) {
    if (
      panel.renderer instanceof BaseWebgl2Renderer ||
      panel.renderer instanceof Base2dRenderer
    ) {
      setRendererZoomPan(panel.renderer);
    }
  }
  // There is a very small shift compared to the canvases, not sure why,
  // but it's good enough.
  const transformOrigin = '50% 50%';
  const translateX = -currentPanX * 100;
  const translateY = -currentPanY * 100;
  const transform = `scale(${currentZoom}) translate(${translateX}%, ${translateY}%)`;
  myImageEl.style.transformOrigin = transformOrigin;
  myImageEl.style.transform = transform;
  myVideoEl.style.transformOrigin = transformOrigin;
  myVideoEl.style.transform = transform;
}
// Same order as in the UI.
const rendererPanelToggles = rendererPanels.map((p) => p.toggle);
const panelToggleToHashName = new Map<HTMLInputElement, string>(
  rendererPanels.map((p) => [p.toggle, p.hashName]),
);
const hashNameToPanelToggle = new Map<string, HTMLInputElement>(
  rendererPanels.map((p) => [p.hashName, p.toggle]),
);

// Hardware stats
let nativeHeadroomLinear = 1;

let keepHeadroomSetToNativeHeadroom = true;
let isApplyingStateFromHash = false;

// SMPTE 2094-50 metadata
let agtmMetadataType: AgtmMetadataType | 'fromfile' | 'custom' =
  kDefaultAgtmMetadataType;
let agtmMetadata: AgtmMetadata = kDefaultMetadata;
let originalAgtmMetadata: AgtmMetadata = kDefaultMetadata;
let hdrReferenceWhiteOverridden = false;
let baselineHeadroomLinearOverridden = false;
let gainApplicationSpacePrimariesOverridden = false;
let customGainApplicationSpaceChromaticitiesHash: number[] | null = null;
let curvePointsOverridden = false;
let selectedPixelCoords: {x: number; y: number} | null = null;
let customAgtmMetadata: AgtmMetadata | null = null;
let customAgtmMetadataArray: Array<AgtmMetadata | null> | null = null;
// Per-frame dynamic AGTM metadata and computed stats.
let dynamicAgtmMetadata: Array<AgtmMetadata | null> | null = null;
let dynamicAgtmComputedStats: Array<ComputedStats | null> | null = null;

// SMPTE 2094-40 metadata
let hdr10pMetadata: Hdr10pMetadata | null = null;

let mediaBlob: Blob | null = null;
let mediaFilename: string | null = null;
let decodedMedia: DecodedMedia | null = null;
let imageBitmapStats: ImageStats | null = null;
let computedStats: ComputedStats | null = null;

// AbortControllers for in-flight fetches
let currentMediaFetchController: AbortController | null = null;

let dynamicExportController: AbortController | null = null;
let activeDynamicExportsCount = 0;
let exportProgressVideoEl: HTMLVideoElement | null = null;
let dynamicAgtmController: AbortController | null = null;
let dynamicAgtmComputationPromise: Promise<void> | null = null;
let dynamicAgtmPauseResolver: (() => void) | null = null;
let isDynamicAgtmPaused = false;
let dynamicAgtmRestartQueued = false;
// https://stackoverflow.com/questions/5916900/how-can-you-detect-the-version-of-a-browser
function browserVersion(): [string, number] {
  const ua = navigator.userAgent;
  let tem;
  const M =
    ua.match(/(opera|chrome|safari|firefox|msie|trident(?=\/))\/?\s*(\d+)/i) ||
    [];

  // IE
  if (/trident/i.test(M[1])) {
    tem = /\brv[ :]+(\d+)/g.exec(ua) || [];
    return ['IE', Number(tem[1] || 0)];
  }

  // Opera/Edge (based on Chrome)
  if (M[1] === 'Chrome') {
    tem = ua.match(/\b(OPR|Edge)\/(\d+)/);
    if (tem != null) {
      return [tem[1].replace('OPR', 'Opera'), Number(tem[2])];
    }
  }

  // Default case: M[1] is browser name, M[2] is version string
  let browserName = M[1];
  let versionStr = M[2];

  // Handle Safari's "Version/" pattern, as the main regex might miss the version.
  if (browserName === 'Safari') {
    tem = ua.match(/version\/(\d+)/i);
    if (tem != null) {
      versionStr = tem[1];
    }
  } else if (!versionStr) {
    // Fallback for cases where the first regex didn't capture a version number.
    // tslint:disable-next-line:deprecation
    browserName = navigator.appName;
    // tslint:disable-next-line:deprecation
    versionStr = navigator.appVersion.match(/(\d+)/)?.[1] || '0';
  }

  return [browserName || 'Unknown', Number(versionStr || 0)];
}

function setStats(stats: ComputedStats | null) {
  computedStats = stats;
  getRenderer('stats', StatsViewer)?.setStats(stats);
}

function updateSelectedPixel(
  x: number | null,
  y: number | null,
  rgbNits: [number, number, number] | null,
) {
  const coords = x !== null && y !== null ? {x, y} : null;
  for (const panel of allPanels) {
    if (panel.panelEl.hidden || !panel.renderer) {
      continue;
    }
    if (panel.renderer instanceof CurveEditor) {
      panel.renderer.setSelectedPixel(rgbNits);
    } else if (panel.renderer instanceof StatsViewer) {
      panel.renderer.setSelectedPixel(coords, rgbNits);
    }
  }
}

function updateStats() {
  if (decodedMedia == null) {
    imageBitmapStats = null;
    computedStats = null;
    getRenderer('stats', StatsViewer)?.setStats(null);
    return;
  }
  let stats: ComputedStats | null = computedStats;
  if (imageBitmapStats === null) {
    stats = null;
    imageBitmapStats = new ImageStats(
      decodedMedia.imageBitmap,
      contentTransfer,
    );
  }
  if (stats === null) {
    stats = getStatsForAgtm(
      agtmMetadataType,
      imageBitmapStats,
      contentTransfer,
    );
  }
  if (selectedPixelCoords) {
    const rgbNits = imageBitmapStats.getPixelValueNits(
      selectedPixelCoords.x,
      selectedPixelCoords.y,
      contentTransfer,
    );
    if (rgbNits) {
      updateSelectedPixel(
        selectedPixelCoords.x,
        selectedPixelCoords.y,
        rgbNits,
      );
    }
  } else {
    updateSelectedPixel(null, null, null);
  }

  setStats(stats);
}

function agtmNeedsStats(type: AgtmMetadataType | 'fromfile' | 'custom') {
  return type !== 'fromfile' && type !== 'custom' && needsStats(type);
}

async function computeFrameStats(
  frame: HTMLVideoElement | HTMLImageElement,
  fullRange = false,
): Promise<ComputedStats | null> {
  try {
    const bitmap = await createImageBitmapSource(frame);
    const stats = new ImageStats(bitmap, contentTransfer);
    const computed = getStatsForAgtm(
      agtmMetadataType,
      stats,
      contentTransfer,
      fullRange,
    );
    bitmap.close();
    return computed;
  } catch (e) {
    console.error('Failed to get stats for current frame', e);
    return null;
  }
}

async function getStatsForCurrentFrame(): Promise<ComputedStats | null> {
  if (myVideoEl.readyState < 1) return null;
  return computeFrameStats(myVideoEl);
}

async function recomputeAgtmForCurrentFrame() {
  const currentFrameStats = await getStatsForCurrentFrame();
  if (currentFrameStats) {
    setStats(currentFrameStats);
    await setAgtmMetadata();
    renderVisiblePanels();
  }
}

async function getAgtmForType(
  type: AgtmMetadataType | 'fromfile' | 'custom',
  stats: ComputedStats | null,
  hdrReferenceWhite?: number,
  baselineHeadroomLinear?: number,
): Promise<AgtmMetadata | null> {
  let metadata: AgtmMetadata;
  if (type === 'fromfile') {
    metadata = structuredClone(
      decodedMedia?.metadata?.agtmMetadata ?? kDefaultMetadata,
    );
    if (hdrReferenceWhite !== undefined) {
      metadata.hdr_reference_white = hdrReferenceWhite;
    }
    if (baselineHeadroomLinear !== undefined) {
      metadata.baseline_hdr_headroom =
        baselineHeadroomLinear > 0 ? Math.log2(baselineHeadroomLinear) : 0;
    }
  } else if (type === 'custom') {
    if (customAgtmMetadataArray) {
      let bestMeta: AgtmMetadata | null = null;
      if (decodedMedia?.type === 'video' && decodedMedia.parsedMedia) {
        const videoTrack = getFirstVideoTrack(decodedMedia.parsedMedia.tracks);
        let frameIdx = 0;
        if (videoTrack) {
          frameIdx =
            findTrackSampleIndexForTime(videoTrack, myVideoEl.currentTime) ?? 0;
        }
        frameIdx = Math.min(frameIdx, customAgtmMetadataArray.length - 1);
        // Search backwards from the current frame index. A null entry means
        // to use the metadata from the most recent non-null entry.
        for (let i = frameIdx; i >= 0; --i) {
          if (customAgtmMetadataArray[i]) {
            bestMeta = customAgtmMetadataArray[i];
            break;
          }
        }
      }
      if (bestMeta === null) {
        // For images, or if not video etc., take first non-null.
        bestMeta = customAgtmMetadataArray.find((m) => m !== null) ?? null;
      }
      metadata = structuredClone(bestMeta ?? kDefaultMetadata);
    } else {
      metadata = structuredClone(customAgtmMetadata ?? kDefaultMetadata);
    }

    if (hdrReferenceWhite !== undefined) {
      metadata.hdr_reference_white = hdrReferenceWhite;
    }
    if (baselineHeadroomLinear !== undefined) {
      metadata.baseline_hdr_headroom =
        baselineHeadroomLinear > 0 ? Math.log2(baselineHeadroomLinear) : 0;
    }
  } else {
    if (needsStats(type) && stats === null) {
      return null; // Image pixels not available yet.
    }
    metadata = await getAgtm(
      type,
      contentTransfer,
      stats ?? undefined,
      hdrReferenceWhite,
      baselineHeadroomLinear,
    );
  }
  return metadata;
}

/**
 * Adapts the AGTM metadata if the image is set and the toggle is enabled. This
 * will also update the imageBitmapStats and computedStats if they are not
 * already set.
 * @param hdrReferenceWhite Override for the HDR reference white.
 */
async function setAgtmMetadata(
  hdrReferenceWhite?: number,
  baselineHeadroomLinear?: number,
) {
  if (hdrReferenceWhiteOverridden && hdrReferenceWhite === undefined) {
    hdrReferenceWhite = Number(hdrReferenceWhiteSliderEl.value);
  }
  if (
    baselineHeadroomLinearOverridden &&
    baselineHeadroomLinear === undefined
  ) {
    baselineHeadroomLinear = Number(baselineHeadroomSliderEl.value);
  }

  // If dynamic metadata is enabled and is already computed, use that.
  if (
    dynamicAgtmEl.value === 'all' &&
    dynamicAgtmMetadata &&
    decodedMedia?.type === 'video'
  ) {
    let bestMeta: AgtmMetadata | null = null;
    let bestStats: ComputedStats | null = null;
    if (decodedMedia?.parsedMedia) {
      const videoTrack = getFirstVideoTrack(decodedMedia.parsedMedia.tracks);
      let frameIdx = 0;
      if (videoTrack) {
        frameIdx =
          findTrackSampleIndexForTime(videoTrack, myVideoEl.currentTime) ?? 0;
      }
      frameIdx = Math.min(frameIdx, dynamicAgtmMetadata.length - 1);
      for (let i = frameIdx; i >= 0; --i) {
        if (dynamicAgtmMetadata[i]) {
          bestMeta = dynamicAgtmMetadata[i];
          if (dynamicAgtmComputedStats && dynamicAgtmComputedStats[i]) {
            bestStats = dynamicAgtmComputedStats[i];
          }
          break;
        }
      }
    }
    if (!bestMeta) {
      const idx = dynamicAgtmMetadata.findIndex((m) => m !== null);
      if (idx !== -1) {
        bestMeta = dynamicAgtmMetadata[idx];
        if (dynamicAgtmComputedStats && dynamicAgtmComputedStats[idx]) {
          bestStats = dynamicAgtmComputedStats[idx];
        }
      }
    }
    agtmMetadata = structuredClone(bestMeta ?? kDefaultMetadata);
    if (hdrReferenceWhite !== undefined) {
      agtmMetadata.hdr_reference_white = hdrReferenceWhite;
    }
    if (baselineHeadroomLinear !== undefined) {
      agtmMetadata.baseline_hdr_headroom =
        baselineHeadroomLinear > 0 ? Math.log2(baselineHeadroomLinear) : 0;
    }
    originalAgtmMetadata = structuredClone(agtmMetadata);
    if (bestStats) {
      setStats(bestStats);
    }
    if (gainApplicationSpacePrimariesOverridden) {
      applyGainApplicationSpacePrimaries(agtmMetadata);
    }
    setComponentMixFunction();

    onMetadataChanged();
    return;
  }

  const newAgtmMetadata = await getAgtmForType(
    agtmMetadataType,
    computedStats,
    hdrReferenceWhite,
    baselineHeadroomLinear,
  );
  if (!newAgtmMetadata) return;
  agtmMetadata = newAgtmMetadata;

  // Have the panel fetch the SDR image data which might be different from the
  // original SDR image.
  if (
    decodedMedia !== null &&
    agtmMetadataType.startsWith('gain_map_') &&
    agtmMetadata.base_image
  ) {
    console.log(
      'Resetting the base image after computation of AGTM from gain map',
    );
    getRenderer('agtm', AgtmRenderer)?.setImage(
      decodedMedia.imageBitmapSource,
      agtmMetadata.base_image,
      contentTransfer,
      contentPrimaries,
    );
    getRenderer('agtm_lut', AgtmRenderer)?.setImage(
      decodedMedia.imageBitmapSource,
      agtmMetadata.base_image,
      contentTransfer,
      contentPrimaries,
    );
    // Discard the base image from the AGTM metadata to free up memory before
    // the structuredClone below.
    agtmMetadata.base_image = undefined;
  }

  originalAgtmMetadata = structuredClone(agtmMetadata);

  if (gainApplicationSpacePrimariesOverridden) {
    applyGainApplicationSpacePrimaries(agtmMetadata);
  }
  setComponentMixFunction();

  onMetadataChanged();
}

function updateResetButtonsVisibility() {
  const canShowResets = computedStats || !agtmNeedsStats(agtmMetadataType);

  resetHdrReferenceWhiteButtonEl.hidden =
    !hdrReferenceWhiteOverridden || !canShowResets;
  resetBaselineHeadroomLinearButtonEl.hidden =
    !baselineHeadroomLinearOverridden || !canShowResets;
  resetGainApplicationSpacePrimariesButtonEl.hidden =
    !gainApplicationSpacePrimariesOverridden || !canShowResets;

  const anyOverridden =
    hdrReferenceWhiteOverridden ||
    baselineHeadroomLinearOverridden ||
    gainApplicationSpacePrimariesOverridden ||
    curvePointsOverridden;
  resetAllButtonEl.hidden = !anyOverridden;
}

function getComponentMix(type: string): ComponentMix | null {
  if (type === 'max') {
    return {max: 1, min: 0, channel: 0, rgb: [0, 0, 0]};
  } else if (type === 'luma') {
    return {
      max: 0,
      min: 0,
      channel: 0,
      rgb: [0.2627, 0.678, 0.0593], // Rec2020 luma.
    };
  } else if (type === 'channel') {
    return {max: 0, min: 0, channel: 1, rgb: [0, 0, 0]};
  } else if (type === 'max_channel_mix') {
    return {
      max: 0.5,
      min: 0,
      channel: 0.5,
      rgb: [0, 0, 0],
    };
  } else if (type === 'max_min_mix') {
    return {
      max: 0.5,
      min: 0.5,
      channel: 0,
      rgb: [0, 0, 0],
    };
  } else if (type === 'luma_max_mix') {
    return {
      max: 0.5,
      min: 0,
      channel: 0,
      rgb: [0.2627 * 0.5, 0.678 * 0.5, 0.0593 * 0.5],
    };
  } else if (type === 'luma_channel_mix') {
    return {
      max: 0,
      min: 0,
      channel: 0.5,
      rgb: [0.2627 * 0.5, 0.678 * 0.5, 0.0593 * 0.5],
    };
  } else if (type === 'avg_max') {
    return {
      max: 0.5,
      min: 0,
      channel: 0,
      rgb: [1/6, 1/6, 1/6],
    };
  }
  return null;
}

function setMix(agtmMetadata: AgtmMetadata, mix: ComponentMix) {
  for (let i = 0; i < agtmMetadata.altr.length; ++i) {
    const altr = agtmMetadata.altr[i];
    altr.mix = structuredClone(mix);
  }
}

function applyGainApplicationSpacePrimaries(metadata: AgtmMetadata) {
  const primariesInt = Number(gainApplicationSpacePrimariesSelectEl.value);
  if (primariesInt !== -1) {
    metadata.gain_application_space_primaries = primariesInt;
    metadata.gain_application_space_chromaticities = undefined;
  } else {
    // It's custom, let it fall back to whatever is in `metadata.gain_application_space_chromaticities`
    // or if undefined, set to something default so it parses.
    metadata.gain_application_space_primaries = undefined;
    metadata.gain_application_space_chromaticities =
      metadata.gain_application_space_chromaticities ??
      customGainApplicationSpaceChromaticitiesHash ??
      getChromaticities(kPrimariesRec2020);
  }
}


function applyOverrides(metadata: AgtmMetadata, originalMix: ComponentMix) {
  if (gainApplicationSpacePrimariesOverridden) {
    applyGainApplicationSpacePrimaries(metadata);
  }
  const mixType = componentMixSelectEl.value;
  if (mixType === 'default') {
    setMix(metadata, originalMix);
  } else {
    const mix = getComponentMix(mixType);
    if (mix) {
      setMix(metadata, mix);
    } else {
      console.error('Unknown component mix type:', mixType);
    }
  }
}

function setComponentMixFunction() {
  const originalMix =
    originalAgtmMetadata.altr.length > 0
      ? originalAgtmMetadata.altr[0].mix
      : kDefaultMetadata.altr[0].mix;
  applyOverrides(agtmMetadata, originalMix);
}

function onMetadataChanged() {
  hdrReferenceWhiteSliderEl.value = agtmMetadata.hdr_reference_white.toString();
  hdrReferenceWhiteValueEl.innerText =
    agtmMetadata.hdr_reference_white.toFixed(0);
  baselineHeadroomSliderEl.value = exp2(
    agtmMetadata.baseline_hdr_headroom,
  ).toString();
  baselineHeadroomLinearValueEl.innerText = exp2(
    agtmMetadata.baseline_hdr_headroom,
  ).toFixed(2);
  const primariesEnum = agtmMetadata.gain_application_space_primaries ?? -1;
  gainApplicationSpacePrimariesSelectEl.value = primariesEnum.toString();

  updateResetButtonsVisibility();

  getPanelEl('json').querySelector('textarea')!.value =
    metadataToJson(agtmMetadata);
  getRenderer('curves', CurveEditor)?.setMetadata(agtmMetadata);
  getRenderer('agtm', AgtmRenderer)?.setMetadata(agtmMetadata);
  getRenderer('agtm_lut', AgtmRenderer)?.setMetadata(agtmMetadata);
  getRenderer('luma', LumaRenderer)?.setMetadata(agtmMetadata);
}

function updateSaveAgtmButtons() {
  const isVideo = decodedMedia?.type === 'video';
  const isFromFile = agtmMetadataType === 'fromfile';

  let saveDisabled = false;
  let title = '';
  if (!isVideo) {
    saveDisabled = true;
    title = 'Video only';
  } else if (isFromFile) {
    saveDisabled = true;
    title = 'must choose a different metadata type';
  }
  saveStaticAgtmButtonEl.disabled = saveDisabled;
  saveStaticAgtmButtonEl.title = title;
  saveDynamicAgtmButtonEl.disabled = saveDisabled;
  saveDynamicAgtmButtonEl.title = title;

  const hasDynamicMetadata =
    dynamicAgtmMetadata !== null ||
    customAgtmMetadataArray !== null ||
    hasEmbeddedAgtmMetadata();
  const canComputeDynamicMetadata = isVideo && !isFromFile;
  saveAllJsonButtonEl.disabled =
    !hasDynamicMetadata && !canComputeDynamicMetadata;
  saveAllJsonButtonEl.title =
    hasDynamicMetadata || canComputeDynamicMetadata
      ? ''
      : 'No per-frame metadata available';
}

function getEmbeddedAgtmMetadataList(): Array<AgtmMetadata | null> | null {
  if (!decodedMedia?.parsedMedia) return null;
  const videoTrack = getFirstVideoTrack(decodedMedia.parsedMedia.tracks);
  if (!videoTrack) return null;
  const trackMetadata =
    decodedMedia.parsedMedia.hdrMetadata[videoTrack.id]?.['AGTM'];
  if (!trackMetadata || !trackMetadata.frames) return null;

  // Create a dense array of metadata for all frames.
  const numFrames = videoTrack.samples.length;
  const metadataList = new Array<AgtmMetadata | null>(numFrames).fill(null);

  const frames = trackMetadata.frames;

  let currentMetadata: AgtmMetadata | null = null;
  let frameIdx = 0;
  for (const f of frames) {
    const targetFrameIdx =
      findTrackSampleIndexForTime(videoTrack, f.presentationTimeSec) ?? 0;
    while (frameIdx < targetFrameIdx) {
      metadataList[frameIdx] = currentMetadata;
      frameIdx++;
    }
    currentMetadata = f.agtm ?? null;
    if (frameIdx < numFrames) {
      metadataList[frameIdx] = currentMetadata;
      frameIdx++;
    }
  }
  while (frameIdx < numFrames) {
    metadataList[frameIdx] = currentMetadata;
    frameIdx++;
  }
  return metadataList;
}

function hasEmbeddedAgtmMetadata(): boolean {
  if (!decodedMedia?.parsedMedia) return false;
  const videoTrack = getFirstVideoTrack(decodedMedia.parsedMedia.tracks);
  if (!videoTrack) return false;
  const trackMetadata =
    decodedMedia.parsedMedia.hdrMetadata[videoTrack.id]?.['AGTM'];
  return (trackMetadata?.frames?.length ?? 0) > 0;
}

function resetMetadataOverrides() {
  hdrReferenceWhiteOverridden = false;
  baselineHeadroomLinearOverridden = false;
  gainApplicationSpacePrimariesOverridden = false;
  customGainApplicationSpaceChromaticitiesHash = null;
  curvePointsOverridden = false;
  setHashes({
    'tf': null,
    'pri': null,
    'ref_white': null,
    'max_comp': null,
    'gain_pri': null,
    'custom_pri': null,
  });
}

async function onMetadataTypeChange() {
  if (metadataSelectEl.value === 'custom') {
    jsonUploadEl.value = ''; // Reset file input.
    jsonUploadEl.click();
    return;
  }
  if (!isApplyingStateFromHash) {
    resetMetadataOverrides();
  }
  const oldAgtmMetadataType = agtmMetadataType;
  agtmMetadataType = metadataSelectEl.value as AgtmMetadataType | 'fromfile';
  updateStats();
  await setAgtmMetadata();
  renderVisiblePanels();
  setHash('m', metadataSelectEl.value);
  updateSaveAgtmButtons();
  requestRestartDynamicAgtm();
}

async function onSignalTransferChange() {
  imageBitmapStats = null;
  contentTransfer = Number(signalTransferEl.value);
  // Stats are based on the contentTransfer so they need to be recomputed.
  updateStats();
  await setAgtmMetadata();
  updateRenderersImage();
}

function onSignalPrimariesChange() {
  contentPrimaries = Number(signalPrimariesEl.value);
  updateStats();
  updateRenderersImage();
}

function setHash(key: string, value: string) {
  if (isApplyingStateFromHash) return;
  const hashParams = new URLSearchParams(window.location.hash.substring(1));
  hashParams.set(key, value);
  const newHash = hashParams.toString();
  history.pushState(null, '', document.location.pathname + '#' + newHash);
}

function unsetHash(key: string) {
  if (isApplyingStateFromHash) return;
  const hashParams = new URLSearchParams(window.location.hash.substring(1));
  hashParams.delete(key);
  const newHash = hashParams.toString();
  history.pushState(null, '', document.location.pathname + '#' + newHash);
}

function setHashes(updates: {[key: string]: string | null}) {
  if (isApplyingStateFromHash) return;
  const hashParams = new URLSearchParams(window.location.hash.substring(1));
  for (const key of Object.keys(updates)) {
    const value = updates[key];
    if (value === null) {
      hashParams.delete(key);
    } else {
      hashParams.set(key, value);
    }
  }
  const newHash = hashParams.toString();
  history.pushState(null, '', document.location.pathname + '#' + newHash);
}

function hasHash(key: string): boolean {
  const hashParams = new URLSearchParams(window.location.hash.substring(1));
  return hashParams.has(key);
}

function getHash(key: string): string | null {
  const hashParams = new URLSearchParams(window.location.hash.substring(1));
  return hashParams.get(key);
}

function setRendererImage(renderer: Renderer) {
  if (decodedMedia) {
    renderer.setImage(
      decodedMedia.imageBitmapSource,
      decodedMedia.imageBitmap,
      contentTransfer,
      contentPrimaries,
    );
  }
}

function update() {
  if (!decodedMedia) {
    return;
  }

  myImageEl.hidden = decodedMedia.type !== 'image';
  myVideoEl.hidden = decodedMedia.type !== 'video';
  timeSliderTableEl.hidden = decodedMedia.type !== 'video';

  const isFlipMode = panelDisplayModeEl.value === 'flip';
  flipButton.hidden = !isFlipMode;

  for (const panel of rendererPanels) {
    if (isFlipMode) {
      panel.panelEl.hidden = flipModeVisiblePanel !== panel.toggle;
    } else {
      panel.panelEl.hidden = !panel.toggle.checked;
    }
  }
  for (const panel of miscPanels) {
    panel.panelEl.hidden = !panel.toggle.checked;
  }

  for (const panel of allPanels) {
    if (!panel.rendererFactory) continue;
    const shouldHaveRenderer = !panel.panelEl.hidden;
    if (shouldHaveRenderer && !panel.renderer) {
      panel.renderer = panel.rendererFactory();
      setRendererImage(panel.renderer);
    } else if (!shouldHaveRenderer && panel.renderer) {
      panel.renderer.destroy();
      panel.renderer = null;
    }
  }

  const width =
    decodedMedia.imageBitmapSource instanceof HTMLVideoElement
      ? decodedMedia.imageBitmapSource.videoWidth
      : decodedMedia.imageBitmap.width;
  const height =
    decodedMedia.imageBitmapSource instanceof HTMLVideoElement
      ? decodedMedia.imageBitmapSource.videoHeight
      : decodedMedia.imageBitmap.height;

  for (const panel of allPanels) {
    panel.renderer?.resizeFramebuffer(width, height);
  }
}

function renderVisibleRendererPanels() {
  for (const panel of rendererPanels) {
    if (panel.renderer && !panel.panelEl.hidden) {
      panel.renderer.draw();
    }
  }
}

function renderVisiblePanels() {
  for (const panel of allPanels) {
    if (panel.renderer && !panel.panelEl.hidden) {
      panel.renderer.draw();
    }
  }
}

function updateRenderersImage() {
  if (!decodedMedia) {
    return;
  }
  for (const panel of allPanels) {
    if (panel.renderer) {
      setRendererImage(panel.renderer);
    }
  }
}

async function decodedMediaCallback(media: DecodedMedia, isUploadedFile: boolean) {
  if (decodedMedia) {
    decodedMedia.imageBitmap.close();
  }
  decodedMedia = media;

  if (media.imageBitmapSource instanceof HTMLVideoElement) {
    const videoEl = media.imageBitmapSource;
    timeSliderEl.max = String(videoEl.duration);
    timeSliderValueEl.max = String(videoEl.duration);
    timeSliderEl.value = videoEl.currentTime.toString();
    timeSliderValueEl.value = Number(timeSliderEl.value).toLocaleString(
      'fullwide',
      {
        minimumFractionDigits: 3,
        maximumFractionDigits: 3,
        minimumIntegerDigits: 3,
      },
    );
  }

  if (media.metadata?.transferCharacteristics && !hasHash('tf')) {
    contentTransfer = media.metadata.transferCharacteristics;
    signalTransferEl.value = media.metadata.transferCharacteristics.toString();
  }
  if (media.metadata?.colourPrimaries && !hasHash('pri')) {
    contentPrimaries = media.metadata.colourPrimaries;
    signalPrimariesEl.value = media.metadata.colourPrimaries.toString();
  }

  const smpte209440El = getPanelEl('smpte209440') as HTMLTextAreaElement;
  smpte209440El.value =
    media.metadata?.hdr10pMetadataText ?? '(No input video)';
  hdr10pMetadata = media.metadata?.hdr10pMetadata ?? null;

  getRenderer('hdr10plus', Hdr10pRenderer)?.setMetadata(hdr10pMetadata);
  getRenderer('hdr10pcurves', Hdr10pRenderer)?.setMetadata(hdr10pMetadata);

  getHTMLElement('MediaInfoText').textContent = getMediaInfoString(media);
  if (isUploadedFile) {
    mediaInfoDialogEl.showModal();
  }

  const hasAgtm = media.metadata?.agtmMetadata != null;
  for (const option of metadataSelectEl.options) {
    if (option.value === 'fromfile') {
      option.disabled = !hasAgtm;
      break;
    }
  }

  // Synchronize the dropdown with the hash.
  if (hasHash('m')) {
    const hashM = getHash('m');
    if (hashM) {
      metadataSelectEl.value = hashM;
    }
  }

  // Default to metadata type to 'fromfile' if the file has AGTM metadata.
  if (hasAgtm) {
    if (metadataSelectEl.value !== 'fromfile') {
      metadataSelectEl.value = 'fromfile';
      if (!isUploadedFile) setHash('m', metadataSelectEl.value);
    }
  } else if (metadataSelectEl.value === 'fromfile') {
    metadataSelectEl.value = kDefaultAgtmMetadataType;
    setHash('m', metadataSelectEl.value);
  }

  // If the currently selected option is hidden for this file, pick the
  // first visible one.
  if (
    (metadataSelectEl.options[metadataSelectEl.selectedIndex] as
      | HTMLOptionElement
      | undefined)?.hidden
  ) {
    for (const option of metadataSelectEl.options) {
      if (!option.hidden) {
        metadataSelectEl.value = option.value;
        break;
      }
    }
  }

  agtmMetadataType = metadataSelectEl.value as AgtmMetadataType | 'fromfile';

  dynamicAgtmEl.disabled = media.type !== 'video';
  if (media.type !== 'video' && dynamicAgtmEl.value !== 'off') {
    dynamicAgtmEl.value = 'off';
    dynamicAgtmEl.dispatchEvent(new Event('change'));
  } else if (media.type === 'video') {
    const dyn = getHash('dyn');
    const newValue = dyn === 'seek' || dyn === 'all' ? dyn : 'off';
    if (dynamicAgtmEl.value !== newValue) {
      dynamicAgtmEl.value = newValue;
      dynamicAgtmEl.dispatchEvent(new Event('change'));
    }
  }

  update();
  updateStats();
  await setAgtmMetadata();
  updateSaveAgtmButtons();
  updateRenderersImage();
  renderVisiblePanels();

  // Signal that the app finished loading (useful for tests).
  if (!(window as any)['appReady']) {
    (window as any)['appReady'] = true;
    window.dispatchEvent(new CustomEvent('app-ready'));
  }
}

async function onFile(name: string, f: Blob, isUploadedFile: boolean = false) {
  resetMedia();
  try {
    let isFirstCallback = true;
    const callbackWrapper = async (media: DecodedMedia) => {
      await decodedMediaCallback(media, isUploadedFile && isFirstCallback);
      isFirstCallback = false;
    };

    await decodeMediaWithCallback(
      name,
      f,
      callbackWrapper,
      myImageEl,
      myVideoEl,
    );
    mediaFilename = name;
    mediaBlob = f;
  } catch (error) {
    console.error('Error decoding media:', error);
  }
}

async function onFileList(files: FileList | null) {
  if (!files || files.length === 0) {
    return;
  }
  // Even if multiple files are dragged, we only process the first one.
  const f = files[0];
  if (f.name.endsWith('.json')) {
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const jsonText = e.target!.result as string;
        const parsedJson = jsonToMetadata(jsonText);
        customAgtmMetadata = null;
        customAgtmMetadataArray = null;
        if (Array.isArray(parsedJson)) {
          customAgtmMetadataArray = parsedJson as Array<AgtmMetadata | null>;
        } else {
          customAgtmMetadata = parsedJson as AgtmMetadata;
        }
        agtmMetadataType = 'custom';
        metadataSelectEl.value = 'custom';
        await setAgtmMetadata();
        renderVisiblePanels();
      } catch (err) {
        alert(`Error parsing JSON file: ${err}`);
      }
    };
    reader.readAsText(f);
    return;
  }
  unsetHash('t'); // Reset the time slider.
  await onFile(f.name, f, /* isUploadedFile= */ true);
}

function abortFetch(controller: AbortController | null) {
  if (controller) {
    controller.abort();
  }
}

async function fetchFile(filename: string) {
  let controller: AbortController;

  abortFetch(currentMediaFetchController);
  currentMediaFetchController = new AbortController();
  controller = currentMediaFetchController;

  const myRequest = new Request(filename);
  try {
    const response = await fetch(myRequest, {signal: controller.signal});
    const myBlob = await response.blob();
    if (!controller.signal.aborted) {
      await onFile(filename, myBlob, /* isUploadedFile= */ false);
    }
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'AbortError') {
      console.log('Fetch aborted:', filename);
    } else {
      console.error('Fetch error:', error);
    }
  }
}

function setRadio(
  radios: NodeListOf<HTMLInputElement>,
  value: string,
): HTMLInputElement | null {
  for (const radio of radios) {
    if (radio.value === value) {
      radio.checked = true;
      return radio;
    }
  }
  return null;
}

function updateBackground(grayValue: number) {
  const gray = grayValue.toFixed(2);
  const bgColor = `color(srgb-linear ${gray} ${gray} ${gray})`;
  document.documentElement.style.setProperty('--bg-color', bgColor);
}

function getDisplayMaxNits() {
  const headroomLog2 = Number(headroomSliderEl.value);
  const headroomLinear = Math.pow(2, headroomLog2);
  let nits;
  if (nativeNitsPresetsEl.value === 'sdr_nits') {
    nits = Number(nativeNitsEl.value) * headroomLinear;
  } else {
    nits =
      Number(nativeNitsEl.value) *
      Math.min(1, headroomLinear / nativeHeadroomLinear);
  }
  return nits;
}

function setHeadrooms() {
  const headroomLog2 = Number(headroomSliderEl.value);
  const headroomLinear = Math.pow(2, headroomLog2);
  headroomLog2El.innerText = headroomLog2.toFixed(2);
  headroomLinearEl.innerText = headroomLinear.toFixed(2);
  if (Math.abs(headroomLinear - nativeHeadroomLinear) < 0.001) {
    headroomStatusEl.innerText = 'native: ';
  } else if (headroomLinear < nativeHeadroomLinear) {
    headroomStatusEl.innerText = 'limited: ';
  } else {
    headroomStatusEl.innerText = 'simulated: ';
  }
  headroomStatusEl.innerText += headroomLog2 === 0 ? 'SDR' : 'HDR';

  const simulatedHeadroomLinear =
    1 + Math.max(0, headroomLinear - nativeHeadroomLinear);
  const v = 1 / simulatedHeadroomLinear;
  updateBackground(v);
  const gammaCorrectedOpacity = Math.pow(1 / simulatedHeadroomLinear, 1 / 2.2);
  const gammaCorrectedOpacityStr = String(gammaCorrectedOpacity);
  // The simulated headroom is not forwarded to the <img> and <video> elements,
  // so darkening it is misleading.
  // myImageEl.style.opacity = gammaCorrectedOpacityStr;
  // myVideoEl.style.opacity = gammaCorrectedOpacityStr;
  for (const element of sdrBloatImgEls) {
    element.style.opacity = gammaCorrectedOpacityStr;
  }

  headroomNitsEl.innerText = getDisplayMaxNits().toFixed(2);

  for (const panel of allPanels) {
    if (!panel.renderer) continue;
    setRendererHeadroom(panel.renderer);
  }

  for (const warning of onlyNativeWarnings) {
    const limitedOrSimulated =
      !keepHeadroomSetToNativeHeadroom &&
      Math.abs(headroomLinear - nativeHeadroomLinear) > 0.001;
    warning.hidden = !limitedOrSimulated;
  }
  for (const warning of simWarnings) {
    const simulated =
      !keepHeadroomSetToNativeHeadroom &&
      headroomLinear > nativeHeadroomLinear + 0.001;
    warning.hidden = !simulated;
  }
}

function resetMedia() {
  resetMetadataOverrides();
  mediaBlob = null;
  mediaFilename = null;
  decodedMedia = null;
  imageBitmapStats = null;
  computedStats = null;
  selectedPixelCoords = null;
  if (myVideoEl.src.startsWith('blob:')) {
    URL.revokeObjectURL(myVideoEl.src);
  }
  if (myImageEl.src.startsWith('blob:')) {
    URL.revokeObjectURL(myImageEl.src);
  }
  setZoomPan(1.0, 0.0, 0.0);
  if (dynamicAgtmEl.value !== 'off') {
    dynamicAgtmEl.value = 'off';
    dynamicAgtmEl.dispatchEvent(new Event('change'));
  }
  updateSaveAgtmButtons();
}

async function loadSelectedContent() {
  const contentName = contentSelectEl.value;
  if (!contentName.match(/^[a-zA-Z0-9-_/]+\.[a-z0-9]+$/)) {
    console.warn(`contentName '${contentName}' does not match regex`);
    return;
  }
  const selectedOption = contentSelectEl.options[contentSelectEl.selectedIndex];
  const optgroup = selectedOption.parentElement as HTMLOptGroupElement;
  const inputHasGainmap = optgroup.label === 'JPG+gain map';

  resetMedia();
  if (inputHasGainmap) {
    // TODO(vrabaud): parse the transfer function and primaries from the file
    // name or content.
    contentTransfer = kTransferSrgb;
    contentPrimaries = kPrimariesSRGB;
  } else {
    // Default tranfser/primaries. These get overridden in onFrameChanged() if
    // we can parse them from the file.
    contentTransfer = kTransferPQ;
    contentPrimaries = kPrimariesRec2020;
  }
  signalTransferEl.value = contentTransfer.toString();
  signalPrimariesEl.value = contentPrimaries.toString();

  const pathPrefix = selectedOption.dataset['dirname'];
  const fullPath = pathPrefix ? `${pathPrefix}/${contentName}` : contentName;
  await fetchFile(fullPath);
}

async function updateStateFromHash() {
  const contentId = getHash('content');
  if (contentId) contentSelectEl.value = contentId;
  await loadSelectedContent();

  const displayMode = getHash('display');
  if (displayMode) {
    panelDisplayModeEl.value = displayMode;
  }

  const refWhite = getHash('ref_white');
  if (refWhite) {
    hdrReferenceWhiteOverridden = true;
    hdrReferenceWhiteSliderEl.value = refWhite;
  }
  const maxComp = getHash('max_comp');
  if (maxComp) {
    baselineHeadroomLinearOverridden = true;
    baselineHeadroomSliderEl.value = maxComp;
  }
  const gainPri = getHash('gain_pri');
  if (gainPri) {
    gainApplicationSpacePrimariesOverridden = true;
    gainApplicationSpacePrimariesSelectEl.value = gainPri;
  }
  const customPri = getHash('custom_pri');
  if (customPri) {
    if (gainPri === '-1') {
      const parts = customPri.split(',').map(Number);
      if (parts.length === 8 && parts.every((n) => !isNaN(n))) {
        customGainApplicationSpaceChromaticitiesHash = parts;
      }
    } else {
      unsetHash('custom_pri');
    }
  }


  const metadataId = getHash('m');
  if (metadataId) {
    metadataSelectEl.value = metadataId;
    await onMetadataTypeChange();
  }

  // This must be set after 'content' above so that it overrides the content's
  // default metadata.
  const transfer = getHash('tf');
  if (transfer) {
    signalTransferEl.value = transfer;
    await onSignalTransferChange();
  }
  const primaries = getHash('pri');
  if (primaries) {
    signalPrimariesEl.value = primaries;
    onSignalPrimariesChange();
  }

  const mixId = getHash('mix');
  if (mixId) {
    componentMixSelectEl.value = mixId;
    componentMixSelectEl.dispatchEvent(new Event('change'));
  }

  const altr = getHash('altr');
  if (altr) {
    altrIndexEl.value = altr;
    altrIndexEl.dispatchEvent(new Event('change'));
  }

  const statsMode = getHash('stats_mode');
  if (statsMode) {
    const radio = statsModesEl.querySelector<HTMLInputElement>(
      `input[name="stats_mode"][value="${statsMode}"]`,
    );
    if (radio) {
      radio.checked = true;
    }
  }
  const checkedRadio = statsModesEl.querySelector<HTMLInputElement>(
    'input[name="stats_mode"]:checked',
  );
  if (checkedRadio) {
    checkedRadio.dispatchEvent(new Event('change'));
  }

  const headroom = getHash('hr');
  if (headroom) {
    keepHeadroomSetToNativeHeadroom = false;
    headroomSliderEl.value = headroom;
  }
  const nativeNits = getHash('natnits');
  if (nativeNits) nativeNitsEl.value = nativeNits;
  const nativeNitsPreset = getHash('natnits_preset');
  if (nativeNitsPreset) nativeNitsPresetsEl.value = nativeNitsPreset;

  for (const panel of allPanels) {
    const hashValue = getHash(panel.hashName);
    if (panel.defaultChecked) {
      panel.toggle.checked = hashValue !== '0';
    } else {
      panel.toggle.checked = hashValue === '1';
    }
  }

  if (panelDisplayModeEl.value === 'flip') {
    const flipPanelHash = getHash('flip');
    if (flipPanelHash) {
      flipModeVisiblePanel = hashNameToPanelToggle.get(flipPanelHash) ?? null;
    }
    // If flipModeVisiblePanel is still null (e.g. flip not in hash, or
    // invalid value) or the panel is not checked, then apply default logic.
    if (!flipModeVisiblePanel || !flipModeVisiblePanel.checked) {
      const checkedToggles = rendererPanelToggles.filter((t) => t.checked);
      if (checkedToggles.length > 0) {
        flipModeVisiblePanel = checkedToggles[0];
      } else {
        // If nothing is checked, check native and show it.
        const nativePanel = rendererPanels[0];
        nativePanel.toggle.checked = true;
        // No need to set hash here, as we are reading from it.
        flipModeVisiblePanel = nativePanel.toggle;
      }
    }
  }

  sdrBloatToggle.checked = getHash('sdrbloat') === '1';
  for (const element of sdrBloatEls) {
    element.hidden = !sdrBloatToggle.checked;
  }
  for (const element of sdrBloatParentEls) {
    element.hidden = !sdrBloatToggle.checked;
  }

  logNitsEl.checked = getHash('log_nits') === '1';
  logNitsEl.dispatchEvent(new Event('change'));

  logPercentEl.checked = getHash('log_percent') === '1';
  logPercentEl.dispatchEvent(new Event('change'));

  const showClamped = getHash('clamped');
  if (showClamped) showClampedToggle.checked = showClamped === '1';
  showClampedToggle.dispatchEvent(new Event('change'));

  const time = getHash('t');
  if (time && myVideoEl.readyState > 0) {
    myVideoEl.currentTime = Number(time);
  }

  myVideoEl.loop = getHash('loop') === '1';
  loopButtonEl.classList.toggle('active', myVideoEl.loop);

  const lumaMode = getHash('luma_mode');
  if (lumaMode) {
    lumaModeSelectEl.value = lumaMode;
  }
  lumaModeSelectEl.dispatchEvent(new Event('change'));

  const showGainCurve = getHash('gain');
  if (showGainCurve) showGainCurveEl.checked = showGainCurve === '1';
  showGainCurveEl.dispatchEvent(new Event('change'));

  const showControlPoints = getHash('points');
  // Default is checked.
  showControlPointsEl.checked = showControlPoints !== '0';
  showControlPointsEl.dispatchEvent(new Event('change'));

  const agtmLutSize = getHash('lut');
  if (agtmLutSize) {
    agtmLutSizeInputEl.value = agtmLutSize;
  }
  const agtm1dLutSize = getHash('lut1d');
  if (agtm1dLutSize) {
    agtm1dLutSizeInputEl.value = agtm1dLutSize;
  }
  const agtmSamplingType = getHash('lut1d_type');
  if (agtmSamplingType) {
    agtmSamplingTypeSelectEl.value = agtmSamplingType;
  }
  const agtmLutInputColorSpace = getHash('lut_in_space');
  if (agtmLutInputColorSpace) {
    agtmLutInputColorSpaceSelectEl.value = agtmLutInputColorSpace;
  }
  agtmLutSizeInputEl.dispatchEvent(new Event('change'));

  const agtmLutType = getHash('lut_type');
  if (agtmLutType) {
    agtmLutTypeSelectEl.value = agtmLutType;
  }
  agtmLutTypeSelectEl.dispatchEvent(new Event('change'));

  // Ensure overrides are applied to the final metadata.
  await setAgtmMetadata();
}

function maybeShowWarnings() {
  let warningsText = '';
  const v = browserVersion();
  if (v[0] === 'Chrome' && v[1] < 131) {
    warningsText =
      'Chrome Version <131 has bugs importing HDR video to WebGL. Use a more recent version.';
  }

  if (!document.createElement('canvas').configureHighDynamicRange) {
    const configureHdrWarning =
      'Missing experimental HDR browser features! If you have an HDR capable display, use Chrome and enable "Experimental Web Platform Features" in chrome://flags for the best experience.';
    if (warningsText !== '') {
      warningsText += ' ';
    }
    warningsText += configureHdrWarning;
  }

  if (warningsText !== '' && warningsEl) {
    warningsEl.hidden = false;
    warningsEl.style.color = '#FF0000';
    warningsEl.innerText = warningsText;
  }
}

class PanelScrollSyncer {
  private scrollTop = 0;
  private scrollLeft = 0;

  constructor(private readonly panels: HTMLElement[]) {
    for (const panel of this.panels) {
      panel.addEventListener('scroll', () => {
        this.handleScroll(panel);
      });
    }
  }

  private handleScroll(scrolledPanel: HTMLElement) {
    if (
      scrolledPanel.scrollTop === this.scrollTop &&
      scrolledPanel.scrollLeft === this.scrollLeft
    ) {
      return;
    }

    this.scrollTop = scrolledPanel.scrollTop;
    this.scrollLeft = scrolledPanel.scrollLeft;

    for (const otherPanel of this.panels) {
      if (otherPanel !== scrolledPanel) {
        otherPanel.scrollTop = this.scrollTop;
        otherPanel.scrollLeft = this.scrollLeft;
      }
    }
  }

  syncVisiblePanels() {
    for (const panel of this.panels) {
      if (!panel.hidden) {
        panel.scrollTop = this.scrollTop;
        panel.scrollLeft = this.scrollLeft;
      }
    }
  }
}

function populateContentDropdown() {
  contentSelectEl.textContent = ''; // Clear existing content
  TEST_FILES.forEach((group) => {
    const optgroup = document.createElement('optgroup');
    optgroup.label = group.label;
    group.files.forEach((file) => {
      const basename = file.path.split('/').pop() ?? file.path;
      const dirname = file.path.split('/').slice(0, -1).join('/') ?? '';
      const opt = document.createElement('option');
      opt.value = basename;
      opt.textContent = file.title;
      opt.dataset['dirname'] = dirname;
      if (basename === DEFAULT_FILE) {
        opt.selected = true;
      }
      optgroup.appendChild(opt);
    });
    contentSelectEl.appendChild(optgroup);
  });
}

function populateContentBrowser() {
  contentGridEl.textContent = ''; // Clear existing content

  TEST_FILES.forEach((group) => {
    group.files.forEach((file) => {
      const pathParts = file.path.split('/');
      const basename = pathParts[pathParts.length - 1] ?? file.path;
      const dataDirIdx = pathParts.indexOf('data');
      pathParts.splice(dataDirIdx + 1, 0, 'preview');
      const previewPath = pathParts.join('/') + '.webp';

      const title = file.title;
      const isVideo = basename.endsWith('.mp4');

      const thumbnailEl = document.createElement('div');
      thumbnailEl.className = 'content-thumbnail';

      const mediaContainerEl = document.createElement('div');
      mediaContainerEl.className = 'content-thumbnail-media-container';

      const mediaEl = document.createElement('img');
      mediaEl.src = previewPath;

      const overlayEl = document.createElement('div');
      overlayEl.className = 'content-thumbnail-overlay';

      const tags: string[] = [isVideo ? '🎥' : '🖼️'];
      if (title.includes('HDR10+')) tags.push('HDR10p');
      if (title.includes('PQ')) tags.push('PQ');
      if (title.includes('HLG')) tags.push('HLG');

      for (const tag of tags) {
        const tagEl = document.createElement('span');
        tagEl.className = 'content-thumbnail-tag ' + tag;
        tagEl.textContent = tag;
        overlayEl.appendChild(tagEl);
      }

      mediaContainerEl.appendChild(mediaEl);
      mediaContainerEl.appendChild(overlayEl);

      const textEl = document.createElement('span');
      textEl.textContent = title.trim();

      thumbnailEl.appendChild(mediaContainerEl);
      thumbnailEl.appendChild(textEl);

      thumbnailEl.addEventListener('click', () => {
        contentSelectEl.value = basename;
        // Dispatch change event to load the new content
        contentSelectEl.dispatchEvent(new Event('change'));
        contentBrowserEl.hidden = true;
      });

      contentGridEl.appendChild(thumbnailEl);
    });
  });
}

function handleSaveAnimation(renderers: Renderer[]) {
  if (renderers.length === 0) {
    console.warn('handleSaveAnimation called with no renderers.');
    return;
  }
  const firstRenderer = renderers[0];
  const rendererWidth = firstRenderer.getCanvas().width;
  const rendererHeight = firstRenderer.getCanvas().height;
  const allowNonPictureResize = firstRenderer.isPicture();
  let totalWidth;
  let totalHeight;
  // Ordering the rendered panels arbitrarily.
  // The expected use cases are:
  //  - 1 panel (trivial)
  //  - 2 panels: one on the left, one on the right
  //  - 4 panels: 2x2 grid, pictures on the left, curves on the right
  //              (with the pictures coming first in panel order)
  //              or 2x2 grid with whatever content in any order
  const stackTwoRows = renderers.length >= 4 && renderers.length % 2 === 0;
  if (stackTwoRows) {
    totalWidth = (rendererWidth * renderers.length) / 2;
    totalHeight = rendererHeight * 2;
  } else {
    totalWidth = rendererWidth * renderers.length;
    totalHeight = rendererHeight;
  }

  const originalHeadroom = headroomSliderEl.value;
  const originalNits = nativeNitsEl.value;
  const maxHeadroom = 1.0; // log2
  const numSteps = 8;
  const frames = new Array<Uint8Array>(numSteps + 1);
  const varyingHeadroom = true;
  for (let i = 0; i <= numSteps; ++i) {
    const headroom = (maxHeadroom * i) / numSteps; // log2
    const scaleForPictures = Math.pow(2, headroom) / Math.pow(2, maxHeadroom);
    const scaleForGraphs = varyingHeadroom
      ? 1.0 / Math.pow(2, maxHeadroom)
      : scaleForPictures;
    if (varyingHeadroom) {
      headroomSliderEl.value = String(headroom);
    }
    nativeNitsEl.value = String(Number(originalNits) * scaleForPictures);
    setHeadrooms();

    // Display progress in the console because this takes ages.
    console.log('drawing frame ' + i.toString() + ' / ' + numSteps.toString());
    frames[i] = new Uint8Array(totalWidth * totalHeight * 4);
    let rendererIndex = 0;
    for (const renderer of renderers) {
      let x;
      let y;
      if (stackTwoRows) {
        x = Math.floor(rendererIndex / 2) * rendererWidth;
        y = rendererIndex % 2 === 0 ? 0 : rendererHeight;
      } else {
        x = rendererIndex * rendererWidth;
        y = 0;
      }
      const stride = totalWidth * 4;
      console.log('  from renderer #' + rendererIndex.toString());
      const originalWidth = renderer.getCanvas().width;
      const originalHeight = renderer.getCanvas().height;
      renderer.resizeFramebuffer(
        rendererWidth,
        rendererHeight,
        allowNonPictureResize,
      );
      renderer.draw();
      const scale = renderer.isPicture() ? scaleForPictures : scaleForGraphs;
      renderer.getImageData(scale, x, y, frames[i], stride);
      renderer.resizeFramebuffer(
        originalWidth,
        originalHeight,
        allowNonPictureResize,
      );
      ++rendererIndex;
    }
  }
  console.log('generating APNG');
  let filename = basenameWithoutExtension(mediaFilename ?? '');
  for (const renderer of renderers) {
    const id = renderer.getCanvas().getAttribute('id');
    if (id) {
      if (filename !== '') {
        filename = filename.concat('_');
      }
      filename = filename.concat(id);
    } else {
      filename = 'out';
      break;
    }
  }
  const startTime = performance.now();
  downloadApng(frames, filename, totalWidth, totalHeight);
  const seconds = ((performance.now() - startTime) / 1000).toFixed(2);

  console.log(`generated APNG in ${seconds}s, clearing state`);
  headroomSliderEl.value = originalHeadroom;
  nativeNitsEl.value = originalNits;
  setHeadrooms();
  for (const renderer of renderers) {
    renderer.draw();
  }
}

async function generateDynamicMetadata(
  abortController: AbortController,
  progressCallback?: (frame: number, total: number) => void,
  frameComputedCallback?: (
    metadata: AgtmMetadata | null,
    stats: ComputedStats,
    time: number,
  ) => void,
): Promise<Array<AgtmMetadata | null> | null> {
  if (!decodedMedia?.arrayBuffer || !mediaBlob || !decodedMedia?.parsedMedia) {
    return null;
  }
  const kMaxFramesToProcess = 1000;
  const metadataList: Array<AgtmMetadata | null> = [];

  const parsedMp4 = decodedMedia.parsedMedia;
  const videoTrack = getFirstVideoTrack(parsedMp4.tracks);
  if (!videoTrack || !videoTrack.timescale) {
    console.error('No video track with timescale found');
    return null;
  }
  const numFrames = videoTrack.samples.length;
  const framesToProcess = Math.min(kMaxFramesToProcess, numFrames);

  const tempVideo = document.createElement('video');
  exportProgressVideoEl = tempVideo;
  tempVideo.style.width = '50px';
  tempVideo.style.margin = '5px ';
  tempVideo.style.display = activeDynamicExportsCount > 0 ? '' : 'none';
  saveDynamicAgtmButtonEl.parentElement!.appendChild(tempVideo);
  const videoUrl = objectUrlFromSafeSource(mediaBlob);
  tempVideo.src = videoUrl.toString();

  try {
    await new Promise((resolve) => {
      tempVideo.onloadedmetadata = resolve;
    });

    let averagedStats: ComputedStats | null = null;
    for (let i = 0; i < framesToProcess; i++) {
      if (isDynamicAgtmPaused) {
        await new Promise<void>((resolve) => {
          dynamicAgtmPauseResolver = resolve;
        });
      }
      if (abortController.signal.aborted) {
        return null;
      }
      if (progressCallback) {
        progressCallback(i, framesToProcess);
      }

      const sample = videoTrack.samples[i];
      const time = sample.dts / videoTrack.timescale;

      await new Promise<void>((resolve) => {
        tempVideo.onseeked = () => {
          resolve();
        };
        tempVideo.currentTime = time;
      });

      const computed = await computeFrameStats(tempVideo, /*fullRange=*/ true);
      if (!computed) {
        return [];
      }
      if (!averagedStats) {
        averagedStats = computed;
      } else {
        const kDefaultFramerate = 25;
        // Weight applied for a framerate of kDefaultFramerate.
        const kDefaultWeight = 0.125;
        const framerate = getAverageFramerate(parsedMp4) ?? kDefaultFramerate;
        const weight = Math.min(
          kDefaultWeight * (kDefaultFramerate / framerate),
          1.0,
        );
        averagedStats = averageStats(computed, averagedStats, weight);
      }

      const hdrReferenceWhite = hdrReferenceWhiteOverridden
        ? Number(hdrReferenceWhiteSliderEl.value)
        : undefined;
      const baselineHeadroomLinear = baselineHeadroomLinearOverridden
        ? Number(baselineHeadroomSliderEl.value)
        : undefined;

      const metadata = await getAgtmForType(
        agtmMetadataType,
        averagedStats,
        hdrReferenceWhite,
        baselineHeadroomLinear,
      );
      if (!metadata) {
        console.error(
          'Failed to compute AGTM metadata for frame ' + i.toString(),
        );
        metadataList.push(null);
        if (frameComputedCallback) {
          frameComputedCallback(null, averagedStats, time);
        }
      } else {
        const originalMix = structuredClone(metadata.altr[0].mix);
        applyOverrides(metadata, originalMix);
        metadataList.push(metadata);
        if (frameComputedCallback) {
          frameComputedCallback(metadata, averagedStats, time);
        }
      }
    }
    return metadataList;
  } finally {
    tempVideo.remove();
    exportProgressVideoEl = null;
    URL.revokeObjectURL(videoUrl.toString());
  }
}

function requestRestartDynamicAgtm() {
  if (dynamicAgtmEl.disabled) return;
  if (dynamicAgtmEl.value === 'seek') {
    recomputeAgtmForCurrentFrame();
    return;
  }
  if (dynamicAgtmEl.value !== 'all') {
    return;
  }
  if (dynamicAgtmComputationPromise) {
    dynamicAgtmRestartQueued = true;
    if (dynamicAgtmController) {
      dynamicAgtmController.abort();
    }
  } else {
    dynamicAgtmComputationPromise = computeDynamicAgtmMetadata();
  }
}

async function computeDynamicAgtmMetadata() {
  if (
    !decodedMedia?.arrayBuffer ||
    !mediaBlob ||
    agtmMetadataType === 'fromfile' ||
    agtmMetadataType === 'custom'
  ) {
    return;
  }
  dynamicAgtmRestartQueued = false;
  dynamicAgtmController = new AbortController();
  const oldText = dynamicAgtmProgressEl.textContent;
  pauseResumeDynamicAgtmButtonEl.hidden = false;
  pauseResumeDynamicAgtmButtonEl.textContent = 'Pause';
  isDynamicAgtmPaused = false;
  try {
    dynamicAgtmMetadata = [];
    dynamicAgtmComputedStats = [];
    const metadataList = await generateDynamicMetadata(
      dynamicAgtmController,
      (frame, total) => {
        const progressText = `Processing frame ${frame + 1}/${total}...`;
        dynamicAgtmProgressEl.textContent = progressText;
        if (saveDynamicAgtmButtonEl.disabled) {
          saveDynamicAgtmButtonEl.textContent = progressText;
        }
        if (saveAllJsonButtonEl.disabled) {
          saveAllJsonButtonEl.textContent = progressText;
        }
      },
      (metadata, stats, time) => {
        if (!dynamicAgtmMetadata || !dynamicAgtmComputedStats) return;
        dynamicAgtmMetadata.push(metadata);
        dynamicAgtmComputedStats.push(stats);
        const percent = (time / myVideoEl.duration) * 100;
        timeSliderEl.style.background = `linear-gradient(to right, #28a745 0%, #28a745 ${percent}%, #dee2e6 ${percent}%, #dee2e6 100%)`;
        void setAgtmMetadata();
        renderVisiblePanels();
      },
    );
    updateSaveAgtmButtons();

    if (metadataList && !dynamicAgtmController.signal.aborted) {
      timeSliderEl.style.background = `linear-gradient(to right, #28a745 0%, #28a745 100%, #dee2e6 100%, #dee2e6 100%)`;
      await setAgtmMetadata();
      renderVisiblePanels();
    }
  } finally {
    dynamicAgtmProgressEl.textContent = oldText;
    dynamicAgtmController = null;
    dynamicAgtmComputationPromise = null;
    pauseResumeDynamicAgtmButtonEl.hidden = true;
    if (dynamicAgtmRestartQueued) {
      dynamicAgtmComputationPromise = computeDynamicAgtmMetadata();
    }
  }
}

/**
 * Runs a dynamic export operation, handling UI state and cancellation.
 */
async function runDynamicExport(
  buttonEl: HTMLButtonElement,
  cancelButtonEl: HTMLElement,
  hideElements: HTMLElement[],
  exportAction: (abortController: AbortController) => Promise<void>,
) {
  if (!dynamicExportController) {
    dynamicExportController = new AbortController();
  }
  const controller = dynamicExportController;
  activeDynamicExportsCount++;

  const oldText = buttonEl.textContent;
  buttonEl.disabled = true;
  cancelButtonEl.hidden = false;
  for (const el of hideElements) {
    el.hidden = true;
  }
  try {
    if (exportProgressVideoEl) {
      exportProgressVideoEl.style.display = '';
    }
    await exportAction(controller);
  } catch (e: unknown) {
    if (e instanceof Error && e.name === 'AbortError') {
      console.log('Export cancelled');
    } else {
      throw e;
    }
  } finally {
    buttonEl.textContent = oldText;
    buttonEl.disabled = false;
    cancelButtonEl.hidden = true;
    for (const el of hideElements) {
      el.hidden = false;
    }
    activeDynamicExportsCount--;
    if (exportProgressVideoEl && activeDynamicExportsCount === 0) {
      exportProgressVideoEl.style.display = 'none';
    }
    if (activeDynamicExportsCount === 0) {
      dynamicExportController = null;
    }
  }
}

/** Waits for an existing precomputation promise and executes onSuccess. */
async function waitForPrecomputationAndExport(
  precomputationPromise: Promise<void>,
  buttonEl: HTMLButtonElement,
  cancelButtonEl: HTMLElement,
  hideElements: HTMLElement[],
  onSuccess: () => void,
) {
  await runDynamicExport(
    buttonEl,
    cancelButtonEl,
    hideElements,
    async (controller) => {
      buttonEl.textContent = 'Waiting for precomputation...';
      await Promise.race([
        precomputationPromise,
        new Promise((_, reject) => {
          controller.signal.addEventListener('abort', () => {
            reject(new DOMException('Download cancelled', 'AbortError'));
          });
        }),
      ]);
      onSuccess();
    },
  );
}

/**
 * Downloads the AGTM metadata muxed into the original video.
 */
function downloadAgtmVideo(
  metadataList: Array<AgtmMetadata | null>,
  suffix: string,
) {
  if (!decodedMedia?.arrayBuffer) return;
  const muxed = muxAgtmMetadata(decodedMedia.arrayBuffer, metadataList);
  if (muxed) {
    const isWebm = decodedMedia?.parsedMedia?.containerType === 'webm';
    const ext = isWebm ? 'webm' : 'mp4';
    const mime = isWebm ? 'video/webm' : 'video/mp4';
    const filename = `${basenameWithoutExtension(mediaFilename ?? '')}_${suffix}.${ext}`;
    downloadBlob(new Blob([muxed], {type: mime}), filename);
  }
}

/**
 * Downloads the AGTM metadata as a JSON file.
 */
function downloadAgtmJson(
  metadataList: Array<AgtmMetadata | null>,
  suffix: string,
) {
  const json = metadataListToJson(metadataList);
  const filename = `${basenameWithoutExtension(mediaFilename ?? '')}_${suffix}.json`;
  const blob = new Blob([json], {type: 'application/octet-stream'});
  downloadBlob(blob, filename);
}

// Saves the dynamic AGTM video, when the metadata is in the process of being
// precomputed.
async function saveDynamicAgtmVideoWithPrecomputationPromise(
  precomputationPromise: Promise<void>,
) {
  if (!decodedMedia?.arrayBuffer) return;
  await waitForPrecomputationAndExport(
    precomputationPromise,
    saveDynamicAgtmButtonEl,
    cancelDynamicAgtmButtonEl,
    [saveStaticAgtmButtonEl],
    () => {
      if (dynamicAgtmMetadata) {
        downloadAgtmVideo(dynamicAgtmMetadata, 'dynamic_agtm');
      }
    },
  );
}

async function saveDynamicAgtmJson() {
  // 1. Check if precomputation is already in progress (possibly paused).
  if (dynamicAgtmComputationPromise) {
    if (isDynamicAgtmPaused) {
      pauseResumeDynamicAgtmButtonEl.click();
    }
    await waitForPrecomputationAndExport(
      dynamicAgtmComputationPromise,
      saveAllJsonButtonEl,
      cancelDynamicJsonButtonEl,
      [],
      () => {
        if (dynamicAgtmMetadata) {
          downloadAgtmJson(dynamicAgtmMetadata, 'all');
        }
      },
    );
    return;
  }

  // 2. Check for ready metadata (finished dynamic, custom, or embedded).
  let metadataArray = customAgtmMetadataArray ?? dynamicAgtmMetadata;
  if (!metadataArray && agtmMetadataType === 'fromfile') {
    metadataArray = getEmbeddedAgtmMetadataList();
  }

  if (metadataArray) {
    downloadAgtmJson(metadataArray, 'all');
    return;
  }

  // 3. Not ready and not in progress. Turn on dynamic "all frames" mode (unless embedded).
  if (agtmMetadataType !== 'fromfile') {
    if (dynamicAgtmEl.value !== 'all') {
      dynamicAgtmEl.value = 'all';
      dynamicAgtmEl.dispatchEvent(new Event('change'));
    }

    if (dynamicAgtmComputationPromise) {
      await waitForPrecomputationAndExport(
        dynamicAgtmComputationPromise,
        saveAllJsonButtonEl,
        cancelDynamicJsonButtonEl,
        [],
        () => {
          if (dynamicAgtmMetadata) {
            downloadAgtmJson(dynamicAgtmMetadata, 'all');
          }
        },
      );
    }
  }
}

async function saveDynamicAgtmVideo() {
  if (!decodedMedia?.arrayBuffer) return;

  // 1. Check if precomputation is already in progress (possibly paused).
  if (dynamicAgtmComputationPromise) {
    if (isDynamicAgtmPaused) {
      pauseResumeDynamicAgtmButtonEl.click();
    }
    await saveDynamicAgtmVideoWithPrecomputationPromise(
      dynamicAgtmComputationPromise,
    );
    return;
  }

  // 2. Check for ready metadata (finished dynamic or embedded).
  let metadataArray = dynamicAgtmMetadata;
  if (!metadataArray && agtmMetadataType === 'fromfile') {
    metadataArray = getEmbeddedAgtmMetadataList();
  }

  if (metadataArray) {
    downloadAgtmVideo(metadataArray, 'dynamic_agtm');
    return;
  }

  // 3. Not ready and not in progress. Turn on dynamic "all frames" mode (unless embedded).
  if (agtmMetadataType !== 'fromfile') {
    if (dynamicAgtmEl.value !== 'all') {
      dynamicAgtmEl.value = 'all';
      dynamicAgtmEl.dispatchEvent(new Event('change'));
    }

    if (dynamicAgtmComputationPromise) {
      await saveDynamicAgtmVideoWithPrecomputationPromise(
        dynamicAgtmComputationPromise,
      );
    }
  }
}

function saveStaticAgtmVideo() {
  if (!agtmMetadata) return;
  downloadAgtmVideo([agtmMetadata], 'agtm');
}

async function handleSaveAgtmVideoClick(isDynamic: boolean) {
  if (!decodedMedia?.arrayBuffer || !agtmMetadata || !mediaBlob) {
    return;
  }

  if (isDynamic) {
    if (agtmMetadataType === 'fromfile') {
      console.error(
        "Dynamic AGTM is not supported with 'fromfile' metadata type.",
      );
      return;
    }

    const previousTextContent = saveAgtmDropdownButtonEl.textContent;
    saveAgtmDropdownButtonEl.textContent = '⌛️';
    try {
      await saveDynamicAgtmVideo();
    } finally {
      saveAgtmDropdownButtonEl.textContent = previousTextContent;
    }
  } else {
    saveStaticAgtmVideo();
  }
}

// Handle clicking on a canvas to select a pixel.
function handleCanvasClick(e: MouseEvent) {
  if (!decodedMedia || !imageBitmapStats) return;
  const canvas = e.currentTarget as HTMLCanvasElement;

  const rect = canvas.getBoundingClientRect();
  const u = (e.clientX - rect.left) / rect.width;
  const v = (e.clientY - rect.top) / rect.height;

  const texX = (u - 0.5) / currentZoom + 0.5 + currentPanX;
  const texY = (v - 0.5) / currentZoom + 0.5 + currentPanY;

  const width = decodedMedia.imageBitmap.width;
  const height = decodedMedia.imageBitmap.height;
  const x = Math.max(0, Math.min(width - 1, Math.floor(texX * width)));
  const y = Math.max(0, Math.min(height - 1, Math.floor(texY * height)));

  selectedPixelCoords = {x, y};

  const rgbNits = imageBitmapStats.getPixelValueNits(x, y, contentTransfer);
  if (rgbNits) {
    updateSelectedPixel(x, y, rgbNits);
  }
}

// Zoom/pan controls.
function addZoomPanListeners(
  element: HTMLElement,
  isCanvas: boolean,
  clickHandler?: (e: MouseEvent) => void,
) {
  let didPan = false;
  if (isCanvas && clickHandler) {
    element.addEventListener('click', (e) => {
      if (!didPan) {
        clickHandler(e);
      }
    });
  }
  element.addEventListener('wheel', (e: WheelEvent) => {
    e.preventDefault();
    const zoomFactor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const newZoom = currentZoom * zoomFactor;
    const mouseX = e.offsetX / element.clientWidth;
    const mouseY = e.offsetY / element.clientHeight;
    const panX = currentPanX + (mouseX - 0.5) * (1 / currentZoom - 1 / newZoom);
    const panY = currentPanY + (mouseY - 0.5) * (1 / currentZoom - 1 / newZoom);
    setZoomPan(newZoom, panX, panY);
    renderVisibleRendererPanels();
  });

  let dragging = false;
  let lastX: number;
  let lastY: number;
  element.addEventListener('mousedown', (e: MouseEvent) => {
    didPan = false;
    if (currentZoom > 1.0) {
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      element.style.cursor = 'grabbing';
    }
  });
  element.addEventListener('mousemove', (e: MouseEvent) => {
    if (dragging) {
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      if (dx !== 0 || dy !== 0) {
        didPan = true;
      }
      lastX = e.clientX;
      lastY = e.clientY;
      setZoomPan(
        currentZoom,
        currentPanX - dx / element.clientWidth / currentZoom,
        currentPanY - dy / element.clientHeight / currentZoom,
      );
      renderVisibleRendererPanels();
    }
  });
  const stopDragging = () => {
    if (dragging) {
      dragging = false;
      element.style.cursor = isCanvas ? 'crosshair' : 'default';
    }
  };
  element.addEventListener('mouseup', stopDragging);
  element.addEventListener('mouseleave', stopDragging);
}

/** Main function. */
export function main() {
  for (const type of Object.values(AgtmMetadataType)) {
    const option = document.createElement('option') as HTMLOptionElement;
    option.value = type;
    option.text = kAgtmMetadataTypeNames[type];
    option.hidden = type.startsWith('gain_map');
    option.selected = type === kDefaultAgtmMetadataType;
    metadataSelectEl.add(option);
  }

  for (const panel of rendererPanels) {
    if (panel.renderer) {
      const canvas = panel.panelEl.querySelector('canvas');
      if (canvas) {
        addZoomPanListeners(canvas, true, handleCanvasClick);
      }
    }
  }
  addZoomPanListeners(myImageEl, false);
  addZoomPanListeners(myVideoEl, false);

  document
    .querySelector('.save-native-button')
    ?.addEventListener('click', () => {
      if (mediaBlob && mediaFilename) {
        downloadBlob(mediaBlob, mediaFilename);
      }
    });
  saveStaticAgtmButtonEl.addEventListener(
    'click',
    () => void handleSaveAgtmVideoClick(false),
  );
  saveDynamicAgtmButtonEl.addEventListener(
    'click',
    () => void handleSaveAgtmVideoClick(true),
  );
  cancelDynamicAgtmButtonEl.addEventListener('click', () => {
    if (dynamicAgtmComputationPromise && !isDynamicAgtmPaused) {
      pauseResumeDynamicAgtmButtonEl.click();
    }
    dynamicExportController?.abort();
  });
  cancelDynamicJsonButtonEl.addEventListener('click', () => {
    if (dynamicAgtmComputationPromise && !isDynamicAgtmPaused) {
      pauseResumeDynamicAgtmButtonEl.click();
    }
    dynamicExportController?.abort();
  });
  document.querySelectorAll('.save-canvas-button').forEach((button) => {
    const btn = button as HTMLButtonElement;
    const panelHashName = btn.dataset['panelHashName'];
    if (!panelHashName) return;
    const panel = allPanels.find((p) => p.hashName === panelHashName);
    if (!panel) return;

    btn.addEventListener('click', (e) => {
      const clickedRenderer = panel.renderer;
      if (!clickedRenderer) return;
      if (e.shiftKey || e.ctrlKey || e.metaKey) {
        const renderersToSave: Renderer[] = [];
        const rendererWidth = clickedRenderer.getCanvas().width;
        const rendererHeight = clickedRenderer.getCanvas().height;
        const allowNonPictureResize = clickedRenderer.isPicture();

        if (e.ctrlKey || e.metaKey) {
          for (const panel of allPanels) {
            if (
              panel.renderer &&
              !panel.panelEl.hidden &&
              ((allowNonPictureResize && !panel.renderer.isPicture()) ||
                (panel.renderer.getCanvas().width === rendererWidth &&
                  panel.renderer.getCanvas().height === rendererHeight))
            ) {
              renderersToSave.push(panel.renderer);
            }
          }
        } else {
          // Only shiftKey is pressed, save just the clicked renderer.
          renderersToSave.push(clickedRenderer);
        }
        if (renderersToSave.length > 0) {
          handleSaveAnimation(renderersToSave);
        }
      } else {
        clickedRenderer.draw();
        const canvas = clickedRenderer.getCanvas();
        const base = basenameWithoutExtension(mediaFilename ?? '');
        const suffix = canvas.getAttribute('id') ?? 'out';
        const filename = base ? `${base}_${suffix}.png` : `${suffix}.png`;
        const dataUrl = canvas.toDataURL('image/png');
        download(dataUrl, filename, 'image/png');
      }
    });
  });

  document.querySelectorAll('.save-json-button').forEach((button) => {
    button.addEventListener('click', async (e: Event) => {
      const target = e.currentTarget as HTMLElement;
      if (target.id === 'SaveAllJsonButton') {
        const previousText = saveJsonDropdownButtonEl.textContent;
        saveJsonDropdownButtonEl.textContent = '⌛️';
        try {
          await saveDynamicAgtmJson();
        } finally {
          saveJsonDropdownButtonEl.textContent = previousText;
        }
      } else if (target.id === 'SaveCurrentJsonButton') {
        const json = metadataToJson(agtmMetadata);
        const filename = 'agtm_metadata.json';
        downloadBlob(
          new Blob([json], {type: 'application/octet-stream'}),
          filename,
        );
      }
    });
  });

  saveCurrentBinaryAgtmButtonEl.addEventListener('click', () => {
    const payload = makeAgtmPayload(agtmMetadata);
    const filename = 'agtm_metadata.bin';
    downloadBlob(
      new Blob([payload as BlobPart], {type: 'application/octet-stream'}),
      filename,
    );
  });

  browseContentButtonEl.addEventListener('click', () => {
    contentBrowserEl.hidden = false;
  });

  closeContentBrowserEl.addEventListener('click', () => {
    contentBrowserEl.hidden = true;
  });

  // Create the content browser thumbnails from the select element's options.
  showMediaInfoButtonEl.addEventListener('click', () => {
  mediaInfoDialogEl.showModal();
});
closeMediaInfoDialogEl.addEventListener('click', () => {
  mediaInfoDialogEl.close();
});

const dialogsToCloseOnClickOutside = [mediaInfoDialogEl, permissionDialogEl];
for (const dialog of dialogsToCloseOnClickOutside) {
  dialog.addEventListener('click', (event) => {
    const rect = dialog.getBoundingClientRect();
    const isInDialog =
      rect.top <= event.clientY &&
      event.clientY <= rect.top + rect.height &&
      rect.left <= event.clientX &&
      event.clientX <= rect.left + rect.width;
    if (!isInDialog) {
      dialog.close();
    }
  });
}

populateContentDropdown();
  populateContentBrowser();

  document.querySelectorAll('.tooltip').forEach((tooltip) => {
    const tooltipText = tooltip.querySelector('.tooltip-text') as HTMLElement;
    if (!tooltipText) return;

    const showTooltip = () => {
      tooltipText.classList.add('show');

      // Reset position
      tooltipText.classList.remove('bottom');
      tooltipText.style.left = '50%';
      tooltipText.style.right = 'auto';
      tooltipText.style.transform = 'translateX(-50%)';

      const rect = tooltipText.getBoundingClientRect();
      const viewportWidth = window.innerWidth;

      // Adjust horizontal position
      const containingPanel = tooltip.closest('.panel') as HTMLElement | null;
      const containerRect = containingPanel
        ? containingPanel.getBoundingClientRect()
        : {left: 0, right: viewportWidth};
      if (rect.left < containerRect.left) {
        const overflow = containerRect.left - rect.left;
        tooltipText.style.transform = `translateX(calc(-50% + ${overflow}px))`;
      } else if (rect.right > containerRect.right) {
        const overflow = rect.right - containerRect.right;
        tooltipText.style.transform = `translateX(calc(-50% - ${overflow}px))`;
      }

      // Adjust vertical position
      const adjustedRect = tooltipText.getBoundingClientRect();
      if (adjustedRect.top < 0) {
        tooltipText.classList.add('bottom');
      }
    };

    const hideTooltip = () => {
      tooltipText.classList.remove('show');
      tooltipText.style.left = '';
      tooltipText.style.right = '';
      tooltipText.style.transform = '';
    };

    tooltip.addEventListener('mouseenter', showTooltip);
    tooltip.addEventListener('mouseleave', hideTooltip);
  });

  const applyStateFromHash = async () => {
    isApplyingStateFromHash = true;
    await updateStateFromHash();
    setHeadrooms();
    update();
    renderVisiblePanels();
    isApplyingStateFromHash = false;
  };
  window.addEventListener('hashchange', applyStateFromHash);

  setHeadrooms();
  maybeShowWarnings();

  const scrollSyncer = new PanelScrollSyncer(
    rendererPanels.map((p) => p.panelEl),
  );

  function flip(direction: 'forward' | 'backward') {
    const checkedToggles = rendererPanelToggles.filter((t) => t.checked);
    if (checkedToggles.length === 0) {
      return;
    }

    let currentIndex = -1;
    if (flipModeVisiblePanel) {
      currentIndex = checkedToggles.indexOf(flipModeVisiblePanel);
    }

    let nextIndex;
    if (direction === 'forward') {
      nextIndex = (currentIndex + 1) % checkedToggles.length;
    } else {
      // backward
      if (currentIndex === -1) {
        // When going backward from an unknown state, go to the last item.
        nextIndex = checkedToggles.length - 1;
      } else {
        nextIndex =
          (currentIndex - 1 + checkedToggles.length) % checkedToggles.length;
      }
    }

    const panel = checkedToggles[nextIndex];
    setFlipPanel(panel);
    setHash('flip', panelToggleToHashName.get(panel)!);
    update();
    renderVisiblePanels();
    scrollSyncer.syncVisiblePanels();
  }

  signalTransferEl.addEventListener('change', async (e) => {
    setHash('tf', signalTransferEl.value);
    await onSignalTransferChange();
    renderVisiblePanels();
  });
  signalPrimariesEl.addEventListener('change', (e) => {
    setHash('pri', signalPrimariesEl.value);
    onSignalPrimariesChange();
    renderVisiblePanels();
  });
  contentSelectEl.addEventListener('change', (e) => {
    unsetHash('t'); // Reset the time slider.
    loadSelectedContent();
    setHashes({
      'content': contentSelectEl.value,
      'tf': null,
      'pri': null,
    });
  });


  let previousMetadataType: string | null = null;
  metadataSelectEl.addEventListener('focus', () => {
    previousMetadataType = metadataSelectEl.value;
  });

  jsonUploadEl.addEventListener('change', async (e) => {
    const files = (e.target as HTMLInputElement).files;
    if (files && files.length > 0) {
      await onFileList(files);
    } else {
      // User cancelled.
      if (previousMetadataType) {
        metadataSelectEl.value = previousMetadataType;
      }
    }
  });

  metadataSelectEl.addEventListener('change', async (e) => {
    await onMetadataTypeChange();
  });

  pauseResumeDynamicAgtmButtonEl.addEventListener('click', async () => {
    isDynamicAgtmPaused = !isDynamicAgtmPaused;
    if (isDynamicAgtmPaused) {
      pauseResumeDynamicAgtmButtonEl.textContent = 'Resume';
    } else {
      pauseResumeDynamicAgtmButtonEl.textContent = 'Pause';
      if (dynamicAgtmPauseResolver) {
        dynamicAgtmPauseResolver();
        dynamicAgtmPauseResolver = null;
      }
    }
  });

  dynamicAgtmEl.addEventListener('change', async () => {
    const mode = dynamicAgtmEl.value;
    if (mode === 'off') {
      unsetHash('dyn');
    } else {
      setHash('dyn', mode);
    }
    if (mode === 'all') {
      if (dynamicAgtmComputationPromise) return;
      dynamicAgtmComputationPromise = computeDynamicAgtmMetadata();
    } else {
      if (dynamicAgtmController) {
        dynamicAgtmController.abort();
      }
      dynamicAgtmMetadata = null;
      dynamicAgtmComputedStats = null;
      timeSliderEl.style.background = '';
      if (mode === 'seek') {
        const currentFrameStats = await getStatsForCurrentFrame();
        if (currentFrameStats) {
          setStats(currentFrameStats);
        }
      }
      updateSaveAgtmButtons();
      await setAgtmMetadata();
      renderVisiblePanels();
    }
  });

  const lutChangeHandler = () => {
    const options = getLutOptions();
    getRenderer('agtm_lut', AgtmRenderer)?.setLutOptions(options);
    renderVisiblePanels();
    // Set the hashes based on input element values directly, note the values in
    // the LutOptions since some of them are overridden (e.g. LUT size forced
    // to 0 for unused LUTs).
    setHashes({
      'lut': agtmLutSizeInputEl.value,
      'lut1d': agtm1dLutSizeInputEl.value,
      'lut_type': agtmLutTypeSelectEl.value,
      'lut1d_type': agtmSamplingTypeSelectEl.value,
      'lut_in_space': agtmLutInputColorSpaceSelectEl.value,
    });
  };
  agtmLutSizeInputEl.addEventListener('change', lutChangeHandler);
  agtm1dLutSizeInputEl.addEventListener('change', lutChangeHandler);
  agtmLutTypeSelectEl.addEventListener('change', lutChangeHandler);
  agtmSamplingTypeSelectEl.addEventListener('change', lutChangeHandler);
  agtmLutInputColorSpaceSelectEl.addEventListener('change', lutChangeHandler);

  componentMixSelectEl.addEventListener('change', (e) => {
    const mixType = componentMixSelectEl.value;
    setComponentMixFunction();
    onMetadataChanged();
    renderVisiblePanels();
    setHash('mix', mixType);
    requestRestartDynamicAgtm();
  });
  panelDisplayModeEl.addEventListener('change', () => {
    const updates: {[key: string]: string | null} = {
      'display': panelDisplayModeEl.value,
    };
    if (panelDisplayModeEl.value === 'flip') {
      const checkedToggles = rendererPanelToggles.filter((t) => t.checked);
      let panelToShow: HTMLInputElement;
      if (checkedToggles.length > 0) {
        panelToShow = checkedToggles[0];
      } else {
        // If nothing is checked, check native and show it.
        const nativePanel = rendererPanels[0];
        nativePanel.toggle.checked = true;
        if (nativePanel.defaultChecked) {
          updates[nativePanel.hashName] = null;
        } else {
          updates[nativePanel.hashName] = '1';
        }
        panelToShow = nativePanel.toggle;
      }
      flipModeVisiblePanel = panelToShow;
      updates['flip'] = panelToggleToHashName.get(panelToShow)!;
    } else {
      updates['flip'] = null;
    }
    setHashes(updates);
    update();
    renderVisiblePanels();
    scrollSyncer.syncVisiblePanels();
  });

  playPauseEl.addEventListener('click', (e) => {
    if (myVideoEl.paused) {
      myVideoEl.play();
    } else {
      myVideoEl.pause();
    }
  });

  myVideoEl.addEventListener('play', () => {
    unsetHash('t');
  });

  const updateTimeHash = () => {
    if (myVideoEl.paused) {
      const currentTime = myVideoEl.currentTime;
      // Round to 3 decimal places to avoid long URLs.
      const timeStr = currentTime.toFixed(3);
      if (Number(timeStr) > 0) {
        setHash('t', timeStr);
      } else {
        unsetHash('t');
      }
    }
  };
  myVideoEl.addEventListener('pause', updateTimeHash);
  myVideoEl.addEventListener('seeked', async () => {
    updateTimeHash();
    if (dynamicAgtmEl.value === 'all' && dynamicAgtmMetadata) {
      await setAgtmMetadata();
      renderVisiblePanels();
    } else if (dynamicAgtmEl.value === 'seek') {
      await recomputeAgtmForCurrentFrame();
    }
  });

  myVideoEl.addEventListener('loadedmetadata', () => {
    const time = getHash('t');
    if (time) {
      myVideoEl.currentTime = Number(time);
    }
  });

  myVideoEl.addEventListener('ended', () => {
    if (!myVideoEl.loop) {
      myVideoEl.currentTime = 0;
    }
  });

  loopButtonEl.addEventListener('click', () => {
    myVideoEl.loop = !myVideoEl.loop;
    loopButtonEl.classList.toggle('active', myVideoEl.loop);
    if (myVideoEl.loop) {
      setHash('loop', '1');
    } else {
      unsetHash('loop');
    }
  });

  document.body.addEventListener('drop', async (e) => {
    e.preventDefault();
    contentBrowserEl.hidden = true;
    await onFileList(e.dataTransfer!.files);
  });
  document.body.addEventListener('dragover', (e) => {
    e.preventDefault();
  });

  const metadataJsonEl = getPanelEl('json').querySelector('textarea')!;
  metadataJsonEl.addEventListener('change', (e) => {
    agtmMetadata = jsonToMetadata(metadataJsonEl.value);

    const pri = agtmMetadata.gain_application_space_primaries ?? -1;
    if (pri === -1 && agtmMetadata.gain_application_space_chromaticities) {
      setHash(
        'custom_pri',
        agtmMetadata.gain_application_space_chromaticities.join(','),
      );
      setHash('gain_pri', '-1');
      gainApplicationSpacePrimariesOverridden = true;
      customGainApplicationSpaceChromaticitiesHash =
        agtmMetadata.gain_application_space_chromaticities;
    } else {
      setHash('gain_pri', String(pri));
      unsetHash('custom_pri');
      gainApplicationSpacePrimariesOverridden = true;
      customGainApplicationSpaceChromaticitiesHash = null;
    }

    onMetadataChanged();
    renderVisiblePanels();
  });
  altrIndexEl.addEventListener('change', (e) => {
    getRenderer('curves', CurveEditor)?.setAltrIndex(Number(altrIndexEl.value));
    setHash('altr', altrIndexEl.value);
    onMetadataChanged();
    renderVisiblePanels();
  });
  resetHdrReferenceWhiteButtonEl.addEventListener('click', async () => {
    hdrReferenceWhiteOverridden = false;
    unsetHash('ref_white');
    await setAgtmMetadata();
    renderVisiblePanels();
    requestRestartDynamicAgtm();
  });
  hdrReferenceWhiteSliderEl.addEventListener('input', async (e) => {
    hdrReferenceWhiteOverridden = true;
    const value = Number(hdrReferenceWhiteSliderEl.value);
    setHash('ref_white', value.toString());
    await setAgtmMetadata(value);
    renderVisiblePanels();
    requestRestartDynamicAgtm();
  });
  resetBaselineHeadroomLinearButtonEl.addEventListener('click', async () => {
    baselineHeadroomLinearOverridden = false;
    unsetHash('max_comp');
    await setAgtmMetadata();
    renderVisiblePanels();
    requestRestartDynamicAgtm();
  });
  baselineHeadroomSliderEl.addEventListener('input', async (e) => {
    baselineHeadroomLinearOverridden = true;
    const value = Number(baselineHeadroomSliderEl.value);
    setHash('max_comp', value.toString());
    await setAgtmMetadata(undefined, value);
    renderVisiblePanels();
    requestRestartDynamicAgtm();
  });
  gainApplicationSpacePrimariesSelectEl.addEventListener('change', () => {
    gainApplicationSpacePrimariesOverridden = true;
    applyGainApplicationSpacePrimaries(agtmMetadata);
    setHash('gain_pri', gainApplicationSpacePrimariesSelectEl.value);
    if (
      gainApplicationSpacePrimariesSelectEl.value === '-1' &&
      agtmMetadata.gain_application_space_chromaticities
    ) {
      setHash(
        'custom_pri',
        agtmMetadata.gain_application_space_chromaticities.join(','),
      );
    } else {
      unsetHash('custom_pri');
    }
    onMetadataChanged();
    renderVisiblePanels();
    requestRestartDynamicAgtm();
  });

  resetGainApplicationSpacePrimariesButtonEl.addEventListener(
    'click',
    async () => {
      gainApplicationSpacePrimariesOverridden = false;
      unsetHash('gain_pri');
      unsetHash('custom_pri');
      await setAgtmMetadata();
      renderVisiblePanels();
      requestRestartDynamicAgtm();
    },
  );



  resetAllButtonEl.addEventListener('click', async () => {
    resetMetadataOverrides();
    await setAgtmMetadata();
    renderVisiblePanels();
    requestRestartDynamicAgtm();
  });

  const smpte209440El = getPanelEl('smpte209440') as HTMLTextAreaElement;
  smpte209440El.addEventListener('change', (e) => {
    try {
      hdr10pMetadata = JSON.parse(smpte209440El.value) as Hdr10pMetadata;
      getRenderer('hdr10plus', Hdr10pRenderer)?.setMetadata(hdr10pMetadata);
      getRenderer('hdr10pcurves', Hdr10pRenderer)?.setMetadata(hdr10pMetadata);
    } catch (e) {
      console.error('Failed to parse SMPTE 2094-40 metadata: ', e);
      getRenderer('hdr10plus', Hdr10pRenderer)?.setMetadata(null);
      getRenderer('hdr10pcurves', Hdr10pRenderer)?.setMetadata(null);
    }
    getRenderer('hdr10plus', Hdr10pRenderer)?.draw();
    getRenderer('hdr10pcurves', Hdr10pRenderer)?.draw();
  });
  timeSliderEl.addEventListener(
    'input',
    (e) => {
      myVideoEl.currentTime = Number(timeSliderEl.value);
    },
    false,
  );
  timeSliderValueEl.addEventListener(
    'change',
    (e) => {
      myVideoEl.currentTime = Number(timeSliderValueEl.value);
    },
    false,
  );
  headroomSliderEl.addEventListener(
    'input',
    (e) => {
      keepHeadroomSetToNativeHeadroom = false;
      setHeadrooms();
      renderVisiblePanels();
      setHash('hr', headroomSliderEl.value);
    },
    false,
  );
  setHeadroomToNativeButton.addEventListener('click', () => {
    keepHeadroomSetToNativeHeadroom = true;
    headroomSliderEl.value = String(Math.log2(nativeHeadroomLinear));
    setHeadrooms();
    renderVisiblePanels();
    unsetHash('hr');
  });
  nativeNitsEl.addEventListener('input', (e) => {
    if (nativeNitsPresetsEl.value !== 'sdr_nits') {
      nativeNitsPresetsEl.value = '0'; // Custom
    }
    setHeadrooms();
    renderVisiblePanels();
    setHashes({
      'natnits': nativeNitsEl.value,
      'natnits_preset': nativeNitsPresetsEl.value,
    });
  });
  nativeNitsPresetsEl.addEventListener('change', (e) => {
    if (nativeNitsPresetsEl.value !== '0') {
      if (nativeNitsPresetsEl.value === 'sdr_nits') {
        nativeNitsEl.value = '200';
      } else {
        nativeNitsEl.value = nativeNitsPresetsEl.value;
      }
      setHeadrooms();
      renderVisiblePanels();
      setHashes({
        'natnits': nativeNitsEl.value,
        'natnits_preset': nativeNitsPresetsEl.value,
      });
    }
  });



  lumaModeSelectEl.addEventListener('change', (e) => {
    const mode = lumaModeSelectEl.value as LumaMode;
    const lumaRenderer = getRenderer('luma', LumaRenderer);
    lumaRenderer?.setMode(mode);
    lumaRenderer?.draw();
    setHash('luma_mode', mode);
  });

  // Panel toggles
  for (const panel of rendererPanels) {
    panel.toggle.addEventListener('change', () => {
      const updates: {[key: string]: string | null} = {};
      if (panel.toggle.checked === panel.defaultChecked) {
        updates[panel.hashName] = null;
      } else {
        updates[panel.hashName] = panel.toggle.checked ? '1' : '0';
      }
      if (panelDisplayModeEl.value === 'flip') {
        if (panel.toggle.checked) {
          setFlipPanel(panel.toggle);
        } else if (flipModeVisiblePanel === panel.toggle) {
          // If the unchecked panel was the visible one, find a new one to show.
          const checkedToggles = rendererPanelToggles.filter((t) => t.checked);
          setFlipPanel(checkedToggles.length > 0 ? checkedToggles[0] : null);
        }
        // After updating flipModeVisiblePanel, update the hash.
        if (flipModeVisiblePanel) {
          updates['flip'] = panelToggleToHashName.get(flipModeVisiblePanel)!;
        } else {
          updates['flip'] = null;
        }
      }
      // Update state and display.
      setHashes(updates);
      update();
      renderVisiblePanels();
      scrollSyncer.syncVisiblePanels();
    });
  }
  flipButton.addEventListener('click', (e) => {
    flip('forward');
  });

  for (const panel of miscPanels) {
    panel.toggle.addEventListener('change', () => {
      if (panel.toggle.checked === panel.defaultChecked) {
        unsetHash(panel.hashName);
      } else {
        setHash(panel.hashName, panel.toggle.checked ? '1' : '0');
      }
      if (panel.hashName === 'stats' && panel.toggle.checked) {
        updateStats();
      }
      update();
      if (panel.hashName === 'stats' && panel.toggle.checked) {
        renderVisiblePanels();
      } else {
        panel.renderer?.draw();
      }
    });
  }
  // Other
  sdrBloatToggle.addEventListener('change', (e) => {
    setHash('sdrbloat', sdrBloatToggle.checked ? '1' : '0');
    for (const element of sdrBloatEls) {
      element.hidden = !sdrBloatToggle.checked;
    }
    for (const element of sdrBloatParentEls) {
      element.hidden = !sdrBloatToggle.checked;
    }
  });

  showClampedToggle.addEventListener('change', (e) => {
    const checked = showClampedToggle.checked;
    for (const panel of allPanels) {
      if (!panel.renderer) continue;
      const renderer = panel.renderer;
      if (
        renderer instanceof AgtmRenderer ||
        renderer instanceof Hdr10pRenderer ||
        renderer instanceof HdrRenderer
      ) {
        renderer.setShowClamped(checked);
      }
    }
    renderVisiblePanels();
    setHash('clamped', checked ? '1' : '0');
  });
  showGainCurveEl.addEventListener('change', (e) => {
    const checked = showGainCurveEl.checked;
    const curveEditor = getRenderer('curves', CurveEditor);
    curveEditor?.setShowGainCurve(checked);
    curveEditor?.draw();
    setHash('gain', checked ? '1' : '0');
  });

  showControlPointsEl.addEventListener('change', (e) => {
    const checked = showControlPointsEl.checked;
    const curveEditor = getRenderer('curves', CurveEditor);
    curveEditor?.setShowControlPoints(checked);
    curveEditor?.draw();
    if (checked) {
      unsetHash('points');
    } else {
      setHash('points', '0');
    }
  });

  statsModesEl.querySelectorAll('input[name="stats_mode"]').forEach((radio) => {
    radio.addEventListener('change', (e) => {
      setHash('stats_mode', (e.currentTarget as HTMLInputElement).value);
    });
  });

  logNitsEl.addEventListener('change', () => {
    setHash('log_nits', logNitsEl.checked ? '1' : '0');
  });

  logPercentEl.addEventListener('change', () => {
    setHash('log_percent', logPercentEl.checked ? '1' : '0');
  });

  uploadButtonEl.addEventListener('change', async (e) => {
    await onFileList(uploadButtonEl.files!);
  });
  uploadButtonFakeEl.addEventListener('click', () => {
    uploadButtonEl.click();
  });
  hideUiButton.addEventListener('click', () => {
    settingsEl.hidden = !settingsEl.hidden;
  });

  window.addEventListener('keydown', (e) => {
    const noModifiers = !e.ctrlKey && !e.altKey && !e.metaKey;
    if (e.code === 'Escape') {
      if (!contentBrowserEl.hidden) {
        contentBrowserEl.hidden = true;
      } else {
        settingsEl.hidden = !settingsEl.hidden;
      }
    } else if (e.code === 'KeyF') {
      if (e.shiftKey) {
        e.preventDefault();
        // Shift+F: Flip backwards
        if (panelDisplayModeEl.value === 'flip') {
          flip('backward');
        }
      } else if (noModifiers) {
        e.preventDefault();
        // F: Switch to flip mode or flip forwards, only if no other modifiers are pressed.
        if (panelDisplayModeEl.value !== 'flip') {
          panelDisplayModeEl.value = 'flip';
          panelDisplayModeEl.dispatchEvent(new Event('change'));
        } else {
          flip('forward');
        }
      }
    } else if (e.code === 'KeyS' && noModifiers) {
      e.preventDefault();
      if (panelDisplayModeEl.value !== 'sbs') {
        panelDisplayModeEl.value = 'sbs';
        panelDisplayModeEl.dispatchEvent(new Event('change'));
      }
    }
  });

  // Configure the HDR screen info.
  {
    const screenDetails = async () => {
      const screens = await window.getScreenDetails();
      const updateCurrentScreenInfo = (screen: ScreenDetailed) => {
        nativeHeadroomLinear = 1;
        if (
          screen.highDynamicRangeHeadroom &&
          screen.highDynamicRangeHeadroom >= 1
        ) {
          nativeHeadroomLinear = Number(screen.highDynamicRangeHeadroom);
          nativeHeadroomLinearEl.innerText = nativeHeadroomLinear.toFixed(2);
        } else {
          nativeHeadroomLinear = 1;
          nativeHeadroomLinearEl.innerText = `n/a (${nativeHeadroomLinear.toFixed(2)})`;
        }
        const nativeHeadroomLog2 = Math.log2(nativeHeadroomLinear);
        nativeHeadroomLog2El.innerText = nativeHeadroomLog2.toFixed(2);
        const maxLog2 = Math.max(nativeHeadroomLog2, 4);
        headroomSliderEl.max = String(maxLog2);
        if (keepHeadroomSetToNativeHeadroom) {
          headroomSliderEl.value = String(nativeHeadroomLog2);
        }
        nativeHeadroomSliderEl.style.left = `${(nativeHeadroomLog2 / maxLog2) * 100}%`;
        setHeadrooms();
        renderVisiblePanels();
      };
      updateCurrentScreenInfo(screens.currentScreen);
      screens.addEventListener('currentscreenchange', async (event: Event) => {
        const screens = await window.getScreenDetails();
        updateCurrentScreenInfo(screens.currentScreen);
      });
    };
    const tryScreenDetails = async () => {
      if (getHash('noperm') === '1') { // Useful for tests.
        return;
      }
      try {
        await screenDetails();
      } catch (e: unknown) {
        if (e instanceof Error && e.name === 'NotAllowedError') {
          permissionDialogEl.showModal();
        } else {
          console.error('getScreenDetails() failed:', e);
        }
      }
    };
    permissionButtonEl.addEventListener('click', async () => {
      try {
        await screenDetails();
        permissionDialogEl.close();
      } catch (e: unknown) {
        permissionStep2El.hidden = false;
      }
    });
    closePermissionDialogEl.addEventListener('click', () => {
      permissionDialogEl.close();
    });
    tryScreenDetails();
  }

  applyStateFromHash();
}
