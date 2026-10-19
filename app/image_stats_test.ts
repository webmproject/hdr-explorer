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
  PRIMARIES_REC2020,
  TRANSFER_PQ,
  TRANSFER_SRGB,
} from './color_helpers/color_functions';
import {
  averageStats,
  CdfBin,
  ComputedStats,
  getPercentile,
  ImageStats,
} from './image_stats';

describe('image_stats', () => {
  function createSampleBins(): CdfBin[] {
    const bins: CdfBin[] = [];
    const numBins = 10;
    for (let i = 0; i < numBins; i++) {
      const binMin = i * 10;
      const binMax = (i + 1) * 10;
      const freq = [0.1, 0.1, 0.1, 0.1];
      const count = [100, 100, 100, 100];
      const cdfMin = [i * 0.1, i * 0.1, i * 0.1, i * 0.1];
      const cdfMax = [(i + 1) * 0.1, (i + 1) * 0.1, (i + 1) * 0.1, (i + 1) * 0.1];
      bins.push({
        binMin,
        binMax,
        count,
        freq,
        density: [0.01, 0.01, 0.01, 0.01],
        maxDensity: 0.01,
        cdfMin,
        cdfMax,
      });
    }
    return bins;
  }

  function createSampleStats(offset = 0): ComputedStats {
    const bins = createSampleBins();
    return {
      bins,
      percentileBins: [],
      maxPerChannel: [100 + offset, 100 + offset, 100 + offset, 100 + offset],
      avgPerChannel: [50 + offset, 50 + offset, 50 + offset, 50 + offset],
      maxMaxRgb: 100 + offset,
      minMaxRgb: offset,
      avgMaxRgb: 50 + offset,
    };
  }

  describe('getPercentile', () => {
    it('returns correct value for valid percentile', () => {
      const bins = createSampleBins();
      const p50 = getPercentile(0.5, bins, 0);
      expect(p50).toBeCloseTo(50, 1);

      const p0 = getPercentile(0, bins, 0);
      expect(p0).toBeCloseTo(0, 1);

      const p100 = getPercentile(1.0, bins, 0);
      expect(p100).toBeCloseTo(100, 1);
    });

    it('handles out of bounds percentiles gracefully', () => {
      const bins = createSampleBins();
      expect(getPercentile(-0.1, bins, 0)).toBe(bins[0].binMin);
      expect(getPercentile(1.5, bins, 0)).toBe(bins[bins.length - 1].binMax);
    });
  });

  describe('averageStats', () => {
    it('correctly averages two stats with equal weights', () => {
      const s1 = createSampleStats(0);
      const s2 = createSampleStats(100);
      const avg = averageStats(s1, s2, 0.5);

      expect(avg.maxMaxRgb).toBe(150);
      expect(avg.minMaxRgb).toBe(50);
      expect(avg.avgMaxRgb).toBe(100);
      expect(avg.maxPerChannel[0]).toBe(150);
      expect(avg.avgPerChannel[0]).toBe(100);
      expect(avg.bins.length).toBe(s1.bins.length);
    });
  });

  describe('ImageStats with ImageBitmap', () => {
    it('computes stats on an offscreen image canvas', async () => {
      const width = 64;
      const height = 64;
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#808080';
      ctx.fillRect(0, 0, width, height);

      const bitmap = await createImageBitmap(canvas);
      const statsObj = new ImageStats(bitmap, TRANSFER_SRGB, PRIMARIES_REC2020);

      expect(statsObj.width).toBe(width);
      expect(statsObj.height).toBe(height);

      const stats = statsObj.getStats();
      expect(stats.bins.length).toBe(100);
      expect(stats.maxMaxRgb).toBeGreaterThan(0);
      expect(stats.avgMaxRgb).toBeGreaterThan(0);
      expect(stats.minMaxRgb).toBeGreaterThanOrEqual(0);

      const stats2 = statsObj.getStats();
      expect(stats2.maxMaxRgb).toBe(stats.maxMaxRgb);

      // Verify pixel inspection
      const pixelNits = statsObj.getPixelValueNits(10, 10);
      expect(pixelNits).not.toBeNull();
      expect(pixelNits![0]).toBeGreaterThan(0);

      const pixelEncoded = statsObj.getPixelValueEncoded(10, 10);
      expect(pixelEncoded).not.toBeNull();

      bitmap.close();
    });

    it('computes identical stats with keepEncoded=false and useScratchBuffer=true', async () => {
      const width = 32;
      const height = 32;
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#ff8040';
      ctx.fillRect(0, 0, width, height);

      const bitmap1 = await createImageBitmap(canvas);
      const defaultStatsObj = new ImageStats(
        bitmap1,
        TRANSFER_SRGB,
        PRIMARIES_REC2020,
      );
      const defaultStats = defaultStatsObj.getStats();

      const bitmap2 = await createImageBitmap(canvas);
      const scratchStatsObj = new ImageStats(
        bitmap2,
        TRANSFER_SRGB,
        PRIMARIES_REC2020,
        {keepEncoded: false, useScratchBuffer: true},
      );
      const scratchStats = scratchStatsObj.getStats();

      expect(scratchStats.maxMaxRgb).toBeCloseTo(defaultStats.maxMaxRgb, 4);
      expect(scratchStats.minMaxRgb).toBeCloseTo(defaultStats.minMaxRgb, 4);
      expect(scratchStats.avgMaxRgb).toBeCloseTo(defaultStats.avgMaxRgb, 4);
      expect(scratchStats.bins.length).toBe(defaultStats.bins.length);

      // getPixelValueEncoded should return null when keepEncoded is false
      expect(scratchStatsObj.getPixelValueEncoded(5, 5)).toBeNull();

      // getPixelValueNits should still work
      const nitsDefault = defaultStatsObj.getPixelValueNits(5, 5);
      const nitsScratch = scratchStatsObj.getPixelValueNits(5, 5);
      expect(nitsScratch).not.toBeNull();
      expect(nitsScratch![0]).toBeCloseTo(nitsDefault![0], 4);
      expect(nitsScratch![1]).toBeCloseTo(nitsDefault![1], 4);
      expect(nitsScratch![2]).toBeCloseTo(nitsDefault![2], 4);

      // Subsequent call reusing scratch buffer with different content
      ctx.fillStyle = '#102030';
      ctx.fillRect(0, 0, width, height);
      const bitmap3 = await createImageBitmap(canvas);
      const scratchStatsObj2 = new ImageStats(
        bitmap3,
        TRANSFER_SRGB,
        PRIMARIES_REC2020,
        {keepEncoded: false, useScratchBuffer: true},
      );
      const scratchStats2 = scratchStatsObj2.getStats();
      expect(scratchStats2.avgMaxRgb).toBeLessThan(scratchStats.avgMaxRgb);

      bitmap1.close();
      bitmap2.close();
      bitmap3.close();
    });
  });
});
