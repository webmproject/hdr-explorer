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
import {
  PRIMARIES_REC2020,
  PRIMARIES_SRGB,
  TRANSFER_PQ,
  TRANSFER_SRGB,
} from './color_helpers/color_functions';
import {Hdr10pMetadata} from './color_helpers/hdr10p';
import {getAgtmFromIcc, getIccFromPng} from './icc';
import {
  getAgtmMetadata,
  getCicp,
  getFirstVideoTrack,
  getLastMp4ParseError,
  getLastWebmParseError,
  getSmpte209440Metadata,
  ParsedMedia,
  parseMp4,
  parseWebm,
} from './media_parser';

export interface MediaMetadata {
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
  parsedMedia: ParsedMedia | null;
  parseError?: string | null;
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
  parsedMedia: ParsedMedia | null,
  parseError: string | null,
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
    parsedMedia,
    parseError,
  });
}

const videoFrameCallbackHandles = new WeakMap<HTMLVideoElement, number>();

function getDefaultVideoMetadata(): MediaMetadata {
  return {
    transferCharacteristics: TRANSFER_PQ,
    colourPrimaries: PRIMARIES_REC2020,
    hdr10pMetadata: null,
    hdr10pMetadataText: null,
    agtmMetadata: null,
    agtmMetadataText: null,
  };
}

function getDefaultImageMetadata(): MediaMetadata {
  return {
    transferCharacteristics: TRANSFER_SRGB,
    colourPrimaries: PRIMARIES_SRGB,
    hdr10pMetadata: null,
    hdr10pMetadataText: null,
    agtmMetadata: null,
    agtmMetadataText: null,
  };
}

