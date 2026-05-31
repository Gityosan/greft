// User-registered extension types. They turn objects the core would otherwise
// reject (class instances, Temporal values, domain types, …) into losslessly
// round-trippable values, without changing the core encoder/decoder.
//
// On encode, the first extension whose `match` returns true claims the value;
// its `encode` returns a *surrogate* — any Graft-encodable value — which is
// stored under `Tag.Custom` alongside the extension's `name`. On decode, the
// extension registered under that `name` reconstructs the value from the
// surrogate via `decode`.

export interface TypeExtension<T = any> {
  /** Stable identifier written into the stream; the decode side matches on it. */
  name: string;
  /** Encode-side test: does this extension handle `value`? */
  match: (value: unknown) => boolean;
  /** Map the value to a Graft-encodable surrogate. */
  encode: (value: T) => unknown;
  /** Reconstruct the value from its (already-decoded) surrogate. */
  decode: (surrogate: unknown) => T;
}
