import { describe, expect, it } from "vite-plus/test";
import { ZodError } from "zod";

import {
  auditDetailMaxKeys,
  auditEventSchema,
  auditIdentifierMaxLength,
  auditLogger,
  auditProvenanceMaxItems,
} from "../src/audit.ts";
import type { AuditEvent } from "../src/audit.ts";

/** A queue that keeps what it was sent. */
const memoryQueue = () => {
  const sent: AuditEvent[] = [];
  return {
    sent,
    send: async (event: AuditEvent) => {
      await Promise.resolve();
      sent.push(event);
    },
  };
};

describe("audit logger", () => {
  it("sends a valid event stamped with a new ID, the time and its own Worker", async () => {
    const queue = memoryQueue();
    const { log } = auditLogger(queue, "connect");

    const first = await log({ actor: { type: "system" }, action: "test.a" });
    const second = await log({ actor: { type: "system" }, action: "test.b" });

    expect(queue.sent).toStrictEqual([first, second]);
    expect(auditEventSchema.parse(first)).toStrictEqual(first);
    expect(first.source).toBe("connect");
    expect(first.id).not.toBe(second.id);
  });

  it("ignores an ID, time or source the caller tries to set", async () => {
    const queue = memoryQueue();
    const forged = {
      actor: { type: "system" },
      action: "test.a",
      id: "00000000-0000-4000-8000-000000000000",
      at: "2000-01-01T00:00:00Z",
      source: "core",
    } as const;

    const event = await auditLogger(queue, "connect").log(forged);

    expect(event.id).not.toBe(forged.id);
    expect(event.at).not.toBe(forged.at);
    expect(event.source).toBe("connect");
  });

  it("refuses a malformed event before it reaches the queue", async () => {
    const queue = memoryQueue();
    await expect(
      auditLogger(queue, "core").log({
        actor: { type: "system" },
        action: "model.call",
        cost: { amount: -1, currency: "usd" },
      })
    ).rejects.toThrow(ZodError);
    expect(queue.sent).toStrictEqual([]);
  });
});

describe("audit event bounds", () => {
  const event = {
    id: "0f8fad5b-d9cb-469f-a165-70867728950e",
    at: "2026-09-25T12:00:00Z",
    source: "core",
    actor: { type: "person", userId: "user-1" },
    action: "model.call",
    target: { type: "chat", id: "chat-1" },
    requestId: "request-1",
    provenance: ["doc-1"],
    model: {
      provider: "anthropic",
      model: "m",
      inputTokens: 1,
      outputTokens: 1,
    },
    detail: { status: "ok", attempt: 2, cached: false, "gateway.log_id": null },
  };
  const atLimit = "x".repeat(auditIdentifierMaxLength);
  const overLimit = `${atLimit}x`;
  const valid = (patch: object) =>
    auditEventSchema.safeParse({ ...event, ...patch }).success;

  it("accepts identifiers and detail up to their limits", () => {
    expect(
      valid({
        actor: { type: "agent", agentId: atLimit, onBehalfOf: atLimit },
        target: { type: atLimit, id: atLimit },
        requestId: atLimit,
        provenance: Array.from({ length: auditProvenanceMaxItems }, () => "r"),
        detail: Object.fromEntries(
          Array.from({ length: auditDetailMaxKeys }, (_, i) => [
            `key${i}`,
            atLimit,
          ])
        ),
      })
    ).toBeTruthy();
  });

  it.each([
    ["a person ID", { actor: { type: "person", userId: overLimit } }],
    ["a staff ID", { actor: { type: "staff", userId: overLimit } }],
    [
      "an agent ID",
      { actor: { type: "agent", agentId: overLimit, onBehalfOf: "u" } },
    ],
    [
      "the person an agent acts for",
      { actor: { type: "agent", agentId: "a", onBehalfOf: overLimit } },
    ],
    ["an App ID", { actor: { type: "app", appId: overLimit, part: "server" } }],
    [
      "a workflow run ID",
      {
        actor: {
          type: "workflow",
          appId: "a",
          workflowId: "w",
          runId: overLimit,
        },
      },
    ],
    ["the action", { action: `a.${overLimit}` }],
    ["the target type", { target: { type: overLimit, id: "t" } }],
    ["the target ID", { target: { type: "t", id: overLimit } }],
    ["the request ID", { requestId: overLimit }],
    ["the model provider", { model: { ...event.model, provider: overLimit } }],
    ["the model name", { model: { ...event.model, model: overLimit } }],
    ["a provenance item", { provenance: [overLimit] }],
    ["a detail value", { detail: { prompt: overLimit } }],
  ])("refuses %s over identifier size", (_field, patch) => {
    expect(valid(patch)).toBeFalsy();
  });

  it("refuses more provenance items than one event may name", () => {
    expect(
      valid({
        provenance: Array.from(
          { length: auditProvenanceMaxItems + 1 },
          () => "r"
        ),
      })
    ).toBeFalsy();
  });

  it("refuses more detail members than one event may hold", () => {
    const detail = Object.fromEntries(
      Array.from({ length: auditDetailMaxKeys + 1 }, (_, i) => [`key${i}`, 1])
    );
    expect(valid({ detail })).toBeFalsy();
  });

  it.each([
    ["free text", "Dear team, please see below"],
    ["an uppercase start", "Prompt"],
    ["an empty key", ""],
    ["a key over 64 characters", `k${"x".repeat(64)}`],
  ])("refuses a detail key with %s", (_case, key) => {
    expect(valid({ detail: { [key]: 1 } })).toBeFalsy();
  });

  it("refuses a nested detail value", () => {
    expect(valid({ detail: { response: { text: "Dear team" } } })).toBeFalsy();
  });

  it.each([
    ["one word", "login"],
    ["an uppercase letter", "Model.call"],
    ["a space", "model.call now"],
    ["an empty segment", "model..call"],
    ["free text", "the user read the quarterly report"],
  ])("refuses an action that isn't a dotted verb: %s", (_case, action) => {
    expect(valid({ action })).toBeFalsy();
  });

  it("lowercases the event ID, so case can't make a duplicate look new", () => {
    expect(
      auditEventSchema.parse({ ...event, id: event.id.toUpperCase() }).id
    ).toBe(event.id);
  });
});
