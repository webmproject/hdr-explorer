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

import {Bitstream, ByteWriter, DataStream} from './bitstream';


function readBoxHeader(
    stream: DataStream,
    isTopLevelBox: boolean,
    ): {size: number; type: string; headerSize: number}|null {
  if (stream.remaining < 8) return null;
  let size = stream.readUint32();
  const type = stream.readString(4);
  let headerSize = 8;
  if (size === 1) {
    if (stream.remaining < 8) return null;
    size = Number(stream.readBigUint64());
    headerSize = 16;
  } else if (size === 0) {
    if (isTopLevelBox) {
      size = stream.remaining + 8;
    } else {
      // ISOBMFF Section 4.2.2:
      //  if size is 0, then this box shall be in a top-level box (i.e. not
      // contained in another box)
      return null;
    }
  }
  return {size, type, headerSize};
}

export abstract class Box {
  constructor(
      public type: string,  // 4cc
      public size = 0,
  ) {}

  updateSize(): void {
    const contentSize = this.getContentSize();
    let headerSize = 8;
    if (headerSize + contentSize > 0xffffffff) {
      headerSize += 8;  // largesize
    }
    this.size = headerSize + contentSize;
  }

  /**
   * Parses the content of the box, excluding the header.
   * The passed-in stream should be positioned at the start of the content,
   * and should have exactly enough bytes remaining to parse the content.
   * @param stream The data stream to parse from.
   */
  abstract parseContent(stream: DataStream): void;
  /**
   * Writes the content of the box, excluding the header.
   * @param stream The data stream to write to.
   */
  abstract writeContent(stream: DataStream): void;
  /**
   * Returns the size of the content of the box, excluding the header.
   * May call updateSize() on children boxes, if any.
   */
  abstract getContentSize(): number;
}

interface BoxConstructor {
  new(type: string, size: number): Box;
}

export function findBox<T extends Box>(
    boxes: Box[],
    type: string,
    expectedType: new (...args: never[]) => T,
    ): T|null {
  const child = boxes.find((c) => c.type === type);
  if (child instanceof expectedType) {
    return child;
  }
  return null;
}

function findBoxRecursive<T extends Box>(
    boxes: Box[],
    type: string,
    expectedType: new (...args: never[]) => T,
    ): T|null {
  for (const child of boxes) {
    if (child.type === type) {
      if (child instanceof expectedType) {
        return child;
      }
    } else if (
        child instanceof ContainerBox || child instanceof ContainerFullBox) {
      const descendant = findBoxRecursive(child.children, type, expectedType);
      if (descendant) {
        return descendant;
      }
    }
  }
  return null;
}

export class GenericBox extends Box {
  data: Uint8Array = new Uint8Array(0);

  override parseContent(stream: DataStream) {
    this.data = stream.readUint8Array(stream.remaining);
  }

  override writeContent(stream: DataStream) {
    stream.writeUint8Array(this.data);
  }
  override getContentSize(): number {
    return this.data.byteLength;
  }
}

export class FullBox extends Box {
  version = 0;
  flags = 0;

  override parseContent(stream: DataStream) {
    const vFlags = stream.readUint32();
    this.version = vFlags >> 24;
    this.flags = vFlags & 0x00ffffff;
  }
  override writeContent(stream: DataStream): void {
    stream.writeUint32((this.version << 24) | (this.flags & 0x00ffffff));
  }
  override getContentSize(): number {
    return 4;  // for version and flags
  }
}

export class ContainerBox extends Box {
  children: Box[] = [];

  getChild<T extends Box>(
      type: string,
      expectedType: new(...args: never[]) => T,
      ): T|null {
    return findBox(this.children, type, expectedType);
  }

  getDescendant<T extends Box>(
      type: string,
      expectedType: new(...args: never[]) => T,
      ): T|null {
    return findBoxRecursive(this.children, type, expectedType);
  }

  protected parseDataBeforeChildren(stream: DataStream) {}

  protected writeDataBeforeChildren(stream: DataStream) {}

  protected getContentSizeBeforeChildren(): number {
    return 0;
  }

  override parseContent(stream: DataStream) {
    this.parseDataBeforeChildren(stream);
    while (stream.remaining) {
      const child = parseBox(stream, this);
      if (!child) return;
      this.children.push(child);
    }
  }

  override writeContent(stream: DataStream) {
    this.writeDataBeforeChildren(stream);
    for (const child of this.children) {
      writeBox(child, stream);
    }
  }
  override getContentSize(): number {
    let size = this.getContentSizeBeforeChildren();
    for (const child of this.children) {
      child.updateSize();
      size += child.size;
    }
    return size;
  }
}

export class ContainerFullBox extends FullBox {
  children: Box[] = [];

  getChild<T extends Box>(
      type: string,
      expectedType: new(...args: never[]) => T,
      ): T|null {
    return findBox(this.children, type, expectedType);
  }

  getDescendant<T extends Box>(
      type: string,
      expectedType: new(...args: never[]) => T,
      ): T|null {
    return findBoxRecursive(this.children, type, expectedType);
  }

  protected parseDataBeforeChildren(stream: DataStream): void {}

  protected writeDataBeforeChildren(stream: DataStream): void {}

  protected getContentSizeBeforeChildren(): number {
    return 0;
  }

  override parseContent(stream: DataStream) {
    super.parseContent(stream);
    this.parseDataBeforeChildren(stream);
    while (stream.remaining) {
      const child = parseBox(stream, this);
      if (!child) return;
      this.children.push(child);
    }
  }

  override writeContent(stream: DataStream) {
    super.writeContent(stream);
    this.writeDataBeforeChildren(stream);
    for (const child of this.children) {
      writeBox(child, stream);
    }
  }
  override getContentSize(): number {
    let size = 4;  // for version and flags
    size += this.getContentSizeBeforeChildren();
    for (const child of this.children) {
      child.updateSize();
      size += child.size;
    }
    return size;
  }
}

export class MetaBox extends ContainerFullBox {}
export class MoovBox extends ContainerBox {}
export class TrakBox extends ContainerBox {}
export class MdiaBox extends ContainerBox {}
export class MinfBox extends ContainerBox {}
export class StblBox extends ContainerBox {}
export class EdtsBox extends ContainerBox {}

