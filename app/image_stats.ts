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

import {
  applyHlgOotf,
  getMaxNits,
  PRIMARIES_REC2020,
  TRANSFER_HLG,
  TRANSFER_PQ,
  TRANSFER_SRGB,
  transferToLinear,
} from './color_helpers/color_functions';
import {clamp} from './color_helpers/math_helpers';

export interface CdfBin {
  binMin: number; // Min value of the bin bracket in nits.
  binMax: number; // Max value of the bin bracket in nits.
  count: number[]; // Number of pixels in the bin.
  freq: number[]; // Percentage of pixels in the bin.
  // Density of pixels in the bin, i.e. freq / (binMax - binMin).
  density: number[];
  maxDensity: number; // Max density for any channel in all the bins.
  // CDF min value for each channel. I.e. sum of 'freq' for all previous bins.
  cdfMin: number[];
  // CDF max value for each channel. I.e. sum of 'freq' for all previous bins
  // plus the frequency of the current bin.
  cdfMax: number[];
}

export interface PercentileBin {
  cdfMin: number;
  cdfMax: number;
  valueMin: number[];
  valueMax: number[];
}

export interface ComputedStats {
  bins: CdfBin[];
  percentileBins: PercentileBin[];
  maxPerChannel: [number, number, number, number];
  avgPerChannel: [number, number, number, number];
  maxMaxRgb: number;
  minMaxRgb: number;
  avgMaxRgb: number;
}

/**
 * Computes the average of two stats, weighted by the given weight:
 * stats1 * weight + stats2 * (1 - weight).
 */
export function averageStats(
  stats1: ComputedStats,
  stats2: ComputedStats,
  weight: number,
): ComputedStats {
  const avg = (a: number, b: number, w: number) => a * w + b * (1 - w);
  const averageArray = (
    a1: readonly number[],
    a2: readonly number[],
    w: number,
  ): [number, number, number, number] => [
    avg(a1[0], a2[0], w),
    avg(a1[1], a2[1], w),
    avg(a1[2], a2[2], w),
    avg(a1[3], a2[3], w),
  ];

  const numBins = stats1.bins.length;
  if (numBins !== stats2.bins.length) {
    throw new Error('Number of bins is not the same');
  }
  const result: ComputedStats = {
    bins: new Array(numBins),
    percentileBins: [], // Filled in later.
    maxPerChannel: averageArray(
      stats1.maxPerChannel,
      stats2.maxPerChannel,
      weight,
    ),
    avgPerChannel: averageArray(
      stats1.avgPerChannel,
      stats2.avgPerChannel,
      weight,
    ),
    maxMaxRgb: avg(stats1.maxMaxRgb, stats2.maxMaxRgb, weight),
    minMaxRgb: avg(stats1.minMaxRgb, stats2.minMaxRgb, weight),
    avgMaxRgb: avg(stats1.avgMaxRgb, stats2.avgMaxRgb, weight),
  };
  for (let i = 0; i < numBins; ++i) {
    const bin1 = stats1.bins[i];
    const bin2 = stats2.bins[i];
    if (bin1.binMin !== bin2.binMin || bin1.binMax !== bin2.binMax) {
      throw new Error('Bins do not match');
    }
    result.bins[i] = {
      binMin: bin1.binMin,
      binMax: bin1.binMax,
      count: averageArray(bin1.count, bin2.count, weight),
      freq: averageArray(bin1.freq, bin2.freq, weight),
      density: averageArray(bin1.density, bin2.density, weight),
      maxDensity: avg(bin1.maxDensity, bin2.maxDensity, weight),
      cdfMin: averageArray(bin1.cdfMin, bin2.cdfMin, weight),
      cdfMax: averageArray(bin1.cdfMax, bin2.cdfMax, weight),
    };
  }
  result.percentileBins = getInverseDistribution(result.bins);
  return result;
}

export function getPercentile(p: number, bins: CdfBin[], channel = 1): number {
  for (const bin of bins) {
    if (bin.cdfMin[channel] <= p && p <= bin.cdfMax[channel]) {
      const denom = bin.cdfMax[channel] - bin.cdfMin[channel];
      const scale = denom > 0 ? (p - bin.cdfMin[channel]) / denom : 0;
      return scale * (bin.binMax - bin.binMin) + bin.binMin;
    }
  }
  if (p < bins[0].cdfMin[channel]) {
    return bins[0].binMin;
  }
  return bins[bins.length - 1].binMax;
}

