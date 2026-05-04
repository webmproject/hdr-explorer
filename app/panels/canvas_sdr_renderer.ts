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

import {Base2dRenderer} from './base_renderer';

/**
 * A renderer that draws the SDR image to the canvas.
 * With the new globalHDRHeadroom API this could also be used to render HDR,
 * but this API is only available in Chrome Canary for now.
 */
export class CanvasSdrRenderer extends Base2dRenderer {
  constructor(canvas: HTMLCanvasElement) {
    super(canvas, /* rendersPicture= */ true);
  }

  override getVersion(): string {
    return 'v1.0.0';
  }

  render() {
    if (!this.imageBitmapSource || !this.imageBitmap) {
      return;
    }
    // Assume the canvas size matches the size of the image.
    const width = this.canvas.width;
    const height = this.canvas.height;
    this.context.clearRect(0, 0, width, height);
    this.context.drawImage(
      this.imageBitmapSource,
      width * (0.5 + this.panX - 0.5 / this.zoom),
      height * (0.5 + this.panY - 0.5 / this.zoom),
      width / this.zoom,
      height / this.zoom,
      0,
      0,
      width,
      height,
    );
  }
}