function videoOnFrameCallback(
  videoEl: HTMLVideoElement,
  isVideoElOwnedByCaller: boolean,
  parsedMedia: ParsedMedia | null,
  parseError: string | null,
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
        parsedMedia,
        parseError,
        arrayBuffer,
        decodedMediaCallback,
      ),
    );
    if (isVideoElOwnedByCaller) {
      videoFrameCallbackHandles.set(videoEl, handle);
    }
    const metadata: MediaMetadata = parsedMedia
      ? readMetadata(parsedMedia, videoEl.currentTime, /* isImage= */ false)
      : getDefaultVideoMetadata();
    await onImageBitmapSource(
      videoEl,
      metadata,
      arrayBuffer,
      parsedMedia,
      parseError,
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

function readMetadata(
  parsedMedia: ParsedMedia,
  videoTime: number,
  isImage: boolean,
): MediaMetadata {
  const metadata: MediaMetadata = isImage
    ? getDefaultImageMetadata()
    : getDefaultVideoMetadata();
  const cicp = getCicp(parsedMedia);
  if (cicp) {
    if (cicp.transferCharacteristics) {
      metadata.transferCharacteristics = cicp.transferCharacteristics;
    }
    if (cicp.colourPrimaries) {
      metadata.colourPrimaries = cicp.colourPrimaries;
    }
  }
  const hdr10pMetadata = getSmpte209440Metadata(parsedMedia, videoTime);
  const agtmMetadata = getAgtmMetadata(parsedMedia, videoTime);
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

export const IMAGE_EXTENSIONS = new Set([
  'avif',
  'png',
  'jpg',
  'jpeg',
  'heic',
  'heif',
  'webp',
  'gif',
  'bmp',
]);

export function isImageFilename(filename: string): boolean {
  const extension = filename.split('.').pop()?.toLowerCase();
  return extension ? IMAGE_EXTENSIONS.has(extension) : false;
}

const EXTENSION_TO_MIME_TYPE: Record<string, string> = {
  'avif': 'image/avif',
  'png': 'image/png',
  'jpg': 'image/jpeg',
  'jpeg': 'image/jpeg',
  'webp': 'image/webp',
  'gif': 'image/gif',
  'bmp': 'image/bmp',
  'heic': 'image/heic',
  'heif': 'image/heif',
  'mp4': 'video/mp4',
  'webm': 'video/webm',
};

/**
 * Ensures the blob has a MIME type, if the filename is known.
 * Useful for tests which would otherwise fail with
 * 'Failed to decode media: Error: unsafe blob MIME type: null'.
 */
function ensureTypedBlob(blob: Blob, filename: string): Blob {
  const extension = filename.split('.').pop()?.toLowerCase();
  const knownMimeType = extension ? EXTENSION_TO_MIME_TYPE[extension] : null;
  if (!knownMimeType) {
    return blob;
  }
  if (
    !blob.type ||
    blob.type === 'null' ||
    blob.type === 'application/octet-stream' ||
    !blob.type.includes('/')
  ) {
    return new Blob([blob], {type: knownMimeType});
  }
  return blob;
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

  fileBlob = ensureTypedBlob(fileBlob, filename);
  const extension = filename.split('.').pop()?.toLowerCase();
  const isImage = isImageFilename(filename);

  const url = objectUrlFromSafeSource(fileBlob);

  // ArrayBuffer used to decode metadata from videos or AVIF files..
  const fileArrayBuffer: ArrayBuffer = await readFileAsArrayBuffer(fileBlob);

  const isMatroska = extension === 'webm' || extension === 'mkv';
  let parseError: string | null = null;
  let parsedMedia: ParsedMedia | null = null;
  // Parse the video container for videos and AVIF files.
  if (!isImage || extension === 'avif') {
    parsedMedia = isMatroska
      ? parseWebm(fileArrayBuffer)
      : parseMp4(fileArrayBuffer);
    if (!parsedMedia) {
      const err = isMatroska ? getLastWebmParseError() : getLastMp4ParseError();
      const detail =
        err instanceof Error ? err.message : err ? String(err) : '';
      parseError = `Failed to parse ${isMatroska ? 'WebM' : 'MP4'} metadata${
        detail ? `: ${detail}` : ''
      }`;
    }
  }
  if (parsedMedia) {
    console.debug('Parsed Video:', parsedMedia);
  }

  if (isImage) {
    const myImageEl = await loadImage(url, imageEl);
    const metadata: MediaMetadata = parsedMedia
      ? readMetadata(parsedMedia, 0, /* isImage= */ true)
      : getDefaultImageMetadata();
    if (extension === 'png') {
      const icc = getIccFromPng(new Uint8Array(fileArrayBuffer));
      const agtm = icc ? getAgtmFromIcc(icc) : null;
      console.log('Loaded AGTM from ICC: ', agtm);
      if (agtm) {
        metadata.agtmMetadata = agtm;
      }
    }
    await onImageBitmapSource(
      myImageEl,
      metadata,
      fileArrayBuffer,
      parsedMedia,
      parseError,
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
        parsedMedia,
        parseError,
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

  if (!media.parsedMedia) {
    if (media.type === 'image') {
      info += 'Image File.\n';
      if (media.parseError) {
        info += `Error: ${media.parseError}\n`;
      }
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
      info += media.parseError
        ? `Error: ${media.parseError}\n`
        : 'No parsed media info available.';
    }
    return info;
  }
  const parsed = media.parsedMedia;

  info += `Container: ${parsed.containerType}\n`;
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
      info += `Metadata: ${type}`;
      if (type === 'CICP') {
        info += ` ${meta.colourPrimaries}/${meta.transferCharacteristics}/${meta.matrixCoefficients}\n`;
      } else {
        info += ` (from ${meta.source}), ${meta.frames.length} samples\n`;
        if (meta.overridenMetadata) {
          const overriddenMeta = meta.overridenMetadata;
          const overridenMetaTrack =
            parsed.tracks[overriddenMeta.sourceTrackId];
          info += `Metadata: ${type} (from ${overriddenMeta.source}) [ignored in favor of container metadata], ${overriddenMeta.frames.length} samples\n`;
        }
      }
    }
  }

  if (Object.keys(parsed.tracks).length > 0) {
    info += '\nTracks:\n';
    for (const trackId in parsed.tracks) {
      if (!Object.prototype.hasOwnProperty.call(parsed.tracks, trackId))
        continue;
      const track = parsed.tracks[trackId];
      info += `  - ID: ${track.id}, Type: ${track.handlerType}, Codec: ${track.codec}, Samples: ${track.samples.length}\n`;
      const trackReferences = track.trackReferences;
      if (trackReferences && Object.keys(trackReferences).length > 0) {
        for (const refType in trackReferences) {
          if (!Object.prototype.hasOwnProperty.call(trackReferences, refType))
            continue;
          const refTrackIds = trackReferences[refType];
          info += `    - Track Reference: type '${refType}', ID: ${refTrackIds.join(', ')}\n`;
        }
      }
    }
  }

  return info || 'No relevant metadata found.';
}
