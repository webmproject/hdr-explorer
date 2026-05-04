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

/**
 * @fileoverview Utility for extracting AGTM metadata from ICC profiles.
 */

import {AgtmMetadata} from './color_helpers/agtm';
import {parseAgtm} from './agtm_parser';
import {Bitstream} from './bitstream';
import {ImageTabs} from 'upng-js';
import * as upng from 'upng-js';

// The UPNG type definitions currently don't have the iCCP tag yet.
declare interface ExtendedImageTabs extends ImageTabs {
  iCCP?: Uint8Array;
}

/** Extracts the ICC profile from a PNG file. */
export function getIccFromPng(png: Uint8Array): Uint8Array | null {
  try {
    const image = upng.decode(png.slice().buffer);
    if (!image.tabs) {
      return null;
    }
    // Cast because the type definition does not have the iCCP tag.
    const tabs = image.tabs as ExtendedImageTabs;
    if (tabs?.iCCP) {
      return new Uint8Array(tabs.iCCP);
    }
  } catch (e) {
    console.error('Error decoding PNG for iCCP:', e);
  }
  return null;
}

/** Extracts the AGTM metadata from an ICC profile. */
export function getAgtmFromIcc(icc: Uint8Array): AgtmMetadata | null {
  const tagData = findAdgcTagRaw(icc);
  if (!tagData) {
    console.error('ADGC tag not found in ICC profile');
    return null;
  }

  // Skip the 8-byte 'data' header.
  let adgcData = tagData;
  if (tagData.length >= 8 && matchString(tagData, /*offset=*/ 0, 'data')) {
    adgcData = tagData.slice(8);
  }

  try {
    const stream = new Bitstream(adgcData);
    return parseAgtm(stream);
  } catch (e) {
    console.error(e);
    return null;
  }
}

function findAdgcTagRaw(data: Uint8Array): Uint8Array | null {
  if (data.length < 132) {
    console.error('data.length < 132');
    return null;
  }

  // ICC Profile Signature check: bytes 36..40 should be 'acsp'.
  if (!matchString(data, 36, 'acsp')) {
    console.error(
      `Could not find 'acsp' in data[36..40] ${data[36]} ${data[37]} ${data[38]} ${data[39]}`,
    );
    return null;
  }

  const dataView = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const tagCount = dataView.getUint32(128, false);
  const tagTableOffset = 132;

  if (data.length < tagTableOffset + tagCount * 12) {
    console.error('data.length < tagTableOffset + tagCount * 12');
    return null;
  }

  for (let i = 0; i < tagCount; i++) {
    const entryOffset = tagTableOffset + i * 12;
    if (matchString(data, entryOffset, 'ADGC')) {
      const offset = dataView.getUint32(entryOffset + 4, false);
      const size = dataView.getUint32(entryOffset + 8, false);

      if (offset + size <= data.length) {
        return data.slice(offset, offset + size);
      }
    }
  }

  return null;
}

function matchString(data: Uint8Array, offset: number, expected: string): boolean {
  if (offset + expected.length > data.length) return false;
  for (let i = 0; i < expected.length; i++) {
    if (data[offset + i] !== expected.charCodeAt(i)) return false;
  }
  return true;
}
