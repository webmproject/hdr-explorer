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
  valueWithMarker: bigint;
  /** The actual value of the VINT, without the VINT_WIDTH/VINT_MARKER. */
  value: bigint;
  numBytes: number;
  /** Whether the VINT_DATA is all 1s. For an Element Size, this means the size*/
  isAllOnes: boolean;
}

/**
 * EBML Reader class utilizing Cider's `DataStream` for tracking offsets.
 */
export class EbmlStream extends DataStream {
  readVariableSizeInteger(): VarInt | null {
    if (this.atEos()) return null;
    const firstByte = this.readUint8();
    let numBytes = 0;
    let mask = 0x80;
    for (let i = 1; i <= 8; i++) {
      if (firstByte >= mask) {
        numBytes = i;
        break;
      }
      mask >>= 1;
    }
    if (numBytes === 0) {
      return null;
    }

    if (this.position + numBytes > this.size) return null;
    let valueWithMarker = BigInt(firstByte);
    let value = BigInt(firstByte) - BigInt(mask);
    for (let i = 1; i < numBytes; i++) {
      const byte = this.readUint8();
      value = (value << BigInt(8)) + BigInt(byte);
      valueWithMarker = (valueWithMarker << BigInt(8)) + BigInt(byte);
    }

    let isAllOnes = true;
    if (firstByte !== mask * 2 - 1) {
      isAllOnes = false;
    } else {
      const startPos = this.position - numBytes;
      for (let i = 1; i < numBytes; i++) {
        if (this.view.getUint8(startPos + i) !== 0xff) {
          isAllOnes = false;
          break;
        }
      }
    }

    return {valueWithMarker, value, numBytes, isAllOnes};
  }

  /**
   * Writes a number as a variable-size integer (VINT).
   * https://github.com/ietf-wg-cellar/ebml-specification/blob/master/specification.markdown#variable-size-integer
   */
  writeVarInt(val: number | bigint) {
    const v = BigInt(val);
    let numBytes = getVarIntLength(v);
    if (numBytes === 0) numBytes = 8;

    const marker = BigInt(1) << BigInt(8 - numBytes);
    const firstByte = Number(marker | (v >> BigInt(8 * (numBytes - 1))));
    this.writeUint8(firstByte);
    for (let i = numBytes - 2; i >= 0; i--) {
      this.writeUint8(Number((v >> BigInt(8 * i)) & BigInt(0xff)));
    }
  }

  readUint(size: number): bigint {
    let val = BigInt(0);
    for (let i = 0; i < size; i++) {
      val = (val << BigInt(8)) + BigInt(this.readUint8());
    }
    return val;
  }

  writeUint(val: bigint | number, size: number): void {
    const v = BigInt(val);
    for (let i = size - 1; i >= 0; i--) {
      this.writeUint8(Number((v >> BigInt(i * 8)) & BigInt(0xff)));
    }
  }

  override readString(size: number): string {
    const str = super.readString(size);
    // Remove everything after the first null byte, if any.
    // https://github.com/ietf-wg-cellar/ebml-specification/blob/master/specification.markdown#terminating-elements
    return str.replace(/\0.*$/, '');
  }

  readFloat(size: number): number {
    if (size === 4) {
      return this.readFloat32();
    } else if (size === 8) {
      return this.readFloat64();
    }
    return 0;
  }

  readBytes(size: number): Uint8Array {
    return this.readUint8Array(size);
  }

