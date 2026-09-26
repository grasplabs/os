import { auditLogger } from "@grasp-os/shared/audit";
import type { AuditEvent } from "@grasp-os/shared/audit";
import { auditEventTypeOf } from "@grasp-os/shared/audit-log";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { auditLog } from "../src/audit-log.ts";
import { audit } from "../src/audit.ts";
import worker from "../src/index.ts";
import {
  allEvents,
  eventsAfter,
  logHead,
  oversizedFields,
} from "./audit-events.ts";

// These tests share the deployment's single log, so they look only at the
// events they sent.

const queueName = "grasp-os-audit";
const deadLetterQueueName = "grasp-os-audit-dlq";

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
 * Delivers one batch from `queue` to core's queue consumer, as the queue
 * does on the given attempt, and returns what the consumer did with each
 * message.
 */
const deliverFrom = async (
  queue: string,
  workerEnv: Env,
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
    queue,
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
  await worker.queue(batch, workerEnv);
  return outcomes;
};

/** Delivers one batch from the audit queue. */
const deliverTo = async (
  workerEnv: Env,
  attempts: number,
  ...bodies: unknown[]
): Promise<Outcome[]> =>
  await deliverFrom(queueName, workerEnv, attempts, ...bodies);

const deliverAttempt = async (
  attempts: number,
  ...bodies: unknown[]
): Promise<Outcome[]> => await deliverTo(env, attempts, ...bodies);

const deliver = async (...bodies: unknown[]): Promise<Outcome[]> =>
  await deliverAttempt(1, ...bodies);

/**
 * Delivers one batch from the dead letter queue: events the audit queue
 * gave up on after its retries, or moved there as too large.
 */
const deliverDeadLetters = async (...bodies: unknown[]): Promise<Outcome[]> =>
  await deliverFrom(deadLetterQueueName, env, 1, ...bodies);

/** One structured log line, as `log` writes it. */
const logFieldsSchema = z.record(z.string(), z.unknown());

/**
 * What the consumer logged at error level while `run` ran, as event names
 * and their fields: the alert.
 */