export interface EditListEntry {
  editDuration: number;
  mediaTime: number;
  // Media rate as a 16.16 fixed-point integer (16 bits each for the integer and
  // fractional part)
  mediaRateInteger: number;
  mediaRateFraction: number;
  mediaRate: number;  // Computed from mediaRateInteger and mediaRateFraction.
}

export class ElstBox extends FullBox {
  entries: EditListEntry[] = [];

  override parseContent(stream: DataStream) {
    super.parseContent(stream);
    const entryCount = stream.readUint32();
    for (let i = 0; i < entryCount; i++) {
      const editDuration = this.version === 1 ? Number(stream.readBigUint64()) :
                                                stream.readUint32();
      const mediaTime = this.version === 1 ? Number(stream.readBigInt64()) :
                                             stream.readInt32();
      const mediaRateInteger = stream.readInt16();
      const mediaRateFraction = stream.readInt16();
      this.entries.push({
        editDuration,
        mediaTime,
        mediaRateInteger,
        mediaRateFraction,
        mediaRate: mediaRateInteger + mediaRateFraction / 65536.0,
      });
    }
  }

  override writeContent(stream: DataStream): void {
    super.writeContent(stream);
    stream.writeUint32(this.entries.length);
    for (const entry of this.entries) {
      if (this.version === 1) {
        stream.writeBigUint64(BigInt(entry.editDuration));
        stream.writeBigInt64(BigInt(entry.mediaTime));
      } else {
        stream.writeUint32(entry.editDuration);
        stream.writeInt32(entry.mediaTime);
      }
      stream.writeInt16(entry.mediaRateInteger);
      stream.writeInt16(entry.mediaRateFraction);
    }
  }

  override getContentSize(): number {
    let size = super.getContentSize();
    size += 4;  // entry_count
    const entrySize = this.version === 1 ? 20 : 12;
    size += this.entries.length * entrySize;
    return size;
  }
}

export class DinfBox extends ContainerBox {}
export class IprpBox extends ContainerBox {}
export class IpcoBox extends ContainerBox {}
export class TrefBox extends ContainerBox {}
export class UdatBox extends ContainerBox {}
export class KeysBox extends ContainerBox {}
export class MdatBox extends GenericBox {}

export class ColrBox extends Box {
  colourType = '';
  colorPrimaries = 0;
  transferFunction = 0;
  matrixCoefficients = 0;
  fullRangeFlag = 0;
  iccProfile: Uint8Array|null = null;

  override parseContent(stream: DataStream) {
    this.colourType = stream.readString(4);
    if (this.colourType === 'nclx') {
      this.colorPrimaries = stream.readUint16();
      this.transferFunction = stream.readUint16();
      this.matrixCoefficients = stream.readUint16();
      const fullRangeAndReserved = stream.readUint8();
      this.fullRangeFlag = fullRangeAndReserved >> 7;
    } else if (this.colourType === 'rICC' || this.colourType === 'iCCP') {
      this.iccProfile = stream.readUint8Array(stream.remaining);
    }
  }
  override writeContent(stream: DataStream) {
    stream.writeString(this.colourType);
    if (this.colourType === 'nclx') {
      stream.writeUint16(this.colorPrimaries);
      stream.writeUint16(this.transferFunction);
      stream.writeUint16(this.matrixCoefficients);
      stream.writeUint8(this.fullRangeFlag << 7);
    } else if (this.colourType === 'rICC' || this.colourType === 'iCCP') {
      if (this.iccProfile) {
        stream.writeUint8Array(this.iccProfile);
      }
    }
  }
  override getContentSize(): number {
    let size = 4;  // colourType
    if (this.colourType === 'nclx') {
      size += 2 + 2 + 2 + 1;  // colorPrimaries, transferFunction,
                              // matrixCoefficients, fullRangeFlag
    } else if (this.colourType === 'rICC' || this.colourType === 'iCCP') {
      size += this.iccProfile ? this.iccProfile.byteLength : 0;
    }
    return size;
  }
}

export class FtypBox extends Box {
  majorBrand = '';
  minorVersion = 0;
  compatibleBrands: string[] = [];

  override parseContent(stream: DataStream) {
    this.majorBrand = stream.readString(4);
    this.minorVersion = stream.readUint32();
    this.compatibleBrands = [];
    while (stream.remaining >= 4) {
      this.compatibleBrands.push(stream.readString(4));
    }
  }
  override writeContent(stream: DataStream): void {
    stream.writeString(this.majorBrand);
    stream.writeUint32(this.minorVersion);
    for (const brand of this.compatibleBrands) {
      stream.writeString(brand);
    }
  }
  override getContentSize(): number {
    return 4 + 4 +
        4 *
        this.compatibleBrands
            .length;  // majorBrand, minorVersion, compatibleBrands
  }
}

export class MvhdBox extends FullBox {
  creationTime = '';
  modificationTime = '';
  timescale = 0;
  duration = 0;
  rate = 0;
  volume = 0;
  matrix: number[] = [];
  nextTrackId = 0;

  override parseContent(stream: DataStream) {
    super.parseContent(stream);
    const is64bit = this.version === 1;
    this.creationTime = stream.readDate(is64bit);
    this.modificationTime = stream.readDate(is64bit);
    this.timescale = stream.readUint32();
    this.duration =
        is64bit ? Number(stream.readBigUint64()) : stream.readUint32();
    this.rate = stream.readFixedPoint(16, 16);
    this.volume = stream.readFixedPoint(8, 8);
    stream.skip(10);  // reserved
    this.matrix = stream.readMatrix();
    stream.skip(24);  // pre_defined
    this.nextTrackId = stream.readUint32();
  }
  override writeContent(stream: DataStream): void {
    super.writeContent(stream);
    const is64bit = this.version === 1;
    stream.writeDate(this.creationTime, is64bit);
    stream.writeDate(this.modificationTime, is64bit);
    stream.writeUint32(this.timescale);
    if (is64bit) {
      stream.writeBigUint64(BigInt(this.duration));
    } else {
      stream.writeUint32(this.duration);
    }
    stream.writeFixedPoint(16, 16, this.rate);
    stream.writeFixedPoint(8, 8, this.volume);
    for (let i = 0; i < 10; i++) stream.writeUint8(0);  // reserved
    stream.writeMatrix(this.matrix);
    for (let i = 0; i < 6; i++) stream.writeUint32(0);  // pre_defined
    stream.writeUint32(this.nextTrackId);
  }
  override getContentSize(): number {
    let size = 4;  // super.getContentSize() for FullBox (version+flags)
    if (this.version === 1) {
      size +=
          8 + 8 + 4 + 8;  // creationTime, modificationTime, timescale, duration
    } else {
      size +=
          4 + 4 + 4 + 4;  // creationTime, modificationTime, timescale, duration
    }
    size += 4 + 2;      // rate, volume
    size += 2 + 4 * 2;  // reserved
    size += 36;         // matrix
    size += 24;         // pre_defined
    size += 4;          // nextTrackId
    return size;
  }
}

