import { describe, it, expect } from "vitest";
import { encode, decode, type WeakProvider } from "../src/index.js";

describe("primitives & special numbers", () => {
  const v = {
    n: null,
    u: undefined,
    t: true,
    f: false,
    i: 42,
    neg: -7,
    fl: 3.14,
    nan: NaN,
    negZero: -0,
    inf: Infinity,
    ninf: -Infinity,
    bi: 123456789012345678901234567890n,
    nbi: -42n,
    s: "héllo 🌊",
  };
  const out = decode(encode(v)) as typeof v;

  it("null", () => expect(out.n).toBeNull());
  it("undefined preserved", () => expect(out.u === undefined && "u" in out).toBe(true));
  it("bool", () => expect(out.t === true && out.f === false).toBe(true));
  it("int", () => expect(out.i === 42 && out.neg === -7).toBe(true));
  it("float", () => expect(out.fl).toBe(3.14));
  it("NaN", () => expect(Number.isNaN(out.nan)).toBe(true));
  it("-0 preserved", () => expect(Object.is(out.negZero, -0)).toBe(true));
  it("Infinity", () => expect(out.inf === Infinity && out.ninf === -Infinity).toBe(true));
  it("bigint", () =>
    expect(out.bi === 123456789012345678901234567890n && out.nbi === -42n).toBe(true));
  it("unicode string", () => expect(out.s).toBe("héllo 🌊"));
});

describe("cycles & shared identity", () => {
  const a: any = { name: "a" };
  const b: any = { name: "b", peer: a };
  a.peer = b;
  a.self = a;
  const shared = { tag: "shared" };
  const root = { a, b, x: shared, y: shared };
  const out = decode(encode(root)) as any;

  it("cycle a.self === a", () => expect(out.a.self).toBe(out.a));
  it("cross ref a.peer === b", () => expect(out.a.peer).toBe(out.b));
  it("cross ref b.peer === a", () => expect(out.b.peer).toBe(out.a));
  it("shared identity preserved", () => expect(out.x).toBe(out.y));
});

describe("Map / Set with object keys", () => {
  const key = { k: 1 };
  const m = new Map<unknown, unknown>([
    [key, "v"],
    ["str", 99],
  ]);
  const s = new Set([1, key, "z"]);
  const root = { m, s, key };
  const out = decode(encode(root)) as any;

  it("map size", () => expect(out.m.size).toBe(2));
  it("map object-key identity", () => expect(out.m.get(out.key)).toBe("v"));
  it("map string key", () => expect(out.m.get("str")).toBe(99));
  it("set has shared key", () => expect(out.s.has(out.key)).toBe(true));
  it("set primitive", () => expect(out.s.has(1) && out.s.has("z")).toBe(true));
});

describe("Symbols", () => {
  const reg = Symbol.for("app.id");
  const uniq = Symbol("desc");
  const root = {
    [reg]: 1,
    [uniq]: 2,
    iter: Symbol.iterator,
    pairA: uniq,
    pairB: uniq, // same unique symbol used twice -> file-internal identity
  };
  const out = decode(encode(root)) as any;

  it("registered symbol restored & identical", () => expect(out[Symbol.for("app.id")]).toBe(1));
  it("well-known Symbol.iterator", () => expect(out.iter).toBe(Symbol.iterator));
  it("unique symbol file-internal identity", () => expect(out.pairA).toBe(out.pairB));
  it("unique symbol key present with desc", () => {
    const symKeys = Object.getOwnPropertySymbols(out);
    const uniqKey = symKeys.find((k) => k.description === "desc" && k !== Symbol.for("app.id"));
    expect(uniqKey !== undefined && out[uniqKey!] === 2).toBe(true);
  });
});

