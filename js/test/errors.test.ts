// Verifies that unsupported inputs (encoder) and malformed / unknown streams
// (decoder) fail loudly rather than silently producing wrong data. Every
// documented error path in encode.ts / decode.ts / buffer.ts is exercised here.

import { describe, it, expect } from "vitest";
import { encode, decode, ByteWriter, MAGIC, VERSION, Tag } from "../src/index";

// Builds a stream with a valid header, then whatever payload `body` writes.
function stream(body: (w: ByteWriter) => void): Uint8Array {
  const w = new ByteWriter();
  w.bytes(MAGIC);
  w.u8(VERSION);
  body(w);
  return w.toUint8Array();
}

describe("encoder rejects values it cannot represent losslessly", () => {
  it("supported shapes still encode (control)", () => {
    expect((decode(encode({ ok: 1 })) as { ok: number }).ok).toBe(1);
    const dict = Object.create(null) as Record<string, number>;
    dict.k = 7;
    expect((decode(encode(dict)) as { k: number }).k).toBe(7);
  });

  it("function throws", () => expect(() => encode(() => 1)).toThrow(/functions are out of scope/));
  it("function as nested value throws", () =>
    expect(() => encode({ fn: () => 1 })).toThrow(/functions are out of scope/));

  it("class instance throws with its constructor name", () => {
    class Point {
      constructor(public x = 1) {}
    }
    expect(() => encode(new Point())).toThrow(/unsupported object type: Point/);
  });

  it("Error throws", () =>
    expect(() => encode(new Error("boom"))).toThrow(/unsupported object type: Error/));
  it("URL throws", () =>
    expect(() => encode(new URL("https://example.com"))).toThrow(/unsupported object type: URL/));
  it("Promise throws", () =>
    expect(() => encode(Promise.resolve(1))).toThrow(/unsupported object type: Promise/));
  it("DataView throws (excluded from TypedArray encoding)", () =>
    expect(() => encode(new DataView(new ArrayBuffer(8)))).toThrow(
      /unsupported object type: DataView/,
    ));

  it("exotic value nested inside a supported container still throws", () =>
    expect(() => encode([new Error("x")])).toThrow(/unsupported object type: Error/));
});

describe("decoder rejects malformed or unknown streams", () => {
  it("bad magic throws", () => {
    const bytes = new Uint8Array([0x00, 0x00, 0x00, 0x00, VERSION, 0x00, 0x01, Tag.Null]);
    expect(() => decode(bytes)).toThrow(/bad magic/);
  });

  it("unsupported version throws", () => {
    const w = new ByteWriter();
    w.bytes(MAGIC);
    w.u8(VERSION + 1);
    w.uvarint(0); // root
    w.uvarint(1); // count
    w.u8(Tag.Null);
    expect(() => decode(w.toUint8Array())).toThrow(/unsupported version: /);
  });

  it("reserved / unknown tag throws (FORMAT.md §6)", () => {
    // Tag 8 is in the reserved range.
    const bytes = stream((w) => {
      w.uvarint(0); // root
      w.uvarint(1); // count
      w.u8(8); // reserved tag
    });
    expect(() => decode(bytes)).toThrow(/unknown tag: 8/);
  });

  it("unknown TypedArray element type throws", () => {
    const bytes = stream((w) => {
      w.uvarint(0); // root
      w.uvarint(1); // count
      w.u8(Tag.TypedArray);
      w.u8(99); // bogus element type
      w.uvarint(0); // byte length
    });
    expect(() => decode(bytes)).toThrow(/unknown element type: 99/);
  });

  it("truncated stream (missing node bytes) throws EOF", () => {
    // Header claims one node but provides no node bytes.
    const bytes = stream((w) => {
      w.uvarint(0); // root
      w.uvarint(1); // count
    });
    expect(() => decode(bytes)).toThrow(/EOF/);
  });

  it("stream truncated mid-payload throws EOF", () => {
    const full = encode({ s: "hello world" });
    expect(() => decode(full.subarray(0, full.length - 3))).toThrow(/EOF/);
  });

  it("count larger than a safe integer throws", () => {
    const bytes = stream((w) => {
      w.uvarint(0); // root
      w.uvarint(2n ** 60n); // absurd node count
    });
    expect(() => decode(bytes)).toThrow(/uvarint overflows safe int/);
  });
});
