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
  kColorFunctionGlsl,
  kTransferHLG,
} from '../color_helpers/color_functions';
import {Hdr10pMetadata} from '../color_helpers/hdr10p';
import {exp2} from '../color_helpers/math_helpers';
import {BaseWebgl2Renderer} from './base_renderer';

// Implementation of section A.4.3
// Reference Method for Receiver-side Tone Mapping using ST 2094-40 Metadata of
// https://www.atsc.org/wp-content/uploads/2019/09/S34-1-614r4-A341-Amendment-2094-40.pdf
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

  float binomialCoefficient(int n, int k) {
      if (k < 0 || k > n) {
          return 0.0;
      }
      float res = 1.0;
      for (int i = 1; i <= k; ++i) {
          res = res * (float(n) - float(i) + 1.0) / float(i);
      }
      return res;
  }

  // Implementation from scratch following the PDF linked above.
  uniform float presentation_display_peak_luminance;
  uniform float targeted_system_display_maximum_luminance;
  uniform float distribution_values_0_8;
  uniform float knee_point_x;
  uniform float knee_point_y;
  // SMPTE ST 2094-40:
  //   8.7.3.2 Constraints for ApplicationVersion = 1
  //     BezierCurveAnchors length shall be in the range [0,9]
  #define MAX_NUM_BEZIER_ANCHORS 9
  #define MAX_P_LEN MAX_NUM_BEZIER_ANCHORS + 2
  uniform int num_bezier_anchors;
  uniform float bezier_anchors[MAX_NUM_BEZIER_ANCHORS];

  uniform int display_curves;

  vec2 guidedKneePoint(float T, float D, float NORM, vec2 kvec) {
    // A.4.3.2.2. Guided Knee Point Construction
    //   The construction of the guided knee point can be classified into two
    //   cases.
    // Basically, if D <= T, we interpolate between (0, 0) and kvec, and if
    // D >= T, we interpolate between kvec and (0.5, 0.5).
    if (D <= T) {
      //   Case I: When D <= T
      //   The guided knee point, Kvec = (K_x, K_y), can be obtained by:
      //     Kvec = (w, 1-w) . (kvec, K_0vec)
      //   where . represents the dot product of two vectors, kvec = (k_x, k_y)
      //   is the knee point of the given basis OOTF, K_0vec is a pre-defined
      //   constant vector such as (0, 0), and w is the guided knee point mixing
      //   parameter as a function of D. There are various ways to design w;
      //   however, a linear method is simple and effective.

      //   The reference, linear method is as shown in Figure A.4.3.3, where D_L
      //   is a pre-defined low luminance level, and D_L ≤ T.
      // Arbitrary "pre-defined constant "such as (0, 0)".
      // This is the knee point that we interpolate with.
      vec2 K_0vec = vec2(0.0, 0.0);
      // Arbitrary "predefined low luminance level". This is the value of D
      // (presentation display peak luminance) below which the guided knee point
      // is equal to K_0vec. When D is between D_L and T, the guided knee point
      // is linearly interpolated between K_0vec and kvec.
      float D_L = 0.0;
      // T is guaranteed to be greater than 0.
      float w = max(0.0, (D - D_L) / (T - D_L));
      return w * kvec + (1.0 - w) * K_0vec;
    } else {
      //   Case II: When D >= T
      //   Similar to D <= T, in the case that T <= D, the guided knee point can
      //   be obtained by:
      //     Kvec = (w, 1-w) . (kvec, K_1vec)
      //   where K_1vec=(0.5, 0.5), and w is the guided knee point mixing
      //   parameter as a function of D which can be designed as shown in
      //   Figure A.4.3.5.
      vec2 K_1vec = vec2(0.5, 0.5);
      // NORM=max(D,H_M) and D>T so NORM is guaranteed to be greater than T.
      float w = max(0.0, 1.0 - max(0.0, (D - T) / (NORM - T)));
      return w * kvec + (1.0 - w) * K_1vec;
    }
  }

  void guidedBezierCurveVector(float T, float D, float NORM, int p_len,
                               float p[MAX_P_LEN],
                               out float P[MAX_P_LEN]) {
    // A.4.3.2.3. Guided Bezier Curve Vector Construction
    //   Similar to the guided knee point construction, the guided Bezier curve
    //   vector construction from a given basis Bezier curve vector can also be
    //   classified into two cases.
    // Basically, if D <= T, we interpolate the control points towards the y=1
    // line, and if D >= T, we interpolate them towards the y=x line.
    if (D <= T) {
      //   Case I: When D <= T
      //   In the case of D <= T, the guided Bezier curve, B_N(Pvec, t) can be
      //   found as:
      //     B_N(Pvec, t) = (u, 1-u) . (B_N(pvec, t), B_N(P_0vec, t))
      //   where pvec = (0, p_1, ... , p_N-1, 1)^t is the Bezier curve vector of
      //   the basis OOTF, and P_0vec is a pre-defined Bezier curve vector such
      //   as, but not limited to, (1, 1, ... , 1)^t, and u is the control
      //   parameter as a function of D which can be designed as shown in
      //   Figure A.4.3.7 but not limited to.
      // Arbitrary "predefined low luminance level". This is the value of D
      // (presentation display peak luminance) below which the control points
      // are equal to P_0vec. When D is between D_L and T, the control points
      // are linearly interpolated between P_0vec and p.
      float D_L = 0.0;
      // Same as w in guidedKneePoint().
      float u = max(0.0, (D - D_L) / (T - D_L));
      //   By Property 2, the guided Bezier curve vector, Pvec, of B_N(Pvec, t)
      //   can be calculated as:
      //     Pvec = (u, 1-u) . (pvec, P_0vec)
      for (int i = 0; i < p_len; ++i) {
        // The first point should be 0.0, even though this is not said in the
        // reference method which says to interpolate with (1, ... , 1).
        // This corresponds to Figure A.4.3.2 which mentions:
        //   Guided Bezier Curve Vector: Pvec=(0,P_1,P_k,...,P_N-1,1)
        float P_0vec_i = i == 0 ? 0.0 : 1.0;
        P[i] = u * p[i] + (1.0 - u) * P_0vec_i;
      }
    } else {
      //   Case II: When D >= T
      //   In the case of T <= D, the guided Bezier curve, B_N(Pvec, t) can be
      //   found as:
      //     B_N(Pvec, t) = (u, 1-u) . (B_N(pvec, t), B_N(P_Lvec, t))
      //   where pvec = (0, p_1, ... , p_N-1, 1)^t is the Bezier curve vector of
      //   the basis OOTF, P_Lvec is the Identity Bezier curve introduced in
      //   (6), and u is the mixing parameter as a function of D which can be
      //   designed as shown in Figure A.4.3.8 but not limited to.
      // Same as w in guidedKneePoint().
      float u = 1.0 - max(0.0, (D - T) / (NORM - T));
      //   By Property 2, the guided Bezier curve vector, Pvec, of B_N(Pvec, t)
      //   can be calculated as:
      //     Pvec = (u, 1-u) . (pvec, P_Lvec)
      for (int i = 0; i < p_len; ++i) {
        float P_Lvec_i = float(i) / float(p_len - 1);
        P[i] = u * p[i] + (1.0 - u) * P_Lvec_i;
      }
    }
  }

  // Computes a copy of p with the point at index 1 modified so that the slope
  // at that point is the same as the slope at the knee point.
  void applySlopeContinuity(vec2 kvec, int p_len, float p[MAX_P_LEN], out float continuous_p[MAX_P_LEN]) {
      for (int i = 0; i < p_len; ++i) {
        continuous_p[i] = p[i];
      }
      // A.4.3.2.4. Slope Continuity Condition at the Knee Point
      //   The condition for slope continuity at the knee point is given as:
      //     P_1 = 1/N * K_y/K_x * (1-K_x)/(1-Ky)
      // Slope continuity is only necessary if the knee point part exists.
      if (kvec.x > 0.0) {
        continuous_p[1] = 1.0 / float(p_len - 1) * (kvec.y / kvec.x) *
                                (1.0 - kvec.x) / (1.0 - kvec.y);
      }
  }

  float applyBezier(float t, int p_len, float p[MAX_P_LEN]) {
    int N = p_len - 1;
    float result = 0.0;
    // p[0] should be 0. Skip i=0.
    for (int i = 1; i < p_len; ++i) {
      result += binomialCoefficient(N, i) *
                    pow(1.0 - t, float(N - i)) * pow(t, float(i)) * p[i];
    }
    return result;
  }

  // Applies the tone mapping curve defined by a linear section between (0, 0)
  // and the knee point (kvec.x, kvec.y) and a Bezier section defined by the
  // control points p.
  float applyKneePointBezier(vec2 kvec, int p_len, float p[MAX_P_LEN],
                             float x) {
    // A.4.3.2. Guided OOTF Construction
    // A.4.3.2.1. General
    //   The guided OOTF is based on the peak luminance of the presentation
    //   display and is derived from the basis OOTF.
    //   In general, guided OOTF construction is composed of the following two
    //   parts with the inputs T (peak luminance of the target display that is
    //   obtained with the basis OOTF) and D (peak luminance of the presentation
    //   display):
    //   - Guided Knee Point
    //   - Guided Bezier Curve Anchors
    // The knee point part exists only if the knee point vector is not null.
    if (x < kvec.x) {
        return x * (kvec.y / kvec.x);
    } else if (x >= 1.0) {
        return 1.0;
    } else {
        float p_slope_continuity[MAX_P_LEN];
        applySlopeContinuity(kvec, p_len, p, p_slope_continuity);

        for (int i = 2; i < p_len; ++i) {
          p_slope_continuity[i] = p[i];
        }

        float t = (x - kvec.x) / (1.0 - kvec.x);
        float y = applyBezier(t, p_len, p_slope_continuity);
        return kvec.y + y * (1.0 - kvec.y);
    }
  }

  void drawControlPoint(vec2 kvec, int p_len, int i, float p_val, vec2 current_pixel, vec3 color, inout vec3 dbg) {
    float cp_x = kvec.x + float(i) * (1.0 - kvec.x) / float(p_len - 1);
    float cp_y = kvec.y + (1.0 - kvec.y) * p_val;
    vec2 cp = vec2(cp_x, cp_y);
    if (distance(current_pixel, cp) < 0.004) {
      dbg = color;
    }
  }

  void drawControlPoints(vec2 kvec, int p_len, float p[MAX_P_LEN], vec2 current_pixel, vec3 color, inout vec3 dbg) {
    float continuous_p[MAX_P_LEN];
    applySlopeContinuity(kvec, p_len, p, continuous_p);
    for (int i = 0; i < p_len - 1; ++i) {
      drawControlPoint(kvec, p_len, i, continuous_p[i], current_pixel, color, dbg);
    }
    // Also draw the original (non continuous) control point in a grayish color.
    drawControlPoint(kvec, p_len, 1, p[1], current_pixel, vec3(0.5, 0.5, 0.5) + color * 0.2, dbg);
  }

 void main() {
    if (targeted_system_display_maximum_luminance < 0.0) {
      fragColor = vec4(0.0, 0.0, 1.0, 1.0);
      return;
    }

    float T = targeted_system_display_maximum_luminance;
    // SMPTE ST 2094-40:
    //   The KneePoint shall be a vector with two numbers. (...) The value of
    //   the numbers shall be in the range [0,1] and in multiples of 1/4095.
    vec2 kvec = vec2(knee_point_x / 4095.0, knee_point_y / 4095.0);

    // SMPTE ST 2094-40:
    //   BezierCurveAnchors shall be a vector of numbers whose elements
    //   represent the intermediate anchor parameters (P_1, ..., P_N-1) in
    //   Equation (1), with P0 =0 and P_N=1.
    float p[MAX_P_LEN];
    p[0] = 0.0;
    for (int i = 0; i < num_bezier_anchors; ++i) {
      // SMPTE ST 2094-40:
      //   The values of the vector elements shall be in the range [0,1] and in
      //   multiples of 1/1023
      p[i + 1] = bezier_anchors[i] / 1023.0;
    }
    p[num_bezier_anchors + 1] = 1.0;
    int p_len = num_bezier_anchors + 2;

    float D = presentation_display_peak_luminance; // for example 400
    float MAX_NITS = texture_trfn == kTransferHLG ? 1000.0 : 10000.0;
    // SMPTE ST 2094-40:
    //   Each element in the second vector V shall be in the range [0,1] and in
    //   multiples of 0.00001.
    float H_M = distribution_values_0_8 * 0.00001 * MAX_NITS;  // Convert to nits.
    // Another option would be to use maxscl as suggested in SMPTE ST 2094-40
    // which is typically a much larger value.
    float NORM = max(D, H_M);

    if (D <= 0.0 || T <= 0.0) {
      // Something is wrong. Display pure red.
      fragColor = vec4(1.0, 0.0, 0.0, 1.0);
      return;
    }

    if (display_curves == 1) {
      vec2 Kvec = guidedKneePoint(T, D, NORM, kvec);
      float P[MAX_P_LEN];
      guidedBezierCurveVector(T, D, NORM, p_len, p, P);
      vec3 dbg = vec3(1.0, 1.0, 1.0) * 0.95;
      vec2 current_pixel = vec2(texcoord.x, 1.0 - texcoord.y);

      int fake_Ds[8] = int[](200, 300, 350, 400, 500, 800, 1200, 1800);
      for (int i = 0; i < fake_Ds.length(); ++i) {
        float fake_D = float(fake_Ds[i]);
        float fake_NORM = max(fake_D, H_M);
        vec2 fake_Kvec = guidedKneePoint(T, fake_D, fake_NORM, kvec);
        float fake_P[MAX_P_LEN];
        guidedBezierCurveVector(T, fake_D, fake_NORM, p_len, p, fake_P);
        vec2 fake_guided_ootf = vec2(
            current_pixel.x,
            applyKneePointBezier(fake_Kvec, p_len, fake_P, current_pixel.x));
        if (distance(current_pixel, fake_guided_ootf) < 0.001) {
          if (fake_D >= H_M) {
            dbg = vec3(0.2, 0.2, 0.9);
          } else {
            dbg = vec3(0.2, 0.2, 0.2);
          }
        }
        if (fake_D >= H_M) break;
      }

      vec3 basis_color = vec3(0.2, 0.2, 0.6);
      vec3 guided_color = vec3(0.9, 0.2, 0.2);
      vec2 basis_ootf = vec2(
          current_pixel.x, applyKneePointBezier(kvec, p_len, p, current_pixel.x));
      if (distance(current_pixel, basis_ootf) < 0.002) dbg = basis_color;
      vec2 guided_ootf = vec2(
          current_pixel.x, applyKneePointBezier(Kvec, p_len, P, current_pixel.x));
      if (distance(current_pixel, guided_ootf) < 0.002) dbg = guided_color;

      // Control points (including the knee point which is the first point)
      vec3 color_offset = vec3(0.1, 0.1, 0.1);
      drawControlPoints(kvec, p_len, p, current_pixel, basis_color + color_offset, dbg);
      drawControlPoints(Kvec, p_len, P, current_pixel, guided_color + color_offset, dbg);

      fragColor.rgb = dbg;
      fragColor.a = 1.0;
      return;
    }

    vec3 rgb = texture(content, texcoord).rgb;

    // Go to linear space. This is not part of the PDF linked above.
    rgb = ApplyOetfInv(rgb, texture_trfn);
    rgb = ApplyOotf(rgb, texture_primaries, texture_trfn);
    rgb *= MAX_NITS;  // Convert to nits.

    // A.4.3.1. General
    //   The absolute luminance values (R_in, G_in, B_in)^t are normalized into
    //   the values between 0 and 1 by
    //     r_in = min(1, R_in/NORM)
    //     g_in = min(1, G_in/NORM)
    //     b_in = min(1, B_in/NORM)
    //   where NORM is the normalization factor given by
    //     NORM = max(D, H_M)
    //   in which D is the peak luminance of the presentation display and
    //   HM = distribution_values[0][8].
    rgb = min(vec3(1.0, 1.0, 1.0), rgb / NORM);

    // A.4.3.1. General
    //   For each pixel, the maximum value of r_in, g_in, and b_in for that
    //   pixel is determined, as represented by x.
    float x = max(max(rgb.r, rgb.g), rgb.b);

    // The tone mapping curve is composed of a linear section between (0, 0)
    // and the knee point (kvec.x, kvec.y) and a Bezier section defined by the
    // control points p.
    vec2 Kvec = guidedKneePoint(T, D, NORM, kvec);
    float P[MAX_P_LEN];
    guidedBezierCurveVector(T, D, NORM, p_len, p, P);

    // A.4.3.1. General
    //   The value of x is applied to the guided OOTF, producing the resultant
    //   value, y.
    float y = applyKneePointBezier(Kvec, p_len, P, x);

    // A.4.3.1. General
    //   The values of r_in, g_in, and b_in are each scaled by the ratio y/x.
    // Pure black should stay as pure black. Avoid a division by zero in this
    // case. Allow pure white where both x and y should be 1.
    if (x > 0.0) {
      rgb = rgb * (y / x);
    }

    //   At the end of the process, the signal is de-normalized based on the
    //   peak luminance of the presentation display.
    // Convert to extended SDR. Scale by the display's actual headroom instead
    // of e.g. presentation_display_peak_luminance/203 as this would not be
    // guaranteed to match the actual display's headroom, and the rendering
    // could end up being either too dark or with clipped highlights.
    rgb = rgb * exp2(target_log2_headroom);

    fragColor.rgb = ToDisplayWithClamping(
        rgb, texture_primaries, framebuffer_primaries, framebuffer_trfn,
        target_log2_headroom, linear_scale, show_clamped);
    fragColor.a = 1.0; // Opaque.
  }
