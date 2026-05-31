# Graft Binary Format — Specification v1

**Single source of truth** for the binary encoding.  
All language implementations derive from this document.  
`js/src/format.ts` is the TypeScript mirror of this file; they must stay in sync.

---

## 1. Design Goals

- **Encoder → file: lossless** for all values the source language can represent.
- **File → decoder: best-effort** — values that cannot be expressed in the target language fall back gracefully (documented per tag below).
- **Self-describing**: a reader needs no out-of-band schema to parse the stream.
- **Portable**: fixed-endian (little-endian), no platform-specific types, no runtime-specific encodings.
- **Reference-preserving**: shared object identity and cycles are faithfully encoded via a heap + reference table.

---

## 2. Primitive Encodings

These encodings are used as building blocks inside node payloads.

### 2.1 Unsigned Varint (uvarint)

Little-endian base-128 (LEB128, unsigned).  
Each byte contributes 7 bits. The MSB is a continuation flag.

```
byte = [continue(1)] [value(7)]
```

Example: `300` = `0xAC 0x02`

### 2.2 Signed Varint (svarint)

ZigZag encoding on top of uvarint.

```
encode: n >= 0  →  n * 2
        n <  0  →  (-n * 2) - 1
decode: z even  →  z / 2
        z odd   →  -(z + 1) / 2
```

Example: `-1` → zigzag `1` → uvarint `0x01`  
Example: `1` → zigzag `2` → uvarint `0x02`

### 2.3 Float64 (f64)

IEEE 754 double-precision, 8 bytes, **little-endian**.  
NaN is encoded as the canonical quiet NaN bit pattern `0x7FF8000000000000`.  
`-0.0`, `+Infinity`, `-Infinity` are encoded faithfully.

### 2.4 UTF-8 String (str)

```
uvarint(byte_length) | utf8_bytes
```

### 2.5 Raw Bytes

```
uvarint(byte_length) | raw_bytes
```

---

## 3. File Structure

```
file = MAGIC VERSION ROOT COUNT NODE{COUNT}
```

| Field   | Type    | Value      | Description                          |
|---------|---------|------------|--------------------------------------|
| MAGIC   | u8[4]   | `GRF1`     | 0x47 0x52 0x46 0x31                  |
| VERSION | u8      | `1`        | Format version                       |
| ROOT    | uvarint | —          | Heap index of the root value         |
| COUNT   | uvarint | —          | Total number of nodes in the heap    |

Nodes follow immediately after COUNT, indexed 0 … COUNT-1.

---

## 4. Heap Model

All values are stored as a flat array (the **heap**).  
A **reference** is a uvarint heap index.

This model encodes:
- **Shared identity**: two fields pointing to the same object share one heap index.
- **Cycles**: a node may reference itself or an ancestor (decoder allocates placeholder, then fills).
- **Object keys**: Map keys and Object symbol-keys can themselves be arbitrary heap nodes.

Decoder algorithm (required for all implementations):

1. Allocate all `COUNT` value slots (placeholders).
2. For each node in order: parse tag + payload, store leaf values immediately, record reference lists for containers.
3. Second pass: fill all containers using the now-populated slots.

---

## 5. Node Tags

### 5.1 Leaf Nodes (no child references)

| Tag | Value | Payload | Notes |
|-----|-------|---------|-------|
| `Null`             | 0  | *(none)*                        | JS `null` |
| `Undefined`        | 1  | *(none)*                        | JS `undefined`. Distinct from Null. Fallback: `null` |
| `BoolFalse`        | 2  | *(none)*                        | |
| `BoolTrue`         | 3  | *(none)*                        | |
| `Int`              | 4  | `svarint(n)`                    | Exact integer. Range: all integers representable as i64 or larger via BigInt. JS: safe integers stored here, not as Float. |
| `Float`            | 5  | `f64(n)`                        | Non-integral, NaN, -0, ±Infinity. Always 8 bytes. |
| `BigInt`           | 6  | `u8(sign) + uvarint(magnitude)` | sign: 0=positive/zero, 1=negative. magnitude: absolute value. |
| `String`           | 7  | `str`                           | UTF-8. |
| `Bytes`            | 41 | `uvarint(len) + raw`            | Raw ArrayBuffer / byte string. No element type. Fallback: `[]byte` / `Vec<u8>` / `bytes`. |

