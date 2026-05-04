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

export class PiecewiseLinear {
  constructor(private readonly points: Point2[]) {}

  evaluate(x: number): number {
    if (this.points.length === 0) return 0;
    if (x <= this.points[0].x) return this.points[0].y;
    if (x >= this.points[this.points.length - 1].x) {
      return this.points[this.points.length - 1].y;
    }

    const i = this.points.findIndex((point) => point.x >= x);
    // `i` is guaranteed to be > 0 because of the checks above.
    // We are looking for the segment between points[i-1] and points[i].
    const p1 = this.points[i - 1];
    const p2 = this.points[i];
    const x1 = p1.x;
    const x2 = p2.x;
    const y1 = p1.y;
    const y2 = p2.y;
    if (x2 - x1 === 0) {
      return y1;
    }
    return y1 + ((y2 - y1) * (x - x1)) / (x2 - x1);
  }
}
