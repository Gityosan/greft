// Generates the golden binary vectors in spec/golden/.
// Each .bin file is a single Object node whose keys are the named test cases.
// Run with: cd js && npx tsx scripts/gen-golden.ts
//
// Paths are resolved relative to this file so the output location is stable
// no matter where the script is launched from.

import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { encode } from "../src/index";

const here = dirname(fileURLToPath(import.meta.url));
const goldenDir = join(here, "..", "..", "spec", "golden");
mkdirSync(goldenDir, { recursive: true });

function emit(name: string, value: unknown): void {
  const path = join(goldenDir, name);
  writeFileSync(path, encode(value));
  const metaPath = path.replace(/\.bin$/, ".meta.json");
  writeFileSync(metaPath, JSON.stringify(toMeta(value), null, 2) + "\n");
  console.log("wrote " + path + " (+ .meta.json)");
}

// --- language-neutral expectation sidecar (see conformance/README.md §2) ---
// Mirrors the decoded heap as JSON: reference types get a stable index in
// `nodes` and are cited as { "$ref": n } (so shared identity and cycles are
// expressible), while primitives are inlined as tagged leaves.
const elementTypeName: Array<[new (...a: never[]) => ArrayBufferView, string]> = [
  [BigInt64Array, "BigInt64"],
  [BigUint64Array, "BigUint64"],
  [Float64Array, "Float64"],
  [Float32Array, "Float32"],
  [Int32Array, "Int32"],
  [Uint32Array, "Uint32"],
  [Int16Array, "Int16"],
  [Uint16Array, "Uint16"],
  [Int8Array, "Int8"],
  [Uint8ClampedArray, "Uint8Clamped"],
  [Uint8Array, "Uint8"],
];

function toHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

function toMeta(root: unknown): { root: unknown; nodes: unknown[] } {
  const ids = new Map<unknown, number>();
  const nodes: unknown[] = [];

  const ref = (v: unknown): unknown => {
    if (v === null) return { $: "null" };
    if (typeof v !== "object" && typeof v !== "symbol") return inline(v);
    const seen = ids.get(v);
    if (seen !== undefined) return { $ref: seen };
    const idx = nodes.length;
    ids.set(v, idx);
    nodes.push(null); // reserve slot first so cycles resolve to this index
    nodes[idx] = node(v);
    return { $ref: idx };
  };

  const inline = (v: unknown): unknown => {
    switch (typeof v) {
      case "undefined":
        return { $: "undefined" };
      case "boolean":
        return { $: "bool", v };
      case "string":
        return { $: "string", v };
      case "bigint":
        return { $: "bigint", v: v.toString() };
      case "number": {
        if (Number.isInteger(v) && !Object.is(v, -0)) return { $: "int", v };
        if (Number.isNaN(v)) return { $: "float", v: "NaN" };
        if (v === Infinity) return { $: "float", v: "Infinity" };
        if (v === -Infinity) return { $: "float", v: "-Infinity" };
        if (Object.is(v, -0)) return { $: "float", v: "-0" };
        return { $: "float", v };
      }
      default:
        throw new Error("cannot inline meta for " + typeof v);
    }
  };

  const node = (v: object | symbol): unknown => {
    if (typeof v === "symbol") {
      const key = Symbol.keyFor(v);
      if (key !== undefined) return { tag: "SymbolRegistered", key };
      // Well-known symbols share identity with Symbol.iterator etc.
      const wk = Object.getOwnPropertyNames(Symbol).find(
        (n) => (Symbol as Record<string, unknown>)[n] === v,
      );
      if (wk) return { tag: "SymbolWellKnown", name: wk };
      return { tag: "SymbolUnique", description: v.description ?? "" };
    }
    if (v instanceof Date) return { tag: "Date", unix_ms: v.getTime(), sub_ms_nanos: 0 };
    if (v instanceof RegExp) return { tag: "RegExp", source: v.source, flags: v.flags };
    for (const [Ctor, name] of elementTypeName) {
      if (v instanceof Ctor) {
        const view = v as ArrayBufferView;
        const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
        return { tag: "TypedArray", element_type: name, hex: toHex(bytes) };
      }
    }
    if (v instanceof ArrayBuffer) return { tag: "Bytes", hex: toHex(new Uint8Array(v)) };
    if (Array.isArray(v)) return { tag: "Array", items: v.map((x) => ref(x)) };
    if (v instanceof Map)
      return {
        tag: "Map",
        entries: [...v.entries()].map(([k, val]) => ({ key: ref(k), value: ref(val) })),
      };
    if (v instanceof Set) return { tag: "Set", values: [...v.values()].map((x) => ref(x)) };
    // plain object: string keys (insertion order) then enumerable symbol keys
    const entries: unknown[] = [];
    for (const k of Object.keys(v)) {
      entries.push({ keyKind: "string", key: k, value: ref((v as Record<string, unknown>)[k]) });
    }
    for (const s of Object.getOwnPropertySymbols(v)) {
      if (!Object.getOwnPropertyDescriptor(v, s)?.enumerable) continue;
      entries.push({
        keyKind: "symbol",
        key: ref(s),
        value: ref((v as Record<symbol, unknown>)[s]),
      });
    }
    return { tag: "Object", entries };
  };

  const r = ref(root);
  return { root: r, nodes };
}

