# Conformance — Rust port

A Rust decoder + conformance runner for the Graft binary format. Decodes every
vector in [`../../spec/golden/`](../../spec/golden/) and asserts the result
against the vector's `.meta.json` sidecar, following the parallel-walk algorithm
in [`../README.md`](../README.md) §2.

Dependencies are limited to two well-known crates that don't touch the wire
format's byte determinism: `serde_json` (parse the `.meta.json` sidecars) and
`num-bigint` (arbitrary-precision integers). The binary primitives themselves
(varint / ZigZag / float-LE / UTF-8) stay hand-written, since those define the
format.

## Run

```bash
cd conformance/rust
cargo test     # decode conformance + encoder round-trip (used in CI)
cargo run      # prints per-vector decode results, exits non-zero on failure
```

`cargo test` runs two suites: `tests/conformance.rs` (decode vs `.meta.json`)
and `tests/roundtrip.rs` (`encode(decode(bin)) == bin`, byte-identical).

## Layout

- `src/value.rs` — the decoded value graph. Reference types are `Rc`-wrapped so
  shared identity and cycles survive and can be compared by pointer.
- `src/decode.rs` — the two-pass heap decoder (FORMAT.md §4).
- `src/encode.rs` — the encoder: a faithful clone of the reference algorithm
  (pre-order interning, identity/value dedup, tag layout).
- `src/matcher.rs` — the meta matcher (binds `$ref` on first sight, asserts
  identity afterwards; matches container entries positionally, which also checks
  the property order the format mandates).

## Representation & fallbacks

Per FORMAT.md §5 fallbacks, with arbitrary-precision integers (`BigInt`) kept as
their canonical decimal string (converted via `num-bigint`). Value-type leaves
(`Date`, `Bytes`, `RegExp`, `Url`, `DataView`, `TypedArray`) carry no identity
and are matched structurally — the golden vectors never share them. Symbols and
the container types (`Array`, `Object`, `Map`, `Set`, `Error`) do carry identity.
