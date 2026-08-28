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

import {binomialCoefficient} from './math_helpers';

export declare interface Hdr10pWindow {
  maxscl: number[]; // 0 to 100,000, inclusive (representing 0 to 10,000 cd/m2)
  average_maxrgb: number; // same range/unit as maxscl
  num_distributions: number;
  distribution_index: number[]; // 0 to 99, inclusive (99 means 99.98%)
  distribution_values: number[]; // same range/unit as maxscl
  fraction_bright_pixels: number; // shall be 0
  tone_mapping_flag: number; // probably 1
  knee_point_x: number; // 0 to 4,095, inclusive
  knee_point_y: number; // 0 to 4,095, inclusive
  num_bezier_curve_anchors: number;
  bezier_curve_anchors: number[]; // 0 to 1,023, inclusive (representing 0 to 1)
  color_saturation_mapping_flag: number; // shall be 0
}

// https://www.atsc.org/wp-content/uploads/2018/02/A341S34-1-582r4-A341-Amendment-2094-40.pdf#page=6
export declare interface Hdr10pMetadata {
  terminal_provider_oriented_code: number;
  application_identifier: number;
  application_version: number;
  num_windows: number;
  targeted_system_display_maximum_luminance: number; // 0 to 10,000, inclusive
  targeted_system_display_actual_peak_luminance_flag: number; // shall be 0
  windows: Hdr10pWindow[];
  mastering_display_actual_peak_luminance_flag: number; // shall be 0
}

/*
 * Helper functions to implement the reference rendering method from
 * https://www.atsc.org/wp-content/uploads/2024/04/A341-2024-04-Video-HEVC.pdf
 * See also hdr10p_renderer.ts for more details.
 * Variable names match the specification.
 */

export function guidedKneePoint(
  t: number,
  d: number,
  norm: number,
  kvec: {x: number; y: number},
): {x: number; y: number} {
  if (d <= t) {
    const k0Vec = {x: 0.0, y: 0.0};
    const dL = 0.0;
    const w = Math.max(0.0, (d - dL) / (t - dL));
    return {
      x: w * kvec.x + (1.0 - w) * k0Vec.x,
      y: w * kvec.y + (1.0 - w) * k0Vec.y,
    };
  } else {
    const k1Vec = {x: 0.5, y: 0.5};
    const normMinusT = norm - t;
    const w = Math.max(
      0.0,
      1.0 - (normMinusT > 0 ? Math.max(0.0, (d - t) / normMinusT) : 0.0),
    );
    return {
      x: w * kvec.x + (1.0 - w) * k1Vec.x,
      y: w * kvec.y + (1.0 - w) * k1Vec.y,
    };
  }
}

export function guidedBezierCurveVector(
  t: number,
  d: number,
  norm: number,
  pLen: number,
  p: number[],
): number[] {
  const pVec = new Array<number>(pLen);
  if (d <= t) {
    const dL = 0.0;
    const u = Math.max(0.0, (d - dL) / (t - dL));
    for (let i = 0; i < pLen; ++i) {
      const p0VecI = i === 0 ? 0.0 : 1.0;
      pVec[i] = u * p[i] + (1.0 - u) * p0VecI;
    }
  } else {
    const normMinusT = norm - t;
    const u =
      1.0 -
      (normMinusT > 0 ? Math.max(0.0, (d - t) / normMinusT) : 0.0);
    for (let i = 0; i < pLen; ++i) {
      const pLVecI = i / (pLen - 1);
      pVec[i] = u * p[i] + (1.0 - u) * pLVecI;
    }
  }
  return pVec;
}

export function applySlopeContinuity(
  kvec: {x: number; y: number},
  pLen: number,
  p: number[],
): number[] {
  const continuousP = [...p];
  if (kvec.x > 0.0 && kvec.y < 1.0 && kvec.x < 1.0) {
    continuousP[1] =
      (1.0 / (pLen - 1)) *
      (kvec.y / kvec.x) *
      ((1.0 - kvec.x) / (1.0 - kvec.y));
  }
  return continuousP;
}

export function applyBezier(t: number, pLen: number, p: number[]): number {
  const degree = pLen - 1;
  let result = 0.0;
  for (let i = 1; i < pLen; ++i) {
    result +=
      binomialCoefficient(degree, i) *
      Math.pow(1.0 - t, degree - i) *
      Math.pow(t, i) *
      p[i];
  }
  return result;
}

export function applyKneePointBezier(
  kvec: {x: number; y: number},
  pLen: number,
  p: number[],
  x: number,
): number {
  if (x < kvec.x) {
    return kvec.x > 0.0 ? x * (kvec.y / kvec.x) : x;
  } else if (x >= 1.0) {
    return 1.0;
  } else {
    const continuousP = applySlopeContinuity(kvec, pLen, p);
    const t = (x - kvec.x) / (1.0 - kvec.x);
    const y = applyBezier(t, pLen, continuousP);
    return kvec.y + y * (1.0 - kvec.y);
  }
}

