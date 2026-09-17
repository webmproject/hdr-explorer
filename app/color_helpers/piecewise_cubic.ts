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

import {Point2} from './agtm';

/**
 * Represents a piecewise cubic function defined by a set of control points,
 * including extrapolations to the left and right as defined in the ST 2094-50
 * specification.
 */
export class PiecewiseCubic {
  private readonly controlPoints: Point2[];

  constructor(controlPoints: Point2[]) {
    this.controlPoints = structuredClone(controlPoints);
  }

  /** Returns the control points. */
  getControlPoints(): Point2[] {
    return this.controlPoints;
  }

  /** Inserts a new control point by evaluating the function at `x`. */
  insert(x: number): void {
    const p = this.evaluate(x);
    let i = 0;
    while (this.controlPoints.length > i && this.controlPoints[i].x < p.x) {
      ++i;
    }
    this.controlPoints.splice(i, 0, p);
  }

  /** Removes a control point at a given index. */
  remove(index: number | null): void {
    if (index == null) {
      return;
    }
    this.controlPoints.splice(index, 1);
  }

  /**
   * Evaluates the piecewise function at a given x-coordinate.
   * @param x The x-coordinate at which to evaluate the function.
   * @return The evaluated point {x, y, m} where m is the slope.
   */
  evaluate(x: number): Point2 {
    const result: Point2 = {x, y: NaN};
    const n = this.controlPoints.length;
    if (x <= this.controlPoints[0].x) {
      result.y = this.controlPoints[0].y;
      result.m = 0;
      return result;
    }
    if (x >= this.controlPoints[n - 1].x) {
      const xym = this.controlPoints[n - 1];
      result.y = xym.y + Math.log2(xym.x / x);
      result.m = 0;
      return result;
    }
    for (let i = 0; i < n - 1; ++i) {
      if (x <= this.controlPoints[i + 1].x) {
        const x0 = this.controlPoints[i].x;
        const x1 = this.controlPoints[i + 1].x;
        const y0 = this.controlPoints[i].y;
        const y1 = this.controlPoints[i + 1].y;
        const m0 = this.controlPoints[i].m!;
        const m1 = this.controlPoints[i + 1].m!;

        // Normalize to the unit interval
        const t = (x - x0) / (x1 - x0);
        const m0Norm = m0 * (x1 - x0);
        const m1Norm = m1 * (x1 - x0);

        // Compute cubic coefficients and evaluate.
        const c3 = 2.0 * y0 + m0Norm - 2.0 * y1 + m1Norm;
        const c2 = -3.0 * y0 + 3.0 * y1 - 2.0 * m0Norm - m1Norm;
        const c1 = m0Norm;
        const c0 = y0;
        result.y = c0 + t * (c1 + t * (c2 + t * c3));
        result.m = (c1 + 2 * c2 * t + 3 * c3 * t * t) / (x1 - x0);
        return result;
      }
    }
    // This should be unreachable if control points are sorted and x is within
    // range.
    console.error('Evaluation failed: x is out of bounds in a weird way.');
    return {x, y: NaN, m: NaN};
  }
}