export class TkhdBox extends FullBox {
  creationTime = '';
  modificationTime = '';
  trackId = 0;
  duration = 0;
  layer = 0;
  alternateGroup = 0;
  volume = 0;
  matrix: number[] = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];
  width = 0;
  height = 0;

  override parseContent(stream: DataStream) {
    super.parseContent(stream);
    const is64bit = this.version === 1;
    this.creationTime = stream.readDate(is64bit);
    this.modificationTime = stream.readDate(is64bit);
    this.trackId = stream.readUint32();
    stream.skip(4);  // reserved
    this.duration =
        is64bit ? Number(stream.readBigUint64()) : stream.readUint32();
    stream.skip(8);  // reserved
    this.layer = stream.readInt16();
    this.alternateGroup = stream.readInt16();
    this.volume = stream.readFixedPoint(8, 8);
    stream.skip(2);  // reserved
    this.matrix = stream.readMatrix();
    this.width = stream.readFixedPoint(16, 16);
    this.height = stream.readFixedPoint(16, 16);
  }
  override writeContent(stream: DataStream): void {
    super.writeContent(stream);
    const is64bit = this.version === 1;
    stream.writeDate(this.creationTime, is64bit);
    stream.writeDate(this.modificationTime, is64bit);
    stream.writeUint32(this.trackId);
    stream.writeUint32(0);  // reserved
    if (is64bit) {
      stream.writeBigUint64(BigInt(this.duration));
    } else {
      stream.writeUint32(this.duration);
    }
    stream.writeUint32(0);  // reserved
    stream.writeUint32(0);  // reserved
    stream.writeInt16(this.layer);
    stream.writeInt16(this.alternateGroup);
    stream.writeFixedPoint(8, 8, this.volume);
    stream.writeUint16(0);  // reserved
    stream.writeMatrix(this.matrix);
    stream.writeFixedPoint(16, 16, this.width);
    stream.writeFixedPoint(16, 16, this.height);
  }
  override getContentSize(): number {
    let size = 4;  // super.getContentSize() for FullBox (version+flags)
    if (this.version === 1) {
      size += 8 + 8 + 4 + 4 +
          8;  // creationTime, modificationTime, trackId, reserved, duration
    } else {
      size += 4 + 4 + 4 + 4 +
          4;  // creationTime, modificationTime, trackId, reserved, duration
    }
    size += 8;              // reserved
    size += 2 + 2 + 2 + 2;  // layer, alternateGroup, volume, reserved
    size += 36;             // matrix
    size += 4 + 4;          // width, height
    return size;
  }
}

export class MdhdBox extends FullBox {
  creationTime = '';
  modificationTime = '';
  timescale = 0;
  duration = 0;
  language = 'und';  // Undefined language
  override parseContent(stream: DataStream) {
    super.parseContent(stream);
    const is64bit = this.version === 1;
    this.creationTime = stream.readDate(is64bit);
    this.modificationTime = stream.readDate(is64bit);
    this.timescale = stream.readUint32();
    this.duration =
        is64bit ? Number(stream.readBigUint64()) : stream.readUint32();
    this.language = stream.readLanguage();
    stream.skip(2);  // pre_defined
  }
  override writeContent(stream: DataStream): void {
    super.writeContent(stream);
    const is64bit = this.version === 1;
    stream.writeDate(this.creationTime, is64bit);
    stream.writeDate(this.modificationTime, is64bit);
    stream.writeUint32(this.timescale);
    if (is64bit) {
      stream.writeBigUint64(BigInt(this.duration));
    } else {
      stream.writeUint32(this.duration);
    }
    stream.writeLanguage(this.language);
    stream.writeUint16(0);  // pre_defined
  }
  override getContentSize(): number {
    let size = 4;  // super.getContentSize() for FullBox (version+flags)
    if (this.version === 1) {
      size +=
          8 + 8 + 4 + 8;  // creationTime, modificationTime, timescale, duration
    } else {
      size +=
          4 + 4 + 4 + 4;  // creationTime, modificationTime, timescale, duration
    }
    size += 2;  // language
    size += 2;  // pre_defined, reserved
    return size;
  }
}

export class HdlrBox extends FullBox {
  handlerType = '';
  name = '';
  override parseContent(stream: DataStream) {
    super.parseContent(stream);
    stream.skip(4);  // pre_defined
    this.handlerType = stream.readString(4);
    stream.skip(12);  // reserved
    this.name = stream.readNullTerminatedString();
  }
  override writeContent(stream: DataStream): void {
    super.writeContent(stream);
    stream.writeUint32(0);  // pre_defined
    stream.writeString(this.handlerType);
    for (let i = 0; i < 12; i++) stream.writeUint8(0);  // reserved
    stream.writeNullTerminatedString(this.name);
  }
  override getContentSize(): number {
    let size = 4;  // super.getContentSize() for FullBox (version+flags)
    size += 4;     // pre_defined
    size += 4;     // handlerType
    size += 12;    // reserved
    size += this.name.length + 1;  // name (null-terminated)
    return size;
  }
}

export class VmhdBox extends FullBox {
  graphicsmode = 0;
  opcolorR = 0;
  opcolorG = 0;
  opcolorB = 0;
  override parseContent(stream: DataStream) {
    super.parseContent(stream);
    this.graphicsmode = stream.readUint16();
    this.opcolorR = stream.readUint16();
    this.opcolorG = stream.readUint16();
    this.opcolorB = stream.readUint16();
  }
  override writeContent(stream: DataStream): void {
    super.writeContent(stream);
    stream.writeUint16(this.graphicsmode);
    stream.writeUint16(this.opcolorR);
    stream.writeUint16(this.opcolorG);
    stream.writeUint16(this.opcolorB);
  }
  override getContentSize(): number {
    let size = 4;  // super.getContentSize() for FullBox (version+flags)
    size += 2 + 2 + 2 + 2;  // graphicsmode, opcolorR, opcolorG, opcolorB
    return size;
  }
}

