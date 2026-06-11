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
 * Helper for reading from a Uint8Array.
 */
export class Bitstream {
  private bytePos = 0;
  private bitPos = 0;

  constructor(private readonly data: Uint8Array) {}

  /** Returns the underlying Uint8Array. */
  get uint8Array(): Uint8Array {
    return this.data;
  }

  /** Returns the number of bytes remaining in the stream. */
  bytesLeft(): number {
    return this.data.length - this.bytePos;
  }

  /** Returns the current byte position. */
  get bytePosition(): number {
    return this.bytePos;
  }

  /** Sets the current byte position. */
  set bytePosition(pos: number) {
    this.bytePos = pos;
    this.bitPos = 0;
  }

  /** Returns the current bit position within the current byte (0-7). */
  get bitPosition(): number {
    return this.bitPos;
  }

  /** Sets the current bit position. */
  set bitPosition(pos: number) {
    this.bitPos = pos;
  }

  /**
   * Reads n bits from the stream.
   * @param n Number of bits to read (maximum 32).
   * @returns The value read, or -1 if the end of the stream is reached.
   */
  readBits(n: number): number {
    // In Javascript, numbers are represented as 64-bit floats, so integers
    // can be represented exactly only up to +/- 2^53 - 1.
    if (n > 53) {
      throw new Error('Cannot read more than 53 bits at a time');
    }
    let result = 0;
    for (let i = 0; i < n; i++) {
      const bit = this.readBit();
      if (bit === -1) {
        return -1;
      }
      result = (result << 1) | bit;
    }
    return result;
  }

  /** Skips n bits in the stream. */
  skipBits(n: number): void {
    const totalBits = this.bytePos * 8 + this.bitPos + n;
    this.bytePos = Math.floor(totalBits / 8);
    this.bitPos = totalBits % 8;
    if (this.bytePos > this.data.length ||
        (this.bytePos === this.data.length && this.bitPos > 0)) {
      this.bytePos = this.data.length;
      this.bitPos = 0;
    }
  }

  /**
   * Reads a single bit from the stream.
   * @returns 0 or 1, or -1 if the end of the stream is reached.
   */
  readBit(): number {
    if (this.bytePos >= this.data.length) {
      return -1;
    }
    const byte = this.data[this.bytePos];
    const bit = (byte >> (7 - this.bitPos)) & 1;
    this.bitPos++;
    if (this.bitPos === 8) {
      this.bitPos = 0;
      this.bytePos++;
    }
    return bit;
  }

  /**
   * Reads a single byte, optimized for byte-aligned streams.
   * @returns The byte read, or null if the end of the stream is reached.
   */
  readUByte(): number|null {
    if (this.bitPos === 0) {
      if (this.bytePos >= this.data.length) return null;
      return this.data[this.bytePos++];
    }
    const val = this.readBits(8);
    return val === -1 ? null : val;
  }

  /**
   * Reads an Unsigned Exp-Golomb (UEV/UVLC) coded integer.
   * @returns The value read, or -1 if an error occurred.
   */
  readUE(): number {
    let leadingZeroBits = 0;
    let bit = this.readBit();
    while (bit === 0) {
      leadingZeroBits++;
      bit = this.readBit();
    }
    if (bit === -1) return -1;

    if (leadingZeroBits === 0) return 0;
    if (leadingZeroBits > 31) return -1;

    const remainder = this.readBits(leadingZeroBits);
    if (remainder === -1) return -1;

    return (1 << leadingZeroBits) - 1 + remainder;
  }

  /** Alias for readUE, commonly used in AV1/H264/H265. */
  readUvlc(): number {
    return this.readUE();
  }

  /**
   * Reads a Signed Exp-Golomb (SEV) coded integer.
   * @returns The value read, or -1 if an error occurred.
   */
  readSE(): number {
    const codeNum = this.readUE();
    if (codeNum === -1) return -1;
    const sign = codeNum % 2 === 0 ? -1 : 1;
    return sign * Math.ceil(codeNum / 2);
  }

  /**
   * Reads a LEB128/ULEB128 coded integer.
   * @returns The value read, or -1 if an error occurred.
   */
  readUleb128(): number {
    let value = 0;
    let shift = 0;
    for (let i = 0; i < 8; i++) {
      const byte = this.readUByte();
      if (byte === null) return -1;
      value |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) {
        return value;
      }
      shift += 7;
      if (shift >= 35) throw new Error('Invalid LEB128 sequence');
    }
    return -1;
  }
}

/**
 * Helper for reading from/writing to a DataView while tracking the current
 * position.
 */
export class DataStream {
  private offset = 0;
  constructor(public readonly view: DataView) {}

  get position(): number {
    return this.offset;
  }

  set position(p: number) {
    this.offset = p;
  }

  atEos(): boolean {
    return this.remaining <= 0;
  }

  get size(): number {
    return this.view.byteLength;
  }

  get remaining(): number {
    return this.view.byteLength - this.offset;
  }

  readUint8(): number {
    return this.view.getUint8(this.offset++);
  }
  writeUint8(v: number): void {
    this.view.setUint8(this.offset++, v);
  }

  readUint16(): number {
    const v = this.view.getUint16(this.offset, false);
    this.offset += 2;
    return v;
  }
  writeUint16(v: number): void {
    this.view.setUint16(this.offset, v, false);
    this.offset += 2;
  }

  readUint32(): number {
    const v = this.view.getUint32(this.offset, false);
    this.offset += 4;
    return v;
  }
  writeUint32(v: number): void {
    this.view.setUint32(this.offset, v, false);
    this.offset += 4;
  }

