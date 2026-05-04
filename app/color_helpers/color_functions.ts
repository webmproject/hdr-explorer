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

import {clamp, Mat3, mat3Inv, mat3Mm, mat3Mvm, point3ToVec3, vec3ToPoint3} from './math_helpers';

/** Color functions in GLSL. */
export const kColorFunctionGlsl = `
const int kPrimariesSRGB = 1;
const int kPrimariesRec2020 = 9;
const int kPrimariesP3 = 12;
const int kPrimariesXYZD50 = 1000;

const int kTransferRec709 = 1;
const int kTransferG22 = 4;
const int kTransferG28 = 6;
const int kTransferSrgb = 13;
const int kTransferRec2020_10bit = 14;
const int kTransferRec2020_12bit = 15;
const int kTransferPQ = 16;
const int kTransferHLG = 18;

mat3 primariesToXYZD50(int primaries) {
  if (primaries == kPrimariesSRGB) {
    return mat3(0.43606567, 0.2224884,  0.01391602,
                0.38514709, 0.71687317, 0.09707642,
                0.14306641, 0.06060791, 0.71409607);
  }
  if (primaries == kPrimariesRec2020) {
    return mat3(0.673459,  0.279033,   -0.00193139,
                0.165661,  0.675338,    0.0299794,
                0.1251,    0.0456288,   0.797162);
  }
  if (primaries == kPrimariesP3) {
    return mat3(0.515102,  0.241182,  -0.00104941,
                0.291965,  0.692236,   0.0418818,
                0.157153,  0.0665819,  0.784378);
  }
  if (primaries == kPrimariesXYZD50) {
    return mat3(1.0, 0.0, 0.0,
                0.0, 1.0, 0.0,
                0.0, 0.0, 1.0);
  }
  return mat3(1.0);
}
mat3 primariesFromXYZD50(int primaries) {
  if (primaries == kPrimariesSRGB) {
    return mat3( 3.13411215, -0.97878729,  0.07198304,
                -1.61739246,  1.91627959, -0.22898585,
                -0.4906334,   0.03345471,  1.40538513);
  }
  if (primaries == kPrimariesRec2020) {
    return mat3( 1.6472752,  -0.68261762,  0.02966273,
                -0.39360248,  1.64761778, -0.06291669,
                -0.23598029,  0.01281627,  1.25339643);
  }
  if (primaries == kPrimariesP3) {
    return mat3( 2.40404516, -0.84222838,  0.04818706,
                -0.98989869,  1.79885051, -0.09737385,
                -0.39763172,  0.01604817,  1.27350664);
  }
  if (primaries == kPrimariesXYZD50) {
    return mat3(1.0, 0.0, 0.0,
                0.0, 1.0, 0.0,
                0.0, 0.0, 1.0);
  }
  return mat3(1.0);
}
vec3 primariesConvert(vec3 rgb, int src, int dst) {
  if (src == dst) {
    return rgb;
  }
  return primariesFromXYZD50(dst) * primariesToXYZD50(src) * rgb;
}

mat3 computeXYZMatrix(vec4 rg, vec4 bw) {
  vec2 r = rg.xy;
  vec2 g = rg.zw;
  vec2 b = bw.xy;
  vec2 w = bw.zw;

  float oneRxRy = (1.0 - r.x) / r.y;
  float oneGxGy = (1.0 - g.x) / g.y;
  float oneBxBy = (1.0 - b.x) / b.y;
  float oneWxWy = (1.0 - w.x) / w.y;

  float rxRy = r.x / r.y;
  float gxGy = g.x / g.y;
  float bxBy = b.x / b.y;
  float wxWy = w.x / w.y;

  float by = ((oneWxWy - oneRxRy) * (gxGy - rxRy) - (wxWy - rxRy) * (oneGxGy - oneRxRy)) /
             ((oneBxBy - oneRxRy) * (gxGy - rxRy) - (bxBy - rxRy) * (oneGxGy - oneRxRy));
  float gy = (wxWy - rxRy - by * (bxBy - rxRy)) / (gxGy - rxRy);
  float ry = 1.0 - gy - by;

  float ryRy = ry / r.y;
  float gyGy = gy / g.y;
  float byBy = by / b.y;

  return mat3(
    ryRy * r.x, ry, ryRy * (1.0 - r.x - r.y),
    gyGy * g.x, gy, gyGy * (1.0 - g.x - g.y),
    byBy * b.x, by, byBy * (1.0 - b.x - b.y)
  );
}

mat3 computeBradfordAdaptationMatrix(vec2 whitePoint) {
  vec3 W_src = vec3(whitePoint.x / whitePoint.y, 1.0, (1.0 - whitePoint.x - whitePoint.y) / whitePoint.y);
  vec3 W_D50 = vec3(0.96422, 1.0, 0.82521);
  mat3 M_B = mat3(
    0.8951, -0.7502, 0.0389,
    0.2664, 1.7135, -0.0685,
    -0.1614, 0.0367, 1.0296
  );
  mat3 M_B_inv = mat3(
    0.9869929, 0.4323121, -0.0085287,
    -0.1470543, 0.5183603, 0.0400428,
    0.1599627, 0.0492912, 0.9684867
  );
  vec3 LMS_src = M_B * W_src;
  vec3 LMS_D50 = M_B * W_D50;
  mat3 D = mat3(
    LMS_D50.x / LMS_src.x, 0.0, 0.0,
    0.0, LMS_D50.y / LMS_src.y, 0.0,
    0.0, 0.0, LMS_D50.z / LMS_src.z
  );
  return M_B_inv * D * M_B;
}

mat3 computeXYZD50Matrix(vec4 rg, vec4 bw) {
  mat3 nativeXYZ = computeXYZMatrix(rg, bw);
  mat3 adapt = computeBradfordAdaptationMatrix(bw.zw);
  return adapt * nativeXYZ;
}

float transferToLinear(float x, int transfer) {
  if (transfer == kTransferRec709 ||
      transfer == kTransferRec2020_10bit ||
      transfer == kTransferRec2020_12bit) {
    transfer = kTransferSrgb;
  }
  if (transfer == kTransferG22) {
    return pow(x, 2.2);
  }
  if (transfer == kTransferG28) {
    return pow(x, 2.8);
  }
  if (transfer == kTransferSrgb) {
    if (x < 0.04045)
      return x / 12.92;
    return pow((x + 0.055)/1.055, 2.4);
  }
  if (transfer == kTransferPQ) {
    float c1 =  107.0 / 128.0;
    float c2 = 2413.0 / 128.0;
    float c3 = 2392.0 / 128.0;
    float m1 = 1305.0 / 8192.0;
    float m2 = 2523.0 / 32.0;
    float p = pow(clamp(x, 0.0, 1.0), 1.0 / m2);
    return pow(max(p - c1, 0.0) / (c2 - c3 * p), 1.0 / m1);
  }
  if (transfer == kTransferHLG) {
    const float a = 0.17883277;
    const float b = 0.28466892; // 1.0 - 4.0 * a;
    const float c = 0.55991073; // 0.5 - a * log(4.0 * a);
    if (x <= 0.5) { // sqrt(3*1/12)=0.5
      // E'=sqrt(3E) with E' being x and returning E
      return x * x / 3.0;
    } else {
      // E'=a.ln(12E-b)+c with E' being x and returning E
      return (exp((x - c) / a) + b) / 12.0;
    }
  }
  return 0.0;
}
float transferFromLinear(float x, int transfer) {
  if (transfer == kTransferRec709 ||
      transfer == kTransferRec2020_10bit ||
      transfer == kTransferRec2020_12bit) {
    // Do sRGB.
    transfer = kTransferSrgb;
  }
  if (transfer == kTransferG22) {
    return pow(x, 1.0/2.2);
  }
  if (transfer == kTransferG28) {
    return pow(x, 1.0/2.8);
  }
  if (transfer == kTransferSrgb) {
    if (x < 0.003130800090713953)
      return 12.919999999992248*x;
    return pow(1.1371188301409823*x, 0.4166666666666667) - 0.05499994754780801;
  }
  if (transfer == kTransferPQ) {
    float c1 =  107.0 / 128.0;
    float c2 = 2413.0 / 128.0;
    float c3 = 2392.0 / 128.0;
    float m1 = 1305.0 / 8192.0;
    float m2 = 2523.0 / 32.0;
    float v = pow(clamp(x, 0.0, 1.0), m1);
    return pow((c1 + c2 * v) / (1.0 + c3 * v), m2);
  }
  if (transfer == kTransferHLG) {
    const float a = 0.17883277;
    const float b = 1.0 - 4.0*a;
    const float c = 0.5 - a * log(4.0 * a);
    if (x < 1.0/12.0) {
      return sqrt(3.0 * x);
    }
    return a * log(12.0 * x - b) + c;
  }
  return 0.0;
}

vec3 ApplyOetfInv(vec3 x, int transfer) {
  return vec3(sign(x[0]) * transferToLinear(abs(x[0]), transfer),
              sign(x[1]) * transferToLinear(abs(x[1]), transfer),
              sign(x[2]) * transferToLinear(abs(x[2]), transfer));
}
vec3 ApplyOetf(vec3 x, int transfer) {
  return vec3(sign(x[0]) * transferFromLinear(abs(x[0]), transfer),
              sign(x[1]) * transferFromLinear(abs(x[1]), transfer),
              sign(x[2]) * transferFromLinear(abs(x[2]), transfer));
}

vec3 ToDisplayWithClamping(vec3 rgb, int texture_primaries, int framebuffer_primaries,
                       int framebuffer_trfn, float target_log2_headroom,
                       float linear_scale, bool show_clamped) {
  float max_val = exp2(target_log2_headroom);
  if (show_clamped && (rgb.r > max_val || rgb.g > max_val || rgb.b > max_val)) {
    return vec3(1.0, 0.0, 1.0); // Bright pink
  }
  vec3 rgb_display = primariesConvert(rgb, texture_primaries, framebuffer_primaries);
  if (show_clamped && (rgb_display.r > max_val || rgb_display.g > max_val || rgb_display.b > max_val)) {
    return vec3(0.0, 1.0, 1.0); // Bright cyan
  }
  rgb_display *= linear_scale;
  rgb_display = ApplyOetf(rgb_display, framebuffer_trfn);
  return clamp(rgb_display, 0.0, max_val);
}

vec3 ApplyOotf(vec3 rgb, int primaries, int transfer) {
  if (transfer != kTransferHLG) {
    return rgb;
  }
  rgb = primariesConvert(rgb, primaries, kPrimariesRec2020);
  float Y = 0.2627 * rgb.r + 0.6780 * rgb.g + 0.0593 * rgb.b;
  rgb *= pow(Y, 0.2);
  rgb = primariesConvert(rgb, kPrimariesRec2020, primaries);
  return rgb;
}

// Converts an RGB color from a given input primary space to the space defined by
// the given chromaticities.
vec3 ConvertToGainApplicationSpace(
    vec3 rgb,
    int input_color_primaries,
    vec4 gain_application_space_rg,
    vec4 gain_application_space_bw) {
  mat3 gain_application_space_to_XYZ = computeXYZD50Matrix(gain_application_space_rg, gain_application_space_bw);
  mat3 XYZ_to_gain_application_space = inverse(gain_application_space_to_XYZ);
  mat3 input_to_XYZ = primariesToXYZD50(input_color_primaries);
  return XYZ_to_gain_application_space * input_to_XYZ * rgb;
}

// Converts an RGB color from the space defined by the given chromaticities
// to a given output primary space.
vec3 ConvertFromGainApplicationSpace(
    vec3 rgb,
    int output_color_primaries,
    vec4 gain_application_space_rg,
    vec4 gain_application_space_bw) {
  mat3 gain_application_space_to_XYZ = computeXYZD50Matrix(gain_application_space_rg, gain_application_space_bw);
  mat3 XYZ_to_output = primariesFromXYZD50(output_color_primaries);
  return XYZ_to_output * gain_application_space_to_XYZ * rgb;
}

// https://en.wikipedia.org/wiki/YCbCr#ITU-R_BT.2020_conversion
vec3 RgbToYCbCr(vec3 rgb) {
  float y = rgb.r * 0.2627 + rgb.g * 0.6780 + rgb.b * 0.0593;
  float cb = (rgb.b - y) / 1.8814;
  float cr = (rgb.r - y) / 1.4746;
  return vec3(y, cb, cr);
}
vec3 YCbCrToRgb(vec3 ycbcr) {
  float r = ycbcr.r + ycbcr.b * 1.4746;
  float g = ycbcr.r - ycbcr.g * 0.16455312684366 - ycbcr.b * 0.57135312684366;
  float b = ycbcr.r + ycbcr.g * 1.8814;
  return vec3(r, g, b);
}

float Average(vec3 xyz) {
  return (xyz.x + xyz.y + xyz.z) / 3.0;
}
`;

