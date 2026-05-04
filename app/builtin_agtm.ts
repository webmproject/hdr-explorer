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

import {AgtmMetadata} from './color_helpers/agtm';
import {kPrimariesRec2020} from './color_helpers/color_functions';

export const kDefaultMetadata: AgtmMetadata = {
  'hdr_reference_white': 203,
  'gain_application_space_primaries': kPrimariesRec2020,
  'baseline_hdr_headroom': 2.300448,
  'altr': [
    {
      'headroom': 0.0,
      'mix': {'rgb': [0, 0, 0], 'max': 1, 'min': 0, 'channel': 0},
      'curve': [
        {'x': 1.0, 'y': -1.0, 'm': 0.0},
        {'x': 1.25, 'y': -1.075977, 'm': -0.444911},
        {'x': 1.75, 'y': -1.312798, 'm': -0.461864},
        {'x': 2.5, 'y': -1.624093, 'm': -0.370244},
        {'x': 4.0, 'y': -2.083198, 'm': -0.255875},
        {'x': 4.926108, 'y': -2.300448, 'm': -0.215805},
      ],
    },
  ],
};
