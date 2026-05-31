#!/usr/bin/env node
// Graft CLI — inspect a .bin and diff two .bin files at the value-graph level.
// This is a Node entry point (it touches the filesystem); it is intentionally
// NOT part of the library bundle, which stays runtime-agnostic.
//
//   graft inspect <file.bin>          # readable tree + summary
//   graft diff <a.bin> <b.bin>        # semantic differences (exit 1 if any)

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { decode } from "./decode";

function read(path: string): Uint8Array {
  return new Uint8Array(readFileSync(path));
}

function typeName(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "Array";
  const t = typeof v;
  if (t !== "object") return t;
  const ctor = (v as object).constructor;
  return ctor ? ctor.name : "Object";
}

// --- inspect -----------------------------------------------------------------

export function format(value: unknown): string {
  const ids = new Map<object, number>();
  let next = 0;
  const lines: string[] = [];

  const scalar = (v: unknown): string | null => {
    switch (typeof v) {
      case "string":
        return JSON.stringify(v);
      case "bigint":
        return v.toString() + "n";
      case "number":
        return Object.is(v, -0) ? "-0" : String(v);
      case "boolean":
        return String(v);
      case "undefined":
        return "undefined";
      case "symbol":
        return v.toString();
    }
    if (v === null) return "null";
    return null;
  };

  const write = (v: unknown, indent: string): string => {
    const s = scalar(v);
    if (s !== null) return s;
    const obj = v as object;

    if (ids.has(obj)) return `→ #${ids.get(obj)} (shared/cycle)`;
    const id = next++;
    ids.set(obj, id);
    const tag = `#${id} ${typeName(obj)}`;
    const inner = indent + "  ";

    if (obj instanceof Date)
      return `${tag}(${isNaN(obj.getTime()) ? "Invalid" : obj.toISOString()})`;
    if (obj instanceof RegExp) return `${tag}(/${obj.source}/${obj.flags})`;
    if (typeof URL !== "undefined" && obj instanceof URL) return `${tag}(${obj.href})`;
    if (obj instanceof ArrayBuffer || ArrayBuffer.isView(obj)) {
      const bytes =
        obj instanceof ArrayBuffer
          ? new Uint8Array(obj)
          : new Uint8Array(
              (obj as ArrayBufferView).buffer,
              (obj as ArrayBufferView).byteOffset,
              (obj as ArrayBufferView).byteLength,
            );
      const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join(" ");
      return `${tag}[${bytes.length}B] ${hex}`;
    }
    if (Array.isArray(obj)) {
      if (obj.length === 0) return `${tag}(0) []`;
      const body = obj.map((x, i) => `${inner}${i}: ${write(x, inner)}`).join("\n");
      return `${tag}(${obj.length}) [\n${body}\n${indent}]`;
    }
    if (obj instanceof Map) {
      const body = [...obj]
        .map(([k, val]) => `${inner}${write(k, inner)} => ${write(val, inner)}`)
        .join("\n");
      return `${tag}(${obj.size}) {\n${body}\n${indent}}`;
    }
    if (obj instanceof Set) {
      const body = [...obj].map((x) => `${inner}${write(x, inner)}`).join("\n");
      return `${tag}(${obj.size}) {\n${body}\n${indent}}`;
    }
    if (obj instanceof Error) {
      return `${tag}(${obj.name}: ${JSON.stringify(obj.message)})`;
    }
    // plain object (string + symbol keys)
    const keys: Array<string | symbol> = [
      ...Object.keys(obj),
      ...Object.getOwnPropertySymbols(obj).filter(
        (sym) => Object.getOwnPropertyDescriptor(obj, sym)?.enumerable,
      ),
    ];
    if (keys.length === 0) return `${tag} {}`;
    const body = keys
      .map(
        (k) =>
          `${inner}${String(k)}: ${write((obj as Record<string | symbol, unknown>)[k], inner)}`,
      )
      .join("\n");
    return `${tag} {\n${body}\n${indent}}`;
  };

  lines.push(write(value, ""));
  return lines.join("\n");
}