### 5.2 Symbol Nodes

Symbols are leaf nodes (self-contained, no child refs).

| Tag | Value | Payload | JS behaviour | Fallback (other langs) |
|-----|-------|---------|--------------|------------------------|
| `SymbolRegistered` | 10 | `str(key)` | `Symbol.for(key)` — restored with full identity (same key → same symbol) | Interned string / atom |
| `SymbolUnique`     | 11 | `str(description)` | `Symbol(desc)` — new symbol on decode; file-internal identity preserved via heap refs | Unique opaque value or string |
| `SymbolWellKnown`  | 12 | `str(name)` | e.g. name=`"iterator"` → `Symbol.iterator`. Name is the property name on the `Symbol` constructor. | Language-native equivalent if it exists, else interned string |

Well-known symbol name list (non-exhaustive):
`iterator`, `asyncIterator`, `hasInstance`, `isConcatSpreadable`,
`match`, `matchAll`, `replace`, `search`, `species`, `split`,
`toPrimitive`, `toStringTag`, `unscopables`

### 5.3 Date Node

| Tag | Value | Payload |
|-----|-------|---------|
| `Date` | 40 | `svarint(unix_ms) + svarint(sub_ms_nanos)` |

- `unix_ms`: milliseconds since Unix epoch, signed (negative = before 1970).
- `sub_ms_nanos`: nanosecond offset within the millisecond, range 0–999999.
- JS `Date` has millisecond precision: `unix_ms = date.getTime()`, `sub_ms_nanos = 0`.
- Other languages (Rust `chrono`, Go `time.Time`) may populate `sub_ms_nanos`.
- Fallback (langs without Date): ISO 8601 string or i64 milliseconds.

### 5.4 TypedArray Node

| Tag | Value | Payload |
|-----|-------|---------|
| `TypedArray` | 42 | `u8(element_type) + uvarint(byte_length) + raw_bytes` |

`raw_bytes` contains the array buffer contents in **little-endian** element order.  
`byte_length` is the total byte length (= element_count × element_size).

Element type codes:

| Code | JS type              | Element size | Notes |
|------|----------------------|-------------|-------|
| 0    | `Uint8Array`         | 1 byte      | |
| 1    | `Uint8ClampedArray`  | 1 byte      | Clamped on write; on decode restore as Uint8ClampedArray if available |
| 2    | `Uint16Array`        | 2 bytes     | |
| 3    | `Uint32Array`        | 4 bytes     | |
| 4    | `Int8Array`          | 1 byte      | |
| 5    | `Int16Array`         | 2 bytes     | |
| 6    | `Int32Array`         | 4 bytes     | |
| 7    | `Float32Array`       | 4 bytes     | |
| 8    | `Float64Array`       | 8 bytes     | |
| 9    | `BigInt64Array`      | 8 bytes     | |
| 10   | `BigUint64Array`     | 8 bytes     | |

Fallback (langs without TypedArray): decode as `Bytes` (raw buffer), discard element type.

### 5.5 Container Nodes (children are heap refs)

#### Array

| Tag | Value | Payload |
|-----|-------|---------|
| `Array` | 20 | `uvarint(count) + uvarint(ref){count}` |

Sparse array holes: encode as `Undefined` node references.

#### Object

| Tag | Value | Payload |
|-----|-------|---------|
| `Object` | 21 | `uvarint(count) + entry{count}` |

Each entry:
```
entry = key_kind(u8) key value_ref(uvarint)
```

| key_kind | key encoding | meaning |
|----------|-------------|---------|
| 0 = `String`    | `str`           | string-keyed property |
| 1 = `SymbolRef` | `uvarint(ref)`  | symbol-keyed property; ref points to a Symbol node |

Only own enumerable properties are encoded (same as `Object.keys` + `Object.getOwnPropertySymbols` filtered to enumerable).  
Property order: string keys first (insertion order), then symbol keys.

#### Map

| Tag | Value | Payload |
|-----|-------|---------|
| `Map` | 22 | `uvarint(count) + (key_ref(uvarint) value_ref(uvarint)){count}` |

Insertion order preserved. Keys are arbitrary heap nodes (including objects, symbols, etc.).  
Fallback (langs without Map): array of `[key, value]` pairs.

#### Set

| Tag | Value | Payload |
|-----|-------|---------|
| `Set` | 23 | `uvarint(count) + uvarint(ref){count}` |

