# Graft Conformance Harness

This directory defines how language implementations prove they conform to the
Graft binary format. The format itself is specified in
[`../spec/FORMAT.md`](../spec/FORMAT.md) — that document is the single source of
truth. This README only describes the *testing* contract.

There is no implementation code here yet; this is the skeleton that future
language ports build against.

---

## 1. Golden vectors

The canonical test inputs live in [`../spec/golden/`](../spec/golden/). Each
`.bin` file is a complete Graft stream (`MAGIC VERSION ROOT COUNT NODE{COUNT}`,
see FORMAT.md §3) produced by the reference JS encoder.

Every file's root is a single `Object` node whose keys name the individual
cases. Decode the whole file once, then assert on each key.

| File             | Covers (FORMAT.md §) | Cases |
|------------------|----------------------|-------|
| `primitive.bin`  | §5.1                 | null, undefined, bool, int, float, NaN, -0, ±Infinity |
| `bigint.bin`     | §5.1                 | zero, large positive, large negative |
| `string.bin`     | §2.4                 | empty, ASCII, multibyte UTF-8, emoji (surrogate pairs) |
| `date.bin`       | §5.3                 | epoch, pre-epoch (negative ms), normal, far future |
| `bytes.bin`      | §5.1 `Bytes`         | ArrayBuffer (non-empty + empty) |
| `typedarray.bin` | §5.4                 | every `ElementType` (0–10) + an empty array |
| `map_set.bin`    | §5.5                 | Map & Set, including an object-identity key shared between them |
| `symbol.bin`     | §5.2                 | Registered, Unique (with file-internal identity), WellKnown |
| `cycles.bin`     | §4                   | self-cycle, cross-references, shared identity |

### Regenerating

The vectors are generated from the reference implementation:

```bash
cd js && npx tsx scripts/gen-golden.ts
```

Regenerate only when FORMAT.md changes. The committed `.bin` files are the
authority that other languages test against — treat a diff in these files
during review as a deliberate format change, not an incidental one.

---

## 2. How a new implementation passes conformance

A conforming implementation must satisfy FORMAT.md §8. Concretely, against the
golden vectors:

1. **Read** each `.bin` file as raw bytes.
2. **Verify the header**: `MAGIC == "GRF1"`, `VERSION == 1`. Reject otherwise.
3. **Decode** the full heap using the two-pass algorithm (FORMAT.md §4):
   allocate `COUNT` placeholder slots, parse every node, then resolve all
   references. This is mandatory — cycles and shared identity cannot be
   restored with a single recursive pass.
4. **Assert** the decoded values match the expected structure for each key.
   Use the documented fallback (FORMAT.md §5) for any type the target language
   cannot represent natively, and assert against the fallback shape instead.
5. **Error** on unknown tags (the reserved ranges in FORMAT.md §6) rather than
   skipping them.

A round-trip test (decode → re-encode → byte-compare) is **not** required and
generally won't hold across languages: encoders may legitimately order heap
nodes differently. Conformance is defined by *decoded value equality*, not
byte equality. The one stable guarantee is the JS reference encoder
reproducing its own golden bytes.

### Expected-value notation

FORMAT.md §8 references a `.meta.json` sidecar describing each vector's expected
decoded structure in a language-neutral notation. Those files are not yet
generated. Until they exist, the expectations are defined by the case names in
the table above plus the inputs in `js/scripts/gen-golden.ts`, which is the
human-readable description of what each vector contains.

---

## 3. Directory convention for language implementations

Each language port gets its own subdirectory under `conformance/`:

```
conformance/
  README.md            ← this file
  <lang>/              ← e.g. go/, rust/, python/, ruby/, cpp/
    README.md          ← how to build & run this port's conformance suite
    ...                ← decoder + a test runner over ../../spec/golden/
```

Requirements for each `<lang>/`:

- A test runner that loads every `.bin` from `spec/golden/`, decodes it, and
  asserts the documented expectations.
- A short `README.md` with the exact build/run command (e.g. `go test ./...`,
  `cargo test`, `pytest`).
- No modification of `spec/golden/` or `spec/FORMAT.md` from within a language
  directory. Format changes flow the other way: edit FORMAT.md first, then the
  reference encoder, regenerate golden, then update each port.