describe("WeakMap / WeakSet via explicit provider", () => {
  const k1 = { id: 1 };
  const k2 = { id: 2 };
  const wm = new WeakMap<object, unknown>();
  wm.set(k1, "one");
  wm.set(k2, "two");
  const ws = new WeakSet<object>();
  ws.add(k1);

  // The keys must also be reachable in the graph for identity-based restore.
  const root = { wm, ws, k1, k2 };

  const provider: WeakProvider = {
    weakMapEntries: () => [
      [k1, "one"],
      [k2, "two"],
    ],
    weakSetValues: () => [k1],
  };

  const out = decode(encode(root, provider)) as any;

  it("weakmap restores via reachable key identity", () => expect(out.wm.get(out.k1)).toBe("one"));
  it("weakmap second entry", () => expect(out.wm.get(out.k2)).toBe("two"));
  it("weakset restores", () => expect(out.ws.has(out.k1) && !out.ws.has(out.k2)).toBe(true));
});

describe("arrays with holes treated as undefined", () => {
  const arr = [1, , 3]; // eslint-disable-line no-sparse-arrays
  const out = decode(encode(arr)) as unknown[];

  it("array length preserved", () => expect(out.length).toBe(3));
  it("array hole -> undefined", () => expect(out[1]).toBeUndefined());
});

describe("Date", () => {
  const root = {
    epoch: new Date(0),
    negative: new Date(-1),
    normal: new Date("2024-01-15T12:00:00.000Z"),
    far_future: new Date(253402300799999),
  };
  const out = decode(encode(root)) as typeof root;

  it("date epoch", () => expect(out.epoch instanceof Date && out.epoch.getTime() === 0).toBe(true));
  it("date negative (pre-epoch)", () =>
    expect(out.negative instanceof Date && out.negative.getTime() === -1).toBe(true));
  it("date normal", () =>
    expect(
      out.normal instanceof Date && out.normal.getTime() === Date.parse("2024-01-15T12:00:00.000Z"),
    ).toBe(true));
  it("date far future", () =>
    expect(out.far_future instanceof Date && out.far_future.getTime() === 253402300799999).toBe(
      true,
    ));

  it("date shared identity & value", () => {
    const d = new Date();
    const idOut = decode(encode({ a: d, b: d })) as { a: Date; b: Date };
    expect(idOut.a === idOut.b && idOut.a.getTime() === d.getTime()).toBe(true);
  });
});

describe("ArrayBuffer / TypedArray", () => {
  it("ArrayBuffer roundtrips type & bytes", () => {
    const ab = new ArrayBuffer(4);
    new Uint8Array(ab).set([1, 2, 3, 4]);
    const out = decode(encode({ ab })) as { ab: ArrayBuffer };
    expect(out.ab instanceof ArrayBuffer && out.ab.byteLength === 4).toBe(true);
    expect([...new Uint8Array(out.ab)].join(",")).toBe("1,2,3,4");
  });

  const root = {
    u8: new Uint8Array([0, 127, 255]),
    i16: new Int16Array([-32768, 0, 32767]),
    f64: new Float64Array([1.1, NaN, -0, Infinity]),
    bi64: new BigInt64Array([0n, -1n, 9223372036854775807n]),
    clamped: new Uint8ClampedArray([0, 128, 255]),
    empty: new Uint8Array([]),
  };
  const o = decode(encode(root)) as typeof root;

  it("Uint8Array type & values", () =>
    expect(o.u8 instanceof Uint8Array && [...o.u8].join(",") === "0,127,255").toBe(true));
  it("Int16Array type & values", () =>
    expect(o.i16 instanceof Int16Array && [...o.i16].join(",") === "-32768,0,32767").toBe(true));
  it("Float64Array type & special values", () =>
    expect(
      o.f64 instanceof Float64Array &&
        o.f64[0] === 1.1 &&
        Number.isNaN(o.f64[1]) &&
        Object.is(o.f64[2], -0) &&
        o.f64[3] === Infinity,
    ).toBe(true));
  it("BigInt64Array type & values", () =>
    expect(
      o.bi64 instanceof BigInt64Array &&
        o.bi64[0] === 0n &&
        o.bi64[1] === -1n &&
        o.bi64[2] === 9223372036854775807n,
    ).toBe(true));
  it("Uint8ClampedArray type & values", () =>
    expect(o.clamped instanceof Uint8ClampedArray && [...o.clamped].join(",") === "0,128,255").toBe(
      true,
    ));
  it("empty Uint8Array", () =>
    expect(o.empty instanceof Uint8Array && o.empty.length === 0).toBe(true));
});
