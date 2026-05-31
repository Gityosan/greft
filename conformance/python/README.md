# Conformance — Python port

A zero-dependency (stdlib-only) decoder + conformance runner for the Graft
binary format. Decodes every vector in [`../../spec/golden/`](../../spec/golden/)
and asserts the result against the vector's `.meta.json` sidecar, following the
parallel-walk algorithm in [`../README.md`](../README.md) §2.

## Run

```bash
python3 conformance/python/run.py
```

Prints one line per vector and exits non-zero if any vector fails (CI-friendly).
Requires Python 3.8+.

## Files

- `decode.py` — the decoder. Implements the two-pass heap algorithm (FORMAT.md
  §4) so shared identity and cycles are restored, not copied.
- `run.py` — the matcher + entry point.

## Representation & fallbacks

Python lacks exact equivalents for some JS types, so the decoder uses small
wrapper classes (and the documented fallbacks from FORMAT.md §5):

| Graft / JS            | Python                                   |
|-----------------------|------------------------------------------|
| `null`                | `None`                                   |
| `undefined`           | `UNDEFINED` sentinel (distinct from None)|
| bool / int / bigint   | `bool` / `int` / `int`                   |
| float                 | `float` (NaN, ±inf, -0.0 preserved)      |
| string                | `str`                                    |
| Bytes / DataView      | `Bytes` / `DataView` (wrap `bytes`)      |
| TypedArray            | `TypedArray(element_type, data)`         |
| Date                  | `Date(unix_ms, sub_ms_nanos)`            |
| RegExp / Url          | `RegExp(source, flags)` / `Url(href)`    |
| Error                 | `GraftError(name, message, cause, extra)`|
| Symbol                | `Symbol(kind, value)` (identity-based)   |
| Array / Object        | `list` / `dict` (symbol keys allowed)    |
| Map / Set             | `GraftMap` / `GraftSet` (ordered, by id) |
