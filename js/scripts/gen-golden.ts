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
  console.log("wrote " + path);
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
