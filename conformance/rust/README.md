# Conformance — Rust port

A zero-dependency Rust decoder + conformance runner for the Graft binary format.
Decodes every vector in [`../../spec/golden/`](../../spec/golden/) and asserts the
result against the vector's `.meta.json` sidecar, following the parallel-walk
algorithm in [`../README.md`](../README.md) §2.

No external crates: a minimal JSON parser for the sidecars lives in
[`src/json.rs`](src/json.rs), so it builds and runs offline.

## Run

```bash
cd conformance/rust
cargo test     # one test over all vectors (used in CI)
cargo run      # prints per-vector results, exits non-zero on failure
```

## Layout

- `src/value.rs` — the decoded value graph. Reference types are `Rc`-wrapped so
  shared identity and cycles survive and can be compared by pointer.
- `src/decode.rs` — the two-pass heap decoder (FORMAT.md §4).
- `src/json.rs` — minimal JSON parser for `.meta.json`.
- `src/matcher.rs` — the meta matcher (binds `$ref` on first sight, asserts
  identity afterwards; matches container entries positionally, which also checks
  the property order the format mandates).

## Representation & fallbacks

Per FORMAT.md §5 fallbacks, with arbitrary-precision integers (`BigInt`) kept as
their canonical decimal string (no bignum dependency). Value-type leaves
(`Date`, `Bytes`, `RegExp`, `Url`, `DataView`, `TypedArray`) carry no identity
and are matched structurally — the golden vectors never share them. Symbols and
the container types (`Array`, `Object`, `Map`, `Set`, `Error`) do carry identity.
