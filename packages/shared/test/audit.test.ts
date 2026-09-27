import { describe, expect, it } from "vite-plus/test";
import { ZodError } from "zod";

import {
  auditDetailMaxKeys,
  auditEventMaxBytes,
  auditEventSchema,
  auditIdentifierMaxLength,
  auditProvenanceMaxItems,
  createAuditEvent,
} from "../src/audit.ts";

describe("creating an audit event", () => {
  it("stamps a valid event with a new ID, the time and its own Worker", () => {
    const first = createAuditEvent(
      { actor: { type: "system" }, action: "test.a" },
      "connect"
    );
    const second = createAuditEvent(
      { actor: { type: "system" }, action: "test.b" },
      "connect"
    );

    expect(auditEventSchema.parse(first)).toStrictEqual(first);
    expect(first.source).toBe("connect");
    expect(first.id).not.toBe(second.id);
  });

  it("ignores an ID, time or source the caller tries to set", () => {
    const forged = {
      actor: { type: "system" },
      action: "test.a",
      id: "00000000-0000-4000-8000-000000000000",
      at: "2000-01-01T00:00:00Z",
      source: "core",
    } as const;

    const event = createAuditEvent(forged, "connect");

    expect(event.id).not.toBe(forged.id);
    expect(event.at).not.toBe(forged.at);
    expect(event.source).toBe("connect");
  });

  it("refuses a malformed event", () => {
    expect(() =>
      createAuditEvent(
        {
          actor: { type: "system" },
          action: "model.call",
          cost: { amount: -1, currency: "usd" },
        },
        "core"
      )
    ).toThrow(ZodError);
  });

  it("takes an event naming a large retrieval: a full provenance of identifier-sized IDs", () => {
    const provenance = Array.from({ length: auditProvenanceMaxItems }, () =>
      "r".repeat(auditIdentifierMaxLength)
    );
    const event = createAuditEvent(
      {
        actor: { type: "person", userId: "user-1" },
        action: "model.call",
        provenance,
      },
      "core"
    );
    expect(event.provenance).toStrictEqual(provenance);
  });

  it("refuses an event over the log's size cap", () => {
    // Every field within its bound, the whole over the cap.
    const full = "r".repeat(auditIdentifierMaxLength);
    expect(() =>
      createAuditEvent(
        {
          actor: { type: "system" },
          action: "model.call",
          provenance: Array.from(
            { length: auditProvenanceMaxItems },
            () => full
          ),
          detail: Object.fromEntries(
            Array.from({ length: auditDetailMaxKeys }, (_, i) => [
              `key${i}`,
              full,
            ])
          ),
        },
        "core"
      )
    ).toThrow(`over ${auditEventMaxBytes} bytes`);
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
