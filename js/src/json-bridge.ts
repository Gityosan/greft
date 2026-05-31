// A human-friendly, JSON-serializable view of a Graft value, and its inverse.
//
// JSON can't represent most of what Graft preserves (undefined, bigint, Date,
// Map/Set, RegExp, typed arrays, symbols, NaN/-0/±Infinity, …), so those are
// rendered as tagged `{ "$graft": "<type>", … }` wrappers. `toJSON` output is
// always `JSON.stringify`-able; `fromJSON` reverses it.
//
// This is a *view* for inspection / hand-editing of fixtures — it is lossy on
// object identity (shared references are duplicated) and rejects cycles. For
// exact, identity-preserving transport use `encode` / `decode`.

const MARK = "$graft";

function symbolInfo(sym: symbol): { kind: string; value: string } {
  for (const n of Object.getOwnPropertyNames(Symbol)) {
    if ((Symbol as unknown as Record<string, unknown>)[n] === sym)
      return { kind: "well_known", value: n };
  }
  const key = Symbol.keyFor(sym);
  if (key !== undefined) return { kind: "registered", value: key };
  return { kind: "unique", value: sym.description ?? "" };
}

function symbolFrom(info: { kind: string; value: string }): symbol {
  if (info.kind === "registered") return Symbol.for(info.value);
  if (info.kind === "well_known") {
    const wk = (Symbol as unknown as Record<string, unknown>)[info.value];
    return typeof wk === "symbol" ? wk : Symbol(info.value);
  }
  return Symbol(info.value);
}

function toHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}
function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const typedArrayCtors: Record<string, new (b: ArrayBuffer) => ArrayBufferView> = {
  Uint8Array,
  Uint8ClampedArray,
  Uint16Array,
  Uint32Array,
  Int8Array,
  Int16Array,
  Int32Array,
  Float32Array,
  Float64Array,
  BigInt64Array,
  BigUint64Array,
};

/** Convert a Graft value into a JSON-serializable representation. */
export function toJSON(value: unknown): unknown {
  return convert(value, new WeakSet());
}

function convert(value: unknown, seen: WeakSet<object>): unknown {
  switch (typeof value) {
    case "undefined":
      return { [MARK]: "undefined" };
    case "boolean":
    case "string":
      return value;
    case "bigint":
      return { [MARK]: "bigint", value: value.toString() };
    case "number":
      if (Number.isNaN(value)) return { [MARK]: "number", value: "NaN" };
      if (value === Infinity) return { [MARK]: "number", value: "Infinity" };
      if (value === -Infinity) return { [MARK]: "number", value: "-Infinity" };
      if (Object.is(value, -0)) return { [MARK]: "number", value: "-0" };
      return value;
    case "symbol":
      return { [MARK]: "Symbol", ...symbolInfo(value) };
    case "function":
      throw new Error("functions cannot be represented as JSON");
    case "object":
      break;
    default:
      throw new Error("unsupported value");
  }
  if (value === null) return null;
  const obj = value as object;
  if (seen.has(obj)) throw new Error("cycle is not representable in the JSON bridge");
  seen.add(obj);
  try {
    return convertObject(obj, seen);
  } finally {
    seen.delete(obj);
  }
}

