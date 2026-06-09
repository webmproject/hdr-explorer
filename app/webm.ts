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

import {DataStream} from './bitstream';

type EbmlElementConstructor<T extends EbmlElement> = new (
  id: number,
  size: number,
  offset: number,
) => T;

/**
 * A variable-size integer (VINT) as defined by the EBML specification.
 * https://github.com/ietf-wg-cellar/ebml-specification/blob/master/specification.markdown#variable-size-integer
 */
interface VarInt {
  /** The whole var-int representation, including VINT_WIDTH/VINT_MARKER. */
  encodedValue: number;
  /** The actual value of the VINT, without the VINT_WIDTH/VINT_MARKER. */
  value: number;
  numBytes: number;
  /** Whether the VINT_DATA is all 1s. For an Element Size, this means the size*/
  isAllOnes: boolean;
}

/**
 * EBML Reader class utilizing Cider's `DataStream` for tracking offsets.
 */
export class EbmlReader {
  constructor(public readonly stream: DataStream) {}

  get position(): number {
    return this.stream.position;
  }

  set position(newPos: number) {
    this.stream.position = newPos;
  }

  atEos(): boolean {
    return this.stream.remaining <= 0;
  }

  readVariableSizeInteger(): VarInt | null {
    if (this.atEos()) return null;
    const firstByte = this.stream.readUint8();
    let numBytes = 0;
    let mask = 0;
    const thresholds = [128, 64, 32, 16, 8, 4, 2, 1];
    for (let i = 0; i < thresholds.length; i++) {
      if (firstByte >= thresholds[i]) {
        numBytes = i + 1;
        mask = thresholds[i];
        break;
      }
    }
    if (numBytes === 0) {
      return null;
    }

    if (this.stream.position + numBytes > this.stream.size) return null;
    let encodedValue = firstByte;
    let value = firstByte - mask;
    for (let i = 1; i < numBytes; i++) {
      const byte = this.stream.readUint8();
      value = (value << 8) + byte;
      encodedValue = (encodedValue << 8) + byte;
    }

    let isAllOnes = true;
    if (firstByte !== mask * 2 - 1) {
      isAllOnes = false;
    } else {
      const startPos = this.stream.position - numBytes;
      for (let i = 1; i < numBytes; i++) {
        if (this.stream.view.getUint8(startPos + i) !== 0xff) {
          isAllOnes = false;
          break;
        }
      }
    }

    return {encodedValue, value, numBytes, isAllOnes};
  }

  readUint(size: number): number {
    let val = 0;
    for (let i = 0; i < size; i++) {
      val = (val << 8) + this.stream.readUint8();
    }
    return val;
  }

  readString(size: number): string {
    const str = this.stream.readString(size);
    // Remove everything after the first null byte, if any.
    // https://github.com/ietf-wg-cellar/ebml-specification/blob/master/specification.markdown#terminating-elements
    return str.replace(/\0.*$/, '');
  }

  readFloat(size: number): number {
    if (size === 4) {
      return this.stream.readFloat32();
    } else if (size === 8) {
      return this.stream.readFloat64();
    }
    return 0;
  }

  readBytes(size: number): Uint8Array {
    return this.stream.readUint8Array(size);
  }

  skip(size: number) {
    this.stream.skip(size);
  }

  subReader(size: number): EbmlReader {
    return new EbmlReader(this.stream.subStream(size));
  }
}

export const ID_EBML = 0x1a45dfa3;
export const ID_SEGMENT = 0x18538067;
export const ID_INFO = 0x1549a966;
export const ID_TIMECODE_SCALE = 0x2ad7b1;
export const ID_DURATION = 0x4489;
export const ID_TRACKS = 0x1654ae6b;
export const ID_TRACK_ENTRY = 0xae;
export const ID_TRACK_NUMBER = 0xd7;
export const ID_TRACK_TYPE = 0x83;
export const ID_DEFAULT_DURATION = 0x23e383;
export const ID_CODEC_ID = 0x86;
export const ID_VIDEO = 0xe0;
export const ID_COLOUR = 0x55b0;
export const ID_COLOUR_PRIMARIES = 0x55bb;
export const ID_COLOUR_TRANSFER = 0x55ba;
export const ID_COLOUR_MATRIX = 0x55b1;
export const ID_COLOUR_RANGE = 0x55b9;
export const ID_CLUSTER = 0x1f43b675;
export const ID_CLUSTER_TIMECODE = 0xe7;
export const ID_SIMPLE_BLOCK = 0xa3;
export const ID_BLOCK_GROUP = 0xa0;
export const ID_BLOCK = 0xa1;
export const ID_BLOCK_DURATION = 0x9b;
export const ID_BLOCK_ADDITIONS = 0x75a1;
export const ID_BLOCK_MORE = 0xa6;
export const ID_BLOCK_ADD_ID = 0xee;
export const ID_BLOCK_ADDITIONAL = 0xa5;
export const ID_REFERENCE_BLOCK = 0xfb;

export abstract class EbmlElement {
  constructor(
    public readonly id: number,
    public readonly size: number,
    public readonly offset: number,
  ) {}

  abstract parseContent(reader: EbmlReader): void;
}

export function findEbmlElement<T extends EbmlElement>(
  elements: EbmlElement[],
  id: number,
  expectedType: EbmlElementConstructor<T>,
): T | null {
  return elements.find((el) => elementIsOfType(el, id, expectedType)) ?? null;
}

export class EbmlMasterElement extends EbmlElement {
  readonly children: EbmlElement[] = [];

  override parseContent(reader: EbmlReader) {
    while (!reader.atEos()) {
      const child = parseEbmlElement(reader);
      if (!child) break;
      this.children.push(child);
    }
  }

