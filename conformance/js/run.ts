// Reference conformance runner (JavaScript / TypeScript port).
//
// This is the canonical example that every other-language port models its own
// conformance suite on. It does exactly what conformance/README.md §2 asks:
//
//   1. read each spec/golden/*.bin as raw bytes,
//   2. decode it with the reference decoder,
//   3. load the matching *.meta.json sidecar,
//   4. assert the decoded value matches the language-neutral expectation,
//      including shared identity and cycles (the `$ref` mechanism),
//   5. exit non-zero if any vector fails.
//
// Run with:  cd js && pnpm conformance      (or: npx tsx ../conformance/js/run.ts)

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { decode } from "../../js/src/index";

const here = dirname(fileURLToPath(import.meta.url));
const goldenDir = join(here, "..", "..", "spec", "golden");

// --- meta.json shapes (see conformance/README.md §2) ---
type Meta = { root: MetaValue; nodes: MetaNode[] };
type MetaRef = { $ref: number };
type MetaInline = { $: string; v?: unknown };
type MetaValue = MetaRef | MetaInline;
// Nodes are tagged unions; fields vary per tag, so they are read dynamically.
type MetaNode = { tag: string; [k: string]: unknown };

const isRef = (v: MetaValue): v is MetaRef => typeof v === "object" && v !== null && "$ref" in v;

const typedArrayByName: Record<string, new (b: ArrayBuffer) => ArrayBufferView> = {
  Uint8: Uint8Array,
  Uint8Clamped: Uint8ClampedArray,
  Uint16: Uint16Array,
  Uint32: Uint32Array,
  Int8: Int8Array,
  Int16: Int16Array,
  Int32: Int32Array,
  Float32: Float32Array,
  Float64: Float64Array,
  BigInt64: BigInt64Array,
  BigUint64: BigUint64Array,
};

function hex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

class Mismatch extends Error {}