const errorsDuring = async (
  run: () => Promise<unknown>
): Promise<Record<string, unknown>[]> => {
  const logged = vi.spyOn(console, "error").mockReturnValue();
  try {
    await run();
    return logged.mock.calls.flatMap(([fields]: unknown[]) => {
      const parsed = logFieldsSchema.safeParse(fields);
      return parsed.success ? [parsed.data] : [];
    });
  } finally {
    logged.mockRestore();
  }
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

  it("moves an event over the log's size cap to the dead letter queue at once, and appends the rest", async () => {
    const [before, after] = [newEvent(), newEvent()];
    // Valid to the schema, but over the log's size cap.
    const oversized = { ...newEvent(), ...oversizedFields };
    // The real dead letter queue, noting what it's sent.
    const deadLetters: unknown[] = [];
    const deadLetterQueue: Queue = {
      metrics: async () => await env.AUDIT_DLQ.metrics(),
      send: async (body, options) => {
        deadLetters.push(body);
        return await env.AUDIT_DLQ.send(body, options);
      },
      sendBatch: async (messages, options) =>
        await env.AUDIT_DLQ.sendBatch(messages, options),
    };

    await expect(
      deliverTo(
        { ...env, AUDIT_DLQ: deadLetterQueue },
        1,
        before,
        oversized,
        after
      )
    ).resolves.toStrictEqual(["acked", "acked", "acked"]);
    expect(deadLetters).toStrictEqual([oversized]);
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

// Threat model AU4: no audit event is lost silently. Events the audit queue
// gave up on land in its dead letter queue. Every dead letter raises an
// alert; those the log can take are appended late, and those it can never
// take are counted as lost, either way with an `audit.gap` in the chain.

/** The alerts raised: dead letters logged at error level, by event ID. */
const alertedIds = (errors: readonly Record<string, unknown>[]) =>
  errors
    .filter(({ event }) => event === "audit.dead_lettered")
    .map(({ eventId }) => eventId);

/**
 * What the log appended after position `after` about the event with `id`:
 * the event itself, and any gap that names it. Other tests' events, and
 * the gaps of real dead letters they caused, are left out.
 */
const recordedFor = async (
  after: number,
  id: string
): Promise<AuditEvent[]> => {
  const events = await eventsAfter(after);
  return events.filter(
    (event) => event.id === id || event.provenance.includes(id)
  );
};

describe("audit dead letter queue consumer", () => {
  it("appends a dead-lettered event late, records the gap after it, and raises an alert", async () => {
    const after = await logHead();
    const event = newEvent();

    const errors = await errorsDuring(async () => {
      await expect(deliverDeadLetters(event)).resolves.toStrictEqual(["acked"]);
    });
    expect(alertedIds(errors)).toStrictEqual([event.id]);
    // By the platform, naming the event it appended late.
    await expect(recordedFor(after, event.id)).resolves.toMatchObject([
      event,
      {
        source: "core",
        actor: { type: "system" },
        action: "audit.gap",
        provenance: [event.id],
        detail: { recovered: 1, lost: 0 },
      },
    ]);
    await expect(auditLog(env).verify()).resolves.toMatchObject({ ok: true });
  });

  it("records no gap for a dead letter the log already has, and appends it once", async () => {
    const event = newEvent();
    await deliver(event);
    const after = await logHead();

    const errors = await errorsDuring(async () => {
      await expect(deliverDeadLetters(event)).resolves.toStrictEqual(["acked"]);
    });
    // Still an alert: the queue gave up on it, even if the log had it.
    expect(alertedIds(errors)).toStrictEqual([event.id]);
    await expect(recordedFor(after, event.id)).resolves.toStrictEqual([]);
  });

  it("counts dead letters the log can never take as lost, in a gap", async () => {
    const after = await logHead();
    const oversized = { ...newEvent(), ...oversizedFields };
    const forged = { ...newEvent(), actor: { type: "admin", userId: "u-1" } };

    const errors = await errorsDuring(async () => {
      await expect(
        deliverDeadLetters("not an event", oversized, forged)
      ).resolves.toStrictEqual(["acked", "acked", "acked"]);
    });
    // Every one alerts; only the one that is an event is named.
    expect(alertedIds(errors)).toStrictEqual([
      undefined,
      oversized.id,
      undefined,
    ]);
    // None of their content reaches the chain: only how many were lost.
    const events = await eventsAfter(after);
    expect(events).toContainEqual(
      expect.objectContaining({
        actor: { type: "system" },
        action: "audit.gap",
        provenance: [],
        detail: { recovered: 0, lost: 3 },
      })
    );
    expect(
      events.filter(({ id }) => id === oversized.id || id === forged.id)
    ).toStrictEqual([]);
  });

  it("records a mixed batch in one gap: appended late, already held and lost", async () => {
    const held = newEvent();
    await deliver(held);
    const after = await logHead();
    const late = newEvent();

    await expect(
      deliverDeadLetters(held, late, "not an event")
    ).resolves.toStrictEqual(["acked", "acked", "acked"]);
    const [, gap] = await recordedFor(after, late.id);
    expect(gap).toMatchObject({
      action: "audit.gap",
      provenance: [late.id],
      detail: { recovered: 1, lost: 1 },
    });
    await expect(recordedFor(after, held.id)).resolves.toStrictEqual([]);
    // Found as what the platform did, not as a read of the log.
    expect(gap && auditEventTypeOf(gap)).toBe("action");
  });

  it("keeps dead letters while the log can't take them, and records them once it can", async () => {
    const after = await logHead();
    const event = newEvent();
    // The log can't be reached: outside tests, an object in the EU.
    const unreachable = { ...env, DURABLE_OBJECT_JURISDICTION: undefined };

    const errors = await errorsDuring(async () => {
      await expect(
        deliverFrom(deadLetterQueueName, unreachable, 1, event, "not an event")
      ).resolves.toStrictEqual([{ retryAfter: 10 }, { retryAfter: 10 }]);
    });
    expect(errors.map(({ event: name }) => name)).toContain(
      "audit.recovery_failed"
    );
    await expect(recordedFor(after, event.id)).resolves.toStrictEqual([]);

    // Redelivered once the log is back: nothing was lost meanwhile.
    await deliverDeadLetters(event, "not an event");
    await expect(recordedFor(after, event.id)).resolves.toMatchObject([
      event,
      { action: "audit.gap", detail: { recovered: 1, lost: 1 } },
    ]);
  });
});
