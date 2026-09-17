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
import {Mat2, exp2, mat2Mvm, newtonSolve} from './math_helpers';

/**
 * Computes the gradient of the log-gain function at a given point.
 */
export function logGainToLinearGrad(p: Point2): Mat2 {
  return {xx: 1, xy: 0, yx: exp2(p.y), yy: Math.log(2) * p.x * exp2(p.y)};
}

/**
 * Converts a log-gain point to a linear point.
 */
export function logGainToLinear(p: Point2, clampVal?: number): Point2 {
  const x = p.x;
  let y = p.x * exp2(p.y);
  if (p.m !== undefined) {
    const dXY = mat2Mvm(logGainToLinearGrad(p), {x: 1, y: p.m});
    return {x, y, m: dXY.y / dXY.x};
  }
  if (clampVal !== undefined) {
    y = Math.min(y, clampVal);
  }
  return {x, y};
}

/**
 * Converts a linear point to a log-gain point using Newton's method.
 */
export function linearToLogGain(pLinear: Point2): Point2 {
  return newtonSolve(
    (p: Point2) => logGainToLinear(p),
    logGainToLinearGrad,
    pLinear,
  );
}
