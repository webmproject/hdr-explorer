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

import {arePayloadsEqual, makeAgtmPayload, muxAgtmMetadata} from './agtm_muxer';
import {AgtmMetadata} from './color_helpers/agtm';
import {
  ParsedMedia,
  getAgtmMetadata,
  getFirstVideoTrack,
  parseMp4,
  parseWebm,
} from './media_parser';

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

  it('correctly compares payloads with arePayloadsEqual', () => {
    const payloadA = makeAgtmPayload(sampleAgtm);
    const payloadA2 = makeAgtmPayload({...sampleAgtm});
    const payloadB = makeAgtmPayload({
      ...sampleAgtm,
      hdr_reference_white: 500,
    });
    expect(arePayloadsEqual(payloadA, payloadA2)).toBeTrue();
    expect(arePayloadsEqual(payloadA, payloadB)).toBeFalse();
    expect(arePayloadsEqual(payloadA, new Uint8Array(0))).toBeFalse();
  });

  it('deduplicates identical consecutive metadata in MP4', async () => {
    const response = await fetch('/data/lego_hlg.mp4');
    expect(response.ok).toBeTrue();
    const arrayBuffer = await response.arrayBuffer();

    const referenceWhites = [100, 100, 100, 203, 203, 300];
    const metadataList: AgtmMetadata[] = referenceWhites.map((white) => ({
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
    // Consecutive identical metadata should be deduplicated (100, 203, 300 -> 3 frames).
    expect(agtm.frames.length).toBe(3);
    expect(agtm.frames[0].agtm!.hdr_reference_white).toBe(100);
    expect(agtm.frames[1].agtm!.hdr_reference_white).toBe(203);
    expect(agtm.frames[2].agtm!.hdr_reference_white).toBe(300);

    // Verify that querying metadata at each video frame time correctly resolves
    // to the expected metadata, including for the deduplicated frames.
    const videoTrack = getFirstVideoTrack(parsed!.tracks)!;
    expect(videoTrack).toBeDefined();
    for (let i = 0; i < metadataList.length; ++i) {
      const videoSample = videoTrack.samplesSortedByPresentationTime[i];
      const retrieved = getAgtmMetadata(
        parsed!,
        videoSample.presentationTimeSec,
      );
      expect(typeof retrieved !== 'string').toBeTrue();
      expect((retrieved as AgtmMetadata).hdr_reference_white).toBe(
        referenceWhites[i],
      );
    }
  });

  it('deduplicates all identical metadata into a single sample in MP4', async () => {
    const response = await fetch('/data/lego_hlg.mp4');
    expect(response.ok).toBeTrue();
    const arrayBuffer = await response.arrayBuffer();

    const metadataList: AgtmMetadata[] = Array.from({length: 10}, () => ({
      ...sampleAgtm,
    }));
    metadataList[5] = {
      ...sampleAgtm,
      hdr_reference_white: 500,
    };

    const muxedBuffer = muxAgtmMetadata(arrayBuffer, metadataList);
    expect(muxedBuffer).not.toBeNull();

    const parsed = parseMp4(muxedBuffer!);
    expect(parsed).not.toBeNull();
    const track1Metadata = parsed!.hdrMetadata[1];
    expect(track1Metadata).toBeDefined();

    const videoTrack = getFirstVideoTrack(parsed!.tracks)!;
    expect(videoTrack).toBeDefined();
    const videoSamples = videoTrack.samplesSortedByPresentationTime;

    const agtm = track1Metadata['AGTM'];
    expect(agtm).toBeDefined();
    expect(agtm.frames.length).toBe(3);
    expect(agtm.frames[0].agtm!.hdr_reference_white).toBe(
      sampleAgtm.hdr_reference_white,
    );
    expect(agtm.frames[0].presentationTimeSec).toBe(
      videoSamples[0].presentationTimeSec,
    );
    expect(agtm.frames[1].agtm!.hdr_reference_white).toBe(500);
    expect(agtm.frames[1].presentationTimeSec).toBe(
      videoSamples[5].presentationTimeSec,
    );
    expect(agtm.frames[2].agtm!.hdr_reference_white).toBe(
      sampleAgtm.hdr_reference_white,
    );
    expect(agtm.frames[2].presentationTimeSec).toBe(
      videoSamples[6].presentationTimeSec,
    );
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