/**
 * Computes an array of N+1 CdfBin objects, where each CdfBin represents the upper bound
 * of a percentile range. The CdfBin at index i+1 corresponds to the (i+1)/N% pixels
 * with the lowest values.
 * @param bins The input histogram bins.
 * @param numBins The number of percentile bins (N).
 * @return An array of N+1 CdfBin objects.
 */
function getInverseDistribution(
  bins: CdfBin[],
  numBins = 100,
): PercentileBin[] {
  if (bins.length === 0) {
    return [];
  }
  const totalPixels = bins.reduce((sum, bin) => sum + bin.count[0], 0);
  if (totalPixels === 0) {
    return [];
  }
  const fractionPerBin = 1 / numBins;
  const result: PercentileBin[] = new Array(numBins);
  for (let i = 0; i < numBins; i++) {
    result[i] = {
      cdfMin: fractionPerBin * i,
      cdfMax: fractionPerBin * (i + 1),
      valueMin: [0, 0, 0, 0],
      valueMax: [0, 0, 0, 0],
    };
  }

  for (let c = 0; c < 4; ++c) {
    result[0].valueMin[c] = getPercentile(0, bins, c);
    result[0].valueMax[c] = getPercentile(result[0].cdfMax, bins, c);
    for (let i = 1; i < numBins; i++) {
      result[i].valueMin[c] = result[i - 1].valueMax[c];
      result[i].valueMax[c] = getPercentile(result[i].cdfMax, bins, c);
    }
  }

  return result;
}

const LUT_SIZE = 65536;
const transferScaledLutCache = new Map<number, Float32Array>();

function getScaledTransferLut(transfer: number): Float32Array {
  let lut = transferScaledLutCache.get(transfer);
  if (!lut) {
    lut = new Float32Array(LUT_SIZE + 1);
    const scaling = getMaxNits(transfer);
    for (let i = 0; i <= LUT_SIZE; ++i) {
      lut[i] = transferToLinear(i / LUT_SIZE, transfer) * scaling;
    }
    transferScaledLutCache.set(transfer, lut);
  }
  return lut;
}

const hlgLutCache = new Float32Array(LUT_SIZE + 1);
for (let i = 0; i <= LUT_SIZE; ++i) {
  hlgLutCache[i] = transferToLinear(i / LUT_SIZE, TRANSFER_HLG);
}

const hlgOotfLutCache = new Float32Array(LUT_SIZE + 1);
for (let i = 0; i <= LUT_SIZE; ++i) {
  hlgOotfLutCache[i] = Math.pow(i / LUT_SIZE, 0.2);
}

