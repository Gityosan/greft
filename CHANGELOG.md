# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-06-01

Initial public release of the JS reference implementation.

### Added

- **Core codec** — `encode(value, { provider?, types? })` and
  `decode(bytes, { types?, maxNodes? })`. Cycles and shared identity are
  preserved via a heap + references; decoding resolves lazily with memoization.
- **Type coverage** (tags 0–47): Null, Undefined, Bool, Int, Float, BigInt,
  String; Symbol (registered / unique / well-known); Array, Object, Map, Set
  with arbitrary object keys; WeakMap / WeakSet via an explicit `provider`;
  Date, Bytes, TypedArray, RegExp, Url, DataView, Error; and a `Custom` tag for
  user-registered extension types.
- **Extension types** — opt-in lossless serialization of class instances and
  domain types through a `TypeExtension` registry.
- **JSON bridge** — `toJSON` / `fromJSON` for inspecting and hand-editing an
  encoded graph (identity-lossy; cycles rejected).
- **CLI** — `graft inspect` (tree view + tag histogram) and `graft diff`
  (structural diff of two value graphs).
- **Decode safety** — rejects out-of-range roots/refs, counts exceeding the
  buffer, and bounds work via `maxNodes`.
- **Format spec** — `spec/FORMAT.md` as the single source of truth, with 13
  golden vectors (`.bin` + language-neutral `.meta.json`).
- **Conformance** — JS / Python / Rust / Go ports verified against the golden
  vectors and byte-for-byte round-trip (`encode(decode(golden)) == bytes`).

### Guarantees

- Lossless encoder → file for every value the JS runtime can represent.
- File → other-language decoders is best-effort; unrepresentable types fall back
  per `spec/FORMAT.md` §5.

[0.1.0]: https://github.com/Gityosan/greft/releases/tag/v0.1.0
