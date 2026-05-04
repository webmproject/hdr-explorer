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

import {AgtmMetadata} from '../color_helpers/agtm';
import {kLutOptionsNoLut} from '../color_helpers/agtm_adapt';
import {
  AgtmToneMapper,
  kAgtmToneMapperGlsl,
} from '../color_helpers/agtm_tone_map_gl';
import {
  CHROMATICITIES_REC2020,
  kColorFunctionGlsl,
} from '../color_helpers/color_functions';
import {BaseWebgl2Renderer} from './base_renderer';

const lumaViewerFs =
  `#version 300 es
    precision highp float;
    uniform sampler2D content;
    uniform float hdr_reference_white;
    uniform int texture_trfn;
    uniform int texture_primaries;
    uniform int mode;

    in vec2 texcoord;
    out vec4 fragColor;

    ` +
  kColorFunctionGlsl +
  kAgtmToneMapperGlsl +
  `

    const int kModeLuma = 0;
    const int kModeMaxRGB = 1;
    const int kModeR = 2;
    const int kModeG = 3;
    const int kModeB = 4;
    const int kModeAgtmMixR = 5;
    const int kModeAgtmMixG = 6;
    const int kModeAgtmMixB = 7;

    void main() {
      vec3 rgb = texture(content, texcoord).rgb;
      rgb = ApplyOetfInv(rgb, texture_trfn);
      rgb = ApplyOotf(rgb, texture_primaries, texture_trfn);
      rgb = ConvertToGainApplicationSpace(rgb, texture_primaries, gain_application_space_rg, gain_application_space_bw);

      float scalingFactor = 1.0;
      if (texture_trfn == kTransferPQ) {
        scalingFactor = 10000.0;
      } else if (texture_trfn == kTransferHLG) {
        scalingFactor = 1000.0;
      } else if (texture_trfn == kTransferSrgb) {
        scalingFactor = 203.0;
      }
      rgb *= scalingFactor;
      float value;
      if (mode == kModeLuma) {
        const vec3 kLumaCoeffs = vec3(0.2627, 0.6780, 0.0593);
        value = dot(rgb, kLumaCoeffs);
      } else if (mode == kModeMaxRGB) {
        value = max(rgb.r, max(rgb.g, rgb.b));
      } else if (mode == kModeR) {
        value = rgb.r;
      } else if (mode == kModeG) {
        value = rgb.g;
      } else if (mode == kModeB) {
        value = rgb.b;
      } else {
        int c = mode == kModeAgtmMixR ? 0 : mode == kModeAgtmMixG ? 1 : 2;
        value = EvaluateChannelMix(rgb, mix_rgb_i, mix_Mmc_i)[c];
      }
      float grayscale = value / 10000.0;

      // Display with a gamma value so we can see something.
      const float gamma = 1.0 / 2.2;
      grayscale = pow(grayscale, gamma);
      fragColor = vec4(vec3(grayscale), 1.0);
    }
  `;

export type LumaMode =
  | 'luma'
  | 'maxrgb'
  | 'r'
  | 'g'
  | 'b'
  | 'agtmr'
  | 'agtmg'
  | 'agtmb';

export class LumaRenderer extends BaseWebgl2Renderer {
  private mode: LumaMode = 'luma';
  private agtm: AgtmToneMapper | null = null;

  constructor(canvas: HTMLCanvasElement) {
    super(canvas, lumaViewerFs, /*hdr=*/ false, /*rendersPicture=*/ true);
  }

  override getVersion(): string {
    return 'v1.0.0';
  }

  setMode(mode: LumaMode) {
    this.mode = mode;
  }

  setMetadata(metadata: AgtmMetadata) {
    this.agtm = new AgtmToneMapper(this.gl, metadata);
  }

  setUniforms() {
    this.gl.uniform1i(
      this.gl.getUniformLocation(this.program, 'texture_trfn'),
      this.contentTransfer,
    );
    this.gl.uniform1i(
      this.gl.getUniformLocation(this.program, 'texture_primaries'),
      this.contentPrimaries,
    );
    let modeValue = 0;
    switch (this.mode) {
      case 'luma':
        modeValue = 0;
        break;
      case 'maxrgb':
        modeValue = 1;
        break;
      case 'r':
        modeValue = 2;
        break;
      case 'g':
        modeValue = 3;
        break;
      case 'b':
        modeValue = 4;
        break;
      case 'agtmr':
        modeValue = 5;
        break;
      case 'agtmg':
        modeValue = 6;
        break;
      case 'agtmb':
        modeValue = 7;
        break;
      default:
        break;
    }
    this.gl.uniform1i(
      this.gl.getUniformLocation(this.program, 'mode'),
      modeValue,
    );
    if (this.agtm) {
      this.agtm.setUniforms(
        this.contentTransfer,
        this.contentPrimaries,
        /* targetedHdrHeadroom= */ 0,
        /* hardwareConstrainedMode= */ false,
        this.program,
        /* tex0= */ 2,
        kLutOptionsNoLut,
      );
    } else {
      this.gl.uniform1f(
        this.gl.getUniformLocation(this.program, 'hdr_reference_white'),
        203.0,
      );
      this.gl.uniform4f(
        this.gl.getUniformLocation(this.program, 'gain_application_space_rg'),
        CHROMATICITIES_REC2020[0],
        CHROMATICITIES_REC2020[1],
        CHROMATICITIES_REC2020[2],
        CHROMATICITIES_REC2020[3],
      );
      this.gl.uniform4f(
        this.gl.getUniformLocation(this.program, 'gain_application_space_bw'),
        CHROMATICITIES_REC2020[4],
        CHROMATICITIES_REC2020[5],
        CHROMATICITIES_REC2020[6],
        CHROMATICITIES_REC2020[7],
      );
    }
  }
}
