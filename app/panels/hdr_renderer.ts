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

import {kColorFunctionGlsl} from '../color_helpers/color_functions';
import {exp2} from '../color_helpers/math_helpers';
import {BaseWebgl2Renderer} from './base_renderer';

// HDR implementation (especially HLG).
const fs =
  `#version 300 es
  precision highp float;
  uniform sampler2D content;
  uniform int texture_trfn;
  uniform int texture_primaries;
  uniform int framebuffer_trfn;
  uniform int framebuffer_primaries;
  uniform float target_log2_headroom;
  uniform float linear_scale;
  uniform bool show_clamped;
  in vec2 texcoord;
  out vec4 fragColor;

  ` +
  kColorFunctionGlsl +
  `
  uniform float presentation_display_peak_luminance;

  float log10(float x) {
    return log(x) / log(10.0);
  }

  // OOTF implementation that adapts the HLG formula based on the presentation
  // display peak luminance.
  vec3 ApplyOotfAdaptiveHlg(vec3 rgb) {
    if (texture_trfn != kTransferHLG) {
      return rgb;
    }
    rgb = primariesConvert(rgb, texture_primaries, kPrimariesRec2020);

    //   Y_s is the normalized linear scene luminance.
    float Y = 0.2627 * rgb.r + 0.6780 * rgb.g + 0.0593 * rgb.b;

    float L_W = presentation_display_peak_luminance;

    //   alpha is the variable for user gain in cd/m2. It represents L_W, the
    //   nominal peak luminance of a display for achromatic pixels.
    // In the spec the OOTF maps [0, 1] to [0, L_W] (alpha = L_W) but here we
    // map [0, 1] to [0, 1] for consistency with the other OOTF implementations.
    // Scaling to the display nits is done later in the caller.
    float alpha = 1.0;

    //   gamma is the system gamma. gamma = 1.2 at the nominal display peak
    //   luminance of 1 000 cd/m2. For displays of nominal peak luminance other
    //   than 1 000 cd/m2, the system gamma should be adjusted according to the
    //   gamma formulae in Note 5f.

    //   Note 5f - For displays with nominal peak luminance (L_W) other than
    //   1 000 cd/m2, or where the effective nominal peak luminance is adjusted
    //   through the use of a contrast control, the system gamma value should be
    //   adjusted according to the formula below and may be rounded to three
    //   significant digits:
    //     gamma = 1.2 + 0.42 . log10(L_W/1000)
    //   For applications outside of the usual production monitoring range of
    //   L_W equal to 400 cd/m2 to 2 000 cd/m2, the following extended range
    //   formula should be used:
    //     gamma = 1.2 * K^log2(L_W/1000) where K = 1.111
    float gamma;
    if (L_W >= 400.0 || L_W <= 2000.0) {
      gamma = 1.2 + 0.42 * log10(L_W / 1000.0);
    } else {
      gamma = 1.2 * pow(1.111, log2(L_W / 1000.0));
    }

    rgb *= alpha * pow(Y, gamma - 1.0);

    rgb = primariesConvert(rgb, kPrimariesRec2020, texture_primaries);
    return rgb;
  }

  uniform int display_curves;

 void main() {
    if (presentation_display_peak_luminance <= 0.0) {
      fragColor = vec4(0.0, 0.0, 1.0, 1.0);
      return;
    }

    if (display_curves == 1) {
      vec3 dbg = vec3(1.0, 1.0, 1.0) * 0.05;
      vec2 p = vec2(texcoord.x, 1.0 - texcoord.y);

      // Gray curve is OETF inverted only.
      vec2 e = vec2(p.x, ApplyOetfInv(vec3(p.x, 0.0, 0.0), texture_trfn).r);
      if (distance(p, e) < 0.007) dbg = vec3(0.5, 0.5, 0.5);

      // White and color curves are OETF inverted + OOTF.
      vec2 r = vec2(
          p.x,
          ApplyOotfAdaptiveHlg(ApplyOetfInv(vec3(p.x, 0.0, 0.0), texture_trfn))
              .r);
      vec2 g = vec2(
          p.x,
          ApplyOotfAdaptiveHlg(ApplyOetfInv(vec3(0.0, p.x, 0.0), texture_trfn))
              .g);
      vec2 b = vec2(
          p.x,
          ApplyOotfAdaptiveHlg(ApplyOetfInv(vec3(0.0, 0.0, p.x), texture_trfn))
              .b);
      vec2 w = vec2(
          p.x,
          Average(
              ApplyOotfAdaptiveHlg(
                  ApplyOetfInv(vec3(p.x, p.x, p.x), texture_trfn))));
      if (distance(p, r) < 0.006) dbg = vec3(0.9, 0.2, 0.2);
      if (distance(p, g) < 0.005) dbg = vec3(0.2, 0.9, 0.2);
      if (distance(p, b) < 0.004) dbg = vec3(0.2, 0.2, 0.9);
      if (distance(p, w) < 0.003) dbg = vec3(0.9, 0.9, 0.9);

      // Yellow curve is roundtrip.
      vec2 o = vec2(
          p.x,
          Average(
              ApplyOetf(
                  ApplyOotfAdaptiveHlg(
                      ApplyOetfInv(vec3(p.x, p.x, p.x), texture_trfn)),
                  framebuffer_trfn)));
      if (distance(p, o) < 0.002) dbg = vec3(0.8, 0.8, 0.2);

      fragColor.rgb = dbg;
      fragColor.a = 1.0;
      return;
    }

    vec3 rgb = texture(content, texcoord).rgb;

    // Go to linear space.
    rgb = ApplyOetfInv(rgb, texture_trfn);
    rgb = ApplyOotfAdaptiveHlg(rgb);

    if (texture_trfn == kTransferHLG) {
      // Unlike the standard fixed OOTF that assumes a peak display luminance of
      // 1000 cd/m2 used elsewhere, here we're supposed to scale by the actual
      // display peak luminance (presentation_display_peak_luminance) then
      // divide by the reference white to convert to extended SDR. HLG defines
      // the reference white as the luminance corresponding to a value of 0.75
      // in gamma space (which works out to 203 for a
      // presentation_display_peak_luminance of 1000), see ITU-R BT.2408-8.
      // In essence, HLG assumes a fixed headroom of 1/0.75 in gamma space,
      // which is equivalent to a linear headroom H of roughly 4 to 6 in linear
      // space (depending on the display's peak luminance). However, if we
      // output values that go up to this headroom, they might end up being
      // larger than the current display's actual headroom
      // (exp2(target_log2_headroom)) resulting in clipping of highlights, which
      // is not in the spirit of the HLG spec. So instead of scaling to [0, H],
      // we just scale to [0, exp2(target_log2_headroom)].
      rgb *= exp2(target_log2_headroom);
    }
    if (texture_trfn == kTransferPQ) {
      // The PQ spec is often interpreted as saying that PQ encodes absolute
      // display values, but apparently this may not be entirely true:
      // it encodes absolute values for the *mastering display*, but it's
      // expected that some amount of tone mapping is performed to adapt to the
      // actual display and/or user preference, see the "display adjust" in
      // Fig. 11 of BT.2390-12. However, the spec doesn't say how to do this
      // adaptation, so we just use trivial scaling, which will cause highlights
      // outside of the display's headroom will be clipped.
      rgb *= 10000.0 / 203.0;  // PQ_max / PQ_ref_white
    }

    fragColor.rgb = ToDisplayWithClamping(
        rgb, texture_primaries, framebuffer_primaries, framebuffer_trfn,
        target_log2_headroom, linear_scale, show_clamped);
    fragColor.a = 1.0; // Opaque.
  }
`;

export class HdrRenderer extends BaseWebgl2Renderer {
  private framebufferLinearScale = 1;
  private showClamped = false;

  constructor(
    canvas: HTMLCanvasElement,
    private readonly displayCurves: boolean,
  ) {
    super(canvas, fs, /*hdr=*/ true, /*rendersPicture=*/ !displayCurves);
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

  setUniforms() {
    this.gl.uniform1i(
      this.gl.getUniformLocation(this.program, 'texture_trfn'),
      this.contentTransfer,
    );
    this.gl.uniform1i(
      this.gl.getUniformLocation(this.program, 'texture_primaries'),
      this.contentPrimaries,
    );
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
      this.gl.getUniformLocation(
        this.program,
        'presentation_display_peak_luminance',
      ),
      this.presentationDisplayPeakLuminance,
    );
    this.gl.uniform1f(
      this.gl.getUniformLocation(this.program, 'linear_scale'),
      this.framebufferLinearScale,
    );
    this.gl.uniform1i(
      this.gl.getUniformLocation(this.program, 'show_clamped'),
      this.showClamped ? 1 : 0,
    );

    this.gl.uniform1i(
      this.gl.getUniformLocation(this.program, 'display_curves'),
      this.displayCurves ? 1 : 0,
    );
  }
}
