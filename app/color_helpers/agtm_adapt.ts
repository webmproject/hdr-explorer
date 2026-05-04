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

import {AgtmMetadata, Altr} from './agtm';
import {
  getLumaCoeffs,
  getMaxNits,
  kPrimariesP3,
  kPrimariesRec2020,
  kTransferHLG,
  kTransferPQ,
  primariesConvert,
  transferFromLinear,
  transferToLinear,
} from './color_functions';
import {clamp, exp2, Mat3, mat3Inv, mat3Mvm} from './math_helpers';
import {PiecewiseCubic} from './piecewise_cubic';
export {
  getLumaCoeffs,
  getMaxNits,
  kPrimariesP3,
  kPrimariesRec2020,
  kTransferHLG,
  kTransferPQ,
  primariesConvert,
  transferFromLinear,
  transferToLinear,
};

/**
 * Returns the zero gain altr for the given metadata.
 */
function getZeroGainAltr(metadata: AgtmMetadata): Altr {
  return {
    headroom: metadata.baseline_hdr_headroom,
    curve: [{x: 64, y: 0, m: 0}], // Zero gain curve.
    mix: {
      // Mix doesn't matter for zero gain.
      rgb: [0, 0, 0],
      max: 0,
      min: 0,
      channel: 1,
    },
  };
}

export function getGainApplicationPrimaries(
  metadata: AgtmMetadata,
): number | number[] {
  return (
    metadata.gain_application_space_primaries ??
    metadata.gain_application_space_chromaticities ??
    kPrimariesRec2020
  );
}

/**
 * Returns the altrs for the given metadata, sorted by headroom, including the
 * implicit zero gain altr (made explicit).
 */
export function getSortedAltrsWithZeroGain(metadata: AgtmMetadata): Altr[] {
  // The specification forbids having an altr headroom equal to the baseline
  // headroom, so this shouldn't happen, but remove it just in case.
  const altrs = metadata.altr.filter(
    (a) => a.headroom !== metadata.baseline_hdr_headroom,
  );
  altrs.push(getZeroGainAltr(metadata));
  altrs.sort((a, b) => a.headroom - b.headroom);
  return altrs;
}

/**
 * Result of AGTM adaptation.
 */
export interface AgtmAdaptResult {
  // Indices of altrI/J in the array returned by getSortedAltrsWithZeroGain().
  indexI: number;
  indexJ: number;
  altrI: Altr; // allAltrs[indexI]
  altrJ: Altr; // allAltrs[indexJ]
  weightI: number; // Weight to use for altrI.
  weightJ: number; // Weight to use for altrJ.
}

/**
 * Returns AGTM tone mapping parameters based on headroom.
 * @param metadata AGTM metadata.
 * @param headroom The target headroom.
 * @return The adaptation result.
 */
export function agtmAdapt(
  metadata: AgtmMetadata,
  headroom: number,
): AgtmAdaptResult {
  const altrs = getSortedAltrsWithZeroGain(metadata);

  let altrMin = 0;
  let altrMax = altrs.length - 1;

  // Binary search
  while (altrMax - altrMin > 1) {
    const altrMid = Math.round((altrMin + altrMax) / 2);
    if (headroom <= altrs[altrMid].headroom) {
      altrMax = altrMid;
    }
    if (headroom >= altrs[altrMid].headroom) {
      altrMin = altrMid;
    }
  }

  let wMin = 1.0;
  let wMax = 0.0;
  const hMin = altrs[altrMin].headroom;
  const hMax = altrs[altrMax].headroom;
  if (hMax > hMin) {
    wMax = clamp((headroom - hMin) / (hMax - hMin), 0.0, 1.0);
    wMin = 1.0 - wMax;
  }

  return {
    indexI: altrMin,
    indexJ: altrMax,
    altrI: altrs[altrMin],
    altrJ: altrs[altrMax],
    weightI: wMin,
    weightJ: wMax,
  };
}

/**
 * Computes the component mix values for the given RGB values.
 * @param sdrRelative The RGB values relative to the reference white.
 * @param contentPrimaries The color space of the sdrRelative values.
 * @param metadata The AGTM metadata.
 * @return The component mix values for each channel.
 */
