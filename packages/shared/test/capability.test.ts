// Buffer, to take a token apart the way an attacker would.
/// <reference types="node" />
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import {
  capabilityClockSkewMs,
  capabilityTtlMs,
  signCapability,
  verifyCapability,
} from "../src/capability.ts";
import type { CapabilityScope } from "../src/capability.ts";
import { authoritySchema } from "../src/permissions.ts";

const key = "capability-test-key-of-32-characters-or-more";
const now = Date.UTC(2026, 8, 25, 12);

const authority = authoritySchema.parse({
  subject: { type: "app", appId: "app-invoices" },
  onBehalfOf: "user-anna",
  mode: "workflow",
});

const scope: CapabilityScope = {
  connectionId: "connection-outlook",
  resource: "finance@acme.test",
  action: "mail.send",
  idempotencyKey: "run-1/book",
};

const refusedSchema = z.object({
  code: z.literal("capability.invalid"),
  details: z.object({ reason: z.string() }),
});

/** Why `run` was refused, or "none" if it wasn't. */
const refusal = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
    return "none";
  } catch (error) {
    return refusedSchema.parse(error).details.reason;
  }
};

describe("capabilities", () => {
  it("name who, for whom and how, for the one call they were made for", async () => {
    const token = await signCapability(key, authority, scope, now);
    const claims = await verifyCapability(key, token, scope, now + 1000);
    expect(claims).toMatchObject({
      aud: "connect",
      authority,
      connectionId: scope.connectionId,
      resource: scope.resource,
      action: scope.action,
      idempotencyKey: scope.idempotencyKey,
    });
  });

  it("are refused when made with another key", async () => {
    const forged = await signCapability(
      "an-attackers-own-key-of-32-characters-or-more",
      authority,
      scope,
      now
    );
    await expect(
      refusal(async () => await verifyCapability(key, forged, scope, now))
    ).resolves.toBe("mac");
  });

  it("are refused when any claim was changed on the way", async () => {
    const token = await signCapability(key, authority, scope, now);
    const [payload = "", mac = ""] = token.split(".");
    const claims = z
      .record(z.string(), z.unknown())
      .parse(JSON.parse(Buffer.from(payload, "base64url").toString()));
    const changes = [
      { action: "mail.delete" },
      { connectionId: "connection-other" },
      { authority: { ...authority, subject: { type: "agent", agentId: "a" } } },
      { authority: { ...authority, onBehalfOf: "user-admin" } },
      { exp: now + 3_600_000 },
    ];
    for (const change of changes) {
      const altered = Buffer.from(
        JSON.stringify({ ...claims, ...change })
      ).toString("base64url");
      // oxlint-disable-next-line no-await-in-loop -- one change at a time
      const reason = await refusal(
        async () => await verifyCapability(key, `${altered}.${mac}`, scope, now)
      );
      expect(reason).toBe("mac");
    }
  });

  it("are refused when they aren't one", async () => {
    const token = await signCapability(key, authority, scope, now);
    const [payload = ""] = token.split(".");
    const notTokens = [
      undefined,
      null,
      42,
      { token },
      "",
      payload,
      `${payload}.`,
      `${token}.extra`,
      `${payload}.not base64`,
      `${payload}.${Buffer.from("x".repeat(32)).toString("base64url")}`,
    ];
    const reasons = await Promise.all(
      notTokens.map(
        async (notToken) =>
          await refusal(
            async () => await verifyCapability(key, notToken, scope, now)
          )
      )
    );
    expect(reasons).toStrictEqual([
      "malformed",
      "malformed",
      "malformed",
      "malformed",
      "malformed",
      "malformed",
      "malformed",
      "malformed",
      "malformed",
      "mac",
    ]);
  });

  it("expire, and aren't accepted before they were issued", async () => {
    const token = await signCapability(key, authority, scope, now);
    await expect(
      refusal(
        async () =>
          await verifyCapability(key, token, scope, now + capabilityTtlMs - 1)
      )
    ).resolves.toBe("none");
    await expect(
      refusal(
        async () =>
          await verifyCapability(key, token, scope, now + capabilityTtlMs)
      )
    ).resolves.toBe("expired");

    const early = await signCapability(
      key,
      authority,
      scope,
      now + capabilityClockSkewMs + 1000
    );
    await expect(
      refusal(async () => await verifyCapability(key, early, scope, now))
    ).resolves.toBe("expired");
  });

  it("cover only their own connection, resource, action and idempotency key", async () => {
    const token = await signCapability(key, authority, scope, now);
    const otherCalls: CapabilityScope[] = [
      { ...scope, action: "mail.delete" },
      { ...scope, connectionId: "connection-gmail" },
      { ...scope, resource: "ceo@acme.test" },
      { ...scope, resource: undefined },
      { ...scope, idempotencyKey: "run-1/another-step" },
      { ...scope, idempotencyKey: undefined },
    ];
    const reasons = await Promise.all(
      otherCalls.map(
        async (call) =>
          await refusal(
            async () => await verifyCapability(key, token, call, now)
          )
      )
    );
    expect(reasons).toStrictEqual(otherCalls.map(() => "scope"));

    // Made for the whole connection, it still names no resource.
    const whole = await signCapability(
      key,
      authority,
      { ...scope, resource: undefined },
      now
    );
    await expect(
      refusal(async () => await verifyCapability(key, whole, scope, now))
    ).resolves.toBe("scope");
  });

  it("are each unique", async () => {
    const tokens = await Promise.all(
      [1, 2, 3].map(
        async () => await signCapability(key, authority, scope, now)
      )
    );
    expect(new Set(tokens).size).toBe(3);
  });

  it("need a key long enough to resist guessing, on both sides", async () => {
    await expect(
      signCapability("short", authority, scope, now)
    ).rejects.toThrow("at least 32 characters");
    const token = await signCapability(key, authority, scope, now);
    await expect(verifyCapability("", token, scope, now)).rejects.toThrow(
      "at least 32 characters"
    );
  });
});
