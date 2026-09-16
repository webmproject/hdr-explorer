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

import {muxAgtmMetadata} from './agtm_muxer';
import {AgtmMetadata} from './color_helpers/agtm';
import {ParsedMedia, parseMp4, parseWebm} from './media_parser';

const sampleAgtm: AgtmMetadata = {
  hdr_reference_white: 203,
  baseline_hdr_headroom: 1.0,
  gain_application_space_primaries: 9, // BT.2020
  altr: [
    {
      headroom: 2.0,
      curve: [
        {x: 0, y: 0, m: 1},
        {x: 64, y: 1, m: 1},
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

function verifyAgtmMetadata(parsed: ParsedMedia | null) {
  expect(parsed).not.toBeNull();
  const track1Metadata = parsed!.hdrMetadata[1];
  expect(track1Metadata).toBeDefined();

  const agtm = track1Metadata['AGTM'];
  expect(agtm).toBeDefined();
  expect(agtm.name).toBe('AGTM');
  expect(agtm.frames.length).toBeGreaterThan(0);

  const firstFrame = agtm.frames[0];
  expect(firstFrame.presentationTimeSec).toBe(0);
  expect(firstFrame.agtm).toBeDefined();
  expect(firstFrame.agtm!.hdr_reference_white).toBe(203);
  expect(firstFrame.agtm!.baseline_hdr_headroom).toBeCloseTo(1.0, 4);
  expect(firstFrame.agtm!.altr.length).toBe(1);
  expect(firstFrame.agtm!.altr[0].headroom).toBeCloseTo(2.0, 4);
}

describe('agtm_muxer', () => {
  it('muxes AGTM metadata into MP4', async () => {
    const response = await fetch('/data/lego_hlg.mp4');
    expect(response.ok).toBeTrue();
    const arrayBuffer = await response.arrayBuffer();

    const muxedBuffer = muxAgtmMetadata(arrayBuffer, [sampleAgtm]);
    expect(muxedBuffer).not.toBeNull();

    const parsed = parseMp4(muxedBuffer!);
    verifyAgtmMetadata(parsed);
  });

  it('muxes AGTM metadata into WebM', async () => {
    const response = await fetch('/data/motion_floor_to_sky_vp9_hdr10p.webm');
    expect(response.ok).toBeTrue();
    const arrayBuffer = await response.arrayBuffer();

    const muxedBuffer = muxAgtmMetadata(arrayBuffer, [sampleAgtm]);
    expect(muxedBuffer).not.toBeNull();

    const parsed = parseWebm(muxedBuffer!);
    verifyAgtmMetadata(parsed);
  });

  it('muxes multiple metadata with varying hdr_reference_white into MP4', async () => {
    const response = await fetch('/data/lego_hlg.mp4');
    expect(response.ok).toBeTrue();
    const arrayBuffer = await response.arrayBuffer();

    const referenceWhites = [100, 203, 300, 400, 500];
    const metadataList: AgtmMetadata[] = referenceWhites.map((white, i) => ({
      ...sampleAgtm,
      hdr_reference_white: white,
    }));

    const muxedBuffer = muxAgtmMetadata(arrayBuffer, metadataList);
    expect(muxedBuffer).not.toBeNull();

    const parsed = parseMp4(muxedBuffer!);
    expect(parsed).not.toBeNull();
    const track1Metadata = parsed!.hdrMetadata[1];
    expect(track1Metadata).toBeDefined();

    const agtm = track1Metadata['AGTM'];
    expect(agtm).toBeDefined();
    // MP4 muxing uses metadata tracks, so the number of frames should match the
    // number of metadata provided.
    expect(agtm.frames.length).toBe(metadataList.length);

    for (let i = 0; i < metadataList.length; ++i) {
      const frame = agtm.frames[i];
      expect(frame.agtm).toBeDefined();
      expect(frame.agtm!.hdr_reference_white).toBe(referenceWhites[i]);
    }
  });

  it('muxes multiple metadata with varying hdr_reference_white into WebM', async () => {
    const response = await fetch('/data/motion_floor_to_sky_vp9_hdr10p.webm');
    expect(response.ok).toBeTrue();
    const arrayBuffer = await response.arrayBuffer();

    const referenceWhites = [100, 203, 300, 400, 500];
    const metadataList: AgtmMetadata[] = referenceWhites.map((white, i) => ({
      ...sampleAgtm,
      hdr_reference_white: white,
    }));

    const muxedBuffer = muxAgtmMetadata(arrayBuffer, metadataList);
    expect(muxedBuffer).not.toBeNull();

    const parsed = parseWebm(muxedBuffer!);
    expect(parsed).not.toBeNull();
    const track1Metadata = parsed!.hdrMetadata[1];
    expect(track1Metadata).toBeDefined();

    const agtm = track1Metadata['AGTM'];
    expect(agtm).toBeDefined();
    // WebM muxing uses the T35 payload in the block additions, so the number of
    // frames should match the number of video frames. The last metadata will be
    // applied to all subsequent frames.
    expect(agtm.frames.length).toBe(parsed!.samples.length);

    for (let i = 0; i < agtm.frames.length; ++i) {
      const frame = agtm.frames[i];
      expect(frame.agtm).toBeDefined();
      expect(frame.agtm!.hdr_reference_white).toBe(
        referenceWhites[Math.min(i, metadataList.length - 1)],
      );
    }
  });
});