export class SmhdBox extends FullBox {
  balance = 0;
  override parseContent(stream: DataStream) {
    super.parseContent(stream);
    this.balance = stream.readFixedPoint(8, 8);
    stream.skip(2);  // reserved
  }
  override writeContent(stream: DataStream): void {
    super.writeContent(stream);
    stream.writeFixedPoint(8, 8, this.balance);
    stream.writeUint16(0);  // reserved
  }
  override getContentSize(): number {
    let size = 4;   // super.getContentSize() for FullBox (version+flags)
    size += 2 + 2;  // balance, reserved
    return size;
  }
}

export class DrefBox extends ContainerFullBox {
  override parseDataBeforeChildren(stream: DataStream): void {
    // Unused entry_count, assume it matches the number of children.
    stream.readUint32();
  }
  override writeDataBeforeChildren(stream: DataStream): void {
    stream.writeUint32(this.children.length);
  }
  protected override getContentSizeBeforeChildren(): number {
    return 4;
  }
}

export class UrlBox extends FullBox {
  location: string|null = null;
  override parseContent(stream: DataStream) {
    super.parseContent(stream);
    if (this.flags !== 1) {
      this.location = stream.readNullTerminatedString();
    }
  }
  override writeContent(stream: DataStream): void {
    super.writeContent(stream);
    if (this.flags !== 1 && this.location) {
      stream.writeNullTerminatedString(this.location);
    }
  }
  override getContentSize(): number {
    let size = 4;  // super.getContentSize() for FullBox (version+flags)
    if (this.flags !== 1 && this.location) {
      size += this.location.length + 1;  // location (null-terminated)
    }
    return size;
  }
}

export class PaspBox extends Box {
  hSpacing = 0;
  vSpacing = 0;
  override parseContent(stream: DataStream) {
    this.hSpacing = stream.readUint32();
    this.vSpacing = stream.readUint32();
  }
  override writeContent(stream: DataStream): void {
    stream.writeUint32(this.hSpacing);
    stream.writeUint32(this.vSpacing);
  }
  override getContentSize(): number {
    return 4 + 4;  // hSpacing, vSpacing
  }
}

export class BtrtBox extends Box {
  bufferSizeDB = 0;
  maxBitrate = 0;
  avgBitrate = 0;
  override parseContent(stream: DataStream) {
    this.bufferSizeDB = stream.readUint32();
    this.maxBitrate = stream.readUint32();
    this.avgBitrate = stream.readUint32();
  }
  override writeContent(stream: DataStream): void {
    stream.writeUint32(this.bufferSizeDB);
    stream.writeUint32(this.maxBitrate);
    stream.writeUint32(this.avgBitrate);
  }
  override getContentSize(): number {
    return 4 + 4 + 4;  // bufferSizeDB, maxBitrate, avgBitrate
  }
}

export class SttsBox extends FullBox {
  entries: Array<{sampleCount: number; sampleDelta: number}> = [];
  override parseContent(stream: DataStream) {
    super.parseContent(stream);
    const entryCount = stream.readUint32();
    for (let i = 0; i < entryCount; i++) {
      const sampleCount = stream.readUint32();
      const sampleDelta = stream.readUint32();
      this.entries.push({sampleCount, sampleDelta});
    }
  }
  override writeContent(stream: DataStream): void {
    super.writeContent(stream);
    stream.writeUint32(this.entries.length);
    for (const entry of this.entries) {
      stream.writeUint32(entry.sampleCount);
      stream.writeUint32(entry.sampleDelta);
    }
  }
  override getContentSize(): number {
    let size = 4;  // super.getContentSize() for FullBox (version+flags)
    size += 4;     // entry_count
    size += this.entries.length * (4 + 4);  // sampleCount, sampleDelta
    return size;
  }
}

export class StscBox extends FullBox {
  entries: Array<{
    firstChunk: number; samplesPerChunk: number; sampleDescriptionIndex: number;
  }> = [];
  override parseContent(stream: DataStream) {
    super.parseContent(stream);
    const entryCount = stream.readUint32();
    for (let i = 0; i < entryCount; i++) {
      const firstChunk = stream.readUint32();
      const samplesPerChunk = stream.readUint32();
      const sampleDescriptionIndex = stream.readUint32();
      this.entries.push({
        firstChunk,
        samplesPerChunk,
        sampleDescriptionIndex,
      });
    }
  }
  override writeContent(stream: DataStream): void {
    super.writeContent(stream);
    stream.writeUint32(this.entries.length);
    for (const entry of this.entries) {
      stream.writeUint32(entry.firstChunk);
      stream.writeUint32(entry.samplesPerChunk);
      stream.writeUint32(entry.sampleDescriptionIndex);
    }
  }
  override getContentSize(): number {
    let size = 4;  // super.getContentSize() for FullBox (version+flags)
    size += 4;     // entry_count
    size += this.entries.length *
        (4 + 4 + 4);  // firstChunk, samplesPerChunk, sampleDescriptionIndex
    return size;
  }
}

export class StszBox extends FullBox {
  sampleSize = 0;   // Default sample size if they're all the same size
  sampleCount = 0;  // number of samples in the track
  sampleSizes: number[] = [];
  override parseContent(stream: DataStream) {
    super.parseContent(stream);
    this.sampleSize = stream.readUint32();
    this.sampleCount = stream.readUint32();
    if (this.sampleSize === 0) {
      for (let i = 0; i < this.sampleCount; i++) {
        this.sampleSizes.push(stream.readUint32());
      }
    }
  }
  override writeContent(stream: DataStream): void {
    super.writeContent(stream);
    stream.writeUint32(this.sampleSize);
    stream.writeUint32(this.sampleCount);
    if (this.sampleSize === 0) {
      for (let i = 0; i < this.sampleCount; i++) {
        stream.writeUint32(this.sampleSizes[i]);
      }
    }
  }
  override getContentSize(): number {
    let size = 4;   // super.getContentSize() for FullBox (version+flags)
    size += 4 + 4;  // sampleSize, sampleCount
    if (this.sampleSize === 0) {
      size += this.sampleSizes.length * 4;  // individual sample sizes
    }
    return size;
  }
}

