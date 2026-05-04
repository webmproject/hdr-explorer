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

import {AgtmMetadata} from './agtm';
import {
  agtmAdapt,
  AgtmAdaptResult,
  generate1dGainLut,
  generate3dLut,
  getGainApplicationPrimaries,
  getSortedAltrsWithZeroGain,
  getToLut1d,
  LutOptions,
  lutOptionsAreEqual,
} from './agtm_adapt';
import {
  getChromaticities,
  getLumaCoeffs,
  getMaxNits,
  kPrimariesP3,
} from './color_functions';
import {exp2} from './math_helpers';

/** AGTM tone mapper shader. */
export const kAgtmToneMapperGlsl = `
  uniform sampler2D curve_xym;
  uniform float curve_tex_w;
  uniform float curve_tex_h;
  uniform float curve_texcoord_y_i;
  uniform float curve_N_cp_i;
  uniform float curve_texcoord_y_j;
  uniform float curve_N_cp_j;
  uniform float weight_i;
  uniform float weight_j;
  uniform vec3 mix_rgb_i;
  uniform vec3 mix_rgb_j;
  uniform vec3 mix_Mmc_i;
  uniform vec3 mix_Mmc_j;
  uniform vec4 gain_application_space_rg;
  uniform vec4 gain_application_space_bw;
  uniform vec3 luma_coeffs;

  // LUT-based tone mapping is designed to match the Android hardware LUT API
  // https://developer.android.com/media/grow/hdr-lut
  // This API consists of an optional 1D LUT followed by an optional 3D LUT.
  //
  // Inputs to the first LUT are linear color values in [0, 1], where 1
  // represents 'lut_input_max', which should be the maximum value of the
  // content's transfer function.
  //
  // 1D LUT ('lut1d'):
  // -   'lut1d_size': The size of the 1D LUT. If > 1.0, the 1D LUT is applied.
  // -   'sampling_type': Determines how the vec3 input is mapped to a single value for the 1D LUT:
  //     -   0 (rgb): Each channel is sampled independently.
  //     -   1 (maxrgb): The maximum of the RGB channels is used.
  //     -   2 (ciey): The CIE Y (luma) is used, calculated with 'luma_coeffs'.
  // -   The 1D LUT contains gain values. The output of the 1D stage is the
  //     input color multiplied by the sampled gain, which should be in [0, 1].
  //
  // 3D LUT ('lut3d'):
  // -   'lut3d_size': The size of the 3D LUT. If > 1.0, the 3D LUT is applied.
  // -   The input to the 3D LUT is the output of the 1D LUT stage, or the
  //     linear color values in [0, 1] if there is no 1D LUT.
  // -   The 3D LUT is sampled using tetrahedral interpolation ('Sample3dTex3dTetrahedral').
  //
  // Outputs:
  // -   The final output of the LUT pipeline is normalized so that 1 represents
  //     'lut_output_max' which should be the display headroom. Values may actually
  //      exceed that range depending on the AGTM mix function and will be clipped
  //      at display time (only 'maxRGB' and 'channel' mix function guarantee that
  //      the output stays in range)
  uniform sampler2D lut1d;
  uniform sampler2D lut3d;
  uniform float lut1d_size;
  uniform float lut3d_size;
  uniform float lut_input_max;
  uniform float lut_output_max;
  uniform int sampling_type; // 0=rgb, 1=maxrgb, 2=ciey
  uniform int lut_input_color_space_mode; // 0=gain, 1=content, 2=p3

  vec3 ConvertToLutInputSpace(vec3 rgb, int input_color_primaries) {
    if (lut_input_color_space_mode == 0) { // gain
      return ConvertToGainApplicationSpace(rgb, input_color_primaries, gain_application_space_rg, gain_application_space_bw);
    } else if (lut_input_color_space_mode == 2) { // p3
      return primariesConvert(rgb, input_color_primaries, kPrimariesP3);
    }
    return rgb; // content
  }

  vec3 ConvertFromLutInputSpace(vec3 rgb, int input_color_primaries) {
    if (lut_input_color_space_mode == 0) { // gain
      return ConvertFromGainApplicationSpace(rgb, input_color_primaries, gain_application_space_rg, gain_application_space_bw);
    } else if (lut_input_color_space_mode == 2) { // p3
      return primariesConvert(rgb, kPrimariesP3, input_color_primaries);
    }
    return rgb; // content
  }

  float Sample1d(float v) {
    v = clamp(v, 0.0, 1.0);
    vec2 tc = vec2((v * (lut1d_size - 1.0) + 0.5) / lut1d_size, 0.5);
    return texture(lut1d, tc).r;
  }

  // Tetrahedral sampling of 3D LUT.
  // The coordinates q are integers in the domain [0, N-1]^3.
  vec3 SampleTexture3dNearest(vec3 q) {
    float N = lut3d_size;
    vec2 tc = vec2((q.b + N*q.g + 0.5) / (N*N),
                   (q.r + 0.5) / N);
    return texture(lut3d, tc).rgb;
  }
  vec3 Sample3dTex3dTetrahedral(vec3 C_unit) {
    float N = lut3d_size;
    if (N <= 1.0) {
      return vec3(0.0, 0.0, 0.0);
    }
    vec3 C = clamp(C_unit, 0.0, 1.0) * (N - 1.0);
    vec3 K = floor(C);
    vec3 X = C - K;
    vec3 L = vec3(1.0);
    vec3 A;
    vec3 B;
    if (X[0] >= X[1] && X[1] >= X[2]) { A = vec3(1.0, 0.0, 0.0); B = vec3(1.0, 1.0, 0.0); }
    if (X[1] >= X[0] && X[0] >= X[2]) { A = vec3(1.0, 1.0, 0.0); B = vec3(0.0, 1.0, 0.0); }
    if (X[1] >= X[2] && X[2] >= X[0]) { A = vec3(0.0, 1.0, 0.0); B = vec3(0.0, 1.0, 1.0); }
    if (X[2] >= X[1] && X[1] >= X[0]) { A = vec3(0.0, 1.0, 1.0); B = vec3(0.0, 0.0, 1.0); }
    if (X[2] >= X[0] && X[0] >= X[1]) { A = vec3(0.0, 0.0, 1.0); B = vec3(1.0, 0.0, 1.0); }
    if (X[0] >= X[2] && X[2] >= X[1]) { A = vec3(1.0, 0.0, 1.0); B = vec3(1.0, 0.0, 0.0); }

    // The matrix being inverted is a constant, but I am also lazy.
    mat3 M = mat3(L, A, B);
    vec3 w = inverse(M) * X;
    float w_k = 1.0 - w[0] - w[1] - w[2];

    // Errors in barycentric coordinates are magenta.
    if (w[0] < 0.0 || w[0] > 1.0 ||
        w[1] < 0.0 || w[1] > 1.0 ||
        w[2] < 0.0 || w[2] > 1.0 ||
        w_k  < 0.0 || w_k  > 1.0) {
      return vec3(1.0, 0.0, 1.0);
    }

    // Reconstruction errors are in cyan.
    vec3 Cr = w_k  * ( K ) +
              w[0] * (K+L) +
              w[1] * (K+A) +
              w[2] * (K+B);
    if (length(C - Cr) > 0.1) {
      return vec3(0.0, 0.0, 1.0);
    }

    vec3 x = w_k  * SampleTexture3dNearest(K    ) +
             w[0] * SampleTexture3dNearest(K + L) +
             w[1] * SampleTexture3dNearest(K + A) +
             w[2] * SampleTexture3dNearest(K + B);
    return x;
  }

  // Component mixing function.
  vec3 EvaluateChannelMix(vec3 rgb, vec3 mix_rgb, vec3 mix_Mmc) {
    float c = dot(mix_rgb, rgb) +
              mix_Mmc[0] * max(max(rgb.r, rgb.g), rgb.b) +
              mix_Mmc[1] * min(min(rgb.r, rgb.g), rgb.b);
    float weightSum = mix_rgb.r + mix_rgb.g + mix_rgb.b +
                      mix_Mmc[0] + mix_Mmc[1] + mix_Mmc[2];
    return (mix_Mmc[2] * rgb + vec3(c)) / weightSum;
  }

  vec4 GetCurveXym(float c, float curve_texcoord_y) {
    return texture(curve_xym, vec2((c + 0.5) / curve_tex_w, (curve_texcoord_y + 0.5) / curve_tex_h));
  }

  // Piecewise cubic evaluation.
  float EvaluateGainCurve(float x, float curve_texcoord_y, float curve_N_cp) {
    float c_min = 0.0;
    vec4 xym_min = GetCurveXym(c_min, curve_texcoord_y);
    if (x <= xym_min.x) {
      return xym_min.y;
    }

    float c_max = curve_N_cp - 1.0;
    vec4 xym_max = GetCurveXym(c_max, curve_texcoord_y);
    if (x >= xym_max.x) {
      return xym_max.y + log2(xym_max.x / x);
    }

    // AGTM curves must have at most 32 control points, i.e. 2^5, so a binary
    // search is guaranteed to converge in 5 iterations or less.
    for (int step = 0; step < 5; ++step) {
      if (c_max - c_min <= 1.0) {
        break;
      }

      float c_mid = ceil(0.5 * (c_min + c_max));
      vec4 xym_mid = GetCurveXym(c_mid, curve_texcoord_y);
      if (x == xym_mid.x) {
        return xym_mid.y;
      } else if (x < xym_mid.x) {
        c_max = c_mid;
        xym_max = xym_mid;
      } else {
        c_min = c_mid;
        xym_min = xym_mid;
      }
    }

    float h = xym_max.x - xym_min.x;
    if (h == 0.0) {
      return xym_min.y;
    }
    float mHat_min = xym_min.z * h;
    float mHat_max = xym_max.z * h;
    float c3 =  2.0 * xym_min.y + mHat_min - 2.0 * xym_max.y + mHat_max;
    float c2 = -3.0 * xym_min.y + 3.0 * xym_max.y - 2.0 * mHat_min - mHat_max;
    float c1 = mHat_min;
    float c0 = xym_min.y;
    float t = (x - xym_min.x) / h;
    return ((c3*t + c2)*t + c1)*t + c0;
  }

  vec3 AgtmLogGain(vec3 rgb, bool j, bool merge_hlg_ootf) {
    vec3 mix_rgb = j ? mix_rgb_j : mix_rgb_i;
    vec3 mix_Mmc = j ? mix_Mmc_j : mix_Mmc_i;
    vec3 mix = EvaluateChannelMix(rgb, mix_rgb, mix_Mmc);

    float curve_y = j ? curve_texcoord_y_j : curve_texcoord_y_i;
    float curve_n = j ? curve_N_cp_j : curve_N_cp_i;

    if (merge_hlg_ootf) {
      vec3 rescaled_mix = mix / (1000.0 / hdr_reference_white);
      mix *= pow(rescaled_mix, vec3(0.2));
    }
    vec3 curve;
    if (mix_Mmc[2] == 0.0) {
      curve = vec3(EvaluateGainCurve(mix[0], curve_y, curve_n));
    } else {
      curve = vec3(EvaluateGainCurve(mix[0], curve_y, curve_n),
                   EvaluateGainCurve(mix[1], curve_y, curve_n),
                   EvaluateGainCurve(mix[2], curve_y, curve_n));
    }
    return curve;
  }

  // If merge_hlg_ootf is true, the HLG OOTF is merged into the AGTM tone mapping.
  // Only matches the real HLG OOTF if the component mixing function is Rec.2020 luma.
  vec3 AgtmToneMap(vec3 rgb, int input_color_primaries, bool merge_hlg_ootf) {
    if (lut1d_size > 1.0 || lut3d_size > 1.0) {
      rgb = ConvertToLutInputSpace(rgb, input_color_primaries);

      vec3 after_1d_lut;
      if (lut1d_size > 1.0) {
        vec3 in1d = rgb / lut_input_max;
        if (sampling_type == 1) {
          // maxrgb
          float gain = Sample1d(max(in1d.r, max(in1d.g, in1d.b)));
          after_1d_lut = in1d * gain;
        } else if (sampling_type == 2) {
          // ciey
          float y = dot(in1d, luma_coeffs);
          float gain = Sample1d(y);
          after_1d_lut = in1d * gain;
        } else {
          // rgb
          after_1d_lut =
              in1d * vec3(Sample1d(in1d.r), Sample1d(in1d.g), Sample1d(in1d.b));
        }
      } else {
        after_1d_lut = rgb / lut_input_max;
      }

      if (lut3d_size > 1.0) {
        rgb = Sample3dTex3dTetrahedral(after_1d_lut) * lut_output_max;
      } else {
        rgb = after_1d_lut * lut_output_max;
      }

      rgb = ConvertFromLutInputSpace(rgb, input_color_primaries);
      return rgb;
    }

    rgb = ConvertToGainApplicationSpace(rgb, input_color_primaries, gain_application_space_rg, gain_application_space_bw);

    vec3 U = rgb;
    vec3 G = weight_i * AgtmLogGain(U, false, merge_hlg_ootf) +
             weight_j * AgtmLogGain(U, true, merge_hlg_ootf);
    vec3 gain = exp2(G);
    if (merge_hlg_ootf) {
      vec3 mix = EvaluateChannelMix(U, mix_rgb_i, mix_Mmc_i);
      vec3 rescaled_mix = mix / (1000.0 / hdr_reference_white);
      gain *= pow(rescaled_mix, vec3(0.2));
    }
    rgb = rgb * gain;

    rgb = ConvertFromGainApplicationSpace(rgb, input_color_primaries, gain_application_space_rg, gain_application_space_bw);
    return rgb;
  }
  `;

