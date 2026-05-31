// LXF (Lossless eXchange Format) v1 — language-neutral tag vocabulary.
// Designed so the same byte stream can later be decoded by Go/Rust/etc.

export const MAGIC = new Uint8Array([0x47, 0x52, 0x46, 0x31]); // "GRF1"
export const VERSION = 1;

// Node tags (u8). Leaf values are inlined in the heap node stream; container
// children are stored as heap references (uvarint index) for identity/cycles.
export enum Tag {
  // ---- primitives / leaves ----
  Null = 0, // JS null
  Undefined = 1, // JS undefined (distinct from null)
  BoolFalse = 2,
  BoolTrue = 3,
  Int = 4, // svarint — integral number that fits exactly
  Float = 5, // f64 — any non-integral / special (NaN/-0/±Inf) number
  BigInt = 6, // sign(u8) + uvarint magnitude
  String = 7, // utf8

  // ---- symbols ----
  SymbolRegistered = 10, // Symbol.for(key): str key. Fully restorable + identity.
  SymbolUnique = 11, // Symbol(desc): str desc (0xff sentinel handled as hasDesc flag).
  SymbolWellKnown = 12, // str name e.g. "iterator" for Symbol.iterator.

  // ---- containers (children are heap refs) ----
  Array = 20, // count + count*ref
  Object = 21, // count + count*(keyKind,key,valueRef)
  Map = 22, // count + count*(keyRef,valueRef)
  Set = 23, // count + count*ref

  // ---- weak collections (children supplied via explicit input) ----
  WeakMap = 30, // count + count*(keyRef,valueRef)  [only resolvable entries]
  WeakSet = 31, // count + count*ref

  // ---- extended leaves ----
  Date = 40, // svarint(unix_ms) + svarint(sub_ms_nanos)
  Bytes = 41, // uvarint(byte_length) + raw_bytes (ArrayBuffer)
  TypedArray = 42, // u8(element_type) + uvarint(byte_length) + raw_bytes (LE)
  RegExp = 43, // str(source) + str(flags)
}

// TypedArray element type codes (see FORMAT.md §5.4).
export enum ElementType {
  Uint8 = 0,
  Uint8Clamped = 1,
  Uint16 = 2,
  Uint32 = 3,
  Int8 = 4,
  Int16 = 5,
  Int32 = 6,
  Float32 = 7,
  Float64 = 8,
  BigInt64 = 9,
  BigUint64 = 10,
}

// Object key kinds, since JS object keys may be strings or symbols.
export enum KeyKind {
  String = 0,
  SymbolRef = 1, // key is a heap reference to a Symbol node
}