`;

export class Hdr10pRenderer extends BaseWebgl2Renderer {
  private framebufferLinearScale = 1;
  private showClamped = false;
  metadata: Hdr10pMetadata | null = null;

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

  setMetadata(metadata: Hdr10pMetadata | null) {
    this.metadata = metadata;
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

    if (this.metadata) {
      this.gl.uniform1f(
        this.gl.getUniformLocation(
          this.program,
          'targeted_system_display_maximum_luminance',
        ),
        this.metadata.targeted_system_display_maximum_luminance,
      );
      if (this.metadata.windows[0]) {
        this.gl.uniform1f(
          this.gl.getUniformLocation(this.program, 'knee_point_x'),
          this.metadata.windows[0].knee_point_x,
        );
        this.gl.uniform1f(
          this.gl.getUniformLocation(this.program, 'knee_point_y'),
          this.metadata.windows[0].knee_point_y,
        );
        this.gl.uniform1f(
          this.gl.getUniformLocation(this.program, 'distribution_values_0_8'),
          this.metadata.windows[0].distribution_values[8],
        );
        this.gl.uniform1i(
          this.gl.getUniformLocation(this.program, 'num_bezier_anchors'),
          this.metadata.windows[0].num_bezier_curve_anchors,
        );
        const anchors = this.metadata.windows[0].bezier_curve_anchors || [];
        this.gl.uniform1fv(
          this.gl.getUniformLocation(this.program, 'bezier_anchors'),
          new Float32Array(anchors),
        );
      }
    } else {
      // Signal that there is no available HDR10+ metadata.
      this.gl.uniform1f(
        this.gl.getUniformLocation(
          this.program,
          'targeted_system_display_maximum_luminance',
        ),
        -1.0,
      );
    }

    this.gl.uniform1i(
      this.gl.getUniformLocation(this.program, 'display_curves'),
      this.displayCurves ? 1 : 0,
    );
  }
}