export const kPrimariesSRGB = 1;
export const kPrimariesRec2020 = 9;
export const kPrimariesP3 = 12;

/** sRGB chromaticities: [rx, ry, gx, gy, bx, by, wx, wy] */
export const CHROMATICITIES_SRGB = [
  0.64, 0.33, 0.3, 0.6, 0.15, 0.06, 0.3127, 0.329,
];
/** Rec. 2020 chromaticities: [rx, ry, gx, gy, bx, by, wx, wy] */
export const CHROMATICITIES_REC2020 = [
  0.708, 0.292, 0.17, 0.797, 0.131, 0.046, 0.3127, 0.329,
];
/** P3 chromaticities: [rx, ry, gx, gy, bx, by, wx, wy] */
export const CHROMATICITIES_P3 = [
  0.68, 0.32, 0.265, 0.69, 0.15, 0.06, 0.3127, 0.329,
];

// CICP enum values.
export const kTransferRec709 = 1;
export const kTransferG22 = 4;
export const kTransferG28 = 6;
export const kTransferSrgb = 13;
export const kTransferRec202010Bit = 14;
export const kTransferRec202012Bit = 15;
export const kTransferPQ = 16;
export const kTransferHLG = 18;
// Not in CICP. Based on the JzAzBz color space.
export const kTransferJz = 42; // Arbitrary enum value.

