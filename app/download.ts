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

import {objectUrlFromSafeSource, setAnchorHref} from 'safevalues/dom';
import * as upng from 'upng-js';

/**
 * Returns the basename of the given filename without the extension.
 * @param filename The filename to get the basename from.
 */
export function basenameWithoutExtension(filename: string): string {
  const basename = filename.split('/').pop() || '';
  const lastDotIndex = basename.lastIndexOf('.');
  // If there's no dot, or if the dot is the first character (e.g., ".bashrc"),
  // return the basename as is.
  if (lastDotIndex <= 0) return basename;
  return basename.substring(0, lastDotIndex);
}

function getPixelChannel(
  data: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
  c: number,
): number {
  x = Math.max(0, Math.min(width - 1, x));
  y = Math.max(0, Math.min(height - 1, y));
  return data[(y * width + x) * 4 + c];
}

function resize(
  frame: Uint8Array,
  fromWidth: number,
  fromHeight: number,
  toWidth: number,
  toHeight: number,
): Uint8Array {
  const result = new Uint8Array(toWidth * toHeight * 4);
  const xRatio = fromWidth / toWidth;
  const yRatio = fromHeight / toHeight;

  for (let y = 0; y < toHeight; ++y) {
    for (let x = 0; x < toWidth; ++x) {
      const srcX = (x + 0.5) * xRatio - 0.5;
      const srcY = (y + 0.5) * yRatio - 0.5;

      const x1 = Math.floor(srcX);
      const y1 = Math.floor(srcY);
      const x2 = x1 + 1;
      const y2 = y1 + 1;

      const dx = srcX - x1;
      const dy = srcY - y1;

      const dstOffset = (y * toWidth + x) * 4;

      for (let c = 0; c < 3; ++c) {
        const p11 = getPixelChannel(frame, fromWidth, fromHeight, x1, y1, c);
        const p21 = getPixelChannel(frame, fromWidth, fromHeight, x2, y1, c);
        const p12 = getPixelChannel(frame, fromWidth, fromHeight, x1, y2, c);
        const p22 = getPixelChannel(frame, fromWidth, fromHeight, x2, y2, c);

        const val =
          p11 * (1 - dx) * (1 - dy) +
          p21 * dx * (1 - dy) +
          p12 * (1 - dx) * dy +
          p22 * dx * dy;
        result[dstOffset + c] = Math.round(val);
      }
      result[dstOffset + 3] = 255; // Opaque.
    }
  }
  return result;
}

/**
 * Downloads the given URL to the user's computer.
 * @param url The URL to download.
 * @param filename The filename to use for the downloaded file.
 * @param mimeType The MIME type of the file to download. If not provided, the
 *     MIME type will be determined automatically.
 */
export function download(
  url: string | string,
  filename: string,
  mimeType?: string,
) {
  const downloadLink = document.createElement('a');
  downloadLink.download = filename;
  setAnchorHref(downloadLink, url);
  if (mimeType) {
    downloadLink.dataset['downloadurl'] = [
      mimeType,
      downloadLink.download,
      downloadLink.href,
    ].join(':');
  }
  document.body.appendChild(downloadLink);
  downloadLink.click();
  document.body.removeChild(downloadLink);
}

/**
 * Downloads the given blob to the user's computer.
 * @param blob The blob to download.
 * @param filename The filename to use for the downloaded file.
 */
export function downloadBlob(blob: Blob, filename: string) {
  const url = objectUrlFromSafeSource(blob);
  download(url, filename);
  URL.revokeObjectURL(url.toString());
}

function downloadBuffer(
  buffer: ArrayBuffer,
  filename: string,
  mimeType: string,
) {
  downloadBlob(new Blob([buffer], {type: mimeType}), filename);
}

/**
 * Downloads the given frames as APNG frames to the user's computer.
 * @param frames The frames to download.
 * @param filenameWithoutExtension The filename to use for the downloaded file.
 *     The extension will be set to .png.
 * @param width The width of the frames.
 * @param height The height of the frames.
 */
export function downloadApng(
  frames: Uint8Array[],
  filenameWithoutExtension: string,
  width: number,
  height: number,
) {
  // Make the output file smaller by reducing its resolution below 1MP.
  let finalWidth = width;
  let finalHeight = height;
  while (finalWidth * finalHeight > 1024 * 1024) {
    if (finalWidth > finalHeight) {
      finalWidth = Math.floor(finalWidth / 2);
      finalHeight = Math.max(1, Math.round((height * finalWidth) / width));
    } else {
      finalHeight = Math.floor(finalHeight / 2);
      finalWidth = Math.max(1, Math.round((width * finalHeight) / height));
    }
  }
  if (finalWidth !== width || finalHeight !== height) {
    for (let i = 0; i < frames.length; ++i) {
      frames[i] = resize(frames[i], width, height, finalWidth, finalHeight);
    }
    width = finalWidth;
    height = finalHeight;
  }

  const numFrames = frames.length;
  const durations = [];
  durations.push(1000); // First frame stays longer.
  for (let i = 1; i < numFrames - 1; ++i) {
    durations.push(10);
  }
  durations.push(1000); // Last frame stays longer.
  for (let i = 1; i < numFrames - 1; ++i) {
    // Mirror the animation.
    frames.push(frames[numFrames - i - 1]);
    durations.push(10);
  }
  const cnum = 0; // 0 means lossless.
  const arrayBuffers = frames.map((frame) => frame.slice().buffer);
  const buffer = upng.encode(arrayBuffers, width, height, cnum, durations);
  // Google Slides does not support the .apng extension.
  // objectUrlFromSafeSource will reject a mime type of 'image/apng' as
  // it considers it unsafe, so use octet-stream instead.
  downloadBuffer(
    buffer,
    `${filenameWithoutExtension}.png`,
    'application/octet-stream',
  );
}
