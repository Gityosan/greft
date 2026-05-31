# greft

Language-agnostic lossless binary serializer.

- Format spec: [spec/FORMAT.md](spec/FORMAT.md)
- Conformance ports (JS / Python / Rust / Go): [conformance/README.md](conformance/README.md)
- Release / distribution options (npm 以外): [docs/RELEASING.md](docs/RELEASING.md)

## JS library (`js/`)

```ts
import { encode, decode } from "greft";

const bytes = encode(value); // value -> Uint8Array (lossless, cycles + shared identity)
const back = decode(bytes); // Uint8Array -> value
```

- **Extension types** — losslessly serialize values the core rejects (class
  instances, domain types, …) by registering a `TypeExtension`:
  `encode(v, { types })` / `decode(bytes, { types })`.
- **Decode hardening** — `decode(bytes, { maxNodes })` plus built-in bounds
  checks reject malformed/oversized input.
- **JSON bridge** — `toJSON(value)` / `fromJSON(json)` give a `JSON.stringify`-able
  view for inspecting or hand-editing fixtures (lossy on identity; rejects cycles).
- **CLI** — `graft inspect <file.bin>` (readable tree + summary) and
  `graft diff <a.bin> <b.bin>` (value-graph diff).
