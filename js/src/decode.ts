import { ByteReader } from "./buffer";
import { MAGIC, VERSION, Tag, KeyKind, ElementType } from "./format";
import type { TypeExtension } from "./extension";

type Filler = (resolve: (idx: number) => unknown) => void;

interface DecodedNode {
  value: unknown;
  fill?: Filler;
  // Set for Tag.Custom: the value is produced lazily by the registered type's
  // `decode` once its surrogate has been resolved.
  custom?: { name: string; surrogateRef: number };
  started?: boolean; // container fill has begun (re-entrant cycle guard)
  resolving?: boolean; // custom reconstruction in progress (cycle detector)
  done?: boolean; // custom value computed
}

export interface DecodeOptions {
  /** Reconstructors for `Tag.Custom` nodes, matched by name. */
  types?: TypeExtension[];
  /** Reject streams declaring more than this many heap nodes (DoS guard). */
  maxNodes?: number;
}

const wellKnownByName = new Map<string, symbol>(
  (Object.getOwnPropertyNames(Symbol) as Array<keyof typeof Symbol>)
    .filter((n) => typeof (Symbol as any)[n] === "symbol")
    .map((n) => [String(n), (Symbol as any)[n] as symbol]),
);

// Built-in Error constructors restorable by name; unknown names become a base
// Error with `.name` set to the stored value.
const errorCtors: Record<string, new (message?: string) => Error> = {
  Error,
  EvalError,
  RangeError,
  ReferenceError,
  SyntaxError,
  TypeError,
  URIError,
};
function makeError(name: string, message: string): Error {
  const Ctor = errorCtors[name];
  if (Ctor) return new Ctor(message);
  const e = new Error(message);
  e.name = name;
  return e;
}

