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

/**
 * Computes PCHIP interpolation slopes for a given set of points.
 * @param x The x-coordinates of the points.
 * @param y The y-coordinates of the points.
 * @return The slopes at each point.
 */
export function pchipInterpolationSlopes(x: number[], y: number[]): number[] {
  if (x.length !== y.length) {
    throw new Error('x and y must have the same length.');
  }

  const sampleCount = x.length;
  if (sampleCount < 2) {
    // PChip interpolation requires at least two points.
    return new Array<number>(sampleCount).fill(0);
  }

  const deltaX: number[] = [];
  for (let i = 0; i < sampleCount - 1; ++i) {
    deltaX.push(x[i + 1] - x[i]);
  }

  const directSlopes: number[] = [];
  for (let i = 0; i < sampleCount - 1; ++i) {
    const dy = y[i + 1] - y[i];
    const dx = deltaX[i];
    directSlopes.push(dx === 0 ? 0 : dy / dx);
  }

  const slopes = new Array<number>(sampleCount).fill(0);

  if (sampleCount === 2) {
    slopes[0] = directSlopes[0];
    slopes[1] = directSlopes[0];
  } else {
    // Boundary slopes (m0 and m1)
    // m0: slope at the first point
    const dx0 = deltaX[0];
    const dx1 = deltaX[1];
    const ds0 = directSlopes[0];
    const ds1 = directSlopes[1];
    const m0Num = (2 * dx0 + dx1) * ds0 - dx0 * ds1;
    const m0Den = dx0 + dx1;
    slopes[0] = m0Den === 0 ? 0 : m0Num / m0Den;

    // m1: slope at the last point
    const dxLast = deltaX[sampleCount - 2];
    const dxSecondLast = deltaX[sampleCount - 3];
    const dsLast = directSlopes[sampleCount - 2];
    const dsSecondLast = directSlopes[sampleCount - 3];
    const m1Num = (2 * dxLast + dxSecondLast) * dsLast - dxLast * dsSecondLast;
    const m1Den = dxLast + dxSecondLast;
    slopes[sampleCount - 1] = m1Den === 0 ? 0 : m1Num / m1Den;

    // Internal slopes
    for (let i = 1; i < sampleCount - 1; ++i) {
      const dxPrev = deltaX[i - 1];
      const dxCurr = deltaX[i];
      const dsPrev = directSlopes[i - 1];
      const dsCurr = directSlopes[i];

      if (Math.sign(dsPrev) !== Math.sign(dsCurr)) {
        slopes[i] = 0;
      } else {
        const numerator = 3 * (dxPrev + dxCurr) * dsPrev * dsCurr;
        const denominator =
          (2 * dxPrev + dxCurr) * dsPrev + (dxPrev + 2 * dxCurr) * dsCurr;
        slopes[i] = denominator === 0 ? 0 : numerator / denominator;
      }
    }
  }
  return slopes;
}
