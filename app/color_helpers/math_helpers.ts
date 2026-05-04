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

/** A 3D vector. */
export interface Point3 {
  x: number;
  y: number;
  z: number;
}

/** A 2x2 matrix. */
export interface Mat2 {
  xx: number;
  xy: number;
  yx: number;
  yy: number;
}

/** A 3x3 matrix. */
export interface Mat3 {
  xx: number;
  xy: number;
  xz: number;
  yx: number;
  yy: number;
  yz: number;
  zx: number;
  zy: number;
  zz: number;
}

/** Converts a 3-element array to a Point3. */
export function vec3ToPoint3(v: number[]): Point3 {
  return {x: v[0], y: v[1], z: v[2]};
}

/** Converts a Point3 to a 3-element array. */
export function point3ToVec3(p: Point3): number[] {
  return [p.x, p.y, p.z];
}

/** Computes the base-2 exponent. */
export function exp2(x: number): number {
  return Math.exp(x * Math.log(2));
}

/** Clamps a value `x` to the range `[min, max]`. */
export function clamp(x: number, min: number, max: number): number {
  return Math.min(Math.max(x, min), max);
}

/**
 * Linearly interpolates between two numbers.
 * @param a The value at x=0.0.
 * @param b The value at x=1.0.
 * @param amount The amount to interpolate. 0.0 means `a`, 1.0 means `b`.
 * @return The interpolated value.
 */
export function lerp(a: number, b: number, amount: number): number {
  amount = Math.max(0, Math.min(amount, 1));
  return (1 - amount) * a + amount * b;
}

/** Computes the squared Euclidean distance between two vectors. */
export function vec2Dist(a: Point2, b: Point2): number {
  return (a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y);
}
/** Creates a copy of a vector. */
export function vec2Copy(a: Point2): Point2 {
  return {x: a.x, y: a.y};
}
/** Performs a scaled vector addition (s * a + b). */
export function vec2Madd(s: number, a: Point2, b: Point2): Point2 {
  return {x: s * a.x + b.x, y: s * a.y + b.y};
}
/** Adds two vectors. */
export function vec2Add(a: Point2, b: Point2): Point2 {
  return {x: a.x + b.x, y: a.y + b.y};
}
/** Subtracts vector `b` from vector `a`. */
export function vec2Sub(a: Point2, b: Point2): Point2 {
  return {x: a.x - b.x, y: a.y - b.y};
}
/** Multiplies a 2x2 matrix by a 2D vector. */
export function mat2Mvm(A: Mat2, p: Point2): Point2 {
  return {
    x: A.xx * p.x + A.xy * p.y,
    y: A.yx * p.x + A.yy * p.y,
  };
}
/** Multiplies two 2x2 matrices. */
export function mat2Mm(A: Mat2, B: Mat2): Mat2 {
  return {
    xx: A.xx * B.xx + A.xy * B.yx,
    xy: A.xx * B.xy + A.xy * B.yy,
    yx: A.yx * B.xx + A.yy * B.yx,
    yy: A.yx * B.xy + A.yy * B.yy,
  };
}
/** Computes the inverse of a 2x2 matrix. */
export function mat2Inv(A: Mat2): Mat2 {
  const det = 1 / (A.xx * A.yy - A.xy * A.yx);
  return {
    xx: A.yy * det,
    xy: -A.xy * det,
    yx: -A.yx * det,
    yy: A.xx * det,
  };
}

/** Multiplies a 3x3 matrix by a 3D vector. */
export function mat3Mvm(m: Mat3, p: Point3): Point3 {
  return {
    x: m.xx * p.x + m.xy * p.y + m.xz * p.z,
    y: m.yx * p.x + m.yy * p.y + m.yz * p.z,
    z: m.zx * p.x + m.zy * p.y + m.zz * p.z,
  };
}

/** Multiplies two 3x3 matrices. */
export function mat3Mm(a: Mat3, b: Mat3): Mat3 {
  return {
    xx: a.xx * b.xx + a.xy * b.yx + a.xz * b.zx,
    xy: a.xx * b.xy + a.xy * b.yy + a.xz * b.zy,
    xz: a.xx * b.xz + a.xy * b.yz + a.xz * b.zz,
    yx: a.yx * b.xx + a.yy * b.yx + a.yz * b.zx,
    yy: a.yx * b.xy + a.yy * b.yy + a.yz * b.zy,
    yz: a.yx * b.xz + a.yy * b.yz + a.yz * b.zz,
    zx: a.zx * b.xx + a.zy * b.yx + a.zz * b.zx,
    zy: a.zx * b.xy + a.zy * b.yy + a.zz * b.zy,
    zz: a.zx * b.xz + a.zy * b.yz + a.zz * b.zz,
  };
}

/** Returns the 3x3 identity matrix. */
export function mat3Id(): Mat3 {
  return {
    xx: 1, xy: 0, xz: 0,
    yx: 0, yy: 1, yz: 0,
    zx: 0, zy: 0, zz: 1,
  };
}

/** Computes the inverse of a 3x3 matrix. */
export function mat3Inv(m: Mat3): Mat3 {
  const det =
    m.xx * (m.yy * m.zz - m.zy * m.yz) -
    m.xy * (m.yx * m.zz - m.yz * m.zx) +
    m.xz * (m.yx * m.zy - m.yy * m.zx);
  if (det === 0) {
    return {
      xx: 0,
      xy: 0,
      xz: 0,
      yx: 0,
      yy: 0,
      yz: 0,
      zx: 0,
      zy: 0,
      zz: 0,
    };
  }
  const invdet = 1 / det;
  return {
    xx: (m.yy * m.zz - m.zy * m.yz) * invdet,
    xy: (m.xz * m.zy - m.xy * m.zz) * invdet,
    xz: (m.xy * m.yz - m.xz * m.yy) * invdet,
    yx: (m.yz * m.zx - m.yx * m.zz) * invdet,
    yy: (m.xx * m.zz - m.xz * m.zx) * invdet,
    yz: (m.xz * m.yx - m.xx * m.yz) * invdet,
    zx: (m.yx * m.zy - m.yy * m.zx) * invdet,
    zy: (m.zx * m.xy - m.xx * m.zy) * invdet,
    zz: (m.xx * m.yy - m.yx * m.xy) * invdet,
  };
}

/**
 * Solves f(x) = y for x using Newton's method.
 * @param f The function to solve.
 * @param gradF The gradient of the function `f`.
 * @param y The target value.
 * @param x An optional initial guess for x. If not provided, `y` is used.
 * @return The value of x that solves f(x) = y.
 */
export function newtonSolve(
  f: (v: Point2) => Point2,
  gradF: (v: Point2) => Mat2,
  y: Point2,
  x: Point2 | null = null,
): Point2 {
  let currentX = x ?? y;
  for (let i = 0; i < 25; ++i) {
    const fOfX = f(currentX);
    const gradFOfX = gradF(currentX);
    const gradFOfXInv = mat2Inv(gradFOfX);

    const error = vec2Sub(y, fOfX);
    const step = mat2Mvm(gradFOfXInv, error);
    currentX = vec2Madd(1.0, step, currentX);
  }

  // Solve the slope directly.
  if (y.m !== undefined) {
    const grad = gradF(currentX);
    const gradInv = mat2Inv(grad);

    const dXyView = {x: 1, y: y.m};
    const dXyModel = mat2Mvm(gradInv, dXyView);
    currentX.m = dXyModel.y / dXyModel.x;
  }

  return currentX;
}
