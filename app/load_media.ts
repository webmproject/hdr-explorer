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

import {objectUrlFromSafeSource} from 'safevalues/dom';

import {AgtmMetadata} from './color_helpers/agtm';
import {Hdr10pMetadata} from './color_helpers/hdr10p';
import {getAgtmFromIcc, getIccFromPng} from './icc';
import {getAgtmMetadata, getCicp, getSmpte209440Metadata, ParsedMp4, parseMp4, getFirstVideoTrack} from './media_parser';

interface MediaMetadata {
  transferCharacteristics: number;
  colourPrimaries: number;
  hdr10pMetadata: Hdr10pMetadata | null;
  hdr10pMetadataText: string | null;
  agtmMetadata: AgtmMetadata | null;
  agtmMetadataText: string | null;
}

export interface DecodedMedia {
  imageBitmap: ImageBitmap;
  type: 'image' | 'video';
  imageBitmapSource: HTMLImageElement | HTMLVideoElement;
  metadata: MediaMetadata | null;
  arrayBuffer: ArrayBuffer | null;
  parsedMp4: ParsedMp4 | null;
}

export async function createImageBitmapSource(
  source: HTMLImageElement | HTMLVideoElement,
): Promise<ImageBitmap> {
  const options: ImageBitmapOptions = {colorSpaceConversion: 'none'};
  return await createImageBitmap(source, options);
}

async function onImageBitmapSource(
  source: HTMLImageElement | HTMLVideoElement,
  metadata: MediaMetadata | null,
  arrayBuffer: ArrayBuffer | null,
  parsedMp4: ParsedMp4 | null,
  decodedMediaCallback: (media: DecodedMedia) => void,
) {
  const options: ImageBitmapOptions = {colorSpaceConversion: 'none'};
  const imageBitmap = await createImageBitmap(source, options);
  const type = source instanceof HTMLImageElement ? 'image' : 'video';
  decodedMediaCallback({
    arrayBuffer,
    imageBitmapSource: source,
    imageBitmap,
    metadata,
    type,
    parsedMp4,
  });
}

const videoFrameCallbackHandles = new WeakMap<HTMLVideoElement, number>();

function videoOnFrameCallback(
  videoEl: HTMLVideoElement,
  isVideoElOwnedByCaller: boolean,
  parsedMp4: ParsedMp4 | null,
  arrayBuffer: ArrayBuffer | null,
  decodedMediaCallback: (media: DecodedMedia) => void,
) {
  return async (
    now: DOMHighResTimeStamp,
    frameMetadata: VideoFrameCallbackMetadata,
  ) => {
    const handle = videoEl.requestVideoFrameCallback(
      videoOnFrameCallback(
        videoEl,
        isVideoElOwnedByCaller,
        parsedMp4,
        arrayBuffer,
        decodedMediaCallback,
      ),
    );
    if (isVideoElOwnedByCaller) {
      videoFrameCallbackHandles.set(videoEl, handle);
    }
    const metadata = parsedMp4
      ? readMetadata(parsedMp4, videoEl.currentTime)
      : null;
    await onImageBitmapSource(
      videoEl,
      metadata,
      arrayBuffer,
      parsedMp4,
      decodedMediaCallback,
    );
  };
}

function readFileAsArrayBuffer(file: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      resolve(fr.result as ArrayBuffer);
    };
    fr.onerror = (err) => {
      reject(new Error(`Failed to read file as array buffer: ${err}`));
    };
    fr.readAsArrayBuffer(file);
  });
}

function loadImage(
  url: string,
  imageEl?: HTMLImageElement,
): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = imageEl ?? new Image();
    image.onload = () => {
      resolve(image);
    };
    image.onerror = (err) => {
      reject(new Error(`Failed to load image: ${err}`));
    };
    image.src = url.toString();
  });
}

function readMetadata(parsedMp4: ParsedMp4, videoTime: number): MediaMetadata {
  const metadata: MediaMetadata = {
    transferCharacteristics: 0,
    colourPrimaries: 0,
    hdr10pMetadata: null,
    hdr10pMetadataText: null,
    agtmMetadata: null,
    agtmMetadataText: null,
  };
  const cicp = getCicp(parsedMp4);
  if (cicp) {
    metadata.transferCharacteristics = cicp.transferCharacteristics ?? 0;
    metadata.colourPrimaries = cicp.colourPrimaries ?? 0;
  }
  const hdr10pMetadata = getSmpte209440Metadata(parsedMp4, videoTime);
  const agtmMetadata = getAgtmMetadata(parsedMp4, videoTime);
  metadata.hdr10pMetadataText = JSON.stringify(hdr10pMetadata, null, 2);
  if (typeof hdr10pMetadata !== 'string') {
    metadata.hdr10pMetadata = hdr10pMetadata;
  }
  metadata.agtmMetadataText = JSON.stringify(agtmMetadata, null, 2);
  if (typeof agtmMetadata !== 'string') {
    metadata.agtmMetadata = agtmMetadata;
  }
  return metadata;
}

/**
 * Decodes the given media file and calls the decodedMediaCallback.
 * @param filename The filename of the media file.
 * @param fileBlob The blob of the media file.
 * @param decodedMediaCallback The callback to call with the decoded media.
 *     If the caller passes their own video element, and the video gets played,
 *     the callback will be called for every decoded frame.
 * @param imageEl The image element to use for images. If not provided, a new
 *     temporary image element will be created.
 * @param videoEl The video element to use for videos. If not provided, a new
 *     temporary video element will be created.
 */
