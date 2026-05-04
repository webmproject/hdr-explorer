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
