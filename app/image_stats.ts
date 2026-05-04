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
  getMaxNits,
  kTransferHLG,
  kTransferPQ,
  kTransferSrgb,
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
  ): number[] => a1.map((v, i) => avg(v, a2[i], w));

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
    ) as [number, number, number, number],
    avgPerChannel: averageArray(
      stats1.avgPerChannel,
      stats2.avgPerChannel,
      weight,
    ) as [number, number, number, number],
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
      const scale =
        (p - bin.cdfMin[channel]) / (bin.cdfMax[channel] - bin.cdfMin[channel]);
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
  const pixelsPerBin = totalPixels / numBins;
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

  const kInterpolate = true;
  if (kInterpolate) {
    for (let i = 0; i < numBins; i++) {
      for (let c = 0; c < 4; ++c) {
        result[i].valueMax[c] = getPercentile(result[i].cdfMax, bins, c);
        result[i].valueMin[c] = getPercentile(result[i].cdfMin, bins, c);
      }
    }
  } else {
    for (let c = 0; c < 4; ++c) {
      let cumulativePixels = 0;
      let inputBinIndex = 0;
      for (let i = 0; i < numBins; i++) {
        const targetPixels = (i + 1) * pixelsPerBin;
        while (cumulativePixels < targetPixels && inputBinIndex < bins.length) {
          cumulativePixels += bins[inputBinIndex].count[c];
          inputBinIndex++;
        }
        if (i > 0) {
          result[i].valueMin[c] = result[i - 1].valueMax[c];
        }
        result[i].valueMax[c] = bins[inputBinIndex - 1].binMax;
      }
    }
  }

  return result;
}

function rgbToLinearNits(
  rgbIn: [number, number, number],
  contentTransfer: number,
): [number, number, number] {
  const rgb: [number, number, number] = [...rgbIn];
  for (let c = 0; c < 3; ++c) {
    rgb[c] = transferToLinear(rgb[c], contentTransfer);
  }
  const scalingFactor = getMaxNits(contentTransfer);
  if (contentTransfer === kTransferHLG) {
    // HLG OOTF.
    const Y = 0.2627 * rgb[0] + 0.678 * rgb[1] + 0.0593 * rgb[2];
    const yToPoint2 = Math.pow(Y, 0.2);
    for (let c = 0; c < 3; ++c) {
      rgb[c] *= yToPoint2 * scalingFactor;
    }
  } else {
    for (let c = 0; c < 3; ++c) {
      rgb[c] *= scalingFactor;
    }
  }
  return rgb;
}