/**
 * Returns a human-readable name for the given primary enum or chromaticities.
 * @param primaries The CICP enum or chromaticity array.
 * @return A descriptive string.
 */
export function getPrimariesName(primaries: number | number[]): string {
  if (typeof primaries !== 'number') {
    return 'Custom Color Space';
  }
  switch (primaries) {
    case kPrimariesSRGB:
      return 'sRGB';
    case kPrimariesRec2020:
      return 'BT.2020';
    case kPrimariesP3:
      return 'P3';
    default:
      return 'Unknown';
  }
}

/**
 * Converts a value from a non-linear transfer function to a linear value.
 * @param x The non-linear value.
 * @param transfer The transfer function CICP identifier.
 * @return The converted linear value.
 */
export function transferToLinear(x: number, transfer: number): number {
  if (
    transfer === kTransferRec709 ||
    transfer === kTransferRec202010Bit ||
    transfer === kTransferRec202012Bit
  ) {
    // Do sRGB.
    transfer = kTransferSrgb;
  }
  if (transfer === kTransferG22) {
    // Gamma 2.2
    return Math.pow(x, 2.2);
  }
  if (transfer === kTransferG28) {
    // Gamma 2.8
    return Math.pow(x, 2.8);
  }
  if (transfer === kTransferSrgb) {
    // sRGB
    if (x < 0.04045) return x / 12.92;
    return Math.pow((x + 0.055) / 1.055, 2.4);
  }
  if (transfer === kTransferPQ || transfer === kTransferJz) {
    // PQ
    const c1 = 107.0 / 128.0;
    const c2 = 2413.0 / 128.0;
    const c3 = 2392.0 / 128.0;
    const m1 = 1305.0 / 8192.0;
    const m2 = (2523.0 / 32.0) * (transfer === kTransferJz ? 1.7 : 1.0);
    const p = Math.pow(clamp(x, 0.0, 1.0), 1.0 / m2);
    return Math.pow(Math.max(p - c1, 0.0) / (c2 - c3 * p), 1.0 / m1);
  }
  if (transfer === kTransferHLG) {
    // HLG
    const a = 0.17883277;
    const b = 1.0 - 4.0 * a;
    const c = 0.5 - a * Math.log(4.0 * a);
    if (x <= 0.5) {
      return Math.pow(x, 2.0) / 3.0;
    } else {
      return (Math.exp((x - c) / a) + b) / 12.0;
    }
  }
  return 0.0;
}