function imageToLinearNits(
  dataEncoded: Float32Array,
  contentTransfer: number,
  contentPrimaries: number,
  outBuffer?: Float32Array,
): Float32Array {
  const len = dataEncoded.length;
  const result = outBuffer ?? new Float32Array(len);
  const scalingFactor = getMaxNits(contentTransfer);

  if (contentTransfer === TRANSFER_HLG) {
    const isRec2020 = contentPrimaries === PRIMARIES_REC2020;
    const lut = hlgLutCache;
    const ootfLut = hlgOotfLutCache;

    if (isRec2020) {
      for (let i = 0; i < len; i += 4) {
        const rEnc = dataEncoded[i];
        const gEnc = dataEncoded[i + 1];
        const bEnc = dataEncoded[i + 2];
        const aEnc = dataEncoded[i + 3];

        const rLin =
          rEnc >= 0 && rEnc <= 1
            ? lut[(rEnc * LUT_SIZE + 0.5) | 0]
            : transferToLinear(rEnc, contentTransfer);
        const gLin =
          gEnc >= 0 && gEnc <= 1
            ? lut[(gEnc * LUT_SIZE + 0.5) | 0]
            : transferToLinear(gEnc, contentTransfer);
        const bLin =
          bEnc >= 0 && bEnc <= 1
            ? lut[(bEnc * LUT_SIZE + 0.5) | 0]
            : transferToLinear(bEnc, contentTransfer);

        const luma = 0.2627 * rLin + 0.678 * gLin + 0.0593 * bLin;
        const ootfMult =
          luma >= 0 && luma <= 1
            ? ootfLut[(luma * LUT_SIZE + 0.5) | 0]
            : Math.pow(Math.max(0, luma), 0.2);
        const mult = ootfMult * scalingFactor;

        result[i] = rLin * mult;
        result[i + 1] = gLin * mult;
        result[i + 2] = bLin * mult;
        result[i + 3] = aEnc;
      }
    } else {
      for (let i = 0; i < len; i += 4) {
        const rEnc = dataEncoded[i];
        const gEnc = dataEncoded[i + 1];
        const bEnc = dataEncoded[i + 2];
        const aEnc = dataEncoded[i + 3];

        const rLin =
          rEnc >= 0 && rEnc <= 1
            ? lut[(rEnc * LUT_SIZE + 0.5) | 0]
            : transferToLinear(rEnc, contentTransfer);
        const gLin =
          gEnc >= 0 && gEnc <= 1
            ? lut[(gEnc * LUT_SIZE + 0.5) | 0]
            : transferToLinear(gEnc, contentTransfer);
        const bLin =
          bEnc >= 0 && bEnc <= 1
            ? lut[(bEnc * LUT_SIZE + 0.5) | 0]
            : transferToLinear(bEnc, contentTransfer);

        const ootf = applyHlgOotf([rLin, gLin, bLin], contentPrimaries);
        result[i] = ootf[0] * scalingFactor;
        result[i + 1] = ootf[1] * scalingFactor;
        result[i + 2] = ootf[2] * scalingFactor;
        result[i + 3] = aEnc;
      }
    }
  } else {
    const lut = getScaledTransferLut(contentTransfer);
    for (let i = 0; i < len; i += 4) {
      const r = dataEncoded[i];
      const g = dataEncoded[i + 1];
      const b = dataEncoded[i + 2];
      const a = dataEncoded[i + 3];

      result[i] =
        r >= 0 && r <= 1
          ? lut[(r * LUT_SIZE + 0.5) | 0]
          : transferToLinear(r, contentTransfer) * scalingFactor;
      result[i + 1] =
        g >= 0 && g <= 1
          ? lut[(g * LUT_SIZE + 0.5) | 0]
          : transferToLinear(g, contentTransfer) * scalingFactor;
      result[i + 2] =
        b >= 0 && b <= 1
          ? lut[(b * LUT_SIZE + 0.5) | 0]
          : transferToLinear(b, contentTransfer) * scalingFactor;
      result[i + 3] = a;
    }
  }
  return result;
}

interface CountBuffers {
  countR: Int32Array;
  countG: Int32Array;
  countB: Int32Array;
  countL: Int32Array;
}

let cachedCounts: CountBuffers | null = null;

function getCountBuffers(numBins: number): CountBuffers {
  if (!cachedCounts || cachedCounts.countR.length < numBins) {
    cachedCounts = {
      countR: new Int32Array(numBins),
      countG: new Int32Array(numBins),
      countB: new Int32Array(numBins),
      countL: new Int32Array(numBins),
    };
  } else {
    cachedCounts.countR.fill(0, 0, numBins);
    cachedCounts.countG.fill(0, 0, numBins);
    cachedCounts.countB.fill(0, 0, numBins);
    cachedCounts.countL.fill(0, 0, numBins);
  }
  return cachedCounts;
}

/**
 * Computes the stats for the image.
 * @param data The image data in linear space.
 * @param valueRange The range of values in the image, or null to use the
 *     actual min and max values.
 * @param xScalingFunc The function to scale the x-axis of the bins.
 * @param xScalingInv The inverse of xScalingFunc (i.e., the function to scale
 * the histogrammed values if we assume evenly spaced bins).
 * @param numBins The number of bins to use.
 * @param maxRgbLumaWeight The weight to apply to the max RGB value when
 *     computing the weighted luma.
 */
