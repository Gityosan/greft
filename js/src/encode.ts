import { ByteWriter } from "./buffer";
import { MAGIC, VERSION, Tag, KeyKind, ElementType } from "./format";
import type { TypeExtension } from "./extension";

// Explicit contents for weak collections, since WeakMap/WeakSet are not
// enumerable per spec. The caller supplies the entries they are holding.
export interface WeakProvider {
  weakMapEntries?: (wm: WeakMap<object, unknown>) => Array<[object, unknown]>;
  weakSetValues?: (ws: WeakSet<object>) => object[];
}

export interface EncodeOptions {
  provider?: WeakProvider;
  /** Extension types for values the core would otherwise reject. */
  types?: TypeExtension[];
}

interface Node {
  write(w: ByteWriter, idOf: (v: unknown) => number): void;
}

const wellKnownSymbols = new Map<symbol, string>(
  (Object.getOwnPropertyNames(Symbol) as Array<keyof typeof Symbol>)
    .filter((n) => typeof (Symbol as any)[n] === "symbol")
    .map((n) => [(Symbol as any)[n] as symbol, String(n)]),
);

export function encode(root: unknown, options: EncodeOptions = {}): Uint8Array {
  const provider: WeakProvider = options.provider ?? {};
  const types = options.types ?? [];
  const heap: Node[] = [];
  // identity map for objects/symbols (reference types)
  const ids = new Map<unknown, number>();

  function intern(v: unknown): number {
    const existing = ids.get(v);
    if (existing !== undefined) return existing;
    const idx = heap.length;
    ids.set(v, idx);
    heap.push(null as unknown as Node); // placeholder to reserve index (cycles)
    heap[idx] = build(v);
    return idx;
  }

  function leaf(write: Node["write"]): Node {
    return { write };
  }

  function build(v: unknown): Node {
    switch (typeof v) {
      case "undefined":
        return leaf((w) => w.u8(Tag.Undefined));
      case "boolean":
        return leaf((w) => w.u8(v ? Tag.BoolTrue : Tag.BoolFalse));
      case "bigint":
        return leaf((w) => {
          w.u8(Tag.BigInt);
          w.u8(v < 0n ? 1 : 0);
          w.uvarint(v < 0n ? -v : v);
        });
      case "string":
        return leaf((w) => {
          w.u8(Tag.String);
          w.str(v);
        });
      case "number":
        return buildNumber(v);
      case "symbol":
        return buildSymbol(v);
      case "object":
        if (v === null) return leaf((w) => w.u8(Tag.Null));
        return buildObject(v as object);
      case "function":
        throw new Error("functions are out of scope");
      default:
        throw new Error("unsupported type: " + typeof v);
    }
  }

  function buildNumber(v: number): Node {
    // Use Int when it is an exact integer (and not -0), else Float to keep
    // NaN / -0 / ±Infinity / fractional values bit-faithful.
    const isExactInt = Number.isInteger(v) && !Object.is(v, -0);
    if (isExactInt) {
      return leaf((w) => {
        w.u8(Tag.Int);
        w.svarint(BigInt(v));
      });
    }
    return leaf((w) => {
      w.u8(Tag.Float);
      w.f64(v);
    });
  }

  function buildSymbol(sym: symbol): Node {
    const wk = wellKnownSymbols.get(sym);
    if (wk)
      return leaf((w) => {
        w.u8(Tag.SymbolWellKnown);
        w.str(wk);
      });
    const key = Symbol.keyFor(sym);
    if (key !== undefined) {
      return leaf((w) => {
        w.u8(Tag.SymbolRegistered);
        w.str(key);
      });
    }
    const desc = sym.description ?? "";
    return leaf((w) => {
      w.u8(Tag.SymbolUnique);
      w.str(desc);
    });
  }

  function encodeTypedArray(et: ElementType, arr: ArrayBufferView): Node {
    const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
    return leaf((w) => {
      w.u8(Tag.TypedArray);
      w.u8(et);
      w.uvarint(bytes.length);
      w.bytes(bytes);
    });
  }

  // Own enumerable string + symbol properties, shared by Object and Error.
  // `skip` excludes string keys handled out-of-band (Error's name/message/...).
  type Prop = { kind: KeyKind; key: string | number; val: number };
  function ownEntries(obj: object, skip?: Set<string>): Prop[] {
    const props: Prop[] = [];
    for (const k of Object.keys(obj)) {
      if (skip?.has(k)) continue;
      props.push({ kind: KeyKind.String, key: k, val: intern((obj as any)[k]) });
    }
    for (const s of Object.getOwnPropertySymbols(obj)) {
      if (!Object.getOwnPropertyDescriptor(obj, s)?.enumerable) continue;
      props.push({ kind: KeyKind.SymbolRef, key: intern(s), val: intern((obj as any)[s]) });
    }
    return props;
  }
  function writeEntries(w: ByteWriter, props: Prop[]): void {
    w.uvarint(props.length);
    for (const p of props) {
      w.u8(p.kind);
      if (p.kind === KeyKind.String) w.str(p.key as string);
      else w.uvarint(p.key as number);
      w.uvarint(p.val);
    }
  }
  // True when `key` is a canonical array index within [0, length).
  function isArrayIndex(key: string, length: number): boolean {
    const n = Number(key);
    return Number.isInteger(n) && n >= 0 && n < length && String(n) === key;
  }

  function buildObject(obj: object): Node {
    // Boxed primitives — unwrap to their primitive (best-effort; wrapper
    // identity and any extra props are dropped, see FORMAT.md §9).
    if (obj instanceof Number) return buildNumber(obj.valueOf());
    if (obj instanceof String) {
      const sv = obj.valueOf();
      return leaf((w) => {
        w.u8(Tag.String);
        w.str(sv);
      });
    }
    if (obj instanceof Boolean) {
      const bv = obj.valueOf();
      return leaf((w) => w.u8(bv ? Tag.BoolTrue : Tag.BoolFalse));
    }
    // Date — leaf, checked before structural types.
    if (obj instanceof Date) {
      const ms = obj.getTime();
      return leaf((w) => {
        w.u8(Tag.Date);
        w.svarint(BigInt(ms));
        w.svarint(0n); // sub_ms_nanos: JS は常に 0
      });
    }
    // TypedArrays — concrete subtype first, then ArrayBuffer, all before Array.
    if (obj instanceof BigInt64Array) return encodeTypedArray(ElementType.BigInt64, obj);
    if (obj instanceof BigUint64Array) return encodeTypedArray(ElementType.BigUint64, obj);
    if (obj instanceof Float64Array) return encodeTypedArray(ElementType.Float64, obj);
    if (obj instanceof Float32Array) return encodeTypedArray(ElementType.Float32, obj);
    if (obj instanceof Int32Array) return encodeTypedArray(ElementType.Int32, obj);
    if (obj instanceof Uint32Array) return encodeTypedArray(ElementType.Uint32, obj);
    if (obj instanceof Int16Array) return encodeTypedArray(ElementType.Int16, obj);
    if (obj instanceof Uint16Array) return encodeTypedArray(ElementType.Uint16, obj);
    if (obj instanceof Int8Array) return encodeTypedArray(ElementType.Int8, obj);
    if (obj instanceof Uint8ClampedArray) return encodeTypedArray(ElementType.Uint8Clamped, obj);
    if (obj instanceof Uint8Array) return encodeTypedArray(ElementType.Uint8, obj);
    if (obj instanceof ArrayBuffer) {
      const bytes = new Uint8Array(obj);
      return leaf((w) => {
        w.u8(Tag.Bytes);
        w.uvarint(bytes.length);
        w.bytes(bytes);
      });
    }
    // DataView — its own tag (NOT a TypedArray); stores the viewed window.
    if (obj instanceof DataView) {
      const bytes = new Uint8Array(obj.buffer, obj.byteOffset, obj.byteLength);
      return leaf((w) => {
        w.u8(Tag.DataView);
        w.uvarint(bytes.length);
        w.bytes(bytes);
      });
    }
    if (Array.isArray(obj)) {
      // Arrays carry only their elements 0..length-1. Extra own enumerable
      // properties cannot be represented, so reject rather than drop them.
      const extra = [
        ...Object.keys(obj).filter((k) => !isArrayIndex(k, obj.length)),
        ...Object.getOwnPropertySymbols(obj)
          .filter((s) => Object.getOwnPropertyDescriptor(obj, s)?.enumerable)
          .map((s) => String(s)),
      ];
      if (extra.length > 0) {
        throw new Error("array with non-index properties is not supported: " + extra.join(", "));
      }
      // Iterate by index so holes in sparse arrays become explicit undefined.
      const refs: number[] = new Array(obj.length);
      for (let i = 0; i < obj.length; i++) refs[i] = intern((obj as unknown[])[i]);
      return leaf((w) => {
        w.u8(Tag.Array);
        w.uvarint(refs.length);
        for (const r of refs) w.uvarint(r);
      });
    }
    if (obj instanceof Map) {
      const entries = [...obj.entries()].map(([k, val]) => [intern(k), intern(val)] as const);
      return leaf((w) => {
        w.u8(Tag.Map);
        w.uvarint(entries.length);
        for (const [k, val] of entries) {
          w.uvarint(k);
          w.uvarint(val);
        }
      });
    }
    if (obj instanceof Set) {
      const refs = [...obj.values()].map((x) => intern(x));
      return leaf((w) => {
        w.u8(Tag.Set);
        w.uvarint(refs.length);
        for (const r of refs) w.uvarint(r);
      });
    }
    if (obj instanceof WeakMap) {
      const supplied = provider.weakMapEntries?.(obj as WeakMap<object, unknown>) ?? [];
      const entries = supplied.map(([k, val]) => [intern(k), intern(val)] as const);
      return leaf((w) => {
        w.u8(Tag.WeakMap);
        w.uvarint(entries.length);
        for (const [k, val] of entries) {
          w.uvarint(k);
          w.uvarint(val);
        }
      });
    }
    if (obj instanceof WeakSet) {
      const supplied = provider.weakSetValues?.(obj as WeakSet<object>) ?? [];
      const refs = supplied.map((x) => intern(x));
      return leaf((w) => {
        w.u8(Tag.WeakSet);
        w.uvarint(refs.length);
        for (const r of refs) w.uvarint(r);
      });
    }
    // RegExp — leaf carrying its source pattern and flag string.
    if (obj instanceof RegExp) {
      return leaf((w) => {
        w.u8(Tag.RegExp);
        w.str(obj.source);
        w.str(obj.flags);
      });
    }
    // URL — leaf carrying the serialized href.
    if (typeof URL !== "undefined" && obj instanceof URL) {
      const href = obj.href;
      return leaf((w) => {
        w.u8(Tag.Url);
        w.str(href);
      });
    }
    // Error (and subclasses) — name + message + optional cause + extra props.
    // `stack` is environment-derived and intentionally not encoded.
    if (obj instanceof Error) {
      const name = obj.name;
      const message = obj.message;
      const hasCause = Object.prototype.hasOwnProperty.call(obj, "cause");
      const causeRef = hasCause ? intern((obj as { cause?: unknown }).cause) : 0;
      const extra = ownEntries(obj, new Set(["name", "message", "stack", "cause"]));
      return leaf((w) => {
        w.u8(Tag.Error);
        w.str(name);
        w.str(message);
        w.u8(hasCause ? 1 : 0);
        if (hasCause) w.uvarint(causeRef);
        writeEntries(w, extra);
      });
    }
    // User-registered extension types claim otherwise-unsupported objects.
    // The surrogate is interned as a child so it can be any Graft value.
    for (const t of types) {
      if (t.match(obj)) {
        const ref = intern(t.encode(obj));
        return leaf((w) => {
          w.u8(Tag.Custom);
          w.str(t.name);
          w.uvarint(ref);
        });
      }
    }
    // Guard: only plain records (Object.prototype / null prototype) may fall
    // through to the generic Object encoder. Any other exotic object would lose
    // its internal state when reduced to own enumerable props, so we reject it
    // loudly instead of silently emitting an empty/partial Object.
    const proto = Object.getPrototypeOf(obj);
    if (proto !== null && proto !== Object.prototype) {
      const name = obj.constructor?.name ?? "object";
      throw new Error("unsupported object type: " + name + " (no Graft tag for this exotic type)");
    }
    // Plain object: own enumerable string + symbol keys.
    const props = ownEntries(obj);
    return leaf((w) => {
      w.u8(Tag.Object);
      writeEntries(w, props);
    });
  }

  const rootId = intern(root);

  const w = new ByteWriter();
  w.bytes(MAGIC);
  w.u8(VERSION);
  w.uvarint(rootId);
  w.uvarint(heap.length);
  for (const node of heap) node.write(w, (v) => ids.get(v)!);
  return w.toUint8Array();
}