  subEbmlStream(size: number): EbmlStream {
    return new EbmlStream(this.subStream(size).view);
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

/**
 * Returns the number of bytes required to write the given number.
 */
export function getUintLength(val: number | bigint): number {
  const v = BigInt(val);
  for (let i = 1; i <= 8; i++) {
    if (v < BigInt(1) << BigInt(8 * i)) {
      return i;
    }
  }
  return 8;
}

/**
 * Returns the number of bytes required to write the given number as a
 * variable-size integer (VINT).
 * https://github.com/ietf-wg-cellar/ebml-specification/blob/master/specification.markdown#variable-size-integer
 */
export function getVarIntLength(val: number | bigint): number {
  const v = BigInt(val);
  for (let i = 1; i <= 8; i++) {
    if (v < (BigInt(1) << BigInt(7 * i)) - BigInt(1)) {
      return i;
    }
  }
  return 8;
}

/**
 * Converts a bigint to a number, logging a warning if precision is lost.
 * Returns undefined if the input is null or undefined.
 */
export function bigintToNumber(
  val: bigint | undefined | null,
): number | undefined {
  if (val === undefined || val === null) return undefined;
  if (
    val > BigInt(Number.MAX_SAFE_INTEGER) ||
    val < BigInt(Number.MIN_SAFE_INTEGER)
  ) {
    console.warn(
      `BigInt ${val} is outside safe Number range, precision may be lost.`,
    );
  }
  return Number(val);
}

export abstract class EbmlElement {
  constructor(
    /** EBML ID of the element (i.e. the element type). */
    public readonly id: number,
    /** Size of the payload, excluding the ID and size. */
    public size: number = 0,
    /** Offset in the stream. Set when parsing, not used at writing time. */
    public readonly offset: number = 0,
  ) {}

  abstract parseContent(stream: EbmlStream): void;
  abstract getContentSize(): number;
  abstract writeContent(stream: EbmlStream): void;

  updateSize() {
    this.size = this.getContentSize();
  }

  getTotalSize(): number {
    const payloadSize = this.size;
    const idLen = getUintLength(this.id);
    const sizeLen = getVarIntLength(payloadSize);
    return idLen + sizeLen + payloadSize;
  }

  writeElement(stream: EbmlStream) {
    stream.writeUint(this.id, getUintLength(this.id));
    stream.writeVarInt(this.size);
    this.writeContent(stream);
  }
}

export function findEbmlElement<T extends EbmlElement>(
  elements: EbmlElement[],
  id: number,
  expectedType: EbmlElementConstructor<T>,
): T | null {
  return elements.find((el) => elementIsOfType(el, id, expectedType)) ?? null;
}

export class EbmlMasterElement extends EbmlElement {
  children: EbmlElement[] = [];

  override parseContent(stream: EbmlStream) {
    while (!stream.atEos()) {
      const child = parseEbmlElement(stream);
      if (!child) break;
      this.children.push(child);
    }
  }

  override getContentSize(): number {
    let sum = 0;
    for (const child of this.children) {
      child.updateSize();
      sum += child.getTotalSize();
    }
    return sum;
  }

  override writeContent(stream: EbmlStream) {
    for (const child of this.children) {
      child.writeElement(stream);
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
  value = BigInt(0);
  override parseContent(stream: EbmlStream) {
    this.value = stream.readUint(this.size);
  }
  override getContentSize(): number {
    return this.size;
  }
  override writeContent(stream: EbmlStream) {
    stream.writeUint(this.value, this.size);
  }
}

export class EbmlFloatElement extends EbmlElement {
  value = 0;
  override parseContent(stream: EbmlStream) {
    this.value = stream.readFloat(this.size);
  }
  override getContentSize(): number {
    return this.size;
  }
  override writeContent(stream: EbmlStream) {
    if (this.size === 4) {
      stream.writeFloat32(this.value);
    } else if (this.size === 8) {
      stream.writeFloat64(this.value);
    }
  }
}

export class EbmlStringElement extends EbmlElement {
  value = '';
  override parseContent(stream: EbmlStream) {
    this.value = stream.readString(this.size);
  }
  override getContentSize(): number {
    const encoder = new TextEncoder();
    const bytes = encoder.encode(this.value);
    return bytes.length;
  }
  override writeContent(stream: EbmlStream) {
    const encoder = new TextEncoder();
    const bytes = encoder.encode(this.value);
    stream.writeUint8Array(bytes);
  }
}

export class EbmlBinaryElement extends EbmlElement {
  data: Uint8Array = new Uint8Array(0);
  override parseContent(stream: EbmlStream) {
    this.data = stream.readBytes(this.size);
  }
  override getContentSize(): number {
    return this.data.length;
  }
  override writeContent(stream: EbmlStream) {
    stream.writeUint8Array(this.data);
  }
}

export class EbmlBlockElement extends EbmlElement {
  trackNum = BigInt(0);
  timecode = 0;
  flags = 0;
  data: Uint8Array = new Uint8Array(0);

  override parseContent(stream: EbmlStream) {
    // See https://datatracker.ietf.org/doc/html/rfc9559#name-block-structure
    const startPos = stream.position;
    this.trackNum = stream.readVariableSizeInteger()?.value ?? BigInt(0);
    this.timecode = stream.readInt16();
    this.flags = stream.readUint8();
    const bytesRead = stream.position - startPos;
    this.data = stream.readBytes(this.size - bytesRead);
  }

  override getContentSize(): number {
    const trackLen = getVarIntLength(this.trackNum);
    return trackLen + 2 + 1 + this.data.length;
  }

  override writeContent(stream: EbmlStream) {
    stream.writeVarInt(this.trackNum);
    stream.writeInt16(this.timecode);
    stream.writeUint8(this.flags);
    stream.writeUint8Array(this.data);
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
  const stream = new EbmlStream(new DataView(arrayBuffer));
  const elements: EbmlElement[] = [];
  while (!stream.atEos()) {
    const el = parseEbmlElement(stream);
    if (!el) break;
    elements.push(el);
  }
  return elements;
}

function parseEbmlElement(stream: EbmlStream): EbmlElement | null {
  // See EBML speccification
  // https://github.com/ietf-wg-cellar/ebml-specification/blob/master/specification.markdown
  const idVarInt = stream.readVariableSizeInteger();
  if (idVarInt === null || idVarInt.value === BigInt(0) || idVarInt.isAllOnes) {
    return null;
  }
  // The EBML id is the whole var int, including the width/marker bits.
  const id = idVarInt.valueWithMarker;
  const sizeVarInt = stream.readVariableSizeInteger();
  if (sizeVarInt === null) return null;

  const offset = stream.view.byteOffset + stream.position;
  const idNumber = bigintToNumber(id) ?? 0;
  const elementConstructor = getEbmlConstructorForType(idNumber);
  const payloadSize = sizeVarInt.isAllOnes
    ? stream.remaining
    : (bigintToNumber(sizeVarInt.value) ?? 0);
  const element = new elementConstructor(idNumber, payloadSize, offset);
  element.parseContent(stream.subEbmlStream(payloadSize));
  return element;
}

/**
 * Writes the given EBML elements to an ArrayBuffer.
 * Autmomatically updates the size of each element before writing.
 */
export function writeEbml(elements: EbmlElement[]): ArrayBuffer {
  let totalSize = 0;
  for (const el of elements) {
    el.updateSize();
    totalSize += el.getTotalSize();
  }
  const buffer = new ArrayBuffer(totalSize);
  const stream = new EbmlStream(new DataView(buffer));
  for (const el of elements) {
    el.writeElement(stream);
  }
  return buffer;
}
