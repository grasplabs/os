import { describe, expect, it } from "vite-plus/test";

import { signCapability, verifyCapability } from "../src/capability.ts";
import { deriveClientSecret } from "../src/client-secrets.ts";
import { fromBase64Url } from "../src/encoding.ts";
import { authoritySchema } from "../src/permissions.ts";
import { deriveRouterSecret } from "../src/router.ts";

const clientKey = "test-client-key";

describe("a client's derived secrets", () => {
  it("are HMAC-SHA256 of <purpose>:<clientId>:<generation>, the router secret included", async () => {
    // From `printf 'capability:acme:3' | openssl dgst -sha256 -hmac 'test-client-key'`.
    await expect(
      deriveClientSecret(clientKey, "capability", "acme", 3)
    ).resolves.toBe(
      "65a457e3940dac6e249ba6431d50af9900a021b255e2b3a1745a8bd1528b2fc8"
    );
    await expect(
      deriveRouterSecret("test-router-key", "acme", 3)
    ).resolves.toBe(
      await deriveClientSecret("test-router-key", "router", "acme", 3)
    );
  });

  it("are the same for one client and generation, and differ across clients, generations, purposes and keys", async () => {
    const secrets = await Promise.all([
      deriveClientSecret(clientKey, "capability", "acme", 1),
      deriveClientSecret(clientKey, "capability", "acme", 1),
      deriveClientSecret(clientKey, "capability", "globex", 1),
      deriveClientSecret(clientKey, "capability", "acme", 2),
      deriveClientSecret(clientKey, "better-auth", "acme", 1),
      deriveClientSecret("another-key", "capability", "acme", 1),
    ]);
    expect(secrets[0]).toBe(secrets[1]);
    expect(new Set(secrets.slice(1)).size).toBe(5);
  });

  it("encode as the Worker reading them parses them", async () => {
    const key = await deriveClientSecret(
      clientKey,
      "token-encryption",
      "acme",
      1,
      "base64"
    );
    // Connect's vault: 32 bytes of base64 (its src/vault.ts).
    const bytes = fromBase64Url(
      key.replace(/[=]+$/u, "").replaceAll("+", "-").replaceAll("/", "_")
    );
    expect(bytes.byteLength).toBe(32);

    // A capability signed by core and checked by connect with the key.
    const signing = await deriveClientSecret(
      clientKey,
      "capability",
      "acme",
      1
    );
    const scope = {
      connectionId: "connection-outlook",
      resource: "finance@acme.test",
      action: "mail.send",
      idempotencyKey: "run-1/book",
      origin: {
        permissionId: "permission-outlook",
        context: { type: "app" as const, appId: "app-invoices" },
      },
    };
    const authority = authoritySchema.parse({
      subject: { type: "app", appId: "app-invoices" },
      onBehalfOf: "user-anna",
      mode: "workflow",
      appVersion: 1,
    });
    const token = await signCapability(signing, authority, scope);
    await expect(
      verifyCapability([signing], token, scope)
    ).resolves.toMatchObject({ authority });
  });

  it("refuse a purpose or client id that could collide, an empty key and a bad generation", async () => {
    const refused = await Promise.all(
      [
        ["", "capability", "acme", 1],
        [clientKey, "cap:ability", "acme", 1],
        [clientKey, "capability", "ac:me", 1],
        [clientKey, "capability", "acme", -1],
      ].map(async ([key, purpose, clientId, generation]) => {
        try {
          await deriveClientSecret(
            String(key),
            String(purpose),
            String(clientId),
            Number(generation)
          );
          return "derived";
        } catch (error) {
          return error instanceof TypeError ? "refused" : "other";
        }
      })
    );
    expect(refused).toStrictEqual(["refused", "refused", "refused", "refused"]);
  });
});