  getChild<T extends EbmlElement>(
    id: number,
    expectedType: EbmlElementConstructor<T>,
  ): T | null {
    return findEbmlElement(this.children, id, expectedType);
  }

  getDescendant<T extends EbmlElement>(
    id: number,
    expectedType: EbmlElementConstructor<T>,
  ): T | null {
    for (const child of this.children) {
      if (elementIsOfType(child, id, expectedType)) {
        return child;
      }
      if (child instanceof EbmlMasterElement) {
        const desc = child.getDescendant(id, expectedType);
        if (desc) return desc;
      }
    }
    return null;
  }
}

export class EbmlUintElement extends EbmlElement {
  value = 0;
  override parseContent(reader: EbmlReader) {
    this.value = reader.readUint(this.size);
  }
}

export class EbmlFloatElement extends EbmlElement {
  value = 0;
  override parseContent(reader: EbmlReader) {
    this.value = reader.readFloat(this.size);
  }
}

export class EbmlStringElement extends EbmlElement {
  value = '';
  override parseContent(reader: EbmlReader) {
    this.value = reader.readString(this.size);
  }
}

export class EbmlBinaryElement extends EbmlElement {
  data: Uint8Array = new Uint8Array(0);
  override parseContent(reader: EbmlReader) {
    this.data = reader.readBytes(this.size);
  }
}

export class EbmlBlockElement extends EbmlElement {
  trackNum = 0;
  timecode = 0;
  flags = 0;
  data: Uint8Array = new Uint8Array(0);

  override parseContent(reader: EbmlReader) {
    const startPos = reader.position;
    this.trackNum = reader.readVariableSizeInteger()?.value ?? 0;
    const tc1 = reader.readUint(1);
    const tc2 = reader.readUint(1);
    this.timecode = (tc1 << 8) | tc2;
    if (this.timecode & 0x8000) {
      this.timecode -= 0x10000;
    }
    this.flags = reader.readUint(1);
    const bytesRead = reader.position - startPos;
    this.data = reader.readBytes(this.size - bytesRead);
  }
}

// EBML id to element type.
const EBML_SCHEMA: {
  [id: number]: new (id: number, size: number, offset: number) => EbmlElement;
} = {
  [ID_EBML]: EbmlMasterElement,
  [ID_SEGMENT]: EbmlMasterElement,
  [ID_INFO]: EbmlMasterElement,
  [ID_TIMECODE_SCALE]: EbmlUintElement,
  [ID_DURATION]: EbmlFloatElement,
  [ID_TRACKS]: EbmlMasterElement,
  [ID_TRACK_ENTRY]: EbmlMasterElement,
  [ID_TRACK_NUMBER]: EbmlUintElement,
  [ID_TRACK_TYPE]: EbmlUintElement,
  [ID_DEFAULT_DURATION]: EbmlUintElement,
  [ID_CODEC_ID]: EbmlStringElement,
  [ID_VIDEO]: EbmlMasterElement,
  [ID_COLOUR]: EbmlMasterElement,
  [ID_COLOUR_PRIMARIES]: EbmlUintElement,
  [ID_COLOUR_TRANSFER]: EbmlUintElement,
  [ID_COLOUR_MATRIX]: EbmlUintElement,
  [ID_COLOUR_RANGE]: EbmlUintElement,
  [ID_CLUSTER]: EbmlMasterElement,
  [ID_CLUSTER_TIMECODE]: EbmlUintElement,
  [ID_SIMPLE_BLOCK]: EbmlBlockElement,
  [ID_BLOCK_GROUP]: EbmlMasterElement,
  [ID_BLOCK]: EbmlBlockElement,
  [ID_BLOCK_DURATION]: EbmlUintElement,
  [ID_BLOCK_ADDITIONS]: EbmlMasterElement,
  [ID_BLOCK_MORE]: EbmlMasterElement,
  [ID_BLOCK_ADD_ID]: EbmlUintElement,
  [ID_BLOCK_ADDITIONAL]: EbmlBinaryElement,
  [ID_REFERENCE_BLOCK]: EbmlUintElement,
};

export function elementIsOfType<T extends EbmlElement>(
  ebml: EbmlElement,
  id: number,
  expectedType: EbmlElementConstructor<T>,
): ebml is T {
  if (expectedType != EBML_SCHEMA[id]) {
    throw new Error(`EBML schema mismatch for ID ${id}`);
  }
  return ebml.id === id && ebml instanceof expectedType;
}

function getEbmlConstructorForType(id: number) {
  return EBML_SCHEMA[id] || EbmlBinaryElement;
}

export function parseEbml(arrayBuffer: ArrayBuffer): EbmlElement[] {
  const stream = new DataStream(new DataView(arrayBuffer));
  const reader = new EbmlReader(stream);
  const elements: EbmlElement[] = [];
  while (!reader.atEos()) {
    const el = parseEbmlElement(reader);
    if (!el) break;
    elements.push(el);
  }
  return elements;
}

function parseEbmlElement(reader: EbmlReader): EbmlElement | null {
  // See EBML speccification
  // https://github.com/ietf-wg-cellar/ebml-specification/blob/master/specification.markdown
  const idVarInt = reader.readVariableSizeInteger();
  if (idVarInt === null || idVarInt.value === 0 || idVarInt.isAllOnes) {
    return null;
  }
  const id = idVarInt.encodedValue;
  const sizeVarInt = reader.readVariableSizeInteger();
  if (sizeVarInt === null) return null;

  const offset = reader.position;
  const elementConstructor = getEbmlConstructorForType(id);
  const payloadSize = sizeVarInt.isAllOnes
    ? reader.stream.remaining
    : sizeVarInt.value;
  const element = new elementConstructor(id, payloadSize, offset);
  element.parseContent(reader.subReader(payloadSize));
  return element;
}
