import { capabilityErrors, signCapability } from "@grasp-os/shared/capability";
import { connectErrors } from "@grasp-os/shared/connect";
import {
  authoritySchema,
  bindingNameSchema,
} from "@grasp-os/shared/permissions";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

// Connect is reached only by core, but trusts no call from it blindly: each
// one needs a capability for exactly that call. Connections don't exist yet,
// so a call that passes the check ends at "no such connection".

const authority = authoritySchema.parse({
  subject: { type: "agent", agentId: "agent-anna" },
  onBehalfOf: "user-anna",
  mode: "interactive",
});

const call = {
  connectionId: "connection-outlook",
  action: "mail.list",
  input: { top: 10 },
};

const capabilityFor = async (
  scope: { connectionId: string; action: string; resource?: string },
  key: string = env.CAPABILITY_SIGNING_KEY
) => await signCapability(key, authority, scope);

/** The code connect refused `request` with, or "ok" if it didn't. */
const refusal = async (request: unknown): Promise<string> => {
  try {
    await exports.default.call(request);
    return "ok";
  } catch (error) {
    return (
      capabilityErrors.codeOf(error) ??
      connectErrors.codeOf(error) ??
      String(error)
    );
  }
};

describe("calls to connect", () => {
  it("go through with a capability for exactly that call", async () => {
    const capability = await capabilityFor(call);
    await expect(refusal({ ...call, capability })).resolves.toBe(
      "connect.connection_not_found"
    );
  });

  it("go through with a capability made with the previous key while it is set", async () => {
    const previous: unknown = Reflect.get(
      env,
      "CAPABILITY_SIGNING_KEY_PREVIOUS"
    );
    if (typeof previous !== "string") {
      throw new TypeError("Expected a previous key");
    }
    const capability = await capabilityFor(call, previous);
    await expect(refusal({ ...call, capability })).resolves.toBe(
      "connect.connection_not_found"
    );
  });

  it("can't be given a stub name that is one of connect's own bindings", () => {
    const own = Object.keys(env).filter(
      (name) => !bindingNameSchema.safeParse(name).success
    );
    expect(own).toStrictEqual(Object.keys(env));
  });

  it("are refused without a valid capability", async () => {
    const forged = await capabilityFor(
      call,
      "an-attackers-own-key-of-32-characters-or-more"
    );
    const withoutOne = [
      call,
      { ...call, capability: "" },
      { ...call, capability: "not.a-capability" },
      { ...call, capability: forged },
    ];
    const refused = await Promise.all(withoutOne.map(refusal));
    expect(refused).toStrictEqual(withoutOne.map(() => "capability.invalid"));
  });

  it("are refused with a capability for another action, connection or resource", async () => {
    const capability = await capabilityFor(call);
    const otherCalls = [
      { ...call, action: "mail.send" },
      { ...call, connectionId: "connection-gmail" },
      { ...call, resource: "ceo@acme.test" },
      { ...call, idempotencyKey: "send-1" },
    ];
    const refused = await Promise.all(
      otherCalls.map(async (other) => await refusal({ ...other, capability }))
    );
    expect(refused).toStrictEqual(otherCalls.map(() => "capability.invalid"));
  });

  it("are refused when they aren't a call", async () => {
    const capability = await capabilityFor(call);
    const notCalls = [
      undefined,
      "call",
      { capability },
      { ...call, capability, extra: true },
      { ...call, capability, input: new Date() },
    ];
    const refused = await Promise.all(notCalls.map(refusal));
    expect(refused).toStrictEqual(notCalls.map(() => "connect.invalid_call"));
  });
});