export class StcoBox extends FullBox {
  chunkOffsets: number[] = [];
  parseContentInternal(stream: DataStream, is64bit: boolean) {
    super.parseContent(stream);
    const entryCount = stream.readUint32();
    for (let i = 0; i < entryCount; i++) {
      if (is64bit) {
        this.chunkOffsets.push(Number(stream.readBigUint64()));
      } else {
        this.chunkOffsets.push(stream.readUint32());
      }
    }
  }
  override parseContent(stream: DataStream) {
    this.parseContentInternal(stream, false);
  }
  writeContentInternal(stream: DataStream, is64bit: boolean): void {
    super.writeContent(stream);
    stream.writeUint32(this.chunkOffsets.length);
    for (const chunkOffset of this.chunkOffsets) {
      if (is64bit) {
        stream.writeBigUint64(BigInt(chunkOffset));
      } else {
        stream.writeUint32(chunkOffset);
      }
    }
  }
  override writeContent(stream: DataStream): void {
    this.writeContentInternal(stream, false);
  }
  override getContentSize(): number {
    let size = 4;  // super.getContentSize() for FullBox (version+flags)
    size += 4;     // entry_count
    size += this.chunkOffsets.length * 4;  // 4 bytes per offset for stco
    return size;
  }
}

export class Co64Box extends StcoBox {
  override parseContent(stream: DataStream) {
    this.parseContentInternal(stream, /* is64bit= */ true);
  }
  override writeContent(stream: DataStream): void {
    this.writeContentInternal(stream, /* is64bit= */ true);
  }
  override getContentSize(): number {
    let size = 4;  // super.getContentSize() for FullBox (version+flags)
    size += 4;     // entry_count
    size += this.chunkOffsets.length * 8;  // 8 bytes per offset for co64
    return size;
  }
}

export class CttsBox extends FullBox {
  entries: Array<{sampleCount: number; sampleOffset: number}> = [];
  override parseContent(stream: DataStream) {
    super.parseContent(stream);
    const entryCount = stream.readUint32();
    for (let i = 0; i < entryCount; i++) {
      const sampleCount = stream.readUint32();
      const sampleOffset = stream.readInt32();
      this.entries.push({sampleCount, sampleOffset});
    }
  }
  override writeContent(stream: DataStream): void {
    super.writeContent(stream);
    stream.writeUint32(this.entries.length);
    for (const entry of this.entries) {
      stream.writeUint32(entry.sampleCount);
      stream.writeInt32(entry.sampleOffset);
    }
  }
  override getContentSize(): number {
    let size = 4;  // super.getContentSize() for FullBox (version+flags)
    size += 4;     // entry_count
    size += this.entries.length * (4 + 4);  // sampleCount, sampleOffset
    return size;
  }
}

export class StssBox extends FullBox {
  sampleNumbers: number[] = [];
  override parseContent(stream: DataStream) {
    super.parseContent(stream);
    const entryCount = stream.readUint32();
    for (let i = 0; i < entryCount; i++) {
      this.sampleNumbers.push(stream.readUint32());
    }
  }
  override writeContent(stream: DataStream): void {
    super.writeContent(stream);
    stream.writeUint32(this.sampleNumbers.length);
    for (const sampleNumber of this.sampleNumbers) {
      stream.writeUint32(sampleNumber);
    }
  }
  override getContentSize(): number {
    let size = 4;  // super.getContentSize() for FullBox (version+flags)
    size += 4;     // entry_count
    size += this.sampleNumbers.length * 4;  // sampleNumber
    return size;
  }
}

export class KeydBox extends Box {
  keyNamespace = '';
  keyValue = '';
  override parseContent(stream: DataStream) {
    this.keyNamespace = stream.readString(4);
    this.keyValue = stream.readString(stream.remaining);
  }
  override writeContent(stream: DataStream): void {
    stream.writeString(this.keyNamespace);
    stream.writeString(this.keyValue);
  }
  override getContentSize(): number {
    return 4 + this.keyValue.length;  // keyNamespace, keyValue
  }
}

export class SampleEntryBox extends ContainerBox {
  dataReferenceIndex = 0;

  // Returns true if this box is an actual sample entry in stsd. Returns false
  // if this box is a me4c payload in a multiplexed timed metadata track (mebx).
  protected signalDataReferenceIndex(): boolean {
    return true;
  }

  override parseDataBeforeChildren(stream: DataStream): void {
    if (this.signalDataReferenceIndex()) {
      stream.skip(6);  // reserved
      this.dataReferenceIndex = stream.readUint16();
    }
  }

  override writeDataBeforeChildren(stream: DataStream): void {
    if (this.signalDataReferenceIndex()) {
      for (let i = 0; i < 6; i++) stream.writeUint8(0);  // reserved
      stream.writeUint16(this.dataReferenceIndex);
    }
  }
  protected override getContentSizeBeforeChildren(): number {
    if (this.signalDataReferenceIndex()) {
      return 8;
    } else {
      return 0;
    }
  }
}

export class VisualSampleEntryBox extends SampleEntryBox {
  width = 0;
  height = 0;
  horizresolution = 0;
  vertresolution = 0;
  frameCount = 0;
  compressorName = '';
  depth = 0;

  override parseDataBeforeChildren(stream: DataStream): void {
    super.parseDataBeforeChildren(stream);

    stream.skip(16);  // pre_defined, reserved
    this.width = stream.readUint16();
    this.height = stream.readUint16();
    this.horizresolution = stream.readFixedPoint(16, 16);
    this.vertresolution = stream.readFixedPoint(16, 16);
    stream.skip(4);  // reserved
    this.frameCount = stream.readUint16();
    const compressorNameLen = stream.readUint8();
    this.compressorName = stream.readString(compressorNameLen);
    stream.skip(31 - compressorNameLen);  // skip rest of 32 bytes
    this.depth = stream.readUint16();
    stream.skip(2);  // pre_defined
  }

