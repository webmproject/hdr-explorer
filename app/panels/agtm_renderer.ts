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
import {LutOptions, kLutOptionsNoLut} from '../color_helpers/agtm_adapt';
import {
  AgtmToneMapper,
  kAgtmToneMapperGlsl,
} from '../color_helpers/agtm_tone_map_gl';
import {kColorFunctionGlsl} from '../color_helpers/color_functions';
import {exp2} from '../color_helpers/math_helpers';
import {BaseWebgl2Renderer} from './base_renderer';

const fs =
  `#version 300 es
  precision highp float;
  uniform sampler2D content;
  uniform int texture_trfn;
  uniform int texture_primaries;
  uniform int framebuffer_trfn;
  uniform int framebuffer_primaries;
  uniform bool show_clamped;
  uniform bool skip_ootf;
  in vec2 texcoord;
  out vec4 fragColor;

  uniform float target_log2_headroom;
  uniform float linear_scale;

  uniform float hdr_reference_white;

  ` +
  kColorFunctionGlsl +
  `
  ` +
  kAgtmToneMapperGlsl +
  `

  void main() {
    vec3 rgb = texture(content, texcoord).rgb;
    rgb = ApplyOetfInv(rgb, texture_trfn);

    if (!skip_ootf) {
      rgb = ApplyOotf(rgb, texture_primaries, texture_trfn);
    }

    if (texture_trfn == kTransferHLG) {
      rgb *= 1000.0 / hdr_reference_white;
    }
    if (texture_trfn == kTransferPQ) {
      rgb *= 10000.0 / hdr_reference_white;
    }

    // Apply gain curve.
    bool merge_hlg_ootf = skip_ootf && texture_trfn == kTransferHLG;
    rgb = AgtmToneMap(rgb, texture_primaries, merge_hlg_ootf);

    fragColor.rgb = ToDisplayWithClamping(
        rgb, texture_primaries, framebuffer_primaries, framebuffer_trfn,
        target_log2_headroom, linear_scale, show_clamped);
    fragColor.a = 1.0;
  }`;

export class AgtmRenderer extends BaseWebgl2Renderer {
  private framebufferLinearScale = 1;
  private metadata: AgtmMetadata | null = null;
  private showClamped = false;
  private readonly hardwareConstrainedMode: boolean;
  private agtm: AgtmToneMapper | null = null;
  private lutOptions = kLutOptionsNoLut;

  constructor(canvas: HTMLCanvasElement, hardwareConstrainedMode = false) {
    super(canvas, fs, /*hdr=*/ true, /*rendersPicture=*/ true);
    this.hardwareConstrainedMode = hardwareConstrainedMode;
  }

  override getVersion(): string {
    return 'v1.0.0';
  }

  setShowClamped(value: boolean) {
    this.showClamped = value;
  }

  setSimulatedHeadroomLog2(value: number) {
    this.framebufferLinearScale = 1 / exp2(value);
  }
  setMetadata(metadata: AgtmMetadata) {
    this.metadata = metadata;
    this.agtm = new AgtmToneMapper(this.gl, this.metadata);
  }

  setLutOptions(options: LutOptions) {
    this.lutOptions = options;
  }

  override draw() {
    if (!this.agtm) {
      return;
    }
    super.draw();
  }

  override destroy() {
    if (this.agtm) {
      this.agtm.destroy();
    }
    super.destroy();
  }

  setUniforms() {
    this.gl.uniform1i(
      this.gl.getUniformLocation(this.program, 'framebuffer_trfn'),
      this.framebufferTransfer,
    );
    this.gl.uniform1i(
      this.gl.getUniformLocation(this.program, 'framebuffer_primaries'),
      this.framebufferPrimaries,
    );
    this.gl.uniform1f(
      this.gl.getUniformLocation(this.program, 'target_log2_headroom'),
      this.headroomLog2,
    );
    this.gl.uniform1f(
      this.gl.getUniformLocation(this.program, 'linear_scale'),
      this.framebufferLinearScale,
    );

    this.gl.uniform1i(
      this.gl.getUniformLocation(this.program, 'texture_trfn'),
      this.contentTransfer,
    );
    this.gl.uniform1i(
      this.gl.getUniformLocation(this.program, 'texture_primaries'),
      this.contentPrimaries,
    );
    this.gl.uniform1f(
      this.gl.getUniformLocation(this.program, 'hdr_reference_white'),
      this.metadata?.hdr_reference_white ?? 203,
    );
    this.gl.uniform1i(
      this.gl.getUniformLocation(this.program, 'show_clamped'),
      this.showClamped ? 1 : 0,
    );
    // Skip the OOTF when using LUTs since the Android LUT API does not apply it.
    // Some hardware also does not support it.
    const hasLut =
      this.lutOptions.lut1dSize > 1 || this.lutOptions.lut3dSize > 1;
    const skipOotf = this.hardwareConstrainedMode || hasLut;
    this.gl.uniform1i(
      this.gl.getUniformLocation(this.program, 'skip_ootf'),
      skipOotf ? 1 : 0,
    );
    if (this.agtm) {
      this.agtm.setUniforms(
        this.contentTransfer,
        this.contentPrimaries,
        this.headroomLog2,
        this.hardwareConstrainedMode,
        this.program,
        2,
        this.lutOptions,
      );
    }
  }
}