function convertObject(obj: object, seen: WeakSet<object>): unknown {
  if (Array.isArray(obj)) return obj.map((v) => convert(v, seen));
  if (obj instanceof Date) return { [MARK]: "Date", ms: obj.getTime() };
  if (obj instanceof RegExp) return { [MARK]: "RegExp", source: obj.source, flags: obj.flags };
  if (typeof URL !== "undefined" && obj instanceof URL) return { [MARK]: "URL", href: obj.href };
  if (obj instanceof Map) {
    return {
      [MARK]: "Map",
      entries: [...obj].map(([k, v]) => [convert(k, seen), convert(v, seen)]),
    };
  }
  if (obj instanceof Set) return { [MARK]: "Set", values: [...obj].map((v) => convert(v, seen)) };
  if (obj instanceof ArrayBuffer) {
    return { [MARK]: "ArrayBuffer", hex: toHex(new Uint8Array(obj)) };
  }
  if (obj instanceof DataView) {
    return {
      [MARK]: "DataView",
      hex: toHex(new Uint8Array(obj.buffer, obj.byteOffset, obj.byteLength)),
    };
  }
  if (ArrayBuffer.isView(obj)) {
    const view = obj as ArrayBufferView;
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    return { [MARK]: "TypedArray", kind: obj.constructor.name, hex: toHex(bytes) };
  }
  if (obj instanceof Error) {
    const out: Record<string, unknown> = { [MARK]: "Error", name: obj.name, message: obj.message };
    if (Object.prototype.hasOwnProperty.call(obj, "cause")) {
      out.cause = convert((obj as { cause?: unknown }).cause, seen);
    }
    for (const k of Object.keys(obj))
      out[k] = convert((obj as unknown as Record<string, unknown>)[k], seen);
    return out;
  }
  const proto = Object.getPrototypeOf(obj);
  if (proto !== null && proto !== Object.prototype) {
    throw new Error("unsupported object in JSON bridge: " + (obj.constructor?.name ?? "object"));
  }
  // Plain object. Natural form unless it has symbol keys or a literal $graft key.
  const symKeys = Object.getOwnPropertySymbols(obj).filter(
    (s) => Object.getOwnPropertyDescriptor(obj, s)?.enumerable,
  );
  const rec = obj as Record<string, unknown>;
  if (symKeys.length === 0 && !Object.prototype.hasOwnProperty.call(obj, MARK)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj)) out[k] = convert(rec[k], seen);
    return out;
  }
  const entries: unknown[] = [];
  for (const k of Object.keys(obj)) entries.push({ k, v: convert(rec[k], seen) });
  for (const s of symKeys) {
    entries.push({ ks: symbolInfo(s), v: convert((obj as Record<symbol, unknown>)[s], seen) });
  }
  return { [MARK]: "object", entries };
}

/** Reverse `toJSON`. */
export function fromJSON(json: unknown): unknown {
  if (json === null || typeof json !== "object") return json;
  if (Array.isArray(json)) return json.map(fromJSON);

  const rec = json as Record<string, unknown>;
  const tag = rec[MARK];
  if (typeof tag !== "string") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(rec)) out[k] = fromJSON(rec[k]);
    return out;
  }
  switch (tag) {
    case "undefined":
      return undefined;
    case "bigint":
      return BigInt(rec.value as string);
    case "number": {
      const v = rec.value;
      if (v === "NaN") return NaN;
      if (v === "Infinity") return Infinity;
      if (v === "-Infinity") return -Infinity;
      if (v === "-0") return -0;
      return Number(v);
    }
    case "Symbol":
      return symbolFrom(rec as unknown as { kind: string; value: string });
    case "Date":
      return new Date(rec.ms as number);
    case "RegExp":
      return new RegExp(rec.source as string, rec.flags as string);
    case "URL":
      return new URL(rec.href as string);
    case "Map":
      return new Map(
        (rec.entries as [unknown, unknown][]).map(([k, v]) => [fromJSON(k), fromJSON(v)]),
      );
    case "Set":
      return new Set((rec.values as unknown[]).map(fromJSON));
    case "ArrayBuffer": {
      const bytes = fromHex(rec.hex as string);
      return bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;
    }
    case "DataView": {
      const bytes = fromHex(rec.hex as string);
      return new DataView(bytes.buffer.slice(0, bytes.byteLength) as ArrayBuffer);
    }
    case "TypedArray": {
      const Ctor = typedArrayCtors[rec.kind as string];
      if (!Ctor) throw new Error("unknown TypedArray kind: " + rec.kind);
      const bytes = fromHex(rec.hex as string);
      return new Ctor(bytes.buffer.slice(0, bytes.byteLength) as ArrayBuffer);
    }
    case "Error": {
      const e = new Error(rec.message as string);
      e.name = rec.name as string;
      if ("cause" in rec) {
        Object.defineProperty(e, "cause", {
          value: fromJSON(rec.cause),
          writable: true,
          configurable: true,
          enumerable: false,
        });
      }
      for (const k of Object.keys(rec)) {
        if (k === MARK || k === "name" || k === "message" || k === "cause") continue;
        (e as unknown as Record<string, unknown>)[k] = fromJSON(rec[k]);
      }
      return e;
    }
    case "object": {
      const out: Record<string | symbol, unknown> = {};
      for (const e of rec.entries as Array<Record<string, unknown>>) {
        if ("ks" in e) out[symbolFrom(e.ks as { kind: string; value: string })] = fromJSON(e.v);
        else out[e.k as string] = fromJSON(e.v);
      }
      return out;
    }
    default:
      throw new Error("unknown $graft tag: " + tag);
  }
}
