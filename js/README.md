# greft-codec

Language-agnostic **lossless** binary serializer. Encode values in JavaScript,
decode them in other languages (Python / Rust / Go / …) and use them as-is.

- **Lossless** for everything the JS runtime can represent — cycles, shared
  identity, `Map`/`Set` with arbitrary keys, `BigInt`, typed arrays, `Date`,
  `RegExp`, `Error`, symbols, and more.
- **Zero runtime dependencies.** No `Buffer` / `structuredClone` / `vm` — only
  standard `DataView` / `TextEncoder` / `BigInt`.
- **One format, many readers.** The byte format is a single source of truth
  ([`spec/FORMAT.md`](https://github.com/Gityosan/greft/blob/main/spec/FORMAT.md)),
  verified byte-for-byte across JS / Python / Rust / Go conformance ports.

A primary use case: take JS mock data (e.g. from `zod-v4-mocks`) and reuse it as
test fixtures in other languages.

## Install

```bash
npm add greft-codec      # or: pnpm add greft-codec / yarn add greft-codec
```

## Usage

```ts
import { encode, decode } from "greft-codec";

const bytes = encode(value); // value -> Uint8Array (lossless, cycles + shared identity)
const back = decode(bytes); // Uint8Array -> value
```

### Extension types

Losslessly serialize values the core rejects (class instances, domain types, …)
by registering a `TypeExtension`:

```ts
import { encode, decode } from "greft-codec";

const types = [/* TypeExtension[] */];
const bytes = encode(value, { types });
const back = decode(bytes, { types });
```

### Weak collections

`WeakMap` / `WeakSet` contents are supplied explicitly via a `provider`:

```ts
encode(value, { provider });
```

### JSON bridge

Inspect or hand-edit an encoded graph as JSON (identity-lossy; cycles rejected):

```ts
import { toJSON, fromJSON } from "greft-codec";
```

## CLI

The package installs a `graft` binary:

```bash
npm i -g greft-codec
graft inspect <file.bin>   # tree view + tag histogram
graft diff <a.bin> <b.bin> # structural diff of two value graphs
```

One-off, without installing:

```bash
npx -p greft-codec graft inspect <file.bin>
```

## Decode safety

`decode(bytes, { maxNodes })` bounds work; malformed input (out-of-range refs,
counts exceeding the buffer) is rejected rather than trusted.

## Links

- Format spec: [spec/FORMAT.md](https://github.com/Gityosan/greft/blob/main/spec/FORMAT.md)
- Conformance ports (JS / Python / Rust / Go): [conformance/README.md](https://github.com/Gityosan/greft/blob/main/conformance/README.md)
- Changelog: [CHANGELOG.md](https://github.com/Gityosan/greft/blob/main/CHANGELOG.md)

## License

ISC