// Compares one decoded value against its meta description, throwing on the
// first discrepancy with a path that points at the offending location.
function matchVector(decoded: unknown, meta: Meta): void {
  const nodes = meta.nodes;
  const bound = new Map<number, unknown>(); // $ref index -> the decoded object it names
  const claimed = new Set<unknown>(); // decoded objects already bound to some ref

  const fail = (path: string, msg: string): never => {
    throw new Mismatch(`${path}: ${msg}`);
  };
  const check = (ok: boolean, path: string, msg: string): void => {
    if (!ok) fail(path, msg);
  };

  function matchValue(mv: MetaValue, actual: unknown, path: string): void {
    if (isRef(mv)) {
      const ref = mv.$ref;
      if (bound.has(ref)) {
        // Second+ sighting: identity must hold (this is what proves shared
        // references and cycles were restored, not merely re-decoded copies).
        check(bound.get(ref) === actual, path, `identity mismatch for $ref ${ref}`);
        return;
      }
      bound.set(ref, actual);
      claimed.add(actual);
      const node = nodes[ref];
      if (!node) fail(path, `dangling $ref ${ref}`);
      matchNode(node, actual, `${path}#${ref}`);
      return;
    }
    matchInline(mv, actual, path);
  }

  function matchInline(mv: MetaInline, actual: unknown, path: string): void {
    switch (mv.$) {
      case "null":
        return check(actual === null, path, "expected null");
      case "undefined":
        return check(actual === undefined, path, "expected undefined");
      case "bool":
        return check(actual === mv.v, path, `expected bool ${String(mv.v)}`);
      case "int":
        return check(actual === mv.v, path, `expected int ${String(mv.v)}`);
      case "string":
        return check(actual === mv.v, path, `expected string ${JSON.stringify(mv.v)}`);
      case "bigint":
        return check(
          typeof actual === "bigint" && actual === BigInt(mv.v as string),
          path,
          `expected bigint ${String(mv.v)}`,
        );
      case "float":
        return matchFloat(mv.v, actual, path);
      default:
        return fail(path, `unknown inline tag ${mv.$}`);
    }
  }

  function matchFloat(v: unknown, actual: unknown, path: string): void {
    if (v === "NaN")
      return check(typeof actual === "number" && Number.isNaN(actual), path, "expected NaN");
    if (v === "Infinity") return check(actual === Infinity, path, "expected Infinity");
    if (v === "-Infinity") return check(actual === -Infinity, path, "expected -Infinity");
    if (v === "-0") return check(Object.is(actual, -0), path, "expected -0");
    return check(actual === v, path, `expected float ${String(v)}`);
  }

  function matchNode(node: MetaNode, actual: unknown, path: string): void {
    switch (node.tag) {
      case "Object":
        return matchObject(node, actual, path);
      case "Array": {
        const items = node.items as MetaValue[];
        check(Array.isArray(actual), path, "expected array");
        const arr = actual as unknown[];
        check(arr.length === items.length, path, `array length ${arr.length} != ${items.length}`);
        items.forEach((mv, i) => matchValue(mv, arr[i], `${path}[${i}]`));
        return;
      }
      case "Map": {
        const entries = node.entries as Array<{ key: MetaValue; value: MetaValue }>;
        check(actual instanceof Map, path, "expected Map");
        const pairs = [...(actual as Map<unknown, unknown>).entries()];
        check(
          pairs.length === entries.length,
          path,
          `map size ${pairs.length} != ${entries.length}`,
        );
        entries.forEach((e, i) => {
          matchValue(e.key, pairs[i][0], `${path}{key#${i}}`);
          matchValue(e.value, pairs[i][1], `${path}{val#${i}}`);
        });
        return;
      }
      case "Set": {
        const values = node.values as MetaValue[];
        check(actual instanceof Set, path, "expected Set");
        const vals = [...(actual as Set<unknown>).values()];
        check(vals.length === values.length, path, `set size ${vals.length} != ${values.length}`);
        values.forEach((mv, i) => matchValue(mv, vals[i], `${path}{#${i}}`));
        return;
      }
      case "Date":
        return check(
          actual instanceof Date && actual.getTime() === node.unix_ms,
          path,
          `expected Date(${String(node.unix_ms)})`,
        );
      case "Bytes":
        return check(
          actual instanceof ArrayBuffer && hex(new Uint8Array(actual)) === node.hex,
          path,
          "ArrayBuffer bytes mismatch",
        );
      case "TypedArray": {
        const Ctor = typedArrayByName[node.element_type as string];
        if (!Ctor) return fail(path, `unknown element_type ${String(node.element_type)}`);
        if (!(actual instanceof Ctor)) return fail(path, `expected ${String(node.element_type)}`);
        const view = actual as unknown as ArrayBufferView;
        const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
        return check(hex(bytes) === node.hex, path, "TypedArray bytes mismatch");
      }
      case "RegExp":
        return check(
          actual instanceof RegExp && actual.source === node.source && actual.flags === node.flags,
          path,
          `expected /${String(node.source)}/${String(node.flags)}`,
        );
      case "Url":
        return check(
          typeof URL !== "undefined" && actual instanceof URL && actual.href === node.href,
          path,
          `expected URL ${JSON.stringify(node.href)}`,
        );
      case "DataView": {
        if (!(actual instanceof DataView)) return fail(path, "expected DataView");
        const bytes = new Uint8Array(actual.buffer, actual.byteOffset, actual.byteLength);
        return check(hex(bytes) === node.hex, path, "DataView bytes mismatch");
      }
      case "Error":
        return matchError(node, actual, path);
      case "SymbolRegistered":
        return check(
          typeof actual === "symbol" && Symbol.keyFor(actual) === node.key,
          path,
          `expected Symbol.for(${JSON.stringify(node.key)})`,
        );
      case "SymbolWellKnown":
        return check(
          actual === (Symbol as unknown as Record<string, symbol>)[node.name as string],
          path,
          `expected well-known Symbol.${String(node.name)}`,
        );
      case "SymbolUnique":
        return check(
          typeof actual === "symbol" &&
            Symbol.keyFor(actual) === undefined &&
            (actual.description ?? "") === node.description,
          path,
          `expected unique Symbol(${JSON.stringify(node.description)})`,
        );
      default:
        return fail(path, `unknown node tag ${node.tag}`);
    }
  }

  function matchObject(node: MetaNode, actual: unknown, path: string): void {
    check(typeof actual === "object" && actual !== null, path, "expected object");
    const obj = actual as Record<string | symbol, unknown>;
    const entries = node.entries as Array<{
      keyKind: "string" | "symbol";
      key: string | MetaValue;
      value: MetaValue;
    }>;
    const stringEntries = entries.filter((e) => e.keyKind === "string");
    const symbolEntries = entries.filter((e) => e.keyKind === "symbol");

    const ownStringKeys = Object.keys(obj);
    check(
      ownStringKeys.length === stringEntries.length,
      path,
      `string key count ${ownStringKeys.length} != ${stringEntries.length}`,
    );
    for (const e of stringEntries) {
      const key = e.key as string;
      check(Object.prototype.hasOwnProperty.call(obj, key), path, `missing string key ${key}`);
      matchValue(e.value, obj[key], `${path}.${key}`);
    }

    const ownSyms = Object.getOwnPropertySymbols(obj).filter(
      (s) => Object.getOwnPropertyDescriptor(obj, s)?.enumerable,
    );
    check(
      ownSyms.length === symbolEntries.length,
      path,
      `symbol key count ${ownSyms.length} != ${symbolEntries.length}`,
    );
    for (const e of symbolEntries) {
      const keyRef = e.key as MetaRef;
      const target = resolveSymbolKey(keyRef, ownSyms, path);
      matchValue(keyRef, target, `${path}[symbol key]`); // binds / validates the symbol node
      matchValue(e.value, obj[target], `${path}[${String(target)}]`);
    }
  }

  function matchError(node: MetaNode, actual: unknown, path: string): void {
    check(actual instanceof Error, path, "expected Error");
    const err = actual as Error & { cause?: unknown };
    check(err.name === node.name, path, `error name ${err.name} != ${String(node.name)}`);
    check(err.message === node.message, path, `error message mismatch`);

    if (node.hasCause) {
      check(Object.prototype.hasOwnProperty.call(err, "cause"), path, "expected own cause");
      matchValue(node.cause as MetaValue, err.cause, `${path}.cause`);
    } else {
      check(!Object.prototype.hasOwnProperty.call(err, "cause"), path, "unexpected cause");
    }

    // Extra own enumerable props (intrinsic name/message/stack/cause excluded).
    const skip = new Set(["name", "message", "stack", "cause"]);
    const extra = node.extra as Array<{
      keyKind: "string" | "symbol";
      key: string | MetaValue;
      value: MetaValue;
    }>;
    const stringExtra = extra.filter((e) => e.keyKind === "string");
    const symbolExtra = extra.filter((e) => e.keyKind === "symbol");

    const ownStr = Object.keys(err).filter((k) => !skip.has(k));
    check(
      ownStr.length === stringExtra.length,
      path,
      `error extra string count ${ownStr.length} != ${stringExtra.length}`,
    );
    for (const e of stringExtra) {
      const key = e.key as string;
      check(Object.prototype.hasOwnProperty.call(err, key), path, `missing extra ${key}`);
      matchValue(e.value, (err as unknown as Record<string, unknown>)[key], `${path}.${key}`);
    }

    const ownSyms = Object.getOwnPropertySymbols(err).filter(
      (s) => Object.getOwnPropertyDescriptor(err, s)?.enumerable,
    );
    check(ownSyms.length === symbolExtra.length, path, `error extra symbol count`);
    for (const e of symbolExtra) {
      const keyRef = e.key as MetaRef;
      const target = resolveSymbolKey(keyRef, ownSyms, path);
      matchValue(keyRef, target, `${path}[symbol key]`);
      matchValue(
        e.value,
        (err as unknown as Record<symbol, unknown>)[target],
        `${path}[${String(target)}]`,
      );
    }
  }

  // Picks the decoded own-symbol that the meta key reference denotes.
  function resolveSymbolKey(keyRef: MetaRef, ownSyms: symbol[], path: string): symbol {
    const ref = keyRef.$ref;
    if (bound.has(ref)) {
      const s = bound.get(ref) as symbol;
      if (!ownSyms.includes(s)) fail(path, `bound symbol for $ref ${ref} not an own key`);
      return s;
    }
    const sym = nodes[ref];
    if (!sym) fail(path, `dangling symbol $ref ${ref}`);
    let target: symbol | undefined;
    if (sym.tag === "SymbolRegistered") target = ownSyms.find((s) => Symbol.keyFor(s) === sym.key);
    else if (sym.tag === "SymbolWellKnown")
      target = ownSyms.find(
        (s) => s === (Symbol as unknown as Record<string, symbol>)[sym.name as string],
      );
    else if (sym.tag === "SymbolUnique")
      target = ownSyms.find((s) => !claimed.has(s) && (s.description ?? "") === sym.description);
    else throw new Mismatch(`${path}: symbol key $ref ${ref} -> non-symbol node ${sym.tag}`);
    if (!target) throw new Mismatch(`${path}: no decoded symbol key matches node #${ref}`);
    return target;
  }

  matchValue(meta.root, decoded, "$");
}

function main(): void {
  if (!existsSync(goldenDir)) {
    console.error(`golden directory not found: ${goldenDir}`);
    process.exit(1);
  }
  const files = readdirSync(goldenDir)
    .filter((f) => f.endsWith(".bin"))
    .sort();

  console.log(`Graft conformance — JS reference port (${files.length} vectors)\n`);
  let passed = 0;
  let failed = 0;
  for (const file of files) {
    const metaName = file.replace(/\.bin$/, ".meta.json");
    try {
      if (!existsSync(join(goldenDir, metaName))) throw new Mismatch(`missing sidecar ${metaName}`);
      const bytes = new Uint8Array(readFileSync(join(goldenDir, file)));
      const decoded = decode(bytes);
      const meta = JSON.parse(readFileSync(join(goldenDir, metaName), "utf8")) as Meta;
      matchVector(decoded, meta);
      console.log(`  ✓ ${file}`);
      passed++;
    } catch (err) {
      console.error(`  ✗ ${file}: ${(err as Error).message}`);
      failed++;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