  override writeDataBeforeChildren(stream: DataStream): void {
    super.writeDataBeforeChildren(stream);

    stream.writeUint16(0);                              // pre_defined
    stream.writeUint16(0);                              // reserved
    for (let i = 0; i < 3; i++) stream.writeUint32(0);  // pre_defined[0,1,2]

    stream.writeUint16(this.width);
    stream.writeUint16(this.height);
    stream.writeFixedPoint(16, 16, this.horizresolution);
    stream.writeFixedPoint(16, 16, this.vertresolution);
    stream.writeUint32(0);  // reserved
    stream.writeUint16(this.frameCount);
    stream.writeUint8(this.compressorName.length);
    stream.writeString(this.compressorName);
    for (let i = this.compressorName.length; i < 31; ++i) stream.writeUint8(0);
    stream.writeUint16(this.depth);
    stream.writeInt16(-1);  // pre_defined = -1
  }
  protected override getContentSizeBeforeChildren(): number {
    return 78;
  }
}

export class AudioSampleEntryBox extends SampleEntryBox {
  channelCount = 0;
  sampleSize = 0;
  sampleRate = 0;

  override parseDataBeforeChildren(stream: DataStream): void {
    super.parseDataBeforeChildren(stream);
    stream.skip(8);  // reserved
    this.channelCount = stream.readUint16();
    this.sampleSize = stream.readUint16();
    stream.skip(4);  // pre_defined, reserved
    this.sampleRate = stream.readFixedPoint(16, 16);
  }

  override writeDataBeforeChildren(stream: DataStream): void {
    super.writeDataBeforeChildren(stream);
    stream.writeUint32(0);  // reserved[0]
    stream.writeUint32(0);  // reserved[1]
    stream.writeUint16(this.channelCount);
    stream.writeUint16(this.sampleSize);
    stream.writeUint16(0);  // pre_defined
    stream.writeUint16(0);  // reserved
    stream.writeFixedPoint(16, 16, this.sampleRate);
  }
  protected override getContentSizeBeforeChildren(): number {
    return 28;
  }
}

export class StsdBox extends ContainerFullBox {
  override parseDataBeforeChildren(stream: DataStream): void {
    // Unused entry_count, assume it matches the number of children.
    stream.readUint32();
  }

  override writeDataBeforeChildren(stream: DataStream): void {
    stream.writeUint32(this.children.length);
  }
  protected override getContentSizeBeforeChildren(): number {
    return 4;
  }
}

export class TrackReferenceTypeBox extends Box {
  trackIds: number[] = [];
  override parseContent(stream: DataStream) {
    while (stream.remaining >= 4) {
      this.trackIds.push(stream.readUint32());
    }
  }
  override writeContent(stream: DataStream): void {
    for (const trackId of this.trackIds) {
      stream.writeUint32(trackId);
    }
  }
  override getContentSize(): number {
    return this.trackIds.length * 4;  // trackIds
  }
}

export class It35SampleEntryBox extends SampleEntryBox {
  t35Identifier: Uint8Array = new Uint8Array(0);
  override parseDataBeforeChildren(stream: DataStream): void {
    super.parseDataBeforeChildren(stream);
    if (stream.remaining > 0) {
      const payloadStart = stream.position;

      // Old syntax check: null terminated ASCII string before binary data.
      let isOldSyntax = false;
      let firstZeroIndex = -1;
      const data = new Uint8Array(
          stream.view.buffer, stream.view.byteOffset + stream.position,
          stream.remaining);
      for (let i = 0; i < data.length; ++i) {
        if (data[i] === 0) {
          firstZeroIndex = i;
          break;
        }
      }

      if (firstZeroIndex !== -1) {
        let allAsciiBeforeZero = true;
        for (let i = 0; i < firstZeroIndex; ++i) {
          if (data[i] > 127) {
            allAsciiBeforeZero = false;
            break;
          }
        }
        if (allAsciiBeforeZero) isOldSyntax = true;
      }

      if (isOldSyntax) {
        stream.skip(firstZeroIndex + 1);
        this.t35Identifier = stream.readUint8Array(stream.remaining);
      } else {
        const it35IdentifierLength = stream.readUint8();
        this.t35Identifier = stream.readUint8Array(
            Math.min(it35IdentifierLength, stream.remaining));
      }
    }
  }
  override writeDataBeforeChildren(stream: DataStream): void {
    super.writeDataBeforeChildren(stream);
    stream.writeUint8(this.t35Identifier.length);
    stream.writeUint8Array(this.t35Identifier);
  }
  protected override getContentSizeBeforeChildren(): number {
    return (
        super.getContentSizeBeforeChildren() + 1 +  // t35_identifier_length
        this.t35Identifier.length);
  }
}

export class It35PayloadBox extends It35SampleEntryBox {
  override signalDataReferenceIndex(): boolean {
    // This box is a me4c payload in a multiplexed timed metadata track (mebx).
    // Do not signal sample entry fields.
    return false;
  }
}

export class Av1CBox extends Box {
  marker = 0;
  version = 0;
  seqProfile = 0;
  seqLevelIdx0 = 0;
  seqTier0 = 0;
  highBitdepth = 0;
  twelveBit = 0;
  monochrome = 0;
  chromaSubsamplingX = 0;
  chromaSubsamplingY = 0;
  chromaSamplePosition = 0;
  initialPresentationDelayPresent = 0;
  initialPresentationDelayMinusOne = 0;
  configOBUs: Uint8Array|null = null;