export function rec2020Luma(rgb: number[]) {
  return 0.2627 * rgb[0] + 0.678 * rgb[1] + 0.0593 * rgb[2];
}

/**
 * Converts a linear value to a non-linear value using a specified transfer function.
 * @param x The linear value in the range [0, 1].
 * @param transfer The transfer function identifier.
 * @return The converted non-linear value in the range [0, 1].
 */
export function transferFromLinear(x: number, transfer: number): number {
  if (
    transfer === kTransferRec709 ||
    transfer === kTransferRec202010Bit ||
    transfer === kTransferRec202012Bit
  ) {
    // Do sRGB.
    transfer = kTransferSrgb;
  }
  if (transfer === kTransferG22) {
    // Gamma 2.2
    return Math.pow(x, 1.0 / 2.2);
  }
  if (transfer === kTransferG28) {
    // Gamma 2.8
    return Math.pow(x, 1.0 / 2.8);
  }
  if (transfer === kTransferSrgb) {
    // sRGB
    if (x < 0.003130800090713953) {
      return 12.919999999992248 * x;
    }
    return (
      Math.pow(1.1371188301409823 * x, 0.4166666666666667) - 0.05499994754780801
    );
  }
  if (transfer === kTransferPQ || transfer === kTransferJz) {
    // PQ
    const c1 = 107.0 / 128.0;
    const c2 = 2413.0 / 128.0;
    const c3 = 2392.0 / 128.0;
    const m1 = 1305.0 / 8192.0;
    const m2 = (2523.0 / 32.0) * (transfer === kTransferJz ? 1.7 : 1.0);
    const v = Math.pow(clamp(x, 0.0, 1.0), m1);
    return Math.pow((c1 + c2 * v) / (1.0 + c3 * v), m2);
  }
  if (transfer === kTransferHLG) {
    // HLG
    const a = 0.17883277;
    const b = 1.0 - 4.0 * a;
    const c = 0.5 - a * Math.log(4.0 * a);
    if (x < 1.0 / 12.0) {
      return Math.sqrt(3.0 * x);
    }
    return a * Math.log(12.0 * x - b) + c;
  }
  return 0.0;
}


