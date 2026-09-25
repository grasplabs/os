import { auditEventSchema, auditLogger } from "@grasp-os/shared/audit";
import type { AuditEvent } from "@grasp-os/shared/audit";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { auditLog } from "../src/audit-log.ts";
import { audit } from "../src/audit.ts";
import worker from "../src/index.ts";

// These tests share the deployment's single log, so they look only at the
// events they sent.

const queueName = "grasp-os-audit";

const newEvent = (): AuditEvent => ({
  id: crypto.randomUUID(),
  at: new Date().toISOString(),
  source: "connect",
  actor: { type: "system" },
  action: "connection.action.run",
  provenance: [],
  detail: {},
});

/** What the consumer did with a message: acked, or retried after a delay. */
type Outcome = "acked" | { retryAfter: number | undefined } | "pending";

/**
 * Delivers one batch to core's queue consumer, as the queue does on the
 * given attempt, and returns what the consumer did with each message.
 */
const deliverAttempt = async (
  attempts: number,
  ...bodies: unknown[]
): Promise<Outcome[]> => {
  const outcomes: Outcome[] = bodies.map(() => "pending");
  const messages = bodies.map((body, index): Message => ({
    id: crypto.randomUUID(),
    timestamp: new Date(),
    attempts,
    body,
    ack: () => {
      outcomes[index] = "acked";
    },
    retry: (options) => {
      outcomes[index] = { retryAfter: options?.delaySeconds };
    },
  }));
  const batch: MessageBatch = {
    queue: queueName,
    messages,
    metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    ackAll: () => {
      outcomes.fill("acked");
    },
    retryAll: (options) => {
      for (const index of outcomes.keys()) {
        outcomes[index] = { retryAfter: options?.delaySeconds };
      }
    },
  };
  await worker.queue(batch, env);
  return outcomes;
};

const deliver = async (...bodies: unknown[]): Promise<Outcome[]> =>
  await deliverAttempt(1, ...bodies);

/** Every event in the log, oldest first. */
const allEvents = async (): Promise<AuditEvent[]> => {
  const log = auditLog(env);
  const events: AuditEvent[] = [];
  let page = await log.entries();
  while (page.length > 0) {
    for (const { event } of page) {
      events.push(auditEventSchema.parse(JSON.parse(event)));
    }
    // Pages are read one after another.
    // oxlint-disable-next-line no-await-in-loop
    page = await log.entries(page.at(-1)?.seq);
  }
  return events;
};

/** The stored events with these IDs, in log order. */
const storedWith = async (ids: readonly string[]): Promise<AuditEvent[]> => {
  const events = await allEvents();
  return events.filter((event) => ids.includes(event.id));
};

describe("audit queue consumer", () => {
  it("appends valid events in delivery order and acknowledges them", async () => {
    const events = [newEvent(), newEvent()];
    await expect(deliver(...events)).resolves.toStrictEqual(["acked", "acked"]);
    await expect(storedWith(events.map(({ id }) => id))).resolves.toStrictEqual(
      events
    );
    await expect(auditLog(env).verify()).resolves.toMatchObject({ ok: true });
  });

  it("acknowledges a redelivered event without appending it again", async () => {
    const event = newEvent();
    await deliver(event);
    await expect(deliver(event)).resolves.toStrictEqual(["acked"]);
    await expect(storedWith([event.id])).resolves.toStrictEqual([event]);
  });

  it("retries malformed events, appends none of them, and still appends the rest", async () => {
    const valid = newEvent();
    const malformed = [
      { ...newEvent(), id: "not-a-uuid" },
      // A forged actor: not one of the kinds the schema allows.
      { ...newEvent(), actor: { type: "admin", userId: "user-1" } },
      // An App actor without the part of the App that acted.
      { ...newEvent(), actor: { type: "app", appId: "app-1" } },
      // A source other than the two Workers that hold the queue binding.
      { ...newEvent(), source: "sandbox" },
    ];
    await expect(
      deliver(valid, ...malformed, "not an event")
    ).resolves.toStrictEqual([
      "acked",
      ...malformed.map(() => ({ retryAfter: 10 })),
      { retryAfter: 10 },
    ]);
    await expect(
      storedWith([valid, ...malformed].map(({ id }) => id))
    ).resolves.toStrictEqual([valid]);
  });

  it("appends the rest of a batch when the log refuses one event, and backs off that one", async () => {
    const [before, after] = [newEvent(), newEvent()];
    // Valid to the queue, but over the log's size cap.
    const oversized = {
      ...newEvent(),
      provenance: Array.from({ length: 100 }, () => "r".repeat(100)),
    };

    await expect(
      deliverAttempt(3, before, oversized, after)
    ).resolves.toStrictEqual(["acked", { retryAfter: 40 }, "acked"]);
    await expect(
      storedWith([before, oversized, after].map(({ id }) => id))
    ).resolves.toStrictEqual([before, after]);
  });

  it("backs off retries up to a ceiling", async () => {
    await expect(deliverAttempt(20, "not an event")).resolves.toStrictEqual([
      { retryAfter: 30 * 60 },
    ]);
  });

  it("chains the events core and connect send through the queue", async () => {
    const fromCore = await audit(env).log({
      actor: { type: "person", userId: "user-1" },
      action: "permission.granted",
      target: { type: "app", id: "app-1" },
    });
    // What connect's `audit(env)` sends, to the same queue.
    const fromConnect = await auditLogger(env.AUDIT_QUEUE, "connect").log({
      actor: { type: "agent", agentId: "agent-1", onBehalfOf: "user-1" },
      action: "model.call",
      provenance: ["doc-1"],
      model: {
        provider: "anthropic",
        model: "claude",
        inputTokens: 10,
        outputTokens: 5,
      },
      cost: { amount: 0.001, currency: "USD" },
    });

    const ids = [fromCore.id, fromConnect.id];
    await vi.waitFor(
      async () => {
        await expect(storedWith(ids)).resolves.toHaveLength(ids.length);
      },
      { timeout: 10_000, interval: 50 }
    );
    // The queue doesn't promise delivery order: the log's order is the order
    // events reach it, and one chain runs across both sources.
    await expect(storedWith(ids)).resolves.toStrictEqual(
      expect.arrayContaining([fromCore, fromConnect])
    );
    await expect(auditLog(env).verify()).resolves.toMatchObject({ ok: true });
  });
});
