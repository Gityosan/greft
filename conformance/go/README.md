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
go test ./...   # one test over all vectors (used in CI)
go run .        # prints per-vector results, exits non-zero on failure
```

## Layout

- `decode.go` — the value graph + two-pass heap decoder (FORMAT.md §4).
  Reference types (`*Array`, `*Object`, `*MapV`, `*SetV`, `*ErrorV`, `*Symbol`)
  are pointers so shared identity and cycles survive and compare by address.
- `match.go` — the meta matcher (binds `$ref` on first sight, asserts identity
  afterwards; matches container entries positionally, which also checks the
  property order the format mandates).
- `run.go` — vector discovery, decode+match driver, and `main`.

## Representation & fallbacks

Per FORMAT.md §5 fallbacks: `null`→`nil`, `undefined`→a distinct `Undefined`
sentinel, `BigInt`→canonical decimal string, and small wrapper types for
`Bytes`, `DataView`, `TypedArray`, `Date`, `RegExp`, `URL`, `Symbol`, and the
`Error` object. `Array`/`Object`/`Map`/`Set`/`Error`/`Symbol` carry identity;
value-type leaves do not and are matched structurally (golden never shares them).