// Assign an own enumerable data property. Uses defineProperty so a key of
// "__proto__" becomes a real own property instead of mutating the prototype.
function defineOwn(target: object, key: string | symbol, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

export function decode(bytes: Uint8Array, options: DecodeOptions = {}): unknown {
  const r = new ByteReader(bytes);
  const magic = r.bytes(MAGIC.length);
  for (let i = 0; i < MAGIC.length; i++) {
    if (magic[i] !== MAGIC[i]) throw new Error("bad magic: not an LXF file");
  }
  const version = r.u8();
  if (version !== VERSION) throw new Error("unsupported version: " + version);
  const rootId = r.uvarintNum();
  const count = r.uvarintNum();

  // DoS hardening: every node is at least one byte (its tag), so a declared
  // count larger than the remaining bytes is impossible — reject before
  // allocating. `maxNodes` caps it further for callers reading untrusted input.
  const maxNodes = options.maxNodes ?? bytes.length;
  if (count > bytes.length) {
    throw new Error("declared node count " + count + " exceeds available bytes");
  }
  if (count > maxNodes) {
    throw new Error("node count " + count + " exceeds maxNodes " + maxNodes);
  }
  if (count > 0 && rootId >= count) {
    throw new Error("root index " + rootId + " out of range");
  }

  const types = new Map((options.types ?? []).map((t) => [t.name, t]));
  const nodes: DecodedNode[] = new Array(count);
  for (let i = 0; i < count; i++) nodes[i] = readNode(r);

  // Lazy, memoized resolution. Containers expose a stable placeholder object at
  // parse time, so cycles/shared refs through them just work; Custom nodes are
  // reconstructed on first access once their surrogate is resolved.
  function resolve(idx: number): unknown {
    if (idx < 0 || idx >= count) throw new Error("reference out of range: " + idx);
    const n = nodes[idx];
    if (n.custom) {
      if (n.done) return n.value;
      if (n.resolving) throw new Error("cycle through custom type: " + n.custom.name);
      const type = types.get(n.custom.name);
      if (!type) throw new Error("no registered type for: " + n.custom.name);
      n.resolving = true;
      n.value = type.decode(resolve(n.custom.surrogateRef));
      n.resolving = false;
      n.done = true;
      return n.value;
    }
    if (n.fill && !n.started) {
      n.started = true;
      n.fill(resolve);
    }
    return n.value;
  }

  for (let i = 0; i < count; i++) resolve(i);
  return count > 0 ? resolve(rootId) : undefined;
}

function readNode(r: ByteReader): DecodedNode {
  const tag = r.u8();
  switch (tag) {
    case Tag.Null:
      return { value: null };
    case Tag.Undefined:
      return { value: undefined };
    case Tag.BoolFalse:
      return { value: false };
    case Tag.BoolTrue:
      return { value: true };
    case Tag.Int:
      return { value: Number(r.svarint()) };
    case Tag.Float:
      return { value: r.f64() };
    case Tag.BigInt: {
      const sign = r.u8();
      const mag = r.uvarint();
      return { value: sign ? -mag : mag };
    }
    case Tag.String:
      return { value: r.str() };

    case Tag.SymbolRegistered:
      return { value: Symbol.for(r.str()) };
    case Tag.SymbolUnique: {
      const desc = r.str();
      return { value: Symbol(desc) };
    }
    case Tag.SymbolWellKnown: {
      const name = r.str();
      const sym = wellKnownByName.get(name);
      // Fallback: if unknown well-known on this runtime, make a unique symbol.
      return { value: sym ?? Symbol(name) };
    }

    case Tag.Array: {
      const n = r.uvarintNum();
      const refs: number[] = [];
      for (let i = 0; i < n; i++) refs.push(r.uvarintNum());
      const arr: unknown[] = new Array(n);
      return {
        value: arr,
        fill: (resolve) => {
          for (let i = 0; i < n; i++) arr[i] = resolve(refs[i]);
        },
      };
    }
    case Tag.Object: {
      const n = r.uvarintNum();
      const props: Array<{ kind: KeyKind; key: string | number; val: number }> = [];
      for (let i = 0; i < n; i++) {
        const kind = r.u8() as KeyKind;
        const key = kind === KeyKind.String ? r.str() : r.uvarintNum();
        const val = r.uvarintNum();
        props.push({ kind, key, val });
      }
      const obj: Record<string | symbol, unknown> = {};
      return {
        value: obj,
        fill: (resolve) => {
          for (const p of props) {
            const k =
              p.kind === KeyKind.String ? (p.key as string) : (resolve(p.key as number) as symbol);
            defineOwn(obj, k, resolve(p.val));
          }
        },
      };
    }
    case Tag.Map: {
      const n = r.uvarintNum();
      const pairs: Array<[number, number]> = [];
      for (let i = 0; i < n; i++) pairs.push([r.uvarintNum(), r.uvarintNum()]);
      const m = new Map<unknown, unknown>();
      return {
        value: m,
        fill: (resolve) => {
          for (const [k, v] of pairs) m.set(resolve(k), resolve(v));
        },
      };
    }
    case Tag.Set: {
      const n = r.uvarintNum();
      const refs: number[] = [];
      for (let i = 0; i < n; i++) refs.push(r.uvarintNum());
      const s = new Set<unknown>();
      return {
        value: s,
        fill: (resolve) => {
          for (const ref of refs) s.add(resolve(ref));
        },
      };
    }
    case Tag.WeakMap: {
      const n = r.uvarintNum();
      const pairs: Array<[number, number]> = [];
      for (let i = 0; i < n; i++) pairs.push([r.uvarintNum(), r.uvarintNum()]);
      const wm = new WeakMap<object, unknown>();
      return {
        value: wm,
        fill: (resolve) => {
          for (const [k, v] of pairs) {
            const key = resolve(k);
            if (typeof key === "object" && key !== null) wm.set(key, resolve(v));
          }
        },
      };
    }
    case Tag.WeakSet: {
      const n = r.uvarintNum();
      const refs: number[] = [];
      for (let i = 0; i < n; i++) refs.push(r.uvarintNum());
      const ws = new WeakSet<object>();
      return {
        value: ws,
        fill: (resolve) => {
          for (const ref of refs) {
            const v = resolve(ref);
            if (typeof v === "object" && v !== null) ws.add(v);
          }
        },
      };
    }
    case Tag.Date: {
      const ms = r.svarint();
      r.svarint(); // sub_ms_nanos: JS では無視
      return { value: new Date(Number(ms)) };
    }
    case Tag.Bytes: {
      const len = r.uvarintNum();
      const raw = r.bytes(len);
      return { value: raw.buffer.slice(raw.byteOffset, raw.byteOffset + len) };
    }
    case Tag.TypedArray: {
      const et = r.u8();
      const len = r.uvarintNum();
      const raw = r.bytes(len);
      const buf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + len) as ArrayBuffer;
      const ctors: Record<number, new (b: ArrayBuffer) => ArrayBufferView> = {
        [ElementType.Uint8]: Uint8Array,
        [ElementType.Uint8Clamped]: Uint8ClampedArray,
        [ElementType.Uint16]: Uint16Array,
        [ElementType.Uint32]: Uint32Array,
        [ElementType.Int8]: Int8Array,
        [ElementType.Int16]: Int16Array,
        [ElementType.Int32]: Int32Array,
        [ElementType.Float32]: Float32Array,
        [ElementType.Float64]: Float64Array,
        [ElementType.BigInt64]: BigInt64Array,
        [ElementType.BigUint64]: BigUint64Array,
      };
      const Ctor = ctors[et];
      if (!Ctor) throw new Error("unknown element type: " + et);
      return { value: new Ctor(buf) };
    }
    case Tag.RegExp: {
      const source = r.str();
      const flags = r.str();
      return { value: new RegExp(source, flags) };
    }
    case Tag.Url: {
      return { value: new URL(r.str()) };
    }
    case Tag.DataView: {
      const len = r.uvarintNum();
      const raw = r.bytes(len);
      const buf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + len) as ArrayBuffer;
      return { value: new DataView(buf) };
    }
    case Tag.Error: {
      const name = r.str();
      const message = r.str();
      const flags = r.u8();
      const hasCause = (flags & 1) !== 0;
      const causeRef = hasCause ? r.uvarintNum() : -1;
      const n = r.uvarintNum();
      const props: Array<{ kind: KeyKind; key: string | number; val: number }> = [];
      for (let i = 0; i < n; i++) {
        const kind = r.u8() as KeyKind;
        const key = kind === KeyKind.String ? r.str() : r.uvarintNum();
        const val = r.uvarintNum();
        props.push({ kind, key, val });
      }
      const err = makeError(name, message);
      return {
        value: err,
        fill: (resolve) => {
          if (hasCause) {
            // Match the ECMAScript `{ cause }` option: own, non-enumerable.
            Object.defineProperty(err, "cause", {
              value: resolve(causeRef),
              writable: true,
              configurable: true,
              enumerable: false,
            });
          }
          for (const p of props) {
            const k =
              p.kind === KeyKind.String ? (p.key as string) : (resolve(p.key as number) as symbol);
            defineOwn(err, k, resolve(p.val));
          }
        },
      };
    }
    case Tag.Custom: {
      const name = r.str();
      const surrogateRef = r.uvarintNum();
      return { value: undefined, custom: { name, surrogateRef } };
    }
    default:
      throw new Error("unknown tag: " + tag);
  }
}
