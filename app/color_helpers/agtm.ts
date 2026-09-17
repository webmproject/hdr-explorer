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

// AGTM metadata (SMPTE ST 2094-50).

/** A 2D point with optional slope 'm'. */
export declare interface Point2 {
  x: number;
  y: number;
  m?: number;
}

export declare interface ComponentMix {
  // All values must be in [0, 1] and at least one must be non-zero.
  rgb: [number, number, number];
  max: number;
  min: number;
  channel: number;
}

/** Alternative image tone mapping rule. */
export declare interface Altr {
  headroom: number; // In [0, 6] (log2 value)
  // Up to 32 points, x in [0., 64.], y in [-6., 6.], and a slope m (any value).
  curve: Point2[];
  mix: ComponentMix;
}

/** AGTM metadata. */
export declare interface AgtmMetadata {
  // Between 0 and 4 alternate images.
  // The "zero color gain" curve is implicit and not included here.
  altr: Altr[];
  // An optional CICP enum representing standard primaries (e.g., sRGB, P3, BT.2020).
  gain_application_space_primaries?: number;
  // An optional array of 8 floats: [rx, ry, gx, gy, bx, by, wx, wy] representing chromaticity coordinates.
  // One of gain_application_space_primaries or gain_application_space_chromaticities must be set.
  gain_application_space_chromaticities?: number[];
  hdr_reference_white: number; // In (0, 10000]
  baseline_hdr_headroom: number; // In [0, 6] (log2 value)
  // The new base image. When computing the AGTM metadata from image+gain map,
  // a new base image can sometimes be proposed. It contains float16.
  base_image?: ImageData;
}