  readInt16(): number {
    const v = this.view.getInt16(this.offset, false);
    this.offset += 2;
    return v;
  }
  writeInt16(v: number): void {
    this.view.setInt16(this.offset, v, false);
    this.offset += 2;
  }

  readInt32(): number {
    const v = this.view.getInt32(this.offset, false);
    this.offset += 4;
    return v;
  }
  writeInt32(v: number): void {
    this.view.setInt32(this.offset, v, false);
    this.offset += 4;
  }

  readBigUint64(): bigint {
    const v = this.view.getBigUint64(this.offset, false);
    this.offset += 8;
    return v;
  }
  writeBigUint64(v: bigint): void {
    this.view.setBigUint64(this.offset, v, false);
    this.offset += 8;
  }

  readBigInt64(): bigint {
    const v = this.view.getBigInt64(this.offset, false);
    this.offset += 8;
    return v;
  }
  writeBigInt64(v: bigint): void {
    this.view.setBigInt64(this.offset, v, false);
    this.offset += 8;
  }

  readString(length: number): string {
    let str = '';
    for (let i = 0; i < length; i++) {
      str += String.fromCharCode(this.readUint8());
    }
    return str;
  }
  writeString(str: string): void {
    for (let i = 0; i < str.length; i++) {
      this.writeUint8(str.charCodeAt(i));
    }
  }

  readFloat32(): number {
    const v = this.view.getFloat32(this.offset, false);
    this.offset += 4;
    return v;
  }
  writeFloat32(v: number): void {
    this.view.setFloat32(this.offset, v, false);
    this.offset += 4;
  }
  readFloat64(): number {
    const v = this.view.getFloat64(this.offset, false);
    this.offset += 8;
    return v;
  }
  writeFloat64(v: number): void {
    this.view.setFloat64(this.offset, v, false);
    this.offset += 8;
  }

  readNullTerminatedString(): string {
    let str = '';
    while (this.remaining > 0) {
      const char = this.readUint8();
      if (char === 0) break;
      str += String.fromCharCode(char);
    }
    return str;
  }
  writeNullTerminatedString(str: string): void {
    this.writeString(str);
    this.writeUint8(0);
  }

  readFixedPoint(intBits: number, fracBits: number): number {
    const totalBits = intBits + fracBits;
    const rawValue = totalBits === 32 ? this.readUint32() : this.readUint16();
    return rawValue / (1 << fracBits);
  }
  writeFixedPoint(intBits: number, fracBits: number, value: number): void {
    const totalBits = intBits + fracBits;
    const rawValue = Math.round(value * (1 << fracBits));
    if (totalBits === 32) {
      this.writeUint32(rawValue);
    } else {
      this.writeUint16(rawValue);
    }
  }

  readMatrix(): number[] {
    const matrix: number[] = [];
    for (let i = 0; i < 9; i++) {
      matrix.push(this.readInt32());
    }
    return matrix;
  }
  writeMatrix(matrix: number[]): void {
    for (let i = 0; i < 9; i++) {
      this.writeInt32(matrix[i]);
    }
  }

  readDate(is64bit: boolean): string {
    const macTime = is64bit ? this.readBigUint64() : this.readUint32();
    const epochOffset = 2082844800;
    const date = new Date((Number(macTime) - epochOffset) * 1000);
    return date.toISOString();
  }
  writeDate(dateStr: string, is64bit: boolean): void {
    const epochOffset = 2082844800;
    const date = new Date(dateStr);
    const macTime = Math.round(date.getTime() / 1000) + epochOffset;
    if (is64bit) {
      this.writeBigUint64(BigInt(macTime));
    } else {
      this.writeUint32(macTime);
    }
  }

  readLanguage(): string {
    const langCode = this.readUint16();
    return String.fromCharCode(
        ((langCode >> 10) & 0x1f) + 0x60,
        ((langCode >> 5) & 0x1f) + 0x60,
        (langCode & 0x1f) + 0x60,
    );
  }
  writeLanguage(language: string): void {
    if (language.length !== 3) {
      this.writeUint16(0);
      return;
    }
    const chars = language.split('').map((c) => c.charCodeAt(0) - 0x60);
    const langCode = ((chars[0] & 0x1f) << 10) | ((chars[1] & 0x1f) << 5) |
        (chars[2] & 0x1f);
    this.writeUint16(langCode);
  }

  skip(n: number): void {
    this.offset += n;
  }

  /**
   * Returns a new DataStream that references the next `length` bytes in this
   * stream. This does not copy the data, and the returned stream will share
   * the underlying DataView with this stream.
   * @param length The number of bytes to include in the sub-stream. If not
   *     specified, the sub-stream will include all remaining bytes.
   */
  subStream(length?: number): DataStream {
    const actualLength = length ?? this.remaining;
    const sub = new DataStream(
        new DataView(
            this.view.buffer,
            this.view.byteOffset + this.offset,
            actualLength,
            ),
    );
    this.offset += actualLength;
    return sub;
  }

  readUint8Array(length: number): Uint8Array {
    const arr = new Uint8Array(
        this.view.buffer, this.view.byteOffset + this.offset, length);
    this.offset += length;
    return arr;
  }
  writeUint8Array(arr: Uint8Array): void {
    const dest = new Uint8Array(
        this.view.buffer,
        this.view.byteOffset + this.offset,
        arr.length,
    );
    dest.set(arr);
    this.offset += arr.length;
  }
}

/**
 * Helper for writing bits into a single byte.
 */
export class ByteWriter {
  value = 0;
  addBit(v: boolean) {
    return this.addBits(Number(v), 1);
  }
  addBits(v: number, nBits: number) {
    this.value <<= nBits;
    this.value |= v;
    return this;
  }
}