export function getComponentMixValue(
  sdrRelative: number[],
  contentPrimaries: number | number[],
  metadata: AgtmMetadata,
  altr: Altr,
): [number, number, number] {
  const mix = altr.mix;

  const rgb = primariesConvert(
    sdrRelative,
    contentPrimaries,
    getGainApplicationPrimaries(metadata),
  );

  const weightSum =
    mix.rgb[0] + mix.rgb[1] + mix.rgb[2] + mix.max + mix.min + mix.channel;
  if (weightSum <= 0) {
    // Invalid mix coefficients.
    console.warn('component mix sum is <= 0');
    return [0, 0, 0];
  }

  const maxC = Math.max(rgb[0], rgb[1], rgb[2]);
  const minC = Math.min(rgb[0], rgb[1], rgb[2]);
  const luma = mix.rgb[0] * rgb[0] + mix.rgb[1] * rgb[1] + mix.rgb[2] * rgb[2];

  const baseValue = (mix.max ?? 0) * maxC + (mix.min ?? 0) * minC + luma;
  const values = rgb.map(
    (c: number) => (baseValue + (mix.channel ?? 0) * c) / weightSum,
  );
  return [values[0], values[1], values[2]];
}

/**
 * Computes the tonemapped RGB values.
 */
export function agtmToneMap(
  sdrRelative: number[],
  contentPrimaries: number | number[],
  metadata: AgtmMetadata,
  adaptation: AgtmAdaptResult,
): number[] {
  const curveI = new PiecewiseCubic(adaptation.altrI.curve);
  const curveJ = new PiecewiseCubic(adaptation.altrJ.curve);
  const mixI = getComponentMixValue(
    sdrRelative,
    contentPrimaries,
    metadata,
    adaptation.altrI,
  );
  const mixJ = getComponentMixValue(
    sdrRelative,
    contentPrimaries,
    metadata,
    adaptation.altrJ,
  );
  const logGainsI = mixI.map((mix) => curveI.evaluate(mix).y);
  const logGainsJ = mixJ.map((mix) => curveJ.evaluate(mix).y);
  const logGains = logGainsI.map(
    (gI, i) => adaptation.weightI * gI + adaptation.weightJ * logGainsJ[i],
  );
  const tonemapped = sdrRelative.map((c, i) => c * exp2(logGains[i]));
  return tonemapped;
}

/**
 * Computes the tonemapped RGB values for a gray color (all 3 channels equal).
 */
export function grayAdaptation(
  sdrRelative: number,
  metadata: AgtmMetadata,
  targetedHdrHeadroom: number,
): number {
  const gray = [sdrRelative, sdrRelative, sdrRelative];
  const adaptation = agtmAdapt(metadata, targetedHdrHeadroom);
  const tonemapped = agtmToneMap(
    gray,
    // Assume the color is already in the gain application space, so no color
    // space conversion is needed. For gray, color space conversion is a no-op.
    getGainApplicationPrimaries(metadata),
    metadata,
    adaptation,
  )[0];
  return tonemapped;
}

/**
 * Converts SDR relative values to PQ in [0, 1].
 */
export function toPq(sdrRelative: number, metadata: AgtmMetadata) {
  const unitized = (sdrRelative * metadata.hdr_reference_white) / 10000;
  return transferFromLinear(unitized, kTransferPQ);
}

/**
 * Converts PQ values in [0, 1] to SDR relative values.
 */
export function fromPq(lut1d: number, metadata: AgtmMetadata) {
  return (
    (transferToLinear(lut1d, kTransferPQ) * 10000) /
    metadata.hdr_reference_white
  );
}

export type LookupTable = Array<{x: number; y: number}>;

/**
 * Generates an inverse lookup table for the given function.
 * This is basically a normal LUT but containing both x and y values and sorted
 * by y. The x values are normalized to the range [0, 1].
 * @param lutSize The size of the lookup table.
 * @param f The function to generate the lookup table for.
 * @param lutInputMax The maximum input value to sample the f function at.
 * @return The lookup table.
 */
export function generateInverseLut(
  lutSize: number,
  f: (x: number) => number,
  lutInputMax: number,
): LookupTable {
  const forwardLut = Array.from(generate1dLut(lutSize, f, lutInputMax));
  const lut: LookupTable = forwardLut.map((y, idx) => {
    const unitized = idx / (lutSize - 1);
    return {x: unitized, y};
  });
  lut.sort((a, b) => a.y - b.y); // Sort by y.
  return lut;
}

