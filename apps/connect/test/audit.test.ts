import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import {
  addConnection,
  agentFor,
  appFor,
  auditEvents,
  callAs,
  capabilityFor,
  outcome,
  serverUrl,
} from "./connect.ts";
import { fakeMcpServer } from "./mcp-server.ts";

// Every call to connect is in the audit log: who made it and for whom, on
// which connection, which action, which resources it read, and how it
// ended. Refused calls too. Identifiers only: never the input or output.

/** Graph-sized message IDs, more than one audit event holds. */
const manyMessages = Array.from(
  { length: 250 },
  (_, index) =>
    `AAMkAGI2TG93AAA-${String(index).padStart(3, "0")}-${"x".repeat(100)}`
);

const server = fakeMcpServer(serverUrl, [
  {
    name: "mail.list",
    readOnly: true,
    run: ({ many }) => {
      const messages = many === true ? manyMessages : ["message-1"];
      return {
        output: { subject: "Quarterly numbers, confidential" },
        provenance: messages,
      };
    },
  },
  {
    name: "mail.send",
    run: () => ({ output: { messageId: "sent-1" } }),
  },
]);

const events = auditEvents();

const anna = agentFor("user-anna");

describe("the audit log", () => {
  it("records a read with who made it, for whom, and what it read", async () => {
    const connectionId = await addConnection();
    await callAs(anna, {
      connectionId,
      action: "mail.list",
      input: { query: "secret project" },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      source: "connect",
      actor: { type: "agent", agentId: "agent-chat", onBehalfOf: "user-anna" },
      action: "connection.call",
      target: { type: "connection", id: connectionId },
      provenance: ["message-1"],
      detail: {
        action: "mail.list",
        onBehalfOf: "user-anna",
        mode: "interactive",
        sideEffect: false,
        outcome: "ok",
        provenanceCount: 1,
      },
    });
    // Nothing of the input or the output.
    const recorded = JSON.stringify(events);
    expect(recorded).not.toContain("secret project");
    expect(recorded).not.toContain("Quarterly numbers");
  });

  it("records every resource a large read touched", async () => {
    const connectionId = await addConnection();
    await callAs(appFor("user-anna"), {
      connectionId,
      action: "mail.list",
      input: { many: true },
    });
    const [first, ...rest] = events;
    expect(first).toMatchObject({
      actor: { type: "app", appId: "app-crm", part: "server" },
      action: "connection.call",
      detail: { mode: "workflow", provenanceCount: manyMessages.length },
    });
    expect(rest.length).toBeGreaterThan(0);
    for (const event of rest) {
      expect(event).toMatchObject({
        action: "connection.call.provenance",
        requestId: first?.requestId,
        target: first?.target,
      });
    }
    expect(events.flatMap((event) => event.provenance)).toStrictEqual(
      manyMessages
    );
  });

  it("records a side effect and each repeat answered from its result", async () => {
    const connectionId = await addConnection();
    const call = {
      connectionId,
      action: "mail.send",
      input: {},
      idempotencyKey: "run-1:send",
    };
    await callAs(anna, call);
    await callAs(anna, call);
    expect(events.map((event) => event.detail)).toMatchObject([
      { sideEffect: true, outcome: "ok", idempotencyKey: "run-1:send" },
      { sideEffect: true, outcome: "replayed", idempotencyKey: "run-1:send" },
    ]);
    expect(server.ran).toHaveLength(1);
  });

  it("records refused calls with the reason", async () => {
    const connectionId = await addConnection({
      scope: "personal",
      ownerUserId: "user-anna",
    });
    const call = { connectionId, action: "mail.send", input: {} };
    const forged = await capabilityFor(
      anna,
      call,
      "an-attackers-own-key-of-32-characters-or-more"
    );
    const expired = await capabilityFor(
      anna,
      call,
      undefined,
      Date.now() - 120_000
    );
    const ends = [
      await outcome(exports.default.call({ ...call, capability: forged })),
      await outcome(exports.default.call({ ...call, capability: expired })),
      await outcome(callAs(agentFor("user-ben"), call)),
      await outcome(callAs(anna, call)),
      await outcome(exports.default.call({ nothing: "useful" })),
    ];
    expect(ends).toStrictEqual([
      "capability.invalid",
      "capability.invalid",
      "connect.not_owner",
      "connect.idempotency_key_required",
      "connect.invalid_call",
    ]);
    expect(
      events.map(({ actor, target, detail }) => ({
        actor: actor.type,
        target: target?.id,
        outcome: detail.outcome,
        reason: detail.reason,
      }))
    ).toStrictEqual([
      // Until its capability holds, nobody is known to have made the call.
      {
        actor: "system",
        target: connectionId,
        outcome: "refused",
        reason: "capability.invalid",
      },
      {
        actor: "system",
        target: connectionId,
        outcome: "refused",
        reason: "capability.invalid",
      },
      {
        actor: "agent",
        target: connectionId,
        outcome: "refused",
        reason: "connect.not_owner",
      },
      {
        actor: "agent",
        target: connectionId,
        outcome: "refused",
        reason: "connect.idempotency_key_required",
      },
      {
        actor: "system",
        target: undefined,
        outcome: "refused",
        reason: "connect.invalid_call",
      },
    ]);
    expect(server.ran).toStrictEqual([]);
  });

  it("records a side effect whose outcome is unknown as such", async () => {
    const connectionId = await addConnection();
    server.network = "drop";
    await outcome(
      callAs(anna, {
        connectionId,
        action: "mail.send",
        input: {},
        idempotencyKey: "run-1:send",
      })
    );
    expect(events.map((event) => event.detail)).toMatchObject([
      { outcome: "unknown", reason: "connect.outcome_unknown" },
    ]);
  });
});
