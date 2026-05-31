# Conformance — Go port

A standard-library-only Go decoder + conformance runner for the Graft binary
format. Decodes every vector in [`../../spec/golden/`](../../spec/golden/) and
asserts the result against the vector's `.meta.json` sidecar, following the
parallel-walk algorithm in [`../README.md`](../README.md) §2.

No third-party modules: `encoding/json` parses the sidecars and `math/big`
handles arbitrary-precision integers, so it builds and runs offline.

## Run

```bash
cd conformance/go
go test ./...   # decode conformance + encoder round-trip (used in CI)
go run .        # prints per-vector decode results, exits non-zero on failure
```

`go test` runs two tests: decode-vs-`.meta.json` and the encoder round-trip
(`encode(decode(bin)) == bin`, byte-identical).

## Layout

- `decode.go` — the value graph + two-pass heap decoder (FORMAT.md §4).
  Reference types (`*Array`, `*Object`, `*MapV`, `*SetV`, `*ErrorV`, `*Symbol`)
  are pointers so shared identity and cycles survive and compare by address.
- `encode.go` — the encoder: a faithful clone of the reference algorithm
  (pre-order interning, identity/value dedup, tag layout).
- `match.go` — the meta matcher (binds `$ref` on first sight, asserts identity
  afterwards; matches container entries positionally, which also checks the
  property order the format mandates).
- `run.go` — vector discovery, decode+match and round-trip drivers, and `main`.

## Representation & fallbacks

Per FORMAT.md §5 fallbacks: `null`→`nil`, `undefined`→a distinct `Undefined`
sentinel, `BigInt`→canonical decimal string, and small wrapper types for
`Bytes`, `DataView`, `TypedArray`, `Date`, `RegExp`, `URL`, `Symbol`, and the
`Error` object. `Array`/`Object`/`Map`/`Set`/`Error`/`Symbol` carry identity;
value-type leaves do not and are matched structurally (golden never shares them).