function computeStats(
  data: Float32Array,
  valueRange: [number, number] | null = null,
  xScalingFunc: (x: number) => number,
  xScalingInv: (x: number) => number,
  numBins: number,
  maxRgbLumaWeight = 0,
): ComputedStats {
  let valueMin = 0;
  let valueMax = 0.01;

  let maxR = 0;
  let maxG = 0;
  let maxB = 0;
  let maxL = 0;
  let minMaxRgb = Infinity;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let sumL = 0;
  let maxRgbSum = 0;

  const kLumaCoeff0 = 0.2627;
  const kLumaCoeff1 = 0.678;
  const kLumaCoeff2 = 0.0593;

  const len = data.length;
  const numPixels = len >>> 2;
  if (numPixels === 0) {
    return {
      bins: [],
      percentileBins: [],
      maxPerChannel: [0, 0, 0, 0],
      maxMaxRgb: 0,
      minMaxRgb: 0,
      avgPerChannel: [0, 0, 0, 0],
      avgMaxRgb: 0,
    };
  }

  const {countR, countG, countB, countL} = getCountBuffers(numBins);

  const isSqrt =
    xScalingInv === ImageStats.kDefaultScalingInv ||
    (xScalingInv(0.25) === 0.5 && xScalingInv(0.04) === 0.2);

  for (let i = 0; i < len; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];

    if (r > maxR) maxR = r;
    if (g > maxG) maxG = g;
    if (b > maxB) maxB = b;

    let minRgb = r < g ? r : g;
    if (b < minRgb) minRgb = b;
    if (minRgb < valueMin) valueMin = minRgb;

    let maxRgb = r > g ? r : g;
    if (b > maxRgb) maxRgb = b;
    if (maxRgb > valueMax) valueMax = maxRgb;

    sumR += r;
    sumG += g;
    sumB += b;

    const luma = kLumaCoeff0 * r + kLumaCoeff1 * g + kLumaCoeff2 * b;
    const weightedLuma =
      maxRgb * maxRgbLumaWeight + luma * (1 - maxRgbLumaWeight);
    if (weightedLuma > maxL) maxL = weightedLuma;
    sumL += weightedLuma;

    if (weightedLuma < valueMin) valueMin = weightedLuma;
    if (weightedLuma > valueMax) valueMax = weightedLuma;

    if (maxRgb < minMaxRgb) minMaxRgb = maxRgb;
    maxRgbSum += maxRgb;
  }

  if (valueRange) {
    valueMin = valueRange[0];
    valueMax = valueRange[1];
  }

  const valRange = valueMax - valueMin;
  const invRange = valRange > 0 ? 1 / valRange : 0;
  const maxBin = numBins - 1;

  if (valRange > 0) {
    const scaleInv = isSqrt ? Math.sqrt : xScalingInv;
    for (let i = 0; i < len; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const luma = kLumaCoeff0 * r + kLumaCoeff1 * g + kLumaCoeff2 * b;
      let weightedLuma = luma;
      if (maxRgbLumaWeight > 0) {
        let maxRgb = r > g ? r : g;
        if (b > maxRgb) maxRgb = b;
        weightedLuma =
          maxRgb * maxRgbLumaWeight + luma * (1 - maxRgbLumaWeight);
      }

      let normR = (r - valueMin) * invRange;
      normR = normR < 0 ? 0 : normR > 1 ? 1 : normR;
      const binR = (scaleInv(normR) * numBins) | 0;
      countR[binR > maxBin ? maxBin : binR < 0 ? 0 : binR]++;

      let normG = (g - valueMin) * invRange;
      normG = normG < 0 ? 0 : normG > 1 ? 1 : normG;
      const binG = (scaleInv(normG) * numBins) | 0;
      countG[binG > maxBin ? maxBin : binG < 0 ? 0 : binG]++;

      let normB = (b - valueMin) * invRange;
      normB = normB < 0 ? 0 : normB > 1 ? 1 : normB;
      const binB = (scaleInv(normB) * numBins) | 0;
      countB[binB > maxBin ? maxBin : binB < 0 ? 0 : binB]++;

      let normL = (weightedLuma - valueMin) * invRange;
      normL = normL < 0 ? 0 : normL > 1 ? 1 : normL;
      const binL = (scaleInv(normL) * numBins) | 0;
      countL[binL > maxBin ? maxBin : binL < 0 ? 0 : binL]++;
    }
  } else {
    countR[0] = numPixels;
    countG[0] = numPixels;
    countB[0] = numPixels;
    countL[0] = numPixels;
  }

  // Construct bins
  const bins: CdfBin[] = new Array(numBins);
  let maxDensity = 0;
  const invNumPixels = 1 / numPixels;

  for (let b = 0; b < numBins; ++b) {
    const binMin = (valueMax - valueMin) * xScalingFunc(b / numBins) + valueMin;
    const binMax =
      (valueMax - valueMin) * xScalingFunc((b + 1) / numBins) + valueMin;
    const cR = countR[b];
    const cG = countG[b];
    const cB = countB[b];
    const cL = countL[b];

    const freqR = cR * invNumPixels;
    const freqG = cG * invNumPixels;
    const freqB = cB * invNumPixels;
    const freqL = cL * invNumPixels;

    const binWidth = binMax - binMin;
    let densR = 0;
    let densG = 0;
    let densB = 0;
    let densL = 0;
    if (binWidth > 0) {
      const invW = 1 / binWidth;
      densR = freqR * invW;
      densG = freqG * invW;
      densB = freqB * invW;
      densL = freqL * invW;
      if (densR > maxDensity) maxDensity = densR;
      if (densG > maxDensity) maxDensity = densG;
      if (densB > maxDensity) maxDensity = densB;
      if (densL > maxDensity) maxDensity = densL;
    }

    let cdfMinR = 0;
    let cdfMinG = 0;
    let cdfMinB = 0;
    let cdfMinL = 0;
    if (b > 0) {
      const prev = bins[b - 1];
      cdfMinR = prev.cdfMax[0];
      cdfMinG = prev.cdfMax[1];
      cdfMinB = prev.cdfMax[2];
      cdfMinL = prev.cdfMax[3];
    }

    bins[b] = {
      binMin,
      binMax,
      count: [cR, cG, cB, cL],
      freq: [freqR, freqG, freqB, freqL],
      density: [densR, densG, densB, densL],
      maxDensity: 0,
      cdfMin: [cdfMinR, cdfMinG, cdfMinB, cdfMinL],
      cdfMax: [
        cdfMinR + freqR,
        cdfMinG + freqG,
        cdfMinB + freqB,
        cdfMinL + freqL,
      ],
    };
  }

  for (let b = 0; b < numBins; ++b) {
    bins[b].maxDensity = maxDensity;
  }

  return {
    bins,
    percentileBins: getInverseDistribution(bins),
    maxPerChannel: [maxR, maxG, maxB, maxL],
    maxMaxRgb: Math.max(maxR, maxG, maxB),
    minMaxRgb: minMaxRgb === Infinity ? 0 : minMaxRgb,
    avgPerChannel: [
      sumR * invNumPixels,
      sumG * invNumPixels,
      sumB * invNumPixels,
      sumL * invNumPixels,
    ],
    avgMaxRgb: maxRgbSum * invNumPixels,
  };
}

