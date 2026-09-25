import { capabilityMaxTtlMs } from "@grasp-os/shared/capability";
import { bindingNameSchema } from "@grasp-os/shared/permissions";
import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  addConnection,
  agentFor,
  capabilityFor,
  outcome,
  serverUrl,
} from "./connect.ts";
import type { Call } from "./connect.ts";
import { fakeMcpServer } from "./mcp-server.ts";

// Connect is reached only by core, but trusts no call from it blindly: each
// one needs a capability core signed for exactly that call, and nothing
// goes out before it holds.

const server = fakeMcpServer(serverUrl, [
  {
    name: "mail.list",
    readOnly: true,
    run: () => ({ output: { messages: [] } }),
  },
]);

const anna = agentFor("user-anna");

let call: Call;

const callWith = async (capability: unknown, request: object = call) =>
  await outcome(exports.default.call({ ...request, capability }));

describe("calls to connect", () => {
  beforeEach(async () => {
    call = {
      connectionId: await addConnection(),
      action: "mail.list",
      input: { top: 10 },
      idempotencyKey: "run-1:list",
    };
  });

  it("go through with a capability for exactly that call", async () => {
    await expect(callWith(await capabilityFor(anna, call))).resolves.toBe("ok");
  });

  it("go through with a capability made with the previous key while it is set", async () => {
    const previous: unknown = Reflect.get(
      env,
      "CAPABILITY_SIGNING_KEY_PREVIOUS"
    );
    if (typeof previous !== "string") {
      throw new TypeError("Expected a previous key");
    }
    await expect(
      callWith(await capabilityFor(anna, call, previous))
    ).resolves.toBe("ok");
  });

  it("can't be given a stub name that is one of connect's own bindings", () => {
    // Test-only bindings aside, every name in connect's env is the platform's.
    const names = Object.keys(env).filter(
      (name) => name !== "CONNECT_MIGRATIONS"
    );
    expect(
      names.filter((name) => bindingNameSchema.safeParse(name).success)
    ).toStrictEqual([]);
  });

  it("are refused without a valid capability", async () => {
    const forged = await capabilityFor(
      anna,
      call,
      "an-attackers-own-key-of-32-characters-or-more"
    );
    const valid = await capabilityFor(anna, call);
    const [payload = "", mac = ""] = valid.split(".");
    const altered = `${payload.slice(0, -2)}AA.${mac}`;
    const refused = await Promise.all(
      [undefined, "", "not.a-capability", forged, altered, 42].map(
        async (capability) => await callWith(capability)
      )
    );
    expect(refused).toStrictEqual(refused.map(() => "capability.invalid"));
    expect(server.requests).toBe(0);
  });

  it("are refused with an expired capability, or one from the future", async () => {
    const now = Date.now();
    const expired = await capabilityFor(
      anna,
      call,
      undefined,
      now - capabilityMaxTtlMs
    );
    const future = await capabilityFor(anna, call, undefined, now + 60_000);
    const refused = await Promise.all(
      [expired, future].map(async (capability) => await callWith(capability))
    );
    expect(refused).toStrictEqual(["capability.invalid", "capability.invalid"]);
    expect(server.requests).toBe(0);
  });

  it("are refused with a capability for another action, connection, resource or key", async () => {
    const capability = await capabilityFor(anna, call);
    const otherCalls = [
      { ...call, action: "mail.send" },
      { ...call, action: "MAIL.LIST" },
      { ...call, connectionId: await addConnection() },
      { ...call, resource: "ceo@acme.test" },
      { ...call, idempotencyKey: "run-2:list" },
    ];
    const refused = await Promise.all(
      otherCalls.map(async (other) => await callWith(capability, other))
    );
    expect(refused).toStrictEqual(otherCalls.map(() => "capability.invalid"));
    expect(server.requests).toBe(0);
  });

  it("are refused when they aren't a call", async () => {
    const capability = await capabilityFor(anna, call);
    const notCalls = [
      undefined,
      "call",
      { capability },
      { ...call, capability, extra: true },
      { ...call, capability, input: new Date() },
    ];
    const refused = await Promise.all(
      notCalls.map(
        async (request) => await outcome(exports.default.call(request))
      )
    );
    expect(refused).toStrictEqual(notCalls.map(() => "connect.invalid_call"));
  });
});
