import { describe, expect, it } from "vite-plus/test";

import { canonicalJson } from "../src/audit-chain.ts";

describe("canonical JSON", () => {
  it("gives the same text whatever order the keys were written in", () => {
    expect(
      canonicalJson({ b: 1, a: { d: [2, { f: 3, e: 4 }], c: null } })
    ).toBe(canonicalJson({ a: { c: null, d: [2, { e: 4, f: 3 }] }, b: 1 }));
  });

  it("sorts keys, drops undefined members and adds no whitespace", () => {
    expect(
      canonicalJson({ b: "x", a: [true, "é\n"], skipped: undefined, "": 0 })
    ).toBe('{"":0,"a":[true,"é\\n"],"b":"x"}');
  });

  it("keeps array order, which carries meaning", () => {
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
  });

  it("refuses numbers JSON can't represent", () => {
    expect(() => canonicalJson({ amount: Number.NaN })).toThrow(TypeError);
  });
});