let sharedCanvas: OffscreenCanvas | null = null;
let sharedGl: WebGL2RenderingContext | null = null;
let sharedTexture: WebGLTexture | null = null;
let sharedFb: WebGLFramebuffer | null = null;
let sharedTextureWidth = 0;
let sharedTextureHeight = 0;

interface GlResources {
  gl: WebGL2RenderingContext;
  texture: WebGLTexture;
  fb: WebGLFramebuffer;
}

function getSharedGlResources(width: number, height: number): GlResources {
  if (typeof OffscreenCanvas === 'undefined') {
    throw new Error('OffscreenCanvas is not supported');
  }
  if (sharedGl && sharedGl.isContextLost()) {
    sharedCanvas = null;
    sharedGl = null;
    sharedTexture = null;
    sharedFb = null;
    sharedTextureWidth = 0;
    sharedTextureHeight = 0;
  }
  if (!sharedGl) {
    sharedCanvas = new OffscreenCanvas(1, 1);
    const gl = sharedCanvas.getContext('webgl2');
    if (!gl) throw new Error('Failed to create WebGL2 context');
    gl.getExtension('EXT_color_buffer_half_float');
    gl.getExtension('EXT_color_buffer_float');
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);

    const texture = gl.createTexture();
    if (!texture) throw new Error('Failed to create WebGL texture');
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.bindTexture(gl.TEXTURE_2D, null);

    const fb = gl.createFramebuffer();
    if (!fb) throw new Error('Failed to create WebGL framebuffer');

    sharedGl = gl;
    sharedTexture = texture;
    sharedFb = fb;
  }

  if (width !== sharedTextureWidth || height !== sharedTextureHeight) {
    sharedGl.bindTexture(sharedGl.TEXTURE_2D, sharedTexture!);
    sharedGl.texImage2D(
      sharedGl.TEXTURE_2D,
      0,
      sharedGl.RGBA16F,
      width,
      height,
      0,
      sharedGl.RGBA,
      sharedGl.FLOAT,
      null,
    );
    sharedGl.bindTexture(sharedGl.TEXTURE_2D, null);

    sharedGl.bindFramebuffer(sharedGl.FRAMEBUFFER, sharedFb);
    sharedGl.framebufferTexture2D(
      sharedGl.FRAMEBUFFER,
      sharedGl.COLOR_ATTACHMENT0,
      sharedGl.TEXTURE_2D,
      sharedTexture,
      0,
    );
    sharedGl.bindFramebuffer(sharedGl.FRAMEBUFFER, null);

    sharedTextureWidth = width;
    sharedTextureHeight = height;
  }

  return {gl: sharedGl, texture: sharedTexture!, fb: sharedFb!};
}

