import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { encode, decode } from "../src/index";

// Property: decode(encode(x)) is structurally equal to x for any JSON-like
// value graph. fast-check shrinks counter-examples to a minimal failing case.
describe("roundtrip properties", () => {
  // Leaf values graft can represent losslessly and that compare with toEqual.
  const leaf = fc.oneof(
    fc.constant(null),
    fc.boolean(),
    fc.integer(),
    fc.double({ noDefaultInfinity: false, noNaN: true }),
    fc.string(),
    fc.bigInt(),
  );

  const anyValue = fc.letrec((tie) => ({
    value: fc.oneof({ depthSize: "small" }, leaf, tie("array"), tie("object")),
    array: fc.array(tie("value"), { maxLength: 8 }),
    object: fc.dictionary(fc.string(), tie("value"), { maxKeys: 8 }),
  })).value;

  it("any nested value survives encode -> decode", () => {
    fc.assert(
      fc.property(anyValue, (v) => {
        expect(decode(encode(v))).toEqual(v);
      }),
    );
  });

  it("typed arrays survive encode -> decode", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: -2147483648, max: 2147483647 })), (xs) => {
        const arr = Int32Array.from(xs);
        const out = decode(encode(arr)) as Int32Array;
        expect(out instanceof Int32Array).toBe(true);
        expect([...out]).toEqual([...arr]);
      }),
    );
  });

  it("dates survive encode -> decode", () => {
    fc.assert(
      fc.property(fc.date({ noInvalidDate: true }), (d) => {
        const out = decode(encode(d)) as Date;
        expect(out instanceof Date && out.getTime() === d.getTime()).toBe(true);
      }),
    );
  });
});