/**
 * Computes the matrix to convert from RGB to XYZ given primaries and whitepoint.
 * Does not perform chromatic adaptation.
 * @param chromaticities The r, g, b and white chromaticity coordinates.
 * @return The 3x3 RGB to XYZ conversion matrix.
 */
function computeXYZMatrix(chromaticities: number[]): Mat3 {
  const r = [chromaticities[0], chromaticities[1]];
  const g = [chromaticities[2], chromaticities[3]];
  const b = [chromaticities[4], chromaticities[5]];
  const w = [chromaticities[6], chromaticities[7]];

  const oneRxRy = (1 - r[0]) / r[1];
  const oneGxGy = (1 - g[0]) / g[1];
  const oneBxBy = (1 - b[0]) / b[1];
  const oneWxWy = (1 - w[0]) / w[1];

  const rxRy = r[0] / r[1];
  const gxGy = g[0] / g[1];
  const bxBy = b[0] / b[1];
  const wxWy = w[0] / w[1];

  const by =
    ((oneWxWy - oneRxRy) * (gxGy - rxRy) -
      (wxWy - rxRy) * (oneGxGy - oneRxRy)) /
    ((oneBxBy - oneRxRy) * (gxGy - rxRy) - (bxBy - rxRy) * (oneGxGy - oneRxRy));
  const gy = (wxWy - rxRy - by * (bxBy - rxRy)) / (gxGy - rxRy);
  const ry = 1 - gy - by;

  const ryRy = ry / r[1];
  const gyGy = gy / g[1];
  const byBy = by / b[1];

  return {
    xx: ryRy * r[0],
    xy: gyGy * g[0],
    xz: byBy * b[0],
    yx: ry,
    yy: gy,
    yz: by,
    zx: ryRy * (1 - r[0] - r[1]),
    zy: gyGy * (1 - g[0] - g[1]),
    zz: byBy * (1 - b[0] - b[1]),
  };
}