let sharedScratchBuffer: Float32Array | null = null;

export function getSharedScratchBuffer(size: number): Float32Array {
  if (!sharedScratchBuffer || sharedScratchBuffer.length < size) {
    sharedScratchBuffer = new Float32Array(size);
  }
  return sharedScratchBuffer;
}

export interface ImageStatsOptions {
  /**
   * If false, does not store a copy of the encoded RGB data.
   * Calling `getPixelValueEncoded` will return null. Defaults to true.
   */
  keepEncoded?: boolean;
  /**
   * If true, uses a shared reusable scratch buffer to avoid memory allocation churn.
   * Defaults to false.
   */
  useScratchBuffer?: boolean;
}

export class ImageStats {
  readonly width: number;
  readonly height: number;
  private readonly rgbEncoded: Float32Array | null = null;
  private readonly linearImageNits: Float32Array;

  constructor(
    video: ImageBitmap | VideoFrame,
    contentTransfer: number,
    contentPrimaries: number,
    options?: ImageStatsOptions,
  ) {
    this.width = 'displayWidth' in video ? video.displayWidth : video.width;
    this.height = 'displayHeight' in video ? video.displayHeight : video.height;
    const numFloats = this.width * this.height * 4;
    const keepEncoded = options?.keepEncoded ?? true;
    const useScratchBuffer = options?.useScratchBuffer ?? false;

    const {gl, texture, fb} = getSharedGlResources(this.width, this.height);

    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      this.width,
      this.height,
      gl.RGBA,
      gl.FLOAT,
      video,
    );
    gl.bindTexture(gl.TEXTURE_2D, null);

    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);

    if (keepEncoded) {
      this.rgbEncoded = new Float32Array(numFloats);
      gl.readPixels(
        0,
        0,
        this.width,
        this.height,
        gl.RGBA,
        gl.FLOAT,
        this.rgbEncoded,
      );
      this.linearImageNits = imageToLinearNits(
        this.rgbEncoded,
        contentTransfer,
        contentPrimaries,
      );
    } else {
      const readBuffer = useScratchBuffer
        ? getSharedScratchBuffer(numFloats).subarray(0, numFloats)
        : new Float32Array(numFloats);
      gl.readPixels(
        0,
        0,
        this.width,
        this.height,
        gl.RGBA,
        gl.FLOAT,
        readBuffer,
      );
      this.linearImageNits = imageToLinearNits(
        readBuffer,
        contentTransfer,
        contentPrimaries,
        readBuffer,
      );
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  // The Pixel stats use a gamma curve to adjust the bin sizes.
  // In the Pixel it's implemented with a 1D LUT.
  private static readonly kGamma = 2;
  static readonly kDefaultScalingFunc = (x: number) =>
    Math.pow(x, ImageStats.kGamma);
  static readonly kDefaultScalingInv = (x: number) =>
    Math.pow(x, 1 / ImageStats.kGamma);

  getStats(
    maxNits: number | null = null,
    xScalingFunc = ImageStats.kDefaultScalingFunc,
    xScalingInv = ImageStats.kDefaultScalingInv,
    numBins = 100,
  ): ComputedStats {
    const rgbExtendedL = this.linearImageNits;
    const valueRange: [number, number] | null = maxNits ? [0, maxNits] : null;
    return computeStats(
      rgbExtendedL,
      valueRange,
      xScalingFunc,
      xScalingInv,
      numBins,
    );
  }

  /**
   * Returns the RGB value in nits for the given pixel coordinates.
   * For SDR, uses a max value of 203 nits.
   */
  getPixelValueNits(x: number, y: number): [number, number, number] | null {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) {
      return null;
    }
    const offset = (y * this.width + x) * 4;
    return [
      this.linearImageNits[offset + 0],
      this.linearImageNits[offset + 1],
      this.linearImageNits[offset + 2],
    ];
  }

  getPixelValueEncoded(x: number, y: number): [number, number, number] | null {
    if (
      !this.rgbEncoded ||
      x < 0 ||
      x >= this.width ||
      y < 0 ||
      y >= this.height
    ) {
      return null;
    }
    const offset = (y * this.width + x) * 4;
    return [
      this.rgbEncoded[offset + 0],
      this.rgbEncoded[offset + 1],
      this.rgbEncoded[offset + 2],
    ];
  }
}