Insertion order preserved.  
Fallback (langs without Set): array of values.

### 5.6 Weak Collection Nodes

WeakMap and WeakSet are **not enumerable by spec**.  
Contents are only encoded when the caller explicitly supplies the entries via a `WeakProvider` interface (see implementation notes).  
Entries whose keys are not present elsewhere in the heap are silently dropped — this is consistent with weak reference semantics.

#### WeakMap

| Tag | Value | Payload |
|-----|-------|---------|
| `WeakMap` | 30 | `uvarint(count) + (key_ref(uvarint) value_ref(uvarint)){count}` |

All key refs must point to object nodes already present in the heap.  
Decoder: restore as WeakMap; skip entries whose resolved key is not an object.  
Fallback (langs without WeakMap): Map.

#### WeakSet

| Tag | Value | Payload |
|-----|-------|---------|
| `WeakSet` | 31 | `uvarint(count) + uvarint(ref){count}` |

Fallback (langs without WeakSet): Set.

---

## 6. Tag Summary Table

| Tag name           | Value | Category    |
|--------------------|-------|-------------|
| `Null`             | 0     | Primitive   |
| `Undefined`        | 1     | Primitive   |
| `BoolFalse`        | 2     | Primitive   |
| `BoolTrue`         | 3     | Primitive   |
| `Int`              | 4     | Primitive   |
| `Float`            | 5     | Primitive   |
| `BigInt`           | 6     | Primitive   |
| `String`           | 7     | Primitive   |
| `SymbolRegistered` | 10    | Symbol      |
| `SymbolUnique`     | 11    | Symbol      |
| `SymbolWellKnown`  | 12    | Symbol      |
| `Array`            | 20    | Container   |
| `Object`           | 21    | Container   |
| `Map`              | 22    | Container   |
| `Set`              | 23    | Container   |
| `WeakMap`          | 30    | Weak        |
| `WeakSet`          | 31    | Weak        |
| `Date`             | 40    | Extended    |
| `Bytes`            | 41    | Extended    |
| `TypedArray`       | 42    | Extended    |
| 8–9, 13–19, 24–29, 32–39, 43–255 | — | **Reserved** |

Reserved tags must cause a decode error: `unknown tag: N`.

---

## 7. Versioning

- `VERSION` byte is `1` for this specification.
- A decoder encountering an unknown version must return an error.
- Future versions may add new tags in the reserved ranges.
- New tags are always backward-compatible within a version if decoders are written to error on unknown tags.

---

## 8. Conformance

A conforming implementation must:

1. **Encode** all types listed in §5 losslessly to the binary format.
2. **Decode** all tags listed in §5, applying documented fallbacks for types the language cannot represent.
3. **Error** on unknown tags (reserved range) rather than silently skipping.
4. **Pass** all golden test vectors in `spec/golden/`.

Golden vector format: each `.bin` file contains one encoded value.  
The corresponding `.meta.json` describes the expected decoded structure in a language-neutral notation (see `conformance/README.md`).

---

## 9. Implementation Notes

### Encoder identity deduplication

Use an identity map (`Map<object, number>` in JS, pointer map in native langs) to assign each unique object a single heap index. This ensures shared references and cycles are encoded correctly.

### Cycle handling

Reserve a heap slot (assign the index) before recursing into children. If a child refers back to an ancestor, the ancestor's index is already in the identity map and the reference is emitted directly.

### WeakProvider interface (JS)

```typescript
interface WeakProvider {
  weakMapEntries?: (wm: WeakMap<object, unknown>) => Array<[object, unknown]>;
  weakSetValues?:  (ws: WeakSet<object>)          => object[];
}
```

Implementations in other languages should expose an equivalent mechanism.

### TypedArray byte order

All multi-byte element types are written in **little-endian** byte order, matching the `DataView.setUint16(offset, value, true)` convention. Implementations on big-endian platforms must byte-swap on read and write.

### instanceof ordering in encoder (JS)

Check TypedArray subtypes **before** ArrayBuffer:

```
BigInt64Array → BigUint64Array → Float64Array → Float32Array →
Int32Array → Uint32Array → Int16Array → Uint16Array →
Int8Array → Uint8ClampedArray → Uint8Array →
ArrayBuffer → ...
```

`DataView` is intentionally excluded from TypedArray encoding.
