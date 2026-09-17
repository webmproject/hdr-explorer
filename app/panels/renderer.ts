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

export interface Renderer {
  /** Returns whether this renderer renders a picture, and not e.g. curves. */
  isPicture(): boolean;
  /** Returns the canvas used by this renderer. */
  getCanvas(): HTMLCanvasElement;
  /**
   * Returns the version of the renderer. The version should be incremented
   * every time the implementation changes in a way that affects the rendered
   * image.
   */
  getVersion(): string;
  resizeFramebuffer(
    width: number,
    height: number,
    evenIfNotPicture?: boolean,
  ): void;
  /**
   * Sets the image to be rendered.
   */
  setImage(
    imageBitmapSource: HTMLImageElement | HTMLVideoElement,
    imageBitmap: ImageBitmap,
    contentTransfer: number,
    contentPrimaries: number,
  ): void;
  draw(): void;
  /**
   * Copies the rendered image data from the canvas to the given destination buffer.
   */
  getImageData(
    scale: number,
    xInDst: number,
    yInDst: number,
    dst: Uint8Array,
    dstStride: number,
  ): void;
  /**
   * Removes the renderer's canvas from the DOM and does any other needed cleanup.
   */
  destroy(): void;

  setHeadroomLog2(headroomLog2: number, nits: number): void;
  setSimulatedHeadroomLog2?(simulatedHeadroomLog2: number): void;
}