/**
 * WebGL AGTM tone mapper.
 */
export class AgtmToneMapper {
  private readonly gl: WebGL2RenderingContext;
  private readonly metadata: AgtmMetadata | null;

  private curveTexture: WebGLTexture | null = null;
  private readonly curveTexW: number = 0;
  private readonly curveTexH: number = 0;
  private readonly curveLengths: number[] = [];
  private readonly headroomToTextureIndex = new Map<number, number>();
  // Cache for 1D and 3D LUTs.
  private cachedLutOptions: LutOptions | null = null;
  private cachedTargetedHdrHeadroom = -1;
  private cachedLut1dTexture: WebGLTexture | null = null;
  private cachedLut3dTexture: WebGLTexture | null = null;

  constructor(gl: WebGL2RenderingContext, metadata: AgtmMetadata | null) {
    this.gl = gl;
    this.metadata = metadata;

    if (!this.metadata) {
      return;
    }

    this.headroomToTextureIndex = new Map<number, number>();

    const altrs = getSortedAltrsWithZeroGain(this.metadata);
    const numCurves = altrs.length;
    let maxNumPoints = 0;
    for (const altr of altrs) {
      maxNumPoints = Math.max(maxNumPoints, altr.curve.length);
    }

    this.curveTexW = maxNumPoints;
    this.curveTexH = numCurves;
    this.curveLengths = altrs.map((altr) => altr.curve.length);

    const data = new Float32Array(maxNumPoints * numCurves * 4);
    for (let i = 0; i < numCurves; ++i) {
      const altr = altrs[i];
      for (let j = 0; j < altr.curve.length; ++j) {
        const point = altr.curve[j];
        const offset = (i * maxNumPoints + j) * 4;
        data[offset + 0] = point.x;
        data[offset + 1] = point.y;
        data[offset + 2] = point.m ?? 0.0;
        data[offset + 3] = 0.0; // Unused
      }
      this.headroomToTextureIndex.set(altr.headroom, i);
    }

    this.curveTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.curveTexture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA32F,
      maxNumPoints,
      numCurves,
      0,
      gl.RGBA,
      gl.FLOAT,
      data,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  destroy() {
    const gl = this.gl;
    if (this.curveTexture) {
      gl.deleteTexture(this.curveTexture);
      this.curveTexture = null;
    }
    if (this.cachedLut1dTexture) {
      gl.deleteTexture(this.cachedLut1dTexture);
      this.cachedLut1dTexture = null;
    }
    if (this.cachedLut3dTexture) {
      gl.deleteTexture(this.cachedLut3dTexture);
      this.cachedLut3dTexture = null;
    }
  }

  /**
   * Sets the uniforms for the AGTM shader program.
   * This will use the 4 textures starting at `tex0`.
   */
  setUniforms(
    contentTransfer: number,
    contentPrimaries: number | number[],
    targetedHdrHeadroom: number,
    hardwareConstrainedMode: boolean,
    program: WebGLProgram,
    tex0: number,
    lutOptions: LutOptions,
  ) {
    if (!this.metadata) {
      return;
    }
    const gl = this.gl;
    const p = program;
    const m = this.metadata;
    const a = agtmAdapt(m, targetedHdrHeadroom);

    const altrIMix = {...a.altrI.mix};
    let altrJMix;

    if (hardwareConstrainedMode) {
      // Some hardware doesn't support the 'channel' or 'min' components
      // of the component mixing function.
      // We remove these weights, and if they were the only weights, replace
      // them with maxRGB.
      if (altrIMix.channel + altrIMix.min > 0.999) {
        altrIMix.max = 1.0;
      }
      altrIMix.channel = 0;
      altrIMix.min = 0;
      // Some hardware doesn't support different mixing functions for i and j.
      altrJMix = altrIMix;
    } else {
      altrJMix = {...a.altrJ.mix};
    }

    gl.activeTexture(gl.TEXTURE0 + tex0);
    gl.bindTexture(gl.TEXTURE_2D, this.curveTexture);
    gl.uniform1i(gl.getUniformLocation(p, 'curve_xym'), tex0);

    gl.uniform1f(gl.getUniformLocation(p, 'curve_tex_w'), this.curveTexW);
    gl.uniform1f(gl.getUniformLocation(p, 'curve_tex_h'), this.curveTexH);
    gl.uniform1f(gl.getUniformLocation(p, 'curve_texcoord_y_i'), a.indexI);
    gl.uniform1f(
      gl.getUniformLocation(p, 'curve_N_cp_i'),
      this.curveLengths[a.indexI],
    );
    gl.uniform1f(gl.getUniformLocation(p, 'curve_texcoord_y_j'), a.indexJ);
    gl.uniform1f(
      gl.getUniformLocation(p, 'curve_N_cp_j'),
      this.curveLengths[a.indexJ],
    );

    gl.uniform3f(
      gl.getUniformLocation(p, 'mix_rgb_i'),
      altrIMix.rgb[0],
      altrIMix.rgb[1],
      altrIMix.rgb[2],
    );
    gl.uniform3f(
      gl.getUniformLocation(p, 'mix_rgb_j'),
      altrJMix.rgb[0],
      altrJMix.rgb[1],
      altrJMix.rgb[2],
    );
    gl.uniform3f(
      gl.getUniformLocation(p, 'mix_Mmc_i'),
      altrIMix.max,
      altrIMix.min,
      altrIMix.channel,
    );
    gl.uniform3f(
      gl.getUniformLocation(p, 'mix_Mmc_j'),
      altrJMix.max,
      altrJMix.min,
      altrJMix.channel,
    );

    gl.uniform1f(gl.getUniformLocation(p, 'weight_i'), a.weightI);
    gl.uniform1f(gl.getUniformLocation(p, 'weight_j'), a.weightJ);
    const gainPrimaries = getGainApplicationPrimaries(m);
    let gainChromaticities =
      typeof gainPrimaries === 'number'
        ? getChromaticities(gainPrimaries)
        : gainPrimaries;
    if (hardwareConstrainedMode) {
      gainChromaticities = getChromaticities(kPrimariesP3);
    }

    gl.uniform4f(
      gl.getUniformLocation(p, 'gain_application_space_rg'),
      gainChromaticities[0],
      gainChromaticities[1],
      gainChromaticities[2],
      gainChromaticities[3],
    );
    gl.uniform4f(
      gl.getUniformLocation(p, 'gain_application_space_bw'),
      gainChromaticities[4],
      gainChromaticities[5],
      gainChromaticities[6],
      gainChromaticities[7],
    );

    let lutInputColorSpaceModeInt = 0;
    if (lutOptions.inputColorSpaceMode === 'content') {
      lutInputColorSpaceModeInt = 1;
    } else if (lutOptions.inputColorSpaceMode === 'p3') {
      lutInputColorSpaceModeInt = 2;
    }
    gl.uniform1i(
      gl.getUniformLocation(p, 'lut_input_color_space_mode'),
      lutInputColorSpaceModeInt,
    );

    const inputPrimaries =
      lutOptions.inputColorSpaceMode === 'content'
        ? contentPrimaries
        : lutOptions.inputColorSpaceMode === 'p3'
          ? kPrimariesP3
          : gainChromaticities;

    const lumaCoeffs = getLumaCoeffs(inputPrimaries);
    gl.uniform3f(
      gl.getUniformLocation(p, 'luma_coeffs'),
      lumaCoeffs[0],
      lumaCoeffs[1],
      lumaCoeffs[2],
    );
    gl.uniform1f(gl.getUniformLocation(p, 'lut1d_size'), lutOptions.lut1dSize);
    gl.uniform1f(gl.getUniformLocation(p, 'lut3d_size'), lutOptions.lut3dSize);

    let samplingTypeInt = 0;
    if (lutOptions.samplingType === 'maxrgb') {
      samplingTypeInt = 1;
    } else if (lutOptions.samplingType === 'ciey') {
      samplingTypeInt = 2;
    }
    gl.uniform1i(gl.getUniformLocation(p, 'sampling_type'), samplingTypeInt);

    if (lutOptions.lut1dSize > 1 || lutOptions.lut3dSize > 1) {
      const toLut1d = getToLut1d(
        lutOptions.lutType,
        m,
        targetedHdrHeadroom,
        contentTransfer,
      );

      const lutInputMax =
        getMaxNits(contentTransfer) / (m.hdr_reference_white ?? 203);
      const lutOutputMax = exp2(targetedHdrHeadroom);
      gl.uniform1f(gl.getUniformLocation(p, 'lut_input_max'), lutInputMax);
      gl.uniform1f(gl.getUniformLocation(p, 'lut_output_max'), lutOutputMax);

      if (
        this.cachedLutOptions === null ||
        !lutOptionsAreEqual(lutOptions, this.cachedLutOptions) ||
        targetedHdrHeadroom !== this.cachedTargetedHdrHeadroom
      ) {
        // Delete old textures if they exist, regardless of the new LUT sizes.
        if (this.cachedLut1dTexture) {
          gl.deleteTexture(this.cachedLut1dTexture);
          this.cachedLut1dTexture = null;
        }
        if (this.cachedLut3dTexture) {
          gl.deleteTexture(this.cachedLut3dTexture);
          this.cachedLut3dTexture = null;
        }

        if (toLut1d) {
          const lut1dPixels = generate1dGainLut(
            lutOptions.lut1dSize,
            toLut1d,
            lutInputMax,
          );

          const lut1dTexture = gl.createTexture();
          gl.bindTexture(gl.TEXTURE_2D, lut1dTexture);
          gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            gl.R16F,
            lutOptions.lut1dSize,
            1,
            0,
            gl.RED,
            gl.FLOAT,
            lut1dPixels,
          );
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
          gl.bindTexture(gl.TEXTURE_2D, null);
          this.cachedLut1dTexture = lut1dTexture;
        }
        if (lutOptions.lut3dSize > 1) {
          const lut3d = generate3dLut(
            m,
            targetedHdrHeadroom,
            lutOptions,
            toLut1d,
            contentTransfer,
            contentPrimaries,
          );
          const lut3dTexture = gl.createTexture();
          gl.bindTexture(gl.TEXTURE_2D, lut3dTexture);
          gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            gl.RGBA16F,
            lutOptions.lut3dSize * lutOptions.lut3dSize,
            lutOptions.lut3dSize,
            0,
            gl.RGBA,
            gl.FLOAT,
            lut3d,
          );
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
          gl.bindTexture(gl.TEXTURE_2D, null);
          this.cachedLut3dTexture = lut3dTexture;
        }

        this.cachedLutOptions = lutOptions;
        this.cachedTargetedHdrHeadroom = targetedHdrHeadroom;
      }

      if (lutOptions.lut1dSize > 1) {
        gl.activeTexture(gl.TEXTURE0 + tex0 + 2);
        gl.bindTexture(gl.TEXTURE_2D, this.cachedLut1dTexture);
        gl.uniform1i(gl.getUniformLocation(p, 'lut1d'), tex0 + 2);
      }
      if (lutOptions.lut3dSize > 1) {
        gl.activeTexture(gl.TEXTURE0 + tex0 + 3);
        gl.bindTexture(gl.TEXTURE_2D, this.cachedLut3dTexture);
        gl.uniform1i(gl.getUniformLocation(p, 'lut3d'), tex0 + 3);
      }
    }
  }
}
