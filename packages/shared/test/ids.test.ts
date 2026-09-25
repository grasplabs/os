import { describe, expect, expectTypeOf, it } from "vite-plus/test";

import { appIdSchema, runIdSchema } from "../src/ids.ts";
import type { AppId, RunId } from "../src/ids.ts";

describe("IDs", () => {
  it("rejects an empty ID", () => {
    expect(appIdSchema.safeParse("").success).toBeFalsy();
  });

  it("accepts any other string, since IDs are opaque", () => {
    expect(runIdSchema.parse("run_01J9Z")).toBe("run_01J9Z");
  });

  it("keeps each kind of ID apart, and a plain string out", () => {
    expectTypeOf<AppId>().not.toExtend<RunId>();
    expectTypeOf<RunId>().not.toExtend<AppId>();
    expectTypeOf<string>().not.toExtend<AppId>();
    expectTypeOf(runIdSchema.parse("run_01J9Z")).toEqualTypeOf<RunId>();
  });
});
