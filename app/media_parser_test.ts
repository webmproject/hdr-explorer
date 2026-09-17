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
  findSampleIndexForTime,
  findTrackSampleIndexForTime,
  getAverageFramerate,
  getCicp,
  getFirstVideoTrack,
  isKeyframe,
  OBU,
  parseMp4,
  parseT35,
  parseWebm,
  removeTrack,
} from './media_parser';

describe('media_parser', () => {
  describe('parseMp4', () => {
    it('parses MP4 file (lego_hlg.mp4)', async () => {
      const response = await fetch('/data/lego_hlg.mp4');
      expect(response.ok).toBeTrue();
      const arrayBuffer = await response.arrayBuffer();
      const parsed = parseMp4(arrayBuffer);
      expect(parsed).not.toBeNull();
      expect(parsed!.containerType).toBe('mp4');
      expect(parsed!.boxes.length).toBeGreaterThan(0);

      const videoTrack = getFirstVideoTrack(parsed!.tracks);
      expect(videoTrack).toBeDefined();
      expect(videoTrack!.handlerType).toBe('vide');
      expect(videoTrack!.codec).toBe('av01');

      const track1Metadata = parsed!.hdrMetadata[videoTrack!.id];
      expect(track1Metadata).toBeDefined();

      // Check CICP (BT.2020 / HLG)
      const cicp = track1Metadata['CICP'];
      expect(cicp).toBeDefined();
      expect(cicp.name).toBe('CICP');
      expect(cicp.colourPrimaries).toBe(9);
      expect(cicp.transferCharacteristics).toBe(18);
      expect(cicp.matrixCoefficients).toBe(9);

      // Check helper getCicp
      const extractedCicp = getCicp(parsed!);
      expect(extractedCicp).not.toBeNull();
      expect(extractedCicp!.colourPrimaries).toBe(9);
      expect(extractedCicp!.transferCharacteristics).toBe(18);
      expect(extractedCicp!.matrixCoefficients).toBe(9);

      // Check samples
      expect(parsed!.samples.length).toBeGreaterThan(0);
      expect(parsed!.numKeyframes).toBeGreaterThan(0);

      // Check framerate calculation
      const framerate = getAverageFramerate(parsed!);
      expect(framerate).not.toBeNull();
      expect(framerate!).toBeCloseTo(30, 0.01);

      // Check sample time search
      expect(findTrackSampleIndexForTime(videoTrack!, 0.0)).toBe(0);
      expect(findTrackSampleIndexForTime(videoTrack!, 0.1)).toBe(2);
      expect(findTrackSampleIndexForTime(videoTrack!, 1.0)).toBe(29);

      const times = [0.0, 0.0333, 0.0667, 0.1];
      expect(findSampleIndexForTime(times, 0.033, 1e-3)).toBe(1);
      expect(findSampleIndexForTime(times, 0.033, 1e-6)).toBe(0);
    });

    it('parses HDR10+ metadata in MP4 (indoor_av1_hdr10p.mp4)', async () => {
      const response = await fetch('/data/indoor_av1_hdr10p.mp4');
      expect(response.ok).toBeTrue();
      const arrayBuffer = await response.arrayBuffer();
      const parsed = parseMp4(arrayBuffer);
      expect(parsed).not.toBeNull();
      expect(parsed!.containerType).toBe('mp4');

      const videoTrack = getFirstVideoTrack(parsed!.tracks);
      expect(videoTrack).toBeDefined();
      const trackMetadata = parsed!.hdrMetadata[videoTrack!.id];
      expect(trackMetadata).toBeDefined();

      // Check HDR10+ is present
      const hdr10p = trackMetadata['HDR10+'];
      expect(hdr10p).toBeDefined();
      expect(hdr10p.frames.length).toBeGreaterThan(0);
      expect(hdr10p.frames.length).toBe(videoTrack!.samples.length);

      // Check first frame of HDR10+ metadata
      const firstFrame = hdr10p.frames[0];
      expect(firstFrame.presentationTimeSec).toBeCloseTo(0, 2);
      expect(firstFrame.hdr10p).toBeDefined();
      expect(firstFrame.hdr10p!.application_identifier).toBe(4);
      expect(firstFrame.hdr10p!.num_windows).toBe(1);
    });

    it('handles empty buffer gracefully', () => {
      const parsed = parseMp4(new ArrayBuffer(0));
      expect(parsed).not.toBeNull();
      expect(parsed!.boxes.length).toBe(0);
      expect(Object.keys(parsed!.tracks).length).toBe(0);
      expect(parsed!.samples.length).toBe(0);
    });

    it('returns null for corrupted buffer', () => {
      const corrupted = new Uint8Array([0, 0, 0, 8, 102, 116, 121, 112]); // 'ftyp' with no moov
      const parsed = parseMp4(corrupted.buffer);
      expect(parsed).toBeNull();
    });

    it('removes track correctly', async () => {
      const response = await fetch('/data/lego_hlg.mp4');
      const arrayBuffer = await response.arrayBuffer();
      const parsed = parseMp4(arrayBuffer);
      expect(parsed).not.toBeNull();
      const videoTrack = getFirstVideoTrack(parsed!.tracks);
      expect(videoTrack).toBeDefined();

      const trackId = videoTrack!.id;
      removeTrack(parsed!, trackId);
      expect(parsed!.tracks[trackId]).toBeUndefined();
      expect(parsed!.hdrMetadata[trackId]).toBeUndefined();
    });
  });

  describe('parseWebm', () => {
    it('parses WebM file (motion_floor_to_sky_vp9_hdr10p.webm)', async () => {
      const response = await fetch('/data/motion_floor_to_sky_vp9_hdr10p.webm');
      expect(response.ok).toBeTrue();
      const arrayBuffer = await response.arrayBuffer();
      const parsed = parseWebm(arrayBuffer);
      expect(parsed).not.toBeNull();
      expect(parsed!.containerType).toBe('webm');
      expect(parsed!.ebmlElements.length).toBeGreaterThan(0);

      const videoTrack = getFirstVideoTrack(parsed!.tracks);
      expect(videoTrack).toBeDefined();
      expect(videoTrack!.handlerType).toBe('vide');
      expect(videoTrack!.codec).toBe('vp09');

      const track1Metadata = parsed!.hdrMetadata[videoTrack!.id];
      expect(track1Metadata).toBeDefined();

      // Check CICP (BT.2020 / PQ)
      const cicp = track1Metadata['CICP'];
      expect(cicp).toBeDefined();
      expect(cicp.name).toBe('CICP');
      expect(cicp.colourPrimaries).toBe(9);
      expect(cicp.transferCharacteristics).toBe(16);
      expect(cicp.matrixCoefficients).toBe(9);
      expect(cicp.frames.length).toBe(0);

      // Check HDR10+
      const hdr10p = track1Metadata['HDR10+'];
      expect(hdr10p).toBeDefined();
      expect(hdr10p.name).toBe('HDR10+');
      expect(hdr10p.frames.length).toBeGreaterThan(0);
      expect(hdr10p.frames.length).toBe(videoTrack!.samples.length);

      // Check samples
      expect(parsed!.samples.length).toBeGreaterThan(0);
      expect(parsed!.numKeyframes).toBeGreaterThan(0);
    });

    it('returns null for empty buffer', () => {
      const parsed = parseWebm(new ArrayBuffer(0));
      expect(parsed).toBeNull();
    });

    it('returns null for invalid buffer', () => {
      const corrupted = new Uint8Array([0xff, 0xff, 0xff, 0xff]);
      const parsed = parseWebm(corrupted.buffer);
      expect(parsed).toBeNull();
    });
  });

  describe('parseT35', () => {
    it('handles short payload without error', () => {
      const shortData = new Uint8Array([0xb5]);
      const result = parseT35(shortData);
      expect(result.countryCode).toBe(0xb5);
      expect(result.metadataType).toBeUndefined();
    });
  });

  describe('isKeyframe', () => {
    it('identifies keyframe OBU correctly', () => {
      const obuKeyframe = {
        size: 10,
        header: {
          forbiddenBit: 0,
          type: 3, // OBU_FRAME_HEADER
          typeName: 'OBU_FRAME_HEADER',
          extensionFlag: 0,
          hasSizeField: 0,
          reserved1bit: 0,
        },
        payload: {
          isKeyframe: true,
          showFrame: 1,
          showExistingFrame: 0,
          frameType: 0,
        },
      } as unknown as OBU;
      expect(isKeyframe(obuKeyframe)).toBeTrue();

      const obuNonKeyframe = {
        size: 10,
        header: {
          forbiddenBit: 0,
          type: 3, // OBU_FRAME_HEADER
          typeName: 'OBU_FRAME_HEADER',
          extensionFlag: 0,
          hasSizeField: 0,
          reserved1bit: 0,
        },
        payload: {
          isKeyframe: false,
          showFrame: 1,
          showExistingFrame: 0,
          frameType: 1,
        },
      } as unknown as OBU;
      expect(isKeyframe(obuNonKeyframe)).toBeFalse();

      const obuOther = {
        size: 10,
        header: {
          forbiddenBit: 0,
          type: 1, // OBU_SEQUENCE_HEADER
          typeName: 'OBU_SEQUENCE_HEADER',
          extensionFlag: 0,
          hasSizeField: 0,
          reserved1bit: 0,
        },
        payload: null,
      } as unknown as OBU;
      expect(isKeyframe(obuOther)).toBeFalse();
    });
  });
});
