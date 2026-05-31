// Low-level binary primitives. V8-independent: only uses ECMAScript spec APIs
// (DataView, TextEncoder/TextDecoder, Number, BigInt). Endianness fixed to LE.

export class ByteWriter {
  private chunks: number[] = [];

  get length(): number {
    return this.chunks.length;
  }

  u8(v: number): void {
    this.chunks.push(v & 0xff);
  }

  bytes(arr: Uint8Array): void {
    for (let i = 0; i < arr.length; i++) this.chunks.push(arr[i]);
  }

  // Unsigned LEB128
  uvarint(v: number | bigint): void {
    let n = typeof v === "bigint" ? v : BigInt(v);
    if (n < 0n) throw new Error("uvarint expects non-negative");
    do {
      let byte = Number(n & 0x7fn);
      n >>= 7n;
      if (n !== 0n) byte |= 0x80;
      this.chunks.push(byte);
    } while (n !== 0n);
  }

  // Signed varint via ZigZag (arbitrary precision safe)
  svarint(v: number | bigint): void {
    const n = typeof v === "bigint" ? v : BigInt(v);
    const z = n >= 0n ? n << 1n : (-n << 1n) - 1n;
    this.uvarint(z);
  }

  f64(v: number): void {
    const buf = new ArrayBuffer(8);
    new DataView(buf).setFloat64(0, v, true);
    this.bytes(new Uint8Array(buf));
  }

  str(s: string): void {
    const enc = new TextEncoder().encode(s);
    this.uvarint(enc.length);
    this.bytes(enc);
  }

  toUint8Array(): Uint8Array {
    return Uint8Array.from(this.chunks);
  }
}

export class ByteReader {
  private pos = 0;
  constructor(private readonly buf: Uint8Array) {}

  get offset(): number {
    return this.pos;
  }

  get eof(): boolean {
    return this.pos >= this.buf.length;
  }

  u8(): number {
    if (this.pos >= this.buf.length) throw new Error("EOF");
    return this.buf[this.pos++];
  }

  bytes(n: number): Uint8Array {
    if (this.pos + n > this.buf.length) throw new Error("EOF");
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  uvarint(): bigint {
    let result = 0n;
    let shift = 0n;
    while (true) {
      const byte = this.u8();
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7n;
    }
    return result;
  }

  uvarintNum(): number {
    const v = this.uvarint();
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("uvarint overflows safe int");
    return Number(v);
  }

  svarint(): bigint {
    const z = this.uvarint();
    return (z & 1n) === 0n ? z >> 1n : -((z + 1n) >> 1n);
  }

  f64(): number {
    const b = this.bytes(8);
    return new DataView(b.buffer, b.byteOffset, 8).getFloat64(0, true);
  }

  str(): string {
    const len = this.uvarintNum();
    const b = this.bytes(len);
    return new TextDecoder().decode(b);
  }
}
