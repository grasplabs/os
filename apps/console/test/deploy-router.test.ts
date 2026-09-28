import { describe, expect, it } from "vite-plus/test";

import { coreOrigin } from "../src/deploy/router.ts";

describe("core's address", () => {
  it("is its script on the account's workers.dev subdomain", () => {
    expect(coreOrigin("grasp-os-core", "grasp-acme")).toBe(
      "https://grasp-os-core.grasp-acme.workers.dev"
    );
  });

  it("is refused before anything is sent to it unless it's a workers.dev origin", () => {
    const refused = [
      ["grasp-os-core", "evil.example.com/x"],
      ["grasp-os-core", "grasp acme"],
      ["grasp-os-core", "grasp-acme:8443"],
    ].map(([script = "", subdomain = ""]) => {
      try {
        coreOrigin(script, subdomain);
        return "allowed";
      } catch (error) {
        return error instanceof Error && "code" in error ? error.code : "other";
      }
    });

    expect(refused).toStrictEqual([
      "invalid_core_origin",
      "invalid_core_origin",
      "invalid_core_origin",
    ]);
  });
});