  override parseContent(stream: DataStream): void {
    const bitstream = new Bitstream(stream.readUint8Array(stream.remaining));
    this.marker = bitstream.readBits(1);
    this.version = bitstream.readBits(7);
    this.seqProfile = bitstream.readBits(3);
    this.seqLevelIdx0 = bitstream.readBits(5);
    this.seqTier0 = bitstream.readBits(1);
    this.highBitdepth = bitstream.readBits(1);
    this.twelveBit = bitstream.readBits(1);
    this.monochrome = bitstream.readBits(1);
    this.chromaSubsamplingX = bitstream.readBits(1);
    this.chromaSubsamplingY = bitstream.readBits(1);
    this.chromaSamplePosition = bitstream.readBits(2);
    bitstream.readBits(3);  // reserved
    this.initialPresentationDelayPresent = bitstream.readBits(1);
    if (this.initialPresentationDelayPresent) {
      this.initialPresentationDelayMinusOne = bitstream.readBits(4);
    } else {
      bitstream.readBits(4);  // reserved
    }
    const remainingBytes = bitstream.bytesLeft();
    if (remainingBytes > 0) {
      this.configOBUs = bitstream.uint8Array.slice(bitstream.bytePosition);
    }
  }
  override writeContent(stream: DataStream): void {
    stream.writeUint8(
        new ByteWriter().addBits(this.marker, 1).addBits(this.version, 7).value,
    );
    stream.writeUint8(
        new ByteWriter()
            .addBits(this.seqProfile, 3)
            .addBits(this.seqLevelIdx0, 5)
            .value,
    );
    stream.writeUint8(
        new ByteWriter()
            .addBits(this.seqTier0, 1)
            .addBits(this.highBitdepth, 1)
            .addBits(this.twelveBit, 1)
            .addBits(this.monochrome, 1)
            .addBits(this.chromaSubsamplingX, 1)
            .addBits(this.chromaSubsamplingY, 1)
            .addBits(this.chromaSamplePosition, 2)
            .value,
    );
    const writer = new ByteWriter().addBits(0, 3);  // 3 reserved bits
    writer.addBits(this.initialPresentationDelayPresent ? 1 : 0, 1);
    if (this.initialPresentationDelayPresent) {
      writer.addBits(this.initialPresentationDelayMinusOne, 4);
    } else {
      writer.addBits(0, 4);  // reserved
    }
    stream.writeUint8(writer.value);

    if (this.configOBUs) {
      stream.writeUint8Array(this.configOBUs);
    }
  }
  override getContentSize(): number {
    let size = 4;  // 4 bytes for the fixed fields (marker/version,
                   // profile/level, tier/bitdepth, delay)
    size += this.configOBUs ? this.configOBUs.length : 0;
    return size;
  }
}

interface HvcCBoxNalu {
  length: number;
  data: Uint8Array;
}
interface HvcCBoxNaluArray {
  completeness: number;
  naluType: number;
  nalus: HvcCBoxNalu[];
}

export class HvcCBox extends Box {
  configurationVersion = 0;
  generalProfileSpace = 0;
  generalTierFlag = 0;
  generalProfileIdc = 0;
  generalProfileCompatibilityFlags = 0;
  generalConstraintIndicatorFlags: number[] = [];
  generalLevelIdc = 0;
  minSpatialSegmentationIdc = 0;
  parallelismType = 0;
  chromaFormatIdc = 0;
  bitDepthLumaMinus8 = 0;
  bitDepthChromaMinus8 = 0;
  avgFrameRate = 0;
  constantFrameRate = 0;
  numTemporalLayers = 0;
  temporalIdNested = 0;
  lengthSizeMinusOne = 0;
  numOfArrays = 0;
  naluArrays: HvcCBoxNaluArray[] = [];

  override parseContent(stream: DataStream): void {
    this.configurationVersion = stream.readUint8();
    const profileByte = stream.readUint8();
    this.generalProfileSpace = profileByte >> 6;
    this.generalTierFlag = (profileByte >> 5) & 1;
    this.generalProfileIdc = profileByte & 0x1f;
    this.generalProfileCompatibilityFlags = stream.readUint32();
    this.generalConstraintIndicatorFlags = [];
    for (let i = 0; i < 6; i++) {
      this.generalConstraintIndicatorFlags.push(stream.readUint8());
    }
    this.generalLevelIdc = stream.readUint8();
    this.minSpatialSegmentationIdc = stream.readUint16() & 0xfff;
    this.parallelismType = stream.readUint8() & 3;
    this.chromaFormatIdc = stream.readUint8() & 3;
    this.bitDepthLumaMinus8 = stream.readUint8() & 7;
    this.bitDepthChromaMinus8 = stream.readUint8() & 7;
    this.avgFrameRate = stream.readUint16();
    const naluByte = stream.readUint8();
    this.constantFrameRate = (naluByte >> 6) & 3;
    this.numTemporalLayers = (naluByte >> 3) & 7;
    this.temporalIdNested = (naluByte >> 2) & 1;
    this.lengthSizeMinusOne = naluByte & 3;

    this.numOfArrays = stream.readUint8();
    for (let i = 0; i < this.numOfArrays; i++) {
      const arrayInfo = stream.readUint8();
      const arrayCompleteness = (arrayInfo >> 7) & 1;
      const naluType = arrayInfo & 0x3f;
      const numNalus = stream.readUint16();
      const nalus: HvcCBoxNalu[] = [];
      for (let j = 0; j < numNalus; j++) {
        const naluLength = stream.readUint16();
        nalus.push({
          length: naluLength,
          data: stream.readUint8Array(naluLength),
        });
      }
      this.naluArrays.push({
        completeness: arrayCompleteness,
        naluType,
        nalus,
      });
    }
  }