function imageToLinear(
  dataEncoded: Float32Array,
  contentTransfer: number,
): Float32Array {
  const numPixels = dataEncoded.length / 4;
  const result = new Float32Array(dataEncoded.length);
  for (let i = 0; i < numPixels; ++i) {
    const offset = 4 * i;
    const rgb: [number, number, number] = [
      dataEncoded[offset + 0],
      dataEncoded[offset + 1],
      dataEncoded[offset + 2],
    ];
    const rgbLinear = rgbToLinearNits(rgb, contentTransfer);
    for (let c = 0; c < 3; ++c) {
      result[offset + c] = rgbLinear[c];
    }
  }
  return result;
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

  const channelMax: [number, number, number, number] = [0, 0, 0, 0];
  let minMaxRgb: number | null = null;
  const channelSum: [number, number, number, number] = [0, 0, 0, 0];
  let maxRgbSum = 0;

  const kLumaCoeffs = [0.2627, 0.678, 0.0593];
  // Weighted luma = max(rgb) * kMaxRgbLumaWeight + luma * (1 - kMaxRgbLumaWeight)
  const kMaxRgbLumaWeight = 0; // TODO - maryla: make configurable.

  const numPixels = data.length / 4;
  for (let i = 0; i < numPixels; ++i) {
    const offset = 4 * i;
    let maxRgb = 0;
    for (let c = 0; c < 3; ++c) {
      const value = data[offset + c];
      valueMin = Math.min(valueMin, value);
      valueMax = Math.max(valueMax, value);
      maxRgb = Math.max(maxRgb, value);
      channelMax[c] = Math.max(channelMax[c], value);
      channelSum[c] += value;
    }
    const luma =
      kLumaCoeffs[0] * data[offset + 0] +
      kLumaCoeffs[1] * data[offset + 1] +
      kLumaCoeffs[2] * data[offset + 2];
    const weightedLuma =
      maxRgb * kMaxRgbLumaWeight + luma * (1 - kMaxRgbLumaWeight);
    channelMax[3] = Math.max(channelMax[3], weightedLuma);
    channelSum[3] += weightedLuma;

    valueMin = Math.min(valueMin, weightedLuma);
    valueMax = Math.max(valueMax, weightedLuma);
    minMaxRgb = minMaxRgb === null ? maxRgb : Math.min(minMaxRgb, maxRgb);
    maxRgbSum += maxRgb;
  }
  if (valueRange) {
    // Nits
    valueMin = valueRange[0];
    valueMax = valueRange[1];
  }

  const bins: CdfBin[] = [];

  for (let b = 0; b < numBins; ++b) {
    const binMin =
      (valueMax - valueMin) * xScalingFunc((b + 0) / numBins) + valueMin;
    const binMax =
      (valueMax - valueMin) * xScalingFunc((b + 1) / numBins) + valueMin;
    bins.push({
      binMin,
      binMax,
      count: [0, 0, 0, 0], // R, G, B, weighted luma
      freq: [0, 0, 0, 0],
      density: [0, 0, 0, 0],
      maxDensity: 0,
      cdfMin: [0, 0, 0, 0],
      cdfMax: [0, 0, 0, 0],
    });
  }

  for (let i = 0; i < numPixels; ++i) {
    const offset = 4 * i;
    let maxRgb = 0;
    for (let c = 0; c < 4; ++c) {
      let value;
      if (c === 3) {
        const luma =
          kLumaCoeffs[0] * data[offset + 0] +
          kLumaCoeffs[1] * data[offset + 1] +
          kLumaCoeffs[2] * data[offset + 2];
        const weightedLuma =
          maxRgb * kMaxRgbLumaWeight + luma * (1 - kMaxRgbLumaWeight);
        value = weightedLuma;
      } else {
        value = data[offset + c];
        maxRgb = Math.max(maxRgb, value);
      }
      const valueRange = valueMax - valueMin;
      let binIndex = 0;
      if (valueRange > 0) {
        const normalizedValue = clamp((value - valueMin) / valueRange, 0, 1);
        const gammaCorrected = xScalingInv(normalizedValue);
        binIndex = Math.floor(numBins * gammaCorrected);
        binIndex = Math.min(binIndex, numBins - 1);
      }

      if (binIndex < 0 || binIndex >= numBins) {
        console.warn(
          `Bad bin index (i = ${i}, numBins = ${numBins}, max = ${valueMax}, min = ${valueMin}, value = ${value})`,
        );
        continue;
      }
      bins[binIndex].count[c] += 1;
    }
  }

  let maxDensity = 0;
  for (let b = 0; b < numBins; ++b) {
    const bin = bins[b];
    for (let c = 0; c < 4; ++c) {
      if (b !== 0) {
        bin.cdfMin[c] = bins[b - 1].cdfMax[c];
      }
      bin.freq[c] = bin.count[c] / numPixels;
      bin.cdfMax[c] = bin.cdfMin[c] + bin.freq[c];
      const binWidth = bin.binMax - bin.binMin;
      if (binWidth > 0) {
        const density = bin.freq[c] / binWidth;
        bin.density[c] = density;
        maxDensity = Math.max(maxDensity, density);
      }
    }
  }
  for (let b = 0; b < numBins; ++b) {
    const bin = bins[b];
    for (let c = 0; c < 4; ++c) {
      bin.maxDensity = maxDensity;
    }
  }

  return {
    bins,
    percentileBins: getInverseDistribution(bins),
    maxPerChannel: channelMax,
    maxMaxRgb: Math.max(channelMax[0], Math.max(channelMax[1], channelMax[2])),
    minMaxRgb: minMaxRgb ?? 0,
    avgPerChannel: [
      channelSum[0] / numPixels,
      channelSum[1] / numPixels,
      channelSum[2] / numPixels,
      channelSum[3] / numPixels,
    ],
    avgMaxRgb: maxRgbSum / numPixels,
  };
}

export class ImageStats {
  width: number;
  height: number;
  private readonly rgbEncoded: Float32Array;
  private readonly linearImage: Float32Array;

  constructor(video: ImageBitmap, contentTransfer: number) {
    this.width = video.width;
    this.height = video.height;
    const canvas = new OffscreenCanvas(this.width, this.height);
    const gl = canvas.getContext('webgl2')!;
    const texture = gl.createTexture();

    gl.getExtension('EXT_color_buffer_half_float');
    gl.getExtension('EXT_color_buffer_float');
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA16F,
      this.width,
      this.height,
      0,
      gl.RGBA,
      gl.FLOAT,
      null,
    );
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
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);

    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      texture,
      0,
    );
    this.rgbEncoded = new Float32Array(this.width * this.height * 4);
    gl.readPixels(
      0,
      0,
      this.width,
      this.height,
      gl.RGBA,
      gl.FLOAT,
      this.rgbEncoded,
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);

    this.linearImage = imageToLinear(this.rgbEncoded, contentTransfer);
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
    const rgbExtendedL = this.linearImage;
    const valueRange: [number, number] | null = maxNits ? [0, maxNits] : null;
    const stats = computeStats(
      rgbExtendedL,
      valueRange,
      xScalingFunc,
      xScalingInv,
      numBins,
    );
    return stats;
  }

  getPixelValueNits(
    x: number,
    y: number,
    contentTransfer: number,
  ): [number, number, number] | null {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) {
      return null;
    }
    const offset = (y * this.width + x) * 4;
    const rgbEncoded: [number, number, number] = [
      this.rgbEncoded[offset + 0],
      this.rgbEncoded[offset + 1],
      this.rgbEncoded[offset + 2],
    ];

    return rgbToLinearNits(rgbEncoded, contentTransfer);
  }
}
