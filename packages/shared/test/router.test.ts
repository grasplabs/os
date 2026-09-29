import { describe, expect, it } from "vite-plus/test";

import {
  deriveRouterSecret,
  newClientIdSchema,
  routerHostKey,
} from "../src/router.ts";

describe("router secret", () => {
  it("is HMAC-SHA256 of router:<clientId>:<generation> under the router key, in hex", async () => {
    // From `printf 'router:acme:3' | openssl dgst -sha256 -hmac 'test-router-key'`,
    // so anything computing it outside this code gets the same secret.
    await expect(
      deriveRouterSecret("test-router-key", "acme", 3)
    ).resolves.toBe(
      "cb1d4a5f0ce71969317931bd5fd491a76bc3d4490e44f39be5be1143b1b2e184"
    );
  });

  it("refuses an empty key, a client id with a colon, and a generation that isn't a whole number", async () => {
    await expect(deriveRouterSecret("", "acme", 3)).rejects.toThrow(TypeError);
    await expect(deriveRouterSecret("key", "acme:3", 1)).rejects.toThrow(
      TypeError
    );
    await Promise.all(
      [-1, 1.5, Number.NaN].map(async (generation) => {
        await expect(
          deriveRouterSecret("key", "acme", generation)
        ).rejects.toThrow(TypeError);
      })
    );
  });

  it("takes a new client id that fits its hostname and workers.dev subdomain, up to 50 characters, and no reserved one", () => {
    expect(
      [
        "acme",
        "a".repeat(50),
        "a".repeat(51),
        "Acme",
        "-acme",
        "www",
        "api",
      ].map((id) => newClientIdSchema.safeParse(id).success)
    ).toStrictEqual([true, true, false, false, false, false, false]);
    // The longest fallback subdomain still fits a DNS label.
    expect(`grasp-${"a".repeat(50)}-abcdef`).toHaveLength(63);
  });

  it("keys hostnames in lowercase, without a trailing dot", () => {
    expect(routerHostKey("Acme.Grasp.Test.")).toBe("acme.grasp.test");
  });
});
