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

// Solves a quadratic equation a*t^2 + b*t + c = 0 for t, returning one root.
// This is used to find t in the Bezier function.
function solveQuadratic(a: number, b: number, c: number): number {
  if (Math.abs(a) < 1e-9) {
    // Linear equation: b*t + c = 0
    return -c / b;
  }
  const delta = b * b - 4 * a * c;
  if (delta < 0) {
    // No real roots.
    return NaN;
  }
  const sqrtDelta = Math.sqrt(delta);
  return (-b + sqrtDelta) / (2 * a);
}

/**
 * Control points for the Bezier curve.
 */
interface ControlPoint {
  x: number;
  y: number;
}

export class QuadraticBezier {
  private readonly controlPoints: [ControlPoint, ControlPoint, ControlPoint];
  private readonly xFunction: (t: number) => number;
  private readonly yFunction: (t: number) => number;
  private readonly mFunction: (t: number) => number;
  private readonly tFunction: (x: number) => number;

  constructor(controlPoints: [ControlPoint, ControlPoint, ControlPoint]) {
    this.controlPoints = controlPoints;

    const cpKnee = this.controlPoints[0];
    const cpMid = this.controlPoints[1];
    const cpMax = this.controlPoints[2];

    // Compute the coefficients for B2D(t) = (a_x * t*t + b_x * t + c_x, a_y * t*t + b_y * t + c_y)
    const aX = cpKnee.x - 2 * cpMid.x + cpMax.x;
    const bX = 2 * cpMid.x - 2 * cpKnee.x;
    const cX = cpKnee.x;
    const aY = cpKnee.y - 2 * cpMid.y + cpMax.y;
    const bY = 2 * cpMid.y - 2 * cpKnee.y;
    const cY = cpKnee.y;
    this.xFunction = (t: number) => aX * t * t + bX * t + cX;
    this.yFunction = (t: number) => aY * t * t + bY * t + cY;
    this.mFunction = (t: number) => (2 * aY * t + bY) / (2 * aX * t + bX);
    // Solve a_x * t*t + b_x * t + (c_x - x) = 0 for t
    this.tFunction = (x: number) => solveQuadratic(aX, bX, cX - x);
  }

  getX(t: number): number {
    return this.xFunction(t);
  }

  getY(t: number): number {
    return this.yFunction(t);
  }

  getM(t: number): number {
    return this.mFunction(t);
  }

  evaluate(x: number): number {
    const t = this.tFunction(x);
    if (isNaN(t)) {
      console.warn(`Failed to evaluate Bezier at x=${x}`);
      return NaN;
    }
    return this.yFunction(t);
  }
}