/**
 * Approximates the inverse function x = f^{-1}(y) using linear interpolation
 * on a pre-calculated lookup table.
 * @param targetY The input value for the inverse function.
 * @param table The lookup table pre-sorted by y values.
 * @returns The estimated x-value.
 */
export function inverseFunctionApprox(
  targetY: number,
  table: LookupTable,
): number {
  if (targetY <= table[0].y) {
    return table[0].x;
  }
  if (targetY >= table[table.length - 1].y) {
    return table[table.length - 1].x;
  }

  // Use binary search to find the index `i` such that table[i].y <= targetY < table[i+1].y.
  let low = 0;
  let high = table.length - 2; // We need table[i] and table[i+1]
  let i = 0;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (table[mid].y < targetY) {
      i = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  const y1 = table[i].y;
  const x1 = table[i].x;
  const y2 = table[i + 1].y;
  const x2 = table[i + 1].x;

  if (y2 === y1) {
    return x1;
  }
  const ratio = (targetY - y1) / (y2 - y1);
  return x1 + (x2 - x1) * ratio;
}

/**
 * Samples a 3D LUT using tetrahedral interpolation.
 * @param unitized The normalized texture coordinates in [0, 1].
 * @param lut3d The 3D LUT data as a 1D array.
 * @param lutSize The size of the 3D LUT.
 * @return The sampled RGB values.
 */
// Same as Sample3dTex3dTetrahedral in agtm_tone_map.glsl.
export function sample3dTex3dTetrahedral(
  unitized: number[],
  lut3d: Float32Array,
  lutSize: number,
): number[] {
  const N = lutSize;
  if (N <= 1) {
    return [0, 0, 0];
  }
  const C = unitized.map((c) => clamp(c, 0, 1) * (N - 1));
  const K = C.map(Math.floor);
  const X = C.map((c, i) => c - K[i]);

  let A: number[];
  let B: number[];
  if (X[0] >= X[1] && X[1] >= X[2]) {
    A = [1, 0, 0];
    B = [1, 1, 0];
  } else if (X[1] >= X[0] && X[0] >= X[2]) {
    A = [1, 1, 0];
    B = [0, 1, 0];
  } else if (X[1] >= X[2] && X[2] >= X[0]) {
    A = [0, 1, 0];
    B = [0, 1, 1];
  } else if (X[2] >= X[1] && X[1] >= X[0]) {
    A = [0, 1, 1];
    B = [0, 0, 1];
  } else if (X[2] >= X[0] && X[0] >= X[1]) {
    A = [0, 0, 1];
    B = [1, 0, 1];
  } else {
    // X[0] >= X[2] && X[2] >= X[1]
    A = [1, 0, 1];
    B = [1, 0, 0];
  }

  const L = [1, 1, 1];
  const M: Mat3 = {
    xx: L[0],
    xy: A[0],
    xz: B[0],
    yx: L[1],
    yy: A[1],
    yz: B[1],
    zx: L[2],
    zy: A[2],
    zz: B[2],
  };
  const invM = mat3Inv(M);
  const wPoint = mat3Mvm(invM, {x: X[0], y: X[1], z: X[2]});
  const w = [wPoint.x, wPoint.y, wPoint.z];
  const wK = 1.0 - w[0] - w[1] - w[2];

  const sampleNearest = (q: number[]): number[] => {
    const r = clamp(Math.round(q[0]), 0, N - 1);
    const g = clamp(Math.round(q[1]), 0, N - 1);
    const b = clamp(Math.round(q[2]), 0, N - 1);
    const idx = (r * N * N + g * N + b) * 4;
    return [lut3d[idx], lut3d[idx + 1], lut3d[idx + 2]];
  };

  const K_L = [K[0] + L[0], K[1] + L[1], K[2] + L[2]];
  const K_A = [K[0] + A[0], K[1] + A[1], K[2] + A[2]];
  const K_B = [K[0] + B[0], K[1] + B[1], K[2] + B[2]];

  const sK = sampleNearest(K);
  const sL = sampleNearest(K_L);
  const sA = sampleNearest(K_A);
  const sB = sampleNearest(K_B);

  const result = [0, 0, 0];
  for (let i = 0; i < 3; ++i) {
    result[i] = wK * sK[i] + w[0] * sL[i] + w[1] * sA[i] + w[2] * sB[i];
  }
  return result;
}

type ToLut1dFunc = (sdrRelative: number) => number;

/** Type of 1D/3D LUT to generate. */
export type LutType = 'gray' | 'grayaff' | 'pq' | '3donly' | '1donly' | 'nolut';
/**
 * Input space for the LUT. Corresponds to the "sampling key" type in the
 * Android API.
 */
export type SamplingType = 'rgb' | 'maxrgb' | 'ciey';
/**
 * Input color space for the LUT.
 * 'gain': the gain application space from the AGTM metadata.
 * 'content': the color space of the input content.
 * 'p3': P3 color space.
 */
export type LutInputColorSpaceMode = 'gain' | 'content' | 'p3';

/**
 * Options for LUT generation.
 */
export interface LutOptions {
  lut1dSize: number;
  /** Size of the 3D LUT (N). The number of elements is N*N*N. */
  lut3dSize: number;
  lutType: LutType;
  samplingType: SamplingType;
  inputColorSpaceMode: LutInputColorSpaceMode;
}
export const kLutOptionsNoLut: LutOptions = {
  lut1dSize: 0,
  lut3dSize: 0,
  lutType: 'gray',
  samplingType: 'rgb',
  inputColorSpaceMode: 'gain',
};

export function lutOptionsAreEqual(a: LutOptions, b: LutOptions): boolean {
  return (
    a.lut1dSize === b.lut1dSize &&
    a.lut3dSize === b.lut3dSize &&
    a.lutType === b.lutType &&
    a.samplingType === b.samplingType &&
    a.inputColorSpaceMode === b.inputColorSpaceMode
  );
}

export function getLutInputPrimaries(
  metadata: AgtmMetadata,
  options: LutOptions,
  contentPrimaries: number | number[],
): number | number[] {
  if (options.inputColorSpaceMode === 'content') {
    return contentPrimaries;
  } else if (options.inputColorSpaceMode === 'p3') {
    return kPrimariesP3;
  }
  return getGainApplicationPrimaries(metadata);
}

/**
 * Applies the HLG Opto-Optical Transfer Function (OOTF) to RGB values.
 * The input values are expected to be unitized, where 1.0 corresponds to 1000 nits.
 * The OOTF is defined in Rec. 2020 color space, so an internal conversion is performed.
 * @param unitizedRgb The RGB values in [0, 1].
 * @param contentPrimaries The color space of the unitizedRgb values.
 * @return The RGB values after applying the OOTF.
 */
function applyHlgOotfUnitized(
  unitizedRgb: number[],
  contentPrimaries: number | number[],
): number[] {
  const rgbRec2020 = primariesConvert(
    unitizedRgb,
    contentPrimaries,
    kPrimariesRec2020,
  );
  const luma =
    0.2627 * rgbRec2020[0] + 0.678 * rgbRec2020[1] + 0.0593 * rgbRec2020[2];
  const multiplier = Math.pow(Math.max(0, luma), 0.2);
  const afterOotfRec2020 = rgbRec2020.map((c: number) => c * multiplier);
  return primariesConvert(
    afterOotfRec2020,
    kPrimariesRec2020,
    contentPrimaries,
  );
}

export function applyHlgOotf(
  sdrRelative: number[],
  contentPrimaries: number | number[],
  metadata: AgtmMetadata,
): number[] {
  // Scale from SDR relative to a 1000-nit unitized scale.
  const unitizedRgb = sdrRelative.map(
    (c) => (c * metadata.hdr_reference_white) / 1000,
  );
  const afterOotfUnitized = applyHlgOotfUnitized(unitizedRgb, contentPrimaries);
  // Scale back from 1000-nit unitized to SDR relative.
  return afterOotfUnitized.map(
    (c) => (c * 1000) / metadata.hdr_reference_white,
  );
}

/**
 * Returns a function to convert from SDR relative to the LUT 1D output.
 * The function takes SDR-relative values as input and outputs values in [0, 1].
 * If contentTransfer is HLG, the function will also apply the HLG OOTF.
 * Returns null if lutType is '3donly' or 'nolut'.
 */
export function getToLut1d(
  lutType: LutType,
  metadata: AgtmMetadata,
  targetedHdrHeadroom: number,
  contentTransfer: number,
): ToLut1dFunc | null {
  const lutInputMax =
    getMaxNits(contentTransfer) / (metadata.hdr_reference_white ?? 203);
  const func = getToLut1dFunc(
    lutType,
    metadata,
    targetedHdrHeadroom,
    lutInputMax,
  );
  if (!func) {
    return null;
  }
  if (contentTransfer !== kTransferHLG) {
    return func;
  }
  // In the Android LUT API, for HLG content the LUT input have not had the HLG
  // OOTF applied yet so we need to apply it in the LUTs.
  const withHlgOotf: ToLut1dFunc = (sdrRelative: number) => {
    // For grayscale the math is simpler than in applyHlgOotf (e.g. no need for
    // color space conversion).
    const normalized = (sdrRelative * metadata.hdr_reference_white) / 1000;
    const afterOotf = Math.pow(Math.max(0, normalized), 1.2);
    const afterOotfSdrRelative =
      (afterOotf * 1000) / metadata.hdr_reference_white;
    return func(afterOotfSdrRelative);
  };
  return withHlgOotf;
}

function getToLut1dFunc(
  lutType: LutType,
  metadata: AgtmMetadata,
  targetedHdrHeadroom: number,
  lutInputMax: number,
): ToLut1dFunc | null {
  switch (lutType) {
    case 'gray': {
      const maxOut = grayAdaptation(lutInputMax, metadata, targetedHdrHeadroom);
      return (sdrRelative) => {
        const out = grayAdaptation(sdrRelative, metadata, targetedHdrHeadroom);
        return maxOut > 1 ? out / maxOut : out;
      };
    }
    case '1donly':
      // Scale the output so that it's relative to the display headroom
      // (matches the Android API).
      return (sdrRelative) =>
        grayAdaptation(sdrRelative, metadata, targetedHdrHeadroom) /
        exp2(targetedHdrHeadroom);
    case 'grayaff':
      // 1D LUT function that has two parts, separated by a "knee point". The
      // left part applies AGTM tonemapping (to each channel independently
      // so it's not fully correct in most cases but it gets us close), and the
      // right part is just an affine function (straight line).
      // The idea is that applying the tonemapping function on the whole range
      // tends to compress the bright values (right end of the x axis) into a
      // very narrow output range, i.e. the curve becomes very flat towards the
      // right.
      // This makes it difficult for the 3D LUT to correct the values because
      // it has very few sampling points in that region.
      // To avoid this, we impose a minimum slope for the 1D LUT function.
      // We look for the point at which the AGTM tonemapping curve starts
      // being too flat, and replace it with an affine curve.
      const maxLinear = exp2(metadata.baseline_hdr_headroom);
      let kneePointX = Number.MAX_VALUE;
      let kneePointY = 0;
      let kneePointSlope = 0;
      const lut1dMax = grayAdaptation(maxLinear, metadata, targetedHdrHeadroom);
      // A straight line from (0, 0) to the top right of the graph would have
      // a slope of lut1dMax/maxLinear. We force the slope to be at some
      // fraction of that.
      const minSlopeRatio = 0.5; // Empirical value.
      const minSlope = (lut1dMax / maxLinear) * minSlopeRatio;
      const n = 100; // Number of samples to check the slope of.
      // We use the tonemapping curve at least for the SDR range.
      const iStart = Math.round((1 / maxLinear) * n);
      for (let i = iStart; i < n; ++i) {
        const x1 = (i / n) * maxLinear;
        const x2 = x1 + 1e-3;
        const y1 = grayAdaptation(x1, metadata, targetedHdrHeadroom);
        const y2 = grayAdaptation(x2, metadata, targetedHdrHeadroom);
        const slope = (y2 - y1) / (x2 - x1);
        if (slope < minSlope) {
          kneePointX = x1;
          kneePointY = y1;
          // Ideally we want to use the last point's slope to avoid slope
          // discontinuities, but if it's too far below minSlope (and it
          // could even be negative) we use minSlope / 2 instead.
          kneePointSlope = Math.max(slope, minSlope / 2);
          break;
        }
      }
      const maxOut =
        lutInputMax > kneePointX
          ? kneePointSlope * (lutInputMax - kneePointX) + kneePointY
          : grayAdaptation(lutInputMax, metadata, targetedHdrHeadroom);
      return (sdrRelative) => {
        const out =
          sdrRelative > kneePointX
            ? kneePointSlope * (sdrRelative - kneePointX) + kneePointY
            : grayAdaptation(sdrRelative, metadata, targetedHdrHeadroom);
        return maxOut > 1 ? out / maxOut : out;
      };
    case 'pq':
      return (sdrRelative) => toPq(sdrRelative, metadata);
    case '3donly':
    case 'nolut':
    default:
      return null;
  }
}

function generate1dLut(
  lut1dSize: number,
  toLut1d: ToLut1dFunc,
  inputMax: number,
): Float32Array {
  const lut1d = new Float32Array(lut1dSize);
  for (let i = 0; i < lut1dSize; ++i) {
    const x = (i / (lut1dSize - 1)) * inputMax;
    lut1d[i] = toLut1d(x);
  }
  return lut1d;
}

/**
 * Generates a 1D LUT containing gain values given by toLut1d(x)/xUnit
 * where xUnit is the input value normalized to the range [0, 1].
 * This matches the Android LUT API.
 * @param lut1dSize The size of the 1D LUT.
 * @param toLut1d The function to convert from SDR relative to LUT 1D.
 * @param inputMax The maximum input value of the 1D LUT (SDR relative).
 * @return The 1D LUT.
 */
export function generate1dGainLut(
  lut1dSize: number,
  toLut1d: ToLut1dFunc,
  inputMax: number,
): Float32Array {
  const lut1d = generate1dLut(lut1dSize, toLut1d, inputMax);
  for (let i = 0; i < lut1dSize; ++i) {
    let xUnit = i / (lut1dSize - 1);
    if (xUnit === 0) {
      xUnit = 1e-1 / (lut1dSize - 1);
    }
    lut1d[i] = lut1d[i] / xUnit;
  }
  return lut1d;
}

/** Generates a 3D LUT for the given AGTM metadata. */
export function generate3dLut(
  metadata: AgtmMetadata,
  headroomLog2: number,
  options: LutOptions,
  toLut1d: ToLut1dFunc | null,
  contentTransfer: number,
  contentPrimaries: number | number[],
): Float32Array {
  const lutInputMax =
    getMaxNits(contentTransfer) / metadata.hdr_reference_white;
  const adaptation = agtmAdapt(metadata, headroomLog2);

  const N = options.lut3dSize;
  const lut3d = new Float32Array(4 * N * N * N);

  const lut1dInv = toLut1d
    ? generateInverseLut(4096 * 2, toLut1d, lutInputMax)
    : null;

  const inputPrimaries = getLutInputPrimaries(
    metadata,
    options,
    contentPrimaries,
  );
  const lumaCoeffs = getLumaCoeffs(inputPrimaries);

  let j = 0;
  for (let r = 0; r < N; ++r) {
    for (let g = 0; g < N; ++g) {
      for (let b = 0; b < N; ++b) {
        // Unitized 3D LUT input value.
        const unitized = [r / (N - 1), g / (N - 1), b / (N - 1)];
        // 1D LUT input value that corresponds to an output value of 'unitized',
        // normalized so that 1 is the content transfer maximum.
        let rgbUnitized: number[];
        if (lut1dInv) {
          if (options.samplingType === 'maxrgb') {
            const mOut = Math.max(unitized[0], unitized[1], unitized[2]);
            if (mOut === 0) {
              rgbUnitized = [0, 0, 0];
            } else {
              const mIn = inverseFunctionApprox(mOut, lut1dInv);
              rgbUnitized = unitized.map((c) => (c * mIn) / mOut);
            }
          } else if (options.samplingType === 'ciey') {
            const yOut =
              lumaCoeffs[0] * unitized[0] +
              lumaCoeffs[1] * unitized[1] +
              lumaCoeffs[2] * unitized[2];
            if (yOut === 0) {
              rgbUnitized = [0, 0, 0];
            } else {
              const yIn = inverseFunctionApprox(yOut, lut1dInv);
              rgbUnitized = unitized.map((c) => (c * yIn) / yOut);
            }
          } else {
            rgbUnitized = unitized.map((u) =>
              inverseFunctionApprox(u, lut1dInv),
            );
          }
        } else {
          rgbUnitized = unitized; // No 1D LUT.
        }

        if (contentTransfer === kTransferHLG) {
          rgbUnitized = applyHlgOotfUnitized(rgbUnitized, inputPrimaries);
        }

        const rgbSdrRelative = rgbUnitized.map(
          (c) =>
            (c * getMaxNits(contentTransfer)) / metadata.hdr_reference_white,
        );

        const tonemapped = agtmToneMap(
          rgbSdrRelative,
          inputPrimaries,
          metadata,
          adaptation,
        );

        const headroomLinear = exp2(headroomLog2);
        // Unitize so that 1 is the display headroom (matches the Android API).
        const tonemappedUnitized = tonemapped.map((c) => c / headroomLinear);
        lut3d[j++] = tonemappedUnitized[0];
        lut3d[j++] = tonemappedUnitized[1];
        lut3d[j++] = tonemappedUnitized[2];
        lut3d[j++] = 1.0;
      }
    }
  }
  return lut3d;
}

/** Samples a 1D LUT using linear interpolation. */
export function sampleLut1d(
  unitized: number,
  lut1d: Float32Array | null,
): number {
  if (!lut1d || lut1d.length <= 1) return 1;
  const t = clamp(unitized, 0, 1);
  const last = lut1d.length - 1;
  const it = t * last;
  const i0 = Math.floor(it);
  const i1 = Math.ceil(it);
  if (i0 === i1) return lut1d[i0];
  return lut1d[i0] * (i1 - it) + lut1d[i1] * (it - i0);
}

/**
 * Applies the AGTM tonemapping to the given SDR relative RGB values using the
 * given 1D and/or 3D LUT.
 * @param sdrRelative The SDR relative RGB values.
 * @param contentPrimaries The color space of the sdrRelative values.
 * @param contentTransfer The transfer function of the sdrRelative values.
 * @param metadata The AGTM metadata.
 * @param headroomLog2 The target headroom.
 * @param options The options for the LUTs.
 * @param lut3d The 3D LUT data.
 * @param lut1d The 1D LUT data.
 * @return The tonemapped RGB values.
 */
export function agtmToneMapWithLut(
  sdrRelative: number[],
  contentPrimaries: number | number[],
  contentTransfer: number,
  metadata: AgtmMetadata,
  headroomLog2: number,
  options: LutOptions,
  lut3d: Float32Array | null,
  lut1d: Float32Array | null,
): number[] {
  const lutInputMax =
    getMaxNits(contentTransfer) / metadata.hdr_reference_white;
  const lutOutputMax = exp2(headroomLog2);

  const inputPrimaries = getLutInputPrimaries(
    metadata,
    options,
    contentPrimaries,
  );
  const lumaCoeffs = getLumaCoeffs(inputPrimaries);

  const rgbInLutSpace = primariesConvert(
    sdrRelative,
    contentPrimaries,
    inputPrimaries,
  );
  const rgbUnitized = rgbInLutSpace.map((c: number) => c / lutInputMax);

  const sampleLut1dGain = (x: number) => sampleLut1d(x, lut1d);

  let after1dLut: number[];
  if (!lut1d || lut1d.length <= 1) {
    after1dLut = rgbUnitized;
  } else if (options.samplingType === 'maxrgb') {
    const gain = sampleLut1dGain(Math.max(...rgbUnitized));
    after1dLut = rgbUnitized.map((c) => c * gain);
  } else if (options.samplingType === 'ciey') {
    const y =
      lumaCoeffs[0] * rgbUnitized[0] +
      lumaCoeffs[1] * rgbUnitized[1] +
      lumaCoeffs[2] * rgbUnitized[2];
    const gain = sampleLut1dGain(y);
    after1dLut = rgbUnitized.map((c) => c * gain);
  } else {
    // samplingType === 'rgb'
    after1dLut = rgbUnitized.map((c) => c * sampleLut1dGain(c));
  }

  let tonemappedInLutSpace: number[];
  if (lut3d === null) {
    tonemappedInLutSpace = after1dLut.map((c) => c * lutOutputMax);
  } else {
    tonemappedInLutSpace = sample3dTex3dTetrahedral(
      after1dLut,
      lut3d,
      options.lut3dSize,
    ).map((c) => c * lutOutputMax);
  }

  return primariesConvert(
    tonemappedInLutSpace,
    inputPrimaries,
    contentPrimaries,
  );
}
