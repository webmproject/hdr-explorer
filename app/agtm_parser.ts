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

/**
 * @fileoverview Utility for parsing AGTM metadata.
 */

import {AgtmMetadata, Altr, ComponentMix, Point2} from './color_helpers/agtm';
import {
  kPrimariesP3,
  kPrimariesRec2020,
  kPrimariesSRGB,
} from './color_helpers/color_functions';
import {clamp} from './color_helpers/math_helpers';
import {pchipInterpolationSlopes} from './color_helpers/pchip';

import {Bitstream} from './bitstream';

/** Reads a scaled U16 from the bitstream. */
export function readScaledU16(
  stream: Bitstream,
  scale = 1,
  shift = 0,
  min = 0,
  max = 65535,
) {
  const value = stream.readBits(16);
  if (value === -1) return 0;
  return (clamp(value, min, max) - shift) / scale;
}

/** Parses AGTM metadata from a bitstream. */
export function parseAgtm(stream: Bitstream): AgtmMetadata | null {
  const kApplicationVersion = 0;
  const applicationVersion = stream.readBits(3);
  const minimumApplicationVersion = stream.readBits(3);
  if (minimumApplicationVersion === -1) return null;
  if (minimumApplicationVersion > kApplicationVersion) {
    console.warn(
      `Version not supported: SMPTE ST 2094-50 minimum application version is ` +
        `set to ${minimumApplicationVersion} but this parser only supports up to version ${kApplicationVersion}`,
    );
    return null;
  }
  stream.skipBits(2); // reserved

  const hasCustomHdrReferenceWhiteFlag = stream.readBits(1) === 1;
  const hasAdaptiveToneMapFlag = stream.readBits(1) === 1;
  stream.skipBits(6); // reserved bits
  let hdrReferenceWhite = 203;
  if (hasCustomHdrReferenceWhiteFlag) {
    hdrReferenceWhite = readScaledU16(stream, 5, 0, 1, 50000);
  }

  if (!hasAdaptiveToneMapFlag) {
    return null;
  }

  const baselineHdrHeadroom = readScaledU16(stream, 10000, 0, 0, 60000);

  const useReferenceWhiteToneMapping = stream.readBits(1) === 1;
  // SMPTE ST 2094-41 Appendix C.3.8.
  if (useReferenceWhiteToneMapping) {
    stream.skipBits(7); // reserved
    const mix: ComponentMix = {rgb: [0, 0, 0], max: 1, min: 0, channel: 0};
    const altrList = [];
    if (baselineHdrHeadroom > 0) {
      for (let i = 0; i < 2; ++i) {
        const headroom =
          i === 0
            ? 0
            : Math.log2(8 / 3) *
              Math.min(baselineHdrHeadroom / Math.log2(1000 / 203), 1);
        const yWhite =
          i === 0
            ? 1 - 0.5 * Math.min(baselineHdrHeadroom / Math.log2(1000 / 203), 1)
            : 1;

        const kappa = 0.65;
        const xKnee = 1.0;
        const yKnee = yWhite;
        const xMax = Math.pow(2, baselineHdrHeadroom);
        const yMax = Math.pow(2, headroom);
        const xMid = (1 - kappa) * xKnee + (kappa * xKnee * yMax) / yKnee;
        const yMid = (1 - kappa) * yKnee + kappa * yMax;

        const xA = xKnee - 2 * xMid + xMax;
        const yA = yKnee - 2 * yMid + yMax;
        const xB = 2 * xMid - 2 * xKnee;
        const yB = 2 * yMid - 2 * yKnee;
        const xC = xKnee;
        const yC = yKnee;

        const curve: Point2[] = [];
        const numControlPoints = 8;
        for (let c = 0; c < numControlPoints; ++c) {
          const t = c / (numControlPoints - 1);
          const x = xC + t * (xB + t * xA);
          const y = yC + t * (yB + t * yA);
          const m = (2 * yA * t + yB) / (2 * xA * t + xB);

          curve.push({
            x,
            y: Math.log2(y / x),
            m: (x * m - y) / (Math.LN2 * x * y),
          });
        }
        altrList.push({headroom, curve, mix});
      }
    }
    const primaries = kPrimariesRec2020;
    return {
      altr: altrList,
      gain_application_space_primaries: primaries,
      hdr_reference_white: hdrReferenceWhite,
      baseline_hdr_headroom: baselineHdrHeadroom,
    };
  }

  const numAltr = stream.readBits(3);
  const gainApplicationChromaticitiesMode = stream.readBits(2);
  const hasCommonMixParamsFlag = stream.readBits(1) === 1;
  const hasCommonCurveParamsFlag = stream.readBits(1) === 1;

  let primaries: number | undefined;
  let chromaticities: number[] | undefined;
  if (gainApplicationChromaticitiesMode === 0) {
    primaries = kPrimariesSRGB;
  } else if (gainApplicationChromaticitiesMode === 1) {
    primaries = kPrimariesP3;
  } else if (gainApplicationChromaticitiesMode === 2) {
    primaries = kPrimariesRec2020;
  } else {
    chromaticities = [];
    for (let i = 0; i < 8; ++i) {
      chromaticities.push(readScaledU16(stream, 50000, 0, 0, 50000));
    }
  }

  const altrList = [];
  let commonMix: ComponentMix = {rgb: [0, 0, 0], max: 1, min: 0, channel: 0};
  let commonCurve: Point2[] = [];
  let commonCurveLength = 0;
  let commonUsePchipSlope = false;

  for (let i = 0; i < numAltr; ++i) {
    const headroom = readScaledU16(stream, 10000, 0, 0, 60000);
    let mix: ComponentMix = {rgb: [0, 0, 0], max: 1, min: 0, channel: 0};
    if (i === 0 || !hasCommonMixParamsFlag) {
      const componentMixingType = stream.readBits(2);
      switch (componentMixingType) {
        case 0:
          mix = {
            rgb: [0, 0, 0],
            max: 1,
            min: 0,
            channel: 0,
          };
          break;
        case 1:
          mix = {
            rgb: [0, 0, 0],
            max: 0,
            min: 0,
            channel: 1,
          };
          break;
        case 2:
          mix = {
            rgb: [1 / 6, 1 / 6, 1 / 6],
            max: 1 / 2,
            min: 0,
            channel: 0,
          };
          break;
        case 3:
          const coeffs = [0, 0, 0, 0, 0, 0];
          const coeffsPresent: boolean[] = [];
          for (let c = 0; c < 6; ++c) {
            coeffsPresent.push(stream.readBits(1) === 1);
          }
          for (let c = 0; c < 6; ++c) {
            if (coeffsPresent[c]) {
              coeffs[c] = readScaledU16(stream, 50000);
            }
          }
          mix = {
            rgb: [coeffs[0], coeffs[1], coeffs[2]],
            max: coeffs[3],
            min: coeffs[4],
            channel: coeffs[5],
          };
          break;
        default:
          break;
      }
      // Normalize the weights to sum to 1.
      const weightSum = mix.rgb[0] + mix.rgb[1] + mix.rgb[2] + mix.max +
          mix.min + mix.channel;
      if (weightSum > 0) {
        for (let c = 0; c < 3; ++c) {
          mix.rgb[c] /= weightSum;
        }
        mix.max /= weightSum;
        mix.min /= weightSum;
        mix.channel /= weightSum;
      }

      if (componentMixingType !== 3) {
        stream.skipBits(6); // reserved
      }
      if (i === 0) {
        commonMix = mix;
      }
    } else {
      mix = commonMix;
    }

    let curveLength = 0;
    let usePchipSlope = false;
    let curve: Point2[] = [];
    if (i === 0 || !hasCommonCurveParamsFlag) {
      curveLength = stream.readBits(5) + 1;
      usePchipSlope = stream.readBits(1) === 1;
      stream.skipBits(2); // reserved
      for (let j = 0; j < curveLength; ++j) {
        curve.push({x: readScaledU16(stream, 1000, 0, 0, 64000), y: 0});
      }
      if (i === 0) {
        commonCurve = curve;
        commonCurveLength = curveLength;
        commonUsePchipSlope = usePchipSlope;
      }
    } else {
      curve = commonCurve.map((p) => ({x: p.x, y: 0}));
      curveLength = commonCurveLength;
      usePchipSlope = commonUsePchipSlope;
    }

    const sign = baselineHdrHeadroom < headroom ? 1 : -1;
    for (let j = 0; j < curveLength; ++j) {
      curve[j].y = readScaledU16(stream, 10000, 0, 0, 60000) * sign;
    }

    if (usePchipSlope) {
      const slopes = pchipInterpolationSlopes(
        curve.map((p) => p.x),
        curve.map((p) => p.y),
      );
      for (let j = 0; j < curveLength; ++j) {
        curve[j].m = slopes[j];
      }
    } else {
      for (let j = 0; j < curveLength; ++j) {
        const theta = readScaledU16(stream, 36000 / Math.PI, 18000, 1, 35999);
        curve[j].m = Math.tan(theta);
      }
    }
    const altr: Altr = {
      headroom,
      curve,
      mix,
    };
    altrList.push(altr);
  }

  return {
    altr: altrList,
    gain_application_space_primaries: primaries,
    gain_application_space_chromaticities: chromaticities,
    hdr_reference_white: hdrReferenceWhite,
    baseline_hdr_headroom: baselineHdrHeadroom,
  };
}
