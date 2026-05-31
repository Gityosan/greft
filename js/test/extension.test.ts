import { describe, it, expect } from "vitest";
import { encode, decode, ByteWriter, MAGIC, VERSION, Tag, type TypeExtension } from "../src/index";

class Point {
  constructor(
    public x: number,
    public y: number,
  ) {}
}

const pointExt: TypeExtension<Point> = {
  name: "Point",
  match: (v) => v instanceof Point,
  encode: (p) => ({ x: p.x, y: p.y }),
  decode: (s) => new Point((s as Point).x, (s as Point).y),
};
const types = [pointExt];

describe("extension types (Tag.Custom)", () => {
  it("round-trips a registered class with its prototype", () => {
    const out = decode(encode({ p: new Point(3, 4) }, { types }), { types }) as { p: Point };
    expect(out.p instanceof Point && out.p.x === 3 && out.p.y === 4).toBe(true);
  });

  it("surrogate may itself contain Graft types", () => {
    class Tagged {
      constructor(public payload: Map<string, number>) {}
    }
    const ext: TypeExtension<Tagged> = {
      name: "Tagged",
      match: (v) => v instanceof Tagged,
      encode: (t) => t.payload,
      decode: (s) => new Tagged(s as Map<string, number>),
    };
    const out = decode(encode(new Tagged(new Map([["a", 1]])), { types: [ext] }), {
      types: [ext],
    }) as Tagged;
    expect(out instanceof Tagged && out.payload instanceof Map && out.payload.get("a") === 1).toBe(
      true,
    );
  });

  it("shared custom value keeps identity", () => {
    const p = new Point(1, 2);
    const out = decode(encode({ a: p, b: p }, { types }), { types }) as { a: Point; b: Point };
    expect(out.a instanceof Point && out.a === out.b).toBe(true);
  });

  it("decoding without the type registered throws", () => {
    const bytes = encode(new Point(1, 1), { types });
    expect(() => decode(bytes)).toThrow(/no registered type for: Point/);
  });

  it("without extensions, the class still throws on encode", () => {
    expect(() => encode(new Point(1, 1))).toThrow(/unsupported object type: Point/);
  });

  it("a cycle through a custom value is rejected", () => {
    class Box {
      inner: unknown = null;
    }
    const boxExt: TypeExtension<Box> = {
      name: "Box",
      match: (v) => v instanceof Box,
      encode: (b) => ({ inner: b.inner }),
      decode: (s) => {
        const b = new Box();
        b.inner = (s as { inner: unknown }).inner;
        return b;
      },
    };
    const b = new Box();
    b.inner = b; // self-cycle through the custom value
    expect(() => decode(encode(b, { types: [boxExt] }), { types: [boxExt] })).toThrow(
      /cycle through custom type: Box/,
    );
  });

  it("WeakProvider is supplied via options.provider", () => {
    const k = { id: 1 };
    const wm = new WeakMap<object, unknown>();
    const root = { wm, k };
    const out = decode(encode(root, { provider: { weakMapEntries: () => [[k, "v"]] } })) as {
      wm: WeakMap<object, unknown>;
      k: object;
    };
    expect(out.wm.get(out.k)).toBe("v");
  });
});

describe("decode safety limits", () => {
  function stream(body: (w: ByteWriter) => void): Uint8Array {
    const w = new ByteWriter();
    w.bytes(MAGIC);
    w.u8(VERSION);
    body(w);
    return w.toUint8Array();
  }

  it("rejects a node count larger than the buffer", () => {
    const bytes = stream((w) => {
      w.uvarint(0); // root
      w.uvarint(1000); // absurd count, but few bytes follow
    });
    expect(() => decode(bytes)).toThrow(/exceeds available bytes/);
  });

  it("honors maxNodes", () => {
    const bytes = encode({ a: 1, b: 2, c: 3 });
    expect(() => decode(bytes, { maxNodes: 1 })).toThrow(/exceeds maxNodes/);
  });

  it("rejects an out-of-range root index", () => {
    const bytes = stream((w) => {
      w.uvarint(9); // root past the end
      w.uvarint(1);
      w.u8(Tag.Null);
    });
    expect(() => decode(bytes)).toThrow(/root index 9 out of range/);
  });

  it("rejects an out-of-range reference", () => {
    const bytes = stream((w) => {
      w.uvarint(0); // root
      w.uvarint(1); // count = 1
      w.u8(Tag.Array); // node 0: array with one ref pointing out of range
      w.uvarint(1); // length 1
      w.uvarint(5); // ref 5 (out of range)
    });
    expect(() => decode(bytes)).toThrow(/reference out of range: 5/);
  });
});