function computeBradfordAdaptationMatrix(
  whitePoint: [number, number],
): Mat3 {
  const wx = whitePoint[0];
  const wy = whitePoint[1];

  const xSrc = wx / wy;
  const ySrc = 1.0;
  const zSrc = (1.0 - wx - wy) / wy;

  const xD50 = 0.96422;
  const yD50 = 1.0;
  const zD50 = 0.82521;

  const mB: Mat3 = {
    xx: 0.8951, xy: 0.2664, xz: -0.1614,
    yx: -0.7502, yy: 1.7135, yz: 0.0367,
    zx: 0.0389, zy: -0.0685, zz: 1.0296,
  };
  const mBInv: Mat3 = {
    xx: 0.9869929, xy: -0.1470543, xz: 0.1599627,
    yx: 0.4323121, yy: 0.5183603, yz: 0.0492912,
    zx: -0.0085287, zy: 0.0400428, zz: 0.9684867,
  };

  const lmsSrc = mat3Mvm(mB, {x: xSrc, y: ySrc, z: zSrc});
  const lmsD50 = mat3Mvm(mB, {x: xD50, y: yD50, z: zD50});

  const d: Mat3 = {
    xx: lmsD50.x / lmsSrc.x, xy: 0, xz: 0,
    yx: 0, yy: lmsD50.y / lmsSrc.y, yz: 0,
    zx: 0, zy: 0, zz: lmsD50.z / lmsSrc.z,
  };

  return mat3Mm(mBInv, mat3Mm(d, mB));
}

function computeXYZD50Matrix(chromaticities: number[]): Mat3 {
  const nativeMat = computeXYZMatrix(chromaticities);
  const adaptMat = computeBradfordAdaptationMatrix([
    chromaticities[6],
    chromaticities[7],
  ]);
  return mat3Mm(adaptMat, nativeMat);
}

export function getChromaticities(primaries: number): number[] {
  switch (primaries) {
    case kPrimariesSRGB:
      return CHROMATICITIES_SRGB;
    case kPrimariesRec2020:
      return CHROMATICITIES_REC2020;
    case kPrimariesP3:
      return CHROMATICITIES_P3;
    default:
      console.error(`Unknown primaries: ${primaries}`);
      return CHROMATICITIES_REC2020;
  }
}

export function getLumaCoeffs(primaries: number | number[]): number[] {
  if (typeof primaries === 'number') {
    if (primaries === kPrimariesSRGB) {
      return [0.2126, 0.7152, 0.0722];
    } else if (primaries === kPrimariesRec2020) {
      return [0.2627, 0.678, 0.0593];
    } else if (primaries === kPrimariesP3) {
      return [0.229, 0.6917, 0.0793];
    }
  }
  // If not precomputed above, compute from chromaticities.
  const flatChromas =
    typeof primaries === 'number' ? getChromaticities(primaries) : primaries;
  const xyzMatrix = computeXYZMatrix(flatChromas);
  return [xyzMatrix.yx, xyzMatrix.yy, xyzMatrix.yz];
}