export function histogram(value: unknown): Map<string, number> {
  const counts = new Map<string, number>();
  const seen = new WeakSet<object>();
  const visit = (v: unknown): void => {
    // Count each distinct object once; count every primitive occurrence.
    if (typeof v === "object" && v !== null) {
      if (seen.has(v)) return;
      seen.add(v);
    }
    const name = typeof v === "object" && v !== null ? typeName(v) : v === null ? "null" : typeof v;
    counts.set(name, (counts.get(name) ?? 0) + 1);
    if (typeof v !== "object" || v === null) return;
    if (Array.isArray(v)) {
      v.forEach(visit);
    } else if (v instanceof Map) {
      for (const [k, val] of v) {
        visit(k);
        visit(val);
      }
    } else if (v instanceof Set) {
      for (const x of v) visit(x);
    } else if (v instanceof Date || v instanceof RegExp || v instanceof ArrayBuffer) {
      return;
    } else if (ArrayBuffer.isView(v)) {
      return;
    } else {
      const rec = v as Record<string | symbol, unknown>;
      for (const k of Object.keys(v)) visit(rec[k]);
      for (const s of Object.getOwnPropertySymbols(v)) visit(rec[s]);
    }
  };
  visit(value);
  return counts;
}

function inspect(path: string): number {
  const value = decode(read(path));
  console.log(format(value));
  const hist = [...histogram(value)].sort((a, b) => b[1] - a[1]);
  console.log("\nsummary: " + hist.map(([k, n]) => `${k}×${n}`).join(", "));
  return 0;
}

// --- diff --------------------------------------------------------------------

function diff(pathA: string, pathB: string): number {
  const diffs = diffValues(decode(read(pathA)), decode(read(pathB)));
  if (diffs.length === 0) {
    console.log("identical");
    return 0;
  }
  for (const d of diffs) console.log(d);
  console.log(`\n${diffs.length} difference(s)`);
  return 1;
}

/** Semantic differences between two decoded value graphs, as path-tagged lines. */
export function diffValues(a: unknown, b: unknown): string[] {
  const diffs: string[] = [];
  const seen = new Set<unknown>();

  const cmp = (x: unknown, y: unknown, path: string): void => {
    if (Object.is(x, y)) return;
    const tx = typeName(x);
    const ty = typeName(y);
    if (tx !== ty) {
      diffs.push(`${path}: type ${tx} != ${ty}`);
      return;
    }
    if (typeof x !== "object" || x === null) {
      if (typeof x === "bigint" && x === (y as bigint)) return;
      diffs.push(`${path}: ${fmtScalar(x)} != ${fmtScalar(y)}`);
      return;
    }
    const key = x as object;
    if (seen.has(key)) return; // avoid infinite recursion on cycles
    seen.add(key);

    if (x instanceof Date) {
      if (x.getTime() !== (y as Date).getTime()) diffs.push(`${path}: Date differs`);
      return;
    }
    if (x instanceof RegExp) {
      const r = y as RegExp;
      if (x.source !== r.source || x.flags !== r.flags) diffs.push(`${path}: RegExp differs`);
      return;
    }
    if (Array.isArray(x)) {
      const arrY = y as unknown[];
      if (x.length !== arrY.length) diffs.push(`${path}: length ${x.length} != ${arrY.length}`);
      for (let i = 0; i < Math.max(x.length, arrY.length); i++) cmp(x[i], arrY[i], `${path}[${i}]`);
      return;
    }
    if (x instanceof Map) {
      cmp([...x], [...(y as Map<unknown, unknown>)], `${path}(map)`);
      return;
    }
    if (x instanceof Set) {
      cmp([...x], [...(y as Set<unknown>)], `${path}(set)`);
      return;
    }
    // plain object / Error: compare own enumerable string keys
    const kx = Object.keys(x as object);
    const ky = new Set(Object.keys(y as object));
    for (const k of kx) {
      if (!ky.has(k)) diffs.push(`${path}.${k}: only in A`);
      else
        cmp((x as Record<string, unknown>)[k], (y as Record<string, unknown>)[k], `${path}.${k}`);
      ky.delete(k);
    }
    for (const k of ky) diffs.push(`${path}.${k}: only in B`);
  };

  cmp(a, b, "$");
  return diffs;
}

function fmtScalar(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "bigint") return v.toString() + "n";
  if (Object.is(v, -0)) return "-0";
  return String(v);
}

// --- main --------------------------------------------------------------------

function main(argv: string[]): number {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "inspect":
      if (rest.length !== 1) return usage();
      return inspect(rest[0]);
    case "diff":
      if (rest.length !== 2) return usage();
      return diff(rest[0], rest[1]);
    default:
      return usage();
  }
}

function usage(): number {
  console.error("usage:\n  graft inspect <file.bin>\n  graft diff <a.bin> <b.bin>");
  return 2;
}

// Only run when executed directly (so the module can also be imported safely).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
