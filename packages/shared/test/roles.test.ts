import { describe, expect, it } from "vite-plus/test";

import { canBuild, isAdmin } from "../src/roles.ts";

describe("roles", () => {
  it("let admins do everything and builders build", () => {
    expect(
      ["admin", "builder", "user"].map((role) => [
        isAdmin(role),
        canBuild(role),
      ])
    ).toStrictEqual([
      [true, true],
      [false, true],
      [false, false],
    ]);
  });

  it("give a role they don't know nothing", () => {
    for (const role of ["owner", "member", "Admin", "", "superadmin"]) {
      expect([isAdmin(role), canBuild(role)]).toStrictEqual([false, false]);
    }
  });
});
