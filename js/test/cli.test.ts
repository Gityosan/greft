import { describe, it, expect } from "vitest";
import { encode } from "../src/index";
import { format, histogram, diffValues } from "../src/cli";
import { decode } from "../src/decode";

const roundtrip = (v: unknown) => decode(encode(v));

describe("cli format (inspect tree)", () => {
  it("renders scalars, types, and shared/cycle markers", () => {
    const shared = { tag: "s" };
    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    const out = format(roundtrip({ a, x: shared, y: shared, n: 1, d: new Date(0) }));
    expect(out).toContain("Date(1970-01-01T00:00:00.000Z)");
    expect(out).toContain("shared/cycle"); // both the self-cycle and the shared object
    expect(out).toContain('name: "a"');
  });
});

describe("cli histogram (summary)", () => {
  it("counts each distinct object once, primitives per occurrence", () => {
    const shared = { v: 1 };
    const h = histogram(roundtrip({ a: shared, b: shared, s: "x", t: "y" }));
    expect(h.get("Object")).toBe(2); // root + shared (counted once despite 2 refs)
    expect(h.get("string")).toBe(2);
  });
});

describe("cli diffValues", () => {
  it("identical graphs produce no diffs", () => {
    expect(diffValues(roundtrip({ a: 1, b: [1, 2] }), roundtrip({ a: 1, b: [1, 2] }))).toEqual([]);
  });

  it("reports changed scalars, added/removed keys, and length", () => {
    const a = roundtrip({ a: 1, b: "x", arr: [1, 2] });
    const b = roundtrip({ a: 2, c: "y", arr: [1, 2, 3] });
    const d = diffValues(a, b);
    expect(d).toContain("$.a: 1 != 2");
    expect(d).toContain("$.b: only in A");
    expect(d).toContain("$.c: only in B");
    expect(d.some((x) => x.includes("length 2 != 3"))).toBe(true);
  });

  it("reports type mismatches and handles cycles without hanging", () => {
    const a: Record<string, unknown> = { x: 1 };
    a.self = a;
    const b: Record<string, unknown> = { x: "1" };
    b.self = b;
    const d = diffValues(roundtrip(a), roundtrip(b));
    expect(d.some((x) => x.includes("$.x: type number != string"))).toBe(true);
  });
});
