import { describe, it, expect } from "vitest";
import { toJSON, fromJSON } from "../src/index";

// Round-trips a value through toJSON -> JSON string -> parse -> fromJSON and
// returns the result, also asserting the intermediate is real JSON.
function bridge<T>(value: T): T {
  const json = toJSON(value);
  const text = JSON.stringify(json); // must not throw
  return fromJSON(JSON.parse(text)) as T;
}

describe("JSON bridge", () => {
  it("plain JSON-ish data is natural and round-trips", () => {
    const v = { a: 1, b: "x", c: [true, null], d: { e: 2 } };
    expect(toJSON(v)).toEqual(v);
    expect(bridge(v)).toEqual(v);
  });

  it("special numbers", () => {
    const out = bridge({ nan: NaN, inf: Infinity, ninf: -Infinity, nz: -0, ok: 3.5 });
    expect(Number.isNaN(out.nan)).toBe(true);
    expect(out.inf === Infinity && out.ninf === -Infinity).toBe(true);
    expect(Object.is(out.nz, -0) && out.ok === 3.5).toBe(true);
  });

  it("undefined, bigint", () => {
    const out = bridge({ u: undefined, big: 123456789012345678901234567890n });
    expect("u" in out && out.u === undefined).toBe(true);
    expect(out.big === 123456789012345678901234567890n).toBe(true);
  });

  it("Date / RegExp / URL", () => {
    const out = bridge({ d: new Date(123456), r: /ab+c/gi, u: new URL("https://x.test/p") });
    expect(out.d instanceof Date && out.d.getTime() === 123456).toBe(true);
    expect(out.r instanceof RegExp && out.r.source === "ab+c" && out.r.flags === "gi").toBe(true);
    expect(out.u instanceof URL && out.u.href === "https://x.test/p").toBe(true);
  });

  it("Map / Set with mixed keys", () => {
    const out = bridge({
      m: new Map<unknown, unknown>([
        ["k", 1],
        [2, "v"],
      ]),
      s: new Set([1, "a"]),
    });
    expect(out.m instanceof Map && out.m.get("k") === 1 && out.m.get(2) === "v").toBe(true);
    expect(out.s instanceof Set && out.s.has(1) && out.s.has("a")).toBe(true);
  });

  it("typed arrays / ArrayBuffer / DataView", () => {
    const ab = new Uint8Array([1, 2, 3]).buffer;
    const out = bridge({ ta: new Int16Array([-1, 2]), ab, dv: new DataView(ab) });
    expect(out.ta instanceof Int16Array && [...out.ta].join() === "-1,2").toBe(true);
    expect(out.ab instanceof ArrayBuffer && [...new Uint8Array(out.ab)].join() === "1,2,3").toBe(
      true,
    );
    expect(out.dv instanceof DataView).toBe(true);
  });

  it("symbols and symbol-keyed objects", () => {
    const sym = Symbol("desc");
    const obj = { [sym]: 1, plain: 2, iter: Symbol.iterator };
    const out = bridge(obj) as Record<string | symbol, unknown>;
    expect(out.plain).toBe(2);
    expect(out.iter).toBe(Symbol.iterator);
    const k = Object.getOwnPropertySymbols(out).find((s) => s.description === "desc");
    expect(k !== undefined && out[k!] === 1).toBe(true);
  });

  it("Error with cause and extra props", () => {
    const e = new TypeError("boom", { cause: { code: 7 } }) as TypeError & { detail?: string };
    e.detail = "ctx";
    const out = bridge(e) as Error & { cause?: { code: number }; detail?: string };
    expect(out instanceof Error && out.name === "TypeError" && out.message === "boom").toBe(true);
    expect(out.cause?.code === 7 && out.detail === "ctx").toBe(true);
  });

  it("an object literally keyed $graft survives", () => {
    const out = bridge({ $graft: "not a tag", x: 1 }) as Record<string, unknown>;
    expect(out.$graft === "not a tag" && out.x === 1).toBe(true);
  });

  it("toJSON rejects cycles", () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(() => toJSON(a)).toThrow(/cycle/);
  });
});
