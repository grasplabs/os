import { env, exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

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
import type { Call } from "./connect.ts";
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
    name: "mail.open",
    readOnly: true,
    run: () => ({
      output: { error: "The message is too large to open" },
      provenance: ["message-9"],
      isError: true,
    }),
  },
  {
    name: "mail.send",
    run: () => ({ output: { messageId: "sent-1" } }),
  },
]);

const audit = auditEvents();

const anna = agentFor("user-anna");

/** A call of `action` with a fresh idempotency key. */
const write = (
  connectionId: string,
  action: string,
  input: Call["input"] = {}
): Call => ({
  connectionId,
  action,
  input,
  idempotencyKey: crypto.randomUUID(),
});

describe("the audit log", () => {
  it("records a call with who made it, for whom, and what it read", async () => {
    const connectionId = await addConnection();
    await callAs(
      anna,
      write(connectionId, "mail.list", { query: "secret project" })
    );
    const audited = await audit.events();
    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({
      source: "connect",
      actor: { type: "agent", agentId: "agent-chat", onBehalfOf: "user-anna" },
      action: "connection.call",
      target: { type: "connection", id: connectionId },
      provenance: ["message-1"],
      detail: {
        action: "mail.list",
        onBehalfOf: "user-anna",
        mode: "workflow",
        sideEffect: true,
        outcome: "ok",
        provenanceCount: 1,
      },
    });
    // Nothing of the input or the output.
    const recorded = JSON.stringify(audited);
    expect(recorded).not.toContain("secret project");
    expect(recorded).not.toContain("Quarterly numbers");
  });

  it("records the App version that made a call, when its capability names one", async () => {
    const connectionId = await addConnection();
    const call = write(connectionId, "mail.list");
    await callAs({ ...appFor("user-anna"), appVersion: 3 }, call);
    // As an earlier core signs it: without one.
    await callAs(appFor("user-anna"), call);
    const audited = await audit.events();
    expect(
      audited.map(({ action, actor, detail }) => ({ action, actor, detail }))
    ).toMatchObject([
      {
        action: "connection.call",
        actor: { type: "app", appId: "app-crm" },
        detail: { action: "mail.list", appVersion: 3 },
      },
      {
        action: "connection.call",
        actor: { type: "app", appId: "app-crm" },
        detail: { action: "mail.list" },
      },
    ]);
    expect(audited[1]?.detail).not.toHaveProperty("appVersion");
  });

  it("records every resource a large read touched", async () => {
    const connectionId = await addConnection();
    await callAs(
      appFor("user-anna"),
      write(connectionId, "mail.list", { many: true })
    );
    const audited = await audit.events();
    const [first, ...rest] = audited;
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
    // In the order they were stored, which is the order core takes them in.
    expect(audited.flatMap((event) => event.provenance)).toStrictEqual(
      manyMessages
    );
    const taken = await exports.default.takeAuditEvents();
    expect(taken.map(({ id }) => id)).toStrictEqual(
      audited.map(({ id }) => id)
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
    const audited = await audit.events();
    const [first, repeat] = audited.map((event) => event.detail);
    expect([first, repeat]).toMatchObject([
      { sideEffect: true, outcome: "ok" },
      { sideEffect: true, outcome: "replayed" },
    ]);
    // App code chooses keys: the log gets a hash, never the key.
    expect(first?.idempotencyKeyHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(repeat?.idempotencyKeyHash).toBe(first?.idempotencyKeyHash);
    expect(JSON.stringify(audited)).not.toContain("run-1:send");
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
      "connect.invalid",
    ]);
    const audited = await audit.events();
    expect(
      audited.map(({ actor, target, detail }) => ({
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
        reason: "connect.invalid",
      },
    ]);
    expect(server.ran).toStrictEqual([]);
  });

  it("records what a failed call touched, and its repeat as replayed", async () => {
    const connectionId = await addConnection();
    const call = write(connectionId, "mail.open");
    await expect(outcome(callAs(anna, call))).resolves.toBe(
      "connect.action_failed"
    );
    await expect(outcome(callAs(anna, call))).resolves.toBe(
      "connect.action_failed"
    );
    const audited = await audit.events();
    expect(audited).toMatchObject([
      {
        provenance: ["message-9"],
        detail: { outcome: "failed", reason: "connect.action_failed" },
      },
      {
        provenance: ["message-9"],
        detail: { outcome: "replayed", reason: "connect.action_failed" },
      },
    ]);
  });

  it("records a call whose answer couldn't be stored as unknown, and spends its key", async () => {
    const connectionId = await addConnection();
    const call = write(connectionId, "mail.send");
    // The database refuses the batch that stores the answer with its event.
    const batch = env.DB.batch.bind(env.DB);
    let batches = 0;
    vi.spyOn(env.DB, "batch").mockImplementation(async (statements) => {
      batches += 1;
      if (batches === 2) {
        throw new Error("D1 is unavailable");
      }
      return await batch(statements);
    });
    await expect(outcome(callAs(anna, call))).resolves.toBe(
      "connect.outcome_unknown"
    );
    await expect(outcome(callAs(anna, call))).resolves.toBe(
      "connect.outcome_unknown"
    );
    expect(server.ran).toHaveLength(1);
    const audited = await audit.events();
    expect(audited.map((event) => event.detail)).toMatchObject([
      { outcome: "unknown", reason: "connect.outcome_unknown" },
      { outcome: "unknown", reason: "connect.outcome_unknown" },
    ]);
  });

  it("keeps its events until core acknowledges them, and removes only those", async () => {
    const connectionId = await addConnection();
    await callAs(anna, write(connectionId, "mail.list"));
    await callAs(anna, write(connectionId, "mail.list"));
    const taken = await exports.default.takeAuditEvents();
    const ids = taken.map(({ id }) => id);
    expect(ids).toHaveLength(2);

    // Taking removes nothing.
    await expect(exports.default.takeAuditEvents()).resolves.toStrictEqual(
      taken
    );
    await exports.default.ackAuditEvents(ids.slice(0, 1));
    // Acknowledging again, or an ID it never had, changes nothing.
    await exports.default.ackAuditEvents([
      ...ids.slice(0, 1),
      crypto.randomUUID(),
    ]);
    const left = await exports.default.takeAuditEvents();
    expect(left.map(({ id }) => id)).toStrictEqual(ids.slice(1));
  });

  it("moves events core rejects out of the outbox, with why, as it acknowledges the rest", async () => {
    const connectionId = await addConnection();
    await callAs(anna, write(connectionId, "mail.list"));
    await callAs(anna, write(connectionId, "mail.list"));
    await callAs(anna, write(connectionId, "mail.list"));
    const [appended, refused, conflicting] =
      await exports.default.takeAuditEvents();

    await exports.default.ackAuditEvents(
      [appended?.id ?? crypto.randomUUID()],
      [
        { id: refused?.id ?? crypto.randomUUID(), reason: "refused" },
        { id: conflicting?.id ?? crypto.randomUUID(), reason: "conflict" },
      ]
    );

    const { results } = await env.DB.prepare(
      "SELECT id, event, reason FROM audit_outbox_rejected ORDER BY reason DESC"
    ).all();
    expect({
      left: await exports.default.takeAuditEvents(),
      rejected: results,
    }).toStrictEqual({
      left: [],
      rejected: [
        { id: refused?.id, event: refused?.event, reason: "refused" },
        { id: conflicting?.id, event: conflicting?.event, reason: "conflict" },
      ],
    });
  });

  it("refuses an acknowledgement that isn't a list of event IDs", async () => {
    await expect(
      outcome(exports.default.ackAuditEvents("everything"))
    ).resolves.toBe("connect.invalid");
    await expect(
      outcome(exports.default.ackAuditEvents(["not-an-event"]))
    ).resolves.toBe("connect.invalid");
    await expect(
      outcome(
        exports.default.ackAuditEvents(
          Array.from({ length: 101 }, () => crypto.randomUUID())
        )
      )
    ).resolves.toBe("connect.invalid");
    await expect(
      outcome(
        exports.default.ackAuditEvents(
          [],
          [{ id: crypto.randomUUID(), reason: "unwanted" }]
        )
      )
    ).resolves.toBe("connect.invalid");
    await expect(
      outcome(
        exports.default.ackAuditEvents(
          Array.from({ length: 60 }, () => crypto.randomUUID()),
          Array.from({ length: 41 }, () => ({
            id: crypto.randomUUID(),
            reason: "refused",
          }))
        )
      )
    ).resolves.toBe("connect.invalid");
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
    const audited = await audit.events();
    expect(audited.map((event) => event.detail)).toMatchObject([
      { outcome: "unknown", reason: "connect.outcome_unknown" },
    ]);
  });
});
