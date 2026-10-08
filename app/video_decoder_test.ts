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

import {Av1CBox, HvcCBox} from './isobmff';
import {
  buildAv1CodecString,
  buildHevcCodecString,
  reverseBits32,
} from './video_decoder';

describe('video_decoder', () => {
  describe('reverseBits32', () => {
    it('reverses 32-bit integers correctly', () => {
      expect(reverseBits32(0x80000000)).toBe(1);
      expect(reverseBits32(1)).toBe(0x80000000);
      expect(reverseBits32(0)).toBe(0);
    });
  });

  describe('buildHevcCodecString', () => {
    it('builds standard Main 10 profile string', () => {
      const hvcC = new HvcCBox('hvcC');
      hvcC.generalProfileSpace = 0;
      hvcC.generalProfileIdc = 2; // Main 10
      hvcC.generalProfileCompatibilityFlags = 0x20000000; // Bit 2 set
      hvcC.generalTierFlag = 0; // Main tier (L)
      hvcC.generalLevelIdc = 153; // Level 5.1 (5.1 * 30 = 153)
      hvcC.generalConstraintIndicatorFlags = [
        0xb0, 0x00, 0x00, 0x00, 0x00, 0x00,
      ];

      expect(buildHevcCodecString(hvcC)).toBe('hvc1.2.4.L153.B0');
    });

    it('builds Main Still Picture string', () => {
      const hvcC = new HvcCBox('hvcC');
      hvcC.generalProfileSpace = 0;
      hvcC.generalProfileIdc = 1;
      hvcC.generalProfileCompatibilityFlags = 0x60000000;
      hvcC.generalTierFlag = 0;
      hvcC.generalLevelIdc = 93;
      hvcC.generalConstraintIndicatorFlags = [
        0xb0, 0x00, 0x00, 0x00, 0x00, 0x00,
      ];

      expect(buildHevcCodecString(hvcC)).toBe('hvc1.1.6.L93.B0');
    });
  });

  describe('buildAv1CodecString', () => {
    it('builds standard AV1 Main profile 10-bit string', () => {
      const av1C = new Av1CBox('av1C');
      av1C.seqProfile = 0; // Main
      av1C.seqLevelIdx0 = 8; // Level 4.0
      av1C.seqTier0 = 0; // Main tier
      av1C.highBitdepth = 1;
      av1C.twelveBit = 0;

      expect(buildAv1CodecString(av1C)).toBe('av01.0.08M.10');
    });

    it('builds AV1 8-bit string', () => {
      const av1C = new Av1CBox('av1C');
      av1C.seqProfile = 0;
      av1C.seqLevelIdx0 = 4;
      av1C.seqTier0 = 0;
      av1C.highBitdepth = 0;
      av1C.twelveBit = 0;

      expect(buildAv1CodecString(av1C)).toBe('av01.0.04M.08');
    });
  });
});