export async function decodeMediaWithCallback(
  filename: string,
  fileBlob: Blob,
  decodedMediaCallback: (media: DecodedMedia) => void,
  imageEl?: HTMLImageElement,
  videoEl?: HTMLVideoElement,
) {
  // Cancel any previous callback associated with this video element.
  if (videoEl) {
    const handle = videoFrameCallbackHandles.get(videoEl);
    if (handle) {
      videoEl.cancelVideoFrameCallback(handle);
      videoFrameCallbackHandles.delete(videoEl);
    }
  }

  const extension = filename.split('.').pop()?.toLowerCase();
  const isImage =
    extension === 'avif' ||
    extension === 'png' ||
    extension === 'jpg' ||
    extension === 'jpeg' ||
    extension === 'heic' ||
    extension === 'heif';

  const url = objectUrlFromSafeSource(fileBlob);

  // ArrayBuffer used to decode metadata from videos or AVIF files..
  let fileArrayBuffer: ArrayBuffer | null = null;
  if (!isImage || (isImage && extension === 'avif')) {
    fileArrayBuffer = await readFileAsArrayBuffer(fileBlob);
  }

  const parsedMp4 = fileArrayBuffer ? parseMp4(fileArrayBuffer) : null;
  if (parsedMp4) {
    console.debug('Parsed MP4:', parsedMp4);
  }

  if (isImage) {
    const myImageEl = await loadImage(url, imageEl);
    let metadata = parsedMp4 ? readMetadata(parsedMp4, 0) : null;
    if (
      extension === 'jpg' ||
      extension === 'jpeg' ||
      extension === 'png'
    ) {
      fileArrayBuffer = await readFileAsArrayBuffer(fileBlob);
      metadata = {
        transferCharacteristics: 0,
        colourPrimaries: 0,
        hdr10pMetadata: null,
        hdr10pMetadataText: null,
        agtmMetadata: null,
        agtmMetadataText: null,
      };
      if (extension === 'png') {
        const icc = getIccFromPng(new Uint8Array(fileArrayBuffer));
        const agtm = icc ? getAgtmFromIcc(icc) : null;
        console.log('Loaded AGTM from ICC: ', agtm);
        if (agtm) {
          metadata.agtmMetadata = agtm;
        } else {
          metadata = null; // No AGTM metadata in the ICC profile.
        }
      }
    }
    await onImageBitmapSource(
      myImageEl,
      metadata,
      fileArrayBuffer,
      parsedMp4,
      decodedMediaCallback,
    );
  } else {
    // If it's not an image, assume it's a video.
    const myVideoEl = videoEl ?? document.createElement('video');
    const isVideoElOwnedByCaller = videoEl !== undefined;
    myVideoEl.currentTime = 0;
    myVideoEl.src = url.toString();
    const handle = myVideoEl.requestVideoFrameCallback(
      videoOnFrameCallback(
        myVideoEl,
        isVideoElOwnedByCaller,
        parsedMp4,
        fileArrayBuffer,
        decodedMediaCallback,
      ),
    );
    if (isVideoElOwnedByCaller) {
      videoFrameCallbackHandles.set(myVideoEl, handle);
    }
  }
}

export async function decodeMedia(
  filename: string,
  fileBlob: Blob,
): Promise<DecodedMedia> {
  return new Promise(async (resolve, reject) => {
    try {
      await decodeMediaWithCallback(
        filename,
        fileBlob,
        (media: DecodedMedia) => {
          resolve(media);
        },
      );
    } catch (error) {
      reject(new Error(`Failed to decode media: ${error}`));
    }
  });
}

export function getMediaInfoString(media: DecodedMedia): string {
  let info = '';

  if (!media.parsedMp4) {
    if (media.type === 'image') {
      info += 'Image File.\n';
      if (media.metadata) {
        if (media.metadata.colourPrimaries) {
          info += `Colour Primaries: ${media.metadata.colourPrimaries}\n`;
        }
        if (media.metadata.transferCharacteristics) {
          info += `Transfer Characteristics: ${media.metadata.transferCharacteristics}\n`;
        }
        if (media.metadata.agtmMetadata) {
          info += 'Metadata: AGTM';
        }
        if (media.metadata.hdr10pMetadata) {
          info += 'Metadata: HDR10+';
        }
      }
    } else {
      info += 'No parsed MP4 info available.';
    }
    return info;
  }
  const parsed = media.parsedMp4;

  const videoTrack = getFirstVideoTrack(parsed.tracks);
  if (videoTrack) {
    info += `Video Codec: ${videoTrack.codec}\n`;
  }

  let hasMetadata = false;
  for (const trackId in parsed.hdrMetadata) {
    for (const type in parsed.hdrMetadata[trackId]) {
      hasMetadata = true;
      const meta = parsed.hdrMetadata[trackId][type];
      const sourceTrack = parsed.tracks[meta.sourceTrackId];
      let carriage = 'unknown';
      if (sourceTrack) {
        if (sourceTrack.handlerType === 'vide') {
          carriage = 'video bitstream';
        } else if (sourceTrack.handlerType === 'meta') {
          carriage = `${sourceTrack.codec} metadata track`;
        }
      }
      info += `Metadata: ${type}`;
      if (type === 'CICP') {
        info += ` ${meta.colourPrimaries}/${meta.transferCharacteristics}/${meta.matrixCoefficients}\n`;
      } else {
        info += ` (from ${carriage}), ${meta.frames.length} samples\n`;
      }
    }
  }

  if (Object.keys(parsed.tracks).length > 0) {
    info += '\nTracks:\n';
    for (const trackId in parsed.tracks) {
      if (!Object.prototype.hasOwnProperty.call(parsed.tracks, trackId)) continue;
      const track = parsed.tracks[trackId];
      info += `  - ID: ${track.id}, Type: ${track.handlerType}, Codec: ${track.codec}, Samples: ${track.samples.length}\n`;
    }
  }

  return info || 'No relevant metadata found.';
}