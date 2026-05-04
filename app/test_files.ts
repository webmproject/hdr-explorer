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

/** Represents an option in the test file selector. */
export interface TestFileOption {
  path: string;
  title: string;
}

/** Represents a group of test files. */
export interface TestFileGroup {
  label: string;
  files: TestFileOption[];
}

export const DEFAULT_FILE = 'indoor_av1_hdr10p.mp4';

/** The list of test files available in the application. */
export const TEST_FILES: TestFileGroup[] = [
  {
    label: 'HLG',
    files: [
      {
        path: 'beach_av1_hlg10_hdr10p.mp4',
        title: 'Beach | Pixel 10 | AV1 HDR10+ (HLG)',
      },
      {
        path: 'lightsaber_av1_hlg10_hdr10p.mp4',
        title: 'Lightsaber | Pixel 10 | AV1 HDR10+ (HLG)',
      },
      {
        path: 'lego_hlg_hdr10p.mp4',
        title: 'Lego | Pixel 10 | AV1 HDR10+ (HLG)',
      },
      {
        path: 'fountain_hlg_hdr10p.mp4',
        title: 'Fountain | iPhone 16 | AV1 HDR10+ (HLG)',
      },
    ],
  },
  {
    label: 'PQ',
    files: [
      {path: 'pigeon-pq.avif', title: 'Pigeon | AVIF (PQ)'},
      {path: 'rainbow-pq.avif', title: 'Rainbow | AVIF (PQ)'},
      {
        path: 'indoor_av1_hdr10p.mp4',
        title: 'Indoor | GalaxyFold 3 | AV1 HDR10+ (PQ)',
      },
      {
        path: 'underground_orange_av1_hdr10p.mp4',
        title: 'Underground Orange | GalaxyFold 3 | AV1 HDR10+ (PQ)',
      },
      {
        path: 'underground_cyan_av1_hdr10p.mp4',
        title: 'Underground Cyan | GalaxyFold 3 | AV1 HDR10+ (PQ)',
      },
      {
        path: 'outdoor_av1_hdr10p.mp4',
        title: 'Outdoor | GalaxyFold 3 | AV1 HDR10+ (PQ)',
      },
      {
        path: 'paris_skyline_av1_hdr10p.mp4',
        title: 'Paris Skyline | GalaxyFold 3 | AV1 HDR10+ (PQ)',
      },
      {
        path: 'badge_reader_av1_hdr10p.mp4',
        title: 'Badge Reader | GalaxyFold 3 | AV1 HDR10+ (PQ)',
      },
      {
        path: 'blank_wall_av1_hdr10p.mp4',
        title: 'Blank Wall | GalaxyFold 3 | AV1 HDR10+ (PQ)',
      },
      {
        path: 'coat_hanger_av1_hdr10p.mp4',
        title: 'Coat Hanger | GalaxyFold 3 | AV1 HDR10+ (PQ)',
      },
      {
        path: 'desks_av1_hdr10p.mp4',
        title: 'Desks | GalaxyFold 3 | AV1 HDR10+ (PQ)',
      },
      {
        path: 'paris_skyline_dusk_av1_hdr10p.mp4',
        title: 'Paris Skyline Dusk | GalaxyFold 3 | AV1 HDR10+ (PQ)',
      },
      {
        path: 'paris_skyline_dusk2_av1_hdr10p.mp4',
        title: 'Paris Skyline Dusk 2 | GalaxyFold 3 | AV1 HDR10+ (PQ)',
      },
      {
        path: 'rooftop_av1_hdr10p.mp4',
        title: 'Rooftop | GalaxyFold 3 | AV1 HDR10+ (PQ)',
      },
      {
        path: 'staircase_av1_hdr10p.mp4',
        title: 'Staircase | GalaxyFold 3 | AV1 HDR10+ (PQ)',
      },
      {
        path: 'motion_floor_to_sky_av1_hdr10p.mp4',
        title: 'Motion Floor To Sky | GalaxyFold 3 | AV1 HDR10+ (PQ)',
      },
      {
        path: 'motion_floor_to_sky2_av1_hdr10p.mp4',
        title: 'Motion Floor To Sky 2 | GalaxyFold 3 | AV1 HDR10+ (PQ)',
      },
      {
        path: 'motion_indoor_to_window_av1_hdr10p.mp4',
        title: 'Motion Indoor To Window | GalaxyFold 3 | AV1 HDR10+ (PQ)',
      },
      {
        path: 'motion_rooftop_360_av1_hdr10p.mp4',
        title: 'Motion Rooftop 360 | GalaxyFold 3 | AV1 HDR10+ (PQ)',
      },
    ],
  },
];