/** Converts primaries to XYZD50 matrix (TypeScript version). */
function primariesToXYZD50(primaries: number): Mat3 {
  // Note that the matrices are row-major unlike the ones in GLSL which are
  // column-major so they look transposed.
  // These matrices are WITH chromatic adaptation.
  if (primaries === kPrimariesSRGB) {
    return {
      xx: 0.43606567, xy: 0.38514709, xz: 0.14306641,
      yx: 0.2224884, yy: 0.71687317, yz: 0.06060791,
      zx: 0.01391602, zy: 0.09707642, zz: 0.71409607,
    };
  }
  if (primaries === kPrimariesRec2020) {
    return {
      xx: 0.673459, xy: 0.165661, xz: 0.1251,
      yx: 0.279033, yy: 0.675338, yz: 0.0456288,
      zx: -0.00193139, zy: 0.0299794, zz: 0.797162,
    };
  }
  if (primaries === kPrimariesP3) {
    return {
      xx: 0.515102, xy: 0.291965, xz: 0.157153,
      yx: 0.241182, yy: 0.692236, yz: 0.0665819,
      zx: -0.00104941, zy: 0.0418818, zz: 0.784378,
    };
  }
  // Assuming kPrimariesXYZD50 or default to identity.
  return {
    xx: 1.0, xy: 0.0, xz: 0.0,
    yx: 0.0, yy: 1.0, yz: 0.0,
    zx: 0.0, zy: 0.0, zz: 1.0,
  };
}

/** Converts from XYZD50 to primaries matrix (TypeScript version). */
function primariesFromXYZD50(primaries: number): Mat3 {
  // Note that the matrices are row-major unlike the ones in GLSL which are
  // column-major so they look transposed.
  if (primaries === kPrimariesSRGB) {
    return {
      xx: 3.13411215, xy: -1.61739246, xz: -0.4906334,
      yx: -0.97878729, yy: 1.91627959, yz: 0.03345471,
      zx: 0.07198304, zy: -0.22898585, zz: 1.40538513,
    };
  }
  if (primaries === kPrimariesRec2020) {
    return {
      xx: 1.6472752, xy: -0.39360248, xz: -0.23598029,
      yx: -0.68261762, yy: 1.64761778, yz: 0.01281627,
      zx: 0.02966273, zy: -0.06291669, zz: 1.25339643,
    };
  }
  if (primaries === kPrimariesP3) {
    return {
      xx: 2.40404516, xy: -0.98989869, xz: -0.39763172,
      yx: -0.84222838, yy: 1.79885051, yz: 0.01604817,
      zx: 0.04818706, zy: -0.09737385, zz: 1.27350664,
    };
  }
  // Assuming kPrimariesXYZD50 or default to identity.
  return {
    xx: 1.0, xy: 0.0, xz: 0.0,
    yx: 0.0, yy: 1.0, yz: 0.0,
    zx: 0.0, zy: 0.0, zz: 1.0,
  };
}

function getXYZD50Matrix(primaries: number | number[]): Mat3 {
  if (typeof primaries === 'number') {
    return primariesToXYZD50(primaries);
  }
  return computeXYZD50Matrix(primaries);
}

/**
 * Converts an RGB color from a source primary space to a destination primary space.
 * @param rgb The RGB color as a 3-element array.
 * @param src The source primary space identifier or chromaticities array.
 * @param dst The destination primary space identifier or chromaticities array.
 * @return The RGB color in the destination primary space.
 */
export function primariesConvert(
  rgb: number[],
  src: number | number[],
  dst: number | number[],
): number[] {
  if (src === dst) {
    return [...rgb]; // Return a copy
  }
  const toXYZ = getXYZD50Matrix(src);
  const fromXYZ =
    typeof dst === 'number'
      ? primariesFromXYZD50(dst)
      : mat3Inv(getXYZD50Matrix(dst));
  // The combined matrix is fromXYZ * toXYZ
  const conversionMatrix = mat3Mm(fromXYZ, toXYZ);
  return point3ToVec3(mat3Mvm(conversionMatrix, vec3ToPoint3(rgb)));
}

export function getMaxNits(contentTransfer: number): number {
  return contentTransfer === kTransferPQ
    ? 10000
    : contentTransfer === kTransferHLG
      ? 1000
      : contentTransfer === kTransferSrgb
        ? 203
        : 1;
}
