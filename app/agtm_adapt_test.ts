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
import {
  agtmAdapt,
  agtmToneMap,
  agtmToneMapWithLut,
  getSortedAltrsWithZeroGain,
  grayAdaptation,
  kLutOptionsNoLut,
} from './color_helpers/agtm_adapt';
import {
  PRIMARIES_REC2020,
  PRIMARIES_SRGB,
  TRANSFER_SRGB,
} from './color_helpers/color_functions';

describe('agtm_adapt zero alternate images (SMPTE ST 2094-50 Section B.4)', () => {
  const metadataNoAltr: AgtmMetadata = {
    hdr_reference_white: 203,
    baseline_hdr_headroom: 1.0,
    gain_application_space_primaries: PRIMARIES_REC2020,
    altr: [],
  };

  it('includes zero gain altr in getSortedAltrsWithZeroGain', () => {
    const altrs = getSortedAltrsWithZeroGain(metadataNoAltr);
    expect(altrs.length).toBe(1);
    expect(altrs[0].headroom).toBe(1.0);
    expect(altrs[0].isZeroGain).toBeTrue();
  });

  it('adapts to zero gain altr regardless of target headroom', () => {
    for (const targetHeadroom of [0.0, 1.0, 2.0, 4.0]) {
      const adaptation = agtmAdapt(metadataNoAltr, targetHeadroom);
      expect(adaptation.altrI.isZeroGain).toBeTrue();
      expect(adaptation.altrJ.isZeroGain).toBeTrue();
    }
  });

  it('evaluates agtmToneMap as identity when altr is empty', () => {
    const adaptation = agtmAdapt(metadataNoAltr, 2.0);
    const testColors = [
      [0.0, 0.0, 0.0],
      [0.5, 0.5, 0.5],
      [1.0, 1.0, 1.0],
      [64.0, 64.0, 64.0],
      [100.0, 50.0, 25.0],
      [128.0, 200.0, 300.0],
    ];

    for (const color of testColors) {
      const tonemapped = agtmToneMap(
        color,
        PRIMARIES_SRGB,
        metadataNoAltr,
        adaptation,
      );
      expect(tonemapped[0]).toBeCloseTo(color[0], 5);
      expect(tonemapped[1]).toBeCloseTo(color[1], 5);
      expect(tonemapped[2]).toBeCloseTo(color[2], 5);
    }
  });

  it('evaluates grayAdaptation as identity when altr is empty', () => {
    for (const x of [0.1, 1.0, 10.0, 64.0, 100.0]) {
      expect(grayAdaptation(x, metadataNoAltr, 2.0)).toBeCloseTo(x, 5);
    }
  });

  it('evaluates agtmToneMapWithLut as identity when altr is empty', () => {
    const color = [2.0, 3.0, 4.0];
    const tonemapped = agtmToneMapWithLut(
      color,
      PRIMARIES_REC2020,
      TRANSFER_SRGB,
      metadataNoAltr,
      2.0,
      kLutOptionsNoLut,
      null,
      null,
    );
    expect(tonemapped[0]).toBeCloseTo(color[0], 5);
    expect(tonemapped[1]).toBeCloseTo(color[1], 5);
    expect(tonemapped[2]).toBeCloseTo(color[2], 5);
  });

  it('does not compress luminance > 64 when interpolating with zero gain rule', () => {
    const metadataWithAltr: AgtmMetadata = {
      hdr_reference_white: 203,
      baseline_hdr_headroom: 1.0,
      gain_application_space_primaries: PRIMARIES_REC2020,
      altr: [
        {
          headroom: 3.0,
          curve: [
            {x: 0, y: 0, m: 1},
            {x: 64, y: 2, m: 1},
          ],
          mix: {
            rgb: [0, 0, 0],
            max: 1,
            min: 0,
            channel: 0,
          },
        },
      ],
    };

    // At baseline headroom 1.0, the active rule is purely zero gain.
    const baselineAdapt = agtmAdapt(metadataWithAltr, 1.0);
    const colorHighLuma = [128.0, 128.0, 128.0];
    const tonemapped = agtmToneMap(
      colorHighLuma,
      PRIMARIES_REC2020,
      metadataWithAltr,
      baselineAdapt,
    );

    // Should NOT attenuate 128 down to 64!
    expect(tonemapped[0]).toBeCloseTo(128.0, 4);
    expect(tonemapped[1]).toBeCloseTo(128.0, 4);
    expect(tonemapped[2]).toBeCloseTo(128.0, 4);
  });
});
