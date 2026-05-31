# Conformance — JS reference port

The reference conformance runner. It decodes every vector in
[`../../spec/golden/`](../../spec/golden/) with the reference decoder
(`../../js/src`) and asserts the result against the vector's `.meta.json`
sidecar, following the parallel-walk algorithm in
[`../README.md`](../README.md) §2.

This is the worked example other language ports should mirror.

## Run

```bash
cd js && pnpm conformance
```

or directly:

```bash
npx tsx conformance/js/run.ts
```

Prints one line per vector and exits non-zero if any vector fails, so it can
gate CI.

## What it checks

- Every leaf type (`null`, `undefined`, bool, int, float incl. `NaN` / `-0` /
  `±Infinity`, bigint, string, Date, Bytes, every TypedArray element type,
  RegExp, and all three Symbol kinds).
- Containers (Object with string **and** symbol keys, Array, Map, Set).
- **Shared identity and cycles**: each `$ref` index is bound to the decoded
  object on first sight and identity is asserted on every later occurrence — so
  a decoder that returns structurally-correct but distinct copies fails.