// --- primitives / special numbers (FORMAT.md §5.1) ---
emit("primitive.bin", {
  null: null,
  undefined: undefined,
  true: true,
  false: false,
  int: 42,
  negative_int: -7,
  float: 3.14,
  nan: NaN,
  negative_zero: -0,
  infinity: Infinity,
  negative_infinity: -Infinity,
});

// --- bigint (FORMAT.md §5.1) ---
emit("bigint.bin", {
  zero: 0n,
  positive: 123456789012345678901234567890n,
  negative: -987654321098765432109876543210n,
});

// --- strings (FORMAT.md §2.4) ---
emit("string.bin", {
  empty: "",
  ascii: "hello world",
  multibyte: "héllo こんにちは",
  emoji: "🌊🚀✨",
});

// --- Date (FORMAT.md §5.3) ---
emit("date.bin", {
  epoch: new Date(0),
  negative: new Date(-1),
  normal: new Date("2024-01-15T12:00:00.000Z"),
  far_future: new Date(253402300799999),
});

// --- ArrayBuffer / Bytes (FORMAT.md §5.1) ---
{
  const ab = new ArrayBuffer(4);
  new Uint8Array(ab).set([1, 2, 3, 4]);
  const empty = new ArrayBuffer(0);
  emit("bytes.bin", { buffer: ab, empty });
}

// --- TypedArray, every ElementType (FORMAT.md §5.4) ---
emit("typedarray.bin", {
  uint8: new Uint8Array([0, 127, 255]),
  uint8_clamped: new Uint8ClampedArray([0, 128, 255]),
  uint16: new Uint16Array([0, 256, 65535]),
  uint32: new Uint32Array([0, 65536, 4294967295]),
  int8: new Int8Array([-128, 0, 127]),
  int16: new Int16Array([-32768, 0, 32767]),
  int32: new Int32Array([-2147483648, 0, 2147483647]),
  float32: new Float32Array([1.5, -0, Infinity]),
  float64: new Float64Array([1.1, NaN, -0, Infinity]),
  bigint64: new BigInt64Array([0n, -1n, 9223372036854775807n]),
  biguint64: new BigUint64Array([0n, 1n, 18446744073709551615n]),
  empty: new Uint8Array([]),
});

// --- RegExp (FORMAT.md §5.1, Tag 43) ---
emit("regexp.bin", {
  simple: /abc/,
  flags: /ab+c/gi,
  empty: new RegExp(""),
  unicode: /\p{Letter}+/u,
  special: /[/\\]"'\n\t/,
});

// --- Map / Set, including object keys (FORMAT.md §5.5) ---
{
  const objKey = { k: 1 };
  const map = new Map<unknown, unknown>([
    ["string_key", 99],
    [objKey, "object-keyed value"],
    [42, "number key"],
  ]);
  const set = new Set<unknown>([1, "two", objKey]);
  emit("map_set.bin", { map, set, shared_key: objKey });
}

// --- Symbols: Registered / Unique / WellKnown (FORMAT.md §5.2) ---
{
  const registered = Symbol.for("app.id");
  const unique = Symbol("desc");
  emit("symbol.bin", {
    [registered]: "registered value",
    [unique]: "unique value",
    well_known: Symbol.iterator,
    unique_again: unique, // file-internal identity for the unique symbol
  });
}

// --- cycles & shared identity (FORMAT.md §4) ---
{
  const a: Record<string, unknown> = { name: "a" };
  const b: Record<string, unknown> = { name: "b", peer: a };
  a.peer = b;
  a.self = a;
  const shared = { tag: "shared" };
  emit("cycles.bin", { a, b, x: shared, y: shared });
}

console.log("\ngolden vectors written to " + goldenDir);
