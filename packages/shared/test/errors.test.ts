import { describe, expect, it } from "vite-plus/test";

import { errorPayloadSchema } from "../src/errors.ts";

describe("error payload", () => {
  it("rejects details that wouldn't survive a trip through JSON", () => {
    for (const value of [new Date(0), 1n, Number.NaN, undefined]) {
      const payload = { code: "x", message: "", details: { value } };
      expect(errorPayloadSchema.safeParse(payload).success).toBeFalsy();
    }
  });

  it("rejects an empty code, since callers branch on it", () => {
    const payload = { code: "", message: "Something went wrong" };
    expect(errorPayloadSchema.safeParse(payload).success).toBeFalsy();
  });
});
