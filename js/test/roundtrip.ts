import { encode, decode, type WeakProvider } from "../src/index.js";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    pass++;
    console.log("  ok  " + name);
  } else {
    fail++;
    console.log("FAIL  " + name);
  }
}

// ---- primitives & special numbers ----
{
  const v = {
    n: null,
    u: undefined,
    t: true,
    f: false,
    i: 42,
    neg: -7,
    big: 9007199254740993, // > MAX_SAFE as float still exact-int? -> 9007199254740992 region
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
  check("null", out.n === null);
  check("undefined preserved", out.u === undefined && "u" in out);
  check("bool", out.t === true && out.f === false);
  check("int", out.i === 42 && out.neg === -7);
  check("float", out.fl === 3.14);
  check("NaN", Number.isNaN(out.nan));
  check("-0 preserved", Object.is(out.negZero, -0));
  check("Infinity", out.inf === Infinity && out.ninf === -Infinity);
  check("bigint", out.bi === 123456789012345678901234567890n && out.nbi === -42n);
  check("unicode string", out.s === "héllo 🌊");
}

// ---- cycles & shared identity ----
{
  const a: any = { name: "a" };
  const b: any = { name: "b", peer: a };
  a.peer = b;
  a.self = a;
  const shared = { tag: "shared" };
  const root = { a, b, x: shared, y: shared };
  const out = decode(encode(root)) as any;
  check("cycle a.self === a", out.a.self === out.a);
  check("cross ref a.peer === b", out.a.peer === out.b);
  check("cross ref b.peer === a", out.b.peer === out.a);
  check("shared identity preserved", out.x === out.y);
}

// ---- Map / Set with object keys ----
{
  const key = { k: 1 };
  const m = new Map<unknown, unknown>([[key, "v"], ["str", 99]]);
  const s = new Set([1, key, "z"]);
  const root = { m, s, key };
  const out = decode(encode(root)) as any;
  check("map size", out.m.size === 2);
  check("map object-key identity", out.m.get(out.key) === "v");
  check("map string key", out.m.get("str") === 99);
  check("set has shared key", out.s.has(out.key));
  check("set primitive", out.s.has(1) && out.s.has("z"));
}

// ---- Symbols ----
{
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
  check("registered symbol restored & identical", out[Symbol.for("app.id")] === 1);
  check("well-known Symbol.iterator", out.iter === Symbol.iterator);
  check("unique symbol file-internal identity", out.pairA === out.pairB);
  // unique symbol value is present under *some* symbol key
  const symKeys = Object.getOwnPropertySymbols(out);
  const uniqKey = symKeys.find((k) => k.description === "desc" && k !== Symbol.for("app.id"));
  check("unique symbol key present with desc", uniqKey !== undefined && out[uniqKey!] === 2);
}

// ---- WeakMap / WeakSet via explicit provider ----
{
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
  check("weakmap restores via reachable key identity", out.wm.get(out.k1) === "one");
  check("weakmap second entry", out.wm.get(out.k2) === "two");
  check("weakset restores", out.ws.has(out.k1) && !out.ws.has(out.k2));
}

// ---- arrays with holes treated as undefined (documented behavior) ----
{
  const arr = [1, , 3]; // eslint-disable-line no-sparse-arrays
  const out = decode(encode(arr)) as unknown[];
  check("array length preserved", out.length === 3);
  check("array hole -> undefined", out[1] === undefined);
}

// ---- Date ----
{
  const root = {
    epoch: new Date(0),
    negative: new Date(-1),
    normal: new Date("2024-01-15T12:00:00.000Z"),
    far_future: new Date(253402300799999),
  };
  const out = decode(encode(root)) as typeof root;
  check("date epoch", out.epoch instanceof Date && out.epoch.getTime() === 0);
  check("date negative (pre-epoch)", out.negative instanceof Date && out.negative.getTime() === -1);
  check(
    "date normal",
    out.normal instanceof Date && out.normal.getTime() === Date.parse("2024-01-15T12:00:00.000Z")
  );
  check("date far future", out.far_future instanceof Date && out.far_future.getTime() === 253402300799999);

  const d = new Date();
  const idRoot = { a: d, b: d };
  const idOut = decode(encode(idRoot)) as typeof idRoot;
  check("date shared identity a === b", idOut.a === idOut.b);
  check("date shared identity value", idOut.a.getTime() === d.getTime());
}

// ---- ArrayBuffer / TypedArray ----
{
  const ab = new ArrayBuffer(4);
  new Uint8Array(ab).set([1, 2, 3, 4]);
  const out = decode(encode({ ab })) as { ab: ArrayBuffer };
  check("arraybuffer is ArrayBuffer", out.ab instanceof ArrayBuffer && out.ab.byteLength === 4);
  check(
    "arraybuffer bytes",
    [...new Uint8Array(out.ab)].join(",") === "1,2,3,4"
  );

  const root = {
    u8: new Uint8Array([0, 127, 255]),
    i16: new Int16Array([-32768, 0, 32767]),
    f64: new Float64Array([1.1, NaN, -0, Infinity]),
    bi64: new BigInt64Array([0n, -1n, 9223372036854775807n]),
    clamped: new Uint8ClampedArray([0, 128, 255]),
    empty: new Uint8Array([]),
  };
  const o = decode(encode(root)) as typeof root;
  check("Uint8Array type & values", o.u8 instanceof Uint8Array && [...o.u8].join(",") === "0,127,255");
  check("Int16Array type & values", o.i16 instanceof Int16Array && [...o.i16].join(",") === "-32768,0,32767");
  check(
    "Float64Array type & special values",
    o.f64 instanceof Float64Array &&
      o.f64[0] === 1.1 &&
      Number.isNaN(o.f64[1]) &&
      Object.is(o.f64[2], -0) &&
      o.f64[3] === Infinity
  );
  check(
    "BigInt64Array type & values",
    o.bi64 instanceof BigInt64Array && o.bi64[0] === 0n && o.bi64[1] === -1n && o.bi64[2] === 9223372036854775807n
  );
  check(
    "Uint8ClampedArray type & values",
    o.clamped instanceof Uint8ClampedArray && [...o.clamped].join(",") === "0,128,255"
  );
  check("empty Uint8Array", o.empty instanceof Uint8Array && o.empty.length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