  override writeContent(stream: DataStream): void {
    stream.writeUint8(this.configurationVersion);
    stream.writeUint8(
        new ByteWriter()
            .addBits(this.generalProfileSpace, 2)
            .addBits(this.generalTierFlag, 1)
            .addBits(this.generalProfileIdc, 5)
            .value,
    );
    stream.writeUint32(this.generalProfileCompatibilityFlags);
    for (let i = 0; i < 6; i++) {
      stream.writeUint8(this.generalConstraintIndicatorFlags[i]);
    }
    stream.writeUint8(this.generalLevelIdc);
    stream.writeUint16(
        new ByteWriter()
            .addBits(0xf, 4)
            .addBits(this.minSpatialSegmentationIdc, 12)
            .value,
    );
    stream.writeUint8(
        new ByteWriter()
            .addBits(0x3f, 6)
            .addBits(this.parallelismType, 2)
            .value,
    );
    stream.writeUint8(
        new ByteWriter()
            .addBits(0x3f, 6)
            .addBits(this.chromaFormatIdc, 2)
            .value,
    );
    stream.writeUint8(
        new ByteWriter()
            .addBits(0x1f, 5)
            .addBits(this.bitDepthLumaMinus8, 3)
            .value,
    );
    stream.writeUint8(
        new ByteWriter()
            .addBits(0x1f, 5)
            .addBits(this.bitDepthChromaMinus8, 3)
            .value,
    );
    stream.writeUint16(this.avgFrameRate);
    stream.writeUint8(
        new ByteWriter()
            .addBits(this.constantFrameRate, 2)
            .addBits(this.numTemporalLayers, 3)
            .addBits(this.temporalIdNested, 1)
            .addBits(this.lengthSizeMinusOne, 2)
            .value,
    );
    stream.writeUint8(this.numOfArrays);
    for (let i = 0; i < this.numOfArrays; i++) {
      const naluArray = this.naluArrays[i];
      stream.writeUint8(
          new ByteWriter()
              .addBits(naluArray.completeness, 1)
              .addBits(0, 1)  // reserved
              .addBits(naluArray.naluType, 6)
              .value,
      );
      stream.writeUint16(naluArray.nalus.length);
      for (const nalu of naluArray.nalus) {
        stream.writeUint16(nalu.length);
        stream.writeUint8Array(nalu.data);
      }
    }
  }
  override getContentSize(): number {
    let size = 0;
    size += 1;  // configurationVersion
    size += 1;  // profileByte
    size += 4;  // generalProfileCompatibilityFlags
    size += 6;  // generalConstraintIndicatorFlags
    size += 1;  // generalLevelIdc
    size += 2;  // minSpatialSegmentationIdc
    size += 1;  // parallelismType
    size += 1;  // chromaFormatIdc
    size += 1;  // bitDepthLumaMinus8
    size += 1;  // bitDepthChromaMinus8
    size += 2;  // avgFrameRate
    size += 1;  // naluByte
    size += 1;  // numOfArrays

    for (const naluArray of this.naluArrays) {
      size += 1;  // arrayInfo
      size += 2;  // numNalus
      for (const nalu of naluArray.nalus) {
        size += 2;            // naluLength
        size += nalu.length;  // nalu data
      }
    }
    return size;
  }
}

function parseBox(stream: DataStream, parentBox: Box|null): Box|null {
  if (stream.remaining < 8) return null;
  const isTopLevel = parentBox === null;
  const header = readBoxHeader(stream, isTopLevel);
  if (!header) return null;
  const {size, type, headerSize} = header;

  const boxConstructors: {[type: string]: BoxConstructor;} = {
    'meta': MetaBox,
    'moov': MoovBox,
    'trak': TrakBox,
    'mdia': MdiaBox,
    'minf': MinfBox,
    'stbl': StblBox,
    'edts': EdtsBox,
    'elst': ElstBox,
    'dinf': DinfBox,
    'iprp': IprpBox,
    'ipco': IpcoBox,
    'tref': TrefBox,
    'udat': UdatBox,
    'keys': KeysBox,
    'colr': ColrBox,
    'ftyp': FtypBox,
    'mvhd': MvhdBox,
    'tkhd': TkhdBox,
    'mdhd': MdhdBox,
    'hdlr': HdlrBox,
    'vmhd': VmhdBox,
    'smhd': SmhdBox,
    'dref': DrefBox,
    'url ': UrlBox,
    'pasp': PaspBox,
    'btrt': BtrtBox,
    'stts': SttsBox,
    'stsc': StscBox,
    'stsz': StszBox,
    'stco': StcoBox,
    'co64': Co64Box,
    'ctts': CttsBox,
    'stss': StssBox,
    'keyd': KeydBox,
    'stsd': StsdBox,
    'avc1': VisualSampleEntryBox,
    'hev1': VisualSampleEntryBox,
    'hvc1': VisualSampleEntryBox,
    'av01': VisualSampleEntryBox,
    'mp4a': AudioSampleEntryBox,
    'it35': It35SampleEntryBox,
    'av1C': Av1CBox,
    'hvcC': HvcCBox,
    'mebx': SampleEntryBox,
    'mdat': MdatBox,
  };

  const parseFuncsForChildrenOf: {[type: string]: BoxConstructor;} = {
    'tref': TrackReferenceTypeBox,
    // Children of 'keys' are of type MetadataKeyBox which is a container box.
    'keys': ContainerBox,
  };

  const parseFuncsForMetaTrack: {[type: string]: BoxConstructor;} = {
    'it35': It35PayloadBox,
  };

  let constructorFunc: BoxConstructor;
  if (parentBox && parseFuncsForChildrenOf[parentBox.type]) {
    constructorFunc = parseFuncsForChildrenOf[parentBox.type];
  } else if (type === 'setu' && parentBox instanceof ContainerBox) {
    // MetadataSetupBox
    const keyd = parentBox.getChild('keyd', KeydBox);
    if (keyd && keyd.keyNamespace === 'me4c' && keyd.keyValue &&
        parseFuncsForMetaTrack[keyd.keyValue]) {
      constructorFunc = parseFuncsForMetaTrack[keyd.keyValue];
    } else {
      constructorFunc = GenericBox;
    }
  } else if (type === 'keys' && parentBox?.type !== 'mebx') {
    // Special case, this is probably Quicktime's keys box which is different
    // from ISOBMFF's.
    constructorFunc = GenericBox;
  } else if (boxConstructors[type]) {
    constructorFunc = boxConstructors[type];
  } else {
    constructorFunc = GenericBox;
  }
  const box = new constructorFunc(type, size);
  const contentSize = size - headerSize;
  box.parseContent(stream.subStream(contentSize));

  return box;
}

export function parseIsobmff(arrayBuffer: ArrayBuffer): Box[] {
  const stream = new DataStream(new DataView(arrayBuffer));
  const boxes: Box[] = [];
  while (stream.remaining) {
    const box = parseBox(stream, /*parentBox=*/ null);
    if (!box) break;
    boxes.push(box);
  }
  return boxes;
}

function writeBox(box: Box, stream: DataStream): void {
  const largeSize = box.size > 0xffffffff;
  const headerSize = largeSize ? 16 : 8;
  if (largeSize) {
    stream.writeUint32(1);  // Size 1, indicating a large size.
    stream.writeString(box.type);
    stream.writeBigUint64(BigInt(box.size));
  } else {
    stream.writeUint32(box.size);
    stream.writeString(box.type);
  }
  box.writeContent(stream.subStream(box.size - headerSize));
}

export function writeIsobmff(boxes: Box[]): ArrayBuffer {
  const totalSize = boxes.reduce((acc, box) => acc + box.size, 0);
  const buffer = new ArrayBuffer(totalSize);
  const stream = new DataStream(new DataView(buffer));
  for (const box of boxes) {
    writeBox(box, stream);
  }
  return buffer;
}
