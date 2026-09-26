import { auditOutboxTakeMax } from "@grasp-os/shared/audit";
import type { AuditEvent } from "@grasp-os/shared/audit";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { auditLog } from "../src/audit-log.ts";
import worker from "../src/index.ts";
import { loggedEvents } from "./audit-events.ts";
import { runCron } from "./cron.ts";
import { outcome } from "./sign-in.ts";
import { connectDb } from "./test-env.ts";

// Every audit event waits in an outbox, written with its change, until a
// drain appends it to the log: core's and Knowledge's own in the background
// right after each change and on every cron run, connect's on every cron
// run, over RPC. These tests break the drain in the ways it can break and
// check that each event still reaches the chain exactly once, in the order
// it was stored. They share the deployment's single log, so they look only
// at their own events, and read it without draining it first.

const newEvent = (action = "permission.granted"): AuditEvent => ({
  id: crypto.randomUUID(),
  at: new Date().toISOString(),
  source: "core",
  actor: { type: "system" },
  action,
  provenance: [],
  detail: {},
});

/** Stores events in core's outbox, as a change does, oldest first. */
const store = async (...events: AuditEvent[]): Promise<AuditEvent[]> => {
  const now = Date.now();
  await env.DB.batch(
    events.map((event, index) =>
      env.DB.prepare(
        "INSERT INTO audit_outbox (id, event, created_at) VALUES (?, ?, ?)"
      ).bind(event.id, JSON.stringify(event), now + index)
    )
  );
  return events;
};

/** The IDs of every event waiting in an outbox, oldest first. */
const allWaitingIn = async (database: D1Database): Promise<string[]> => {
  const { results } = await database
    .prepare("SELECT id FROM audit_outbox ORDER BY rowid")
    .all<{ id: string }>();
  return results.map(({ id }) => id);
};

/** The IDs of `ids` still waiting in an outbox. */
const waitingIn = async (
  database: D1Database,
  ids: readonly string[]
): Promise<string[]> => {
  const waiting = await allWaitingIn(database);
  return waiting.filter((id) => ids.includes(id));
};

/** The stored events with these IDs, in log order, each as often as stored. */
const storedWith = async (ids: readonly string[]): Promise<AuditEvent[]> => {
  const events = await loggedEvents();
  return events.filter((event) => ids.includes(event.id));
};

/**
 * Has connect record `count` events of its own: calls it refuses, as it
 * records every call. Returns their IDs in the order connect stored them.
 */
const connectRecords = async (count: number): Promise<string[]> => {
  const before = await allWaitingIn(connectDb());
  for (let call = 0; call < count; call += 1) {
    // One after another, so each is stored after the one before.
    // oxlint-disable-next-line no-await-in-loop
    await expect(outcome(env.CONNECT.call({}))).resolves.toBe(
      "connect.invalid"
    );
  }
  const after = await allWaitingIn(connectDb());
  return after.filter((id) => !before.includes(id));
};

/** A binding that is down: any use of it throws. */
const down = <T extends object>(binding: T): T =>
  new Proxy(binding, {
    get: () => {
      throw new Error("Unavailable");
    },
  });

const errorLogSchema = z.looseObject({ event: z.string() });

/** Runs `run` with error logs silenced, and returns what they logged. */
const errorLogsDuring = async (
  run: () => Promise<unknown>
): Promise<z.infer<typeof errorLogSchema>[]> => {
  const logged = vi.spyOn(console, "error").mockReturnValue();
  try {
    await run();
    return logged.mock.calls.flatMap(([fields]: unknown[]) => {
      const parsed = errorLogSchema.safeParse(fields);
      return parsed.success ? [parsed.data] : [];
    });
  } finally {
    logged.mockRestore();
  }
};

/** Runs `run` with error logs silenced, and returns their event names. */
const errorsDuring = async (run: () => Promise<unknown>): Promise<string[]> => {
  const logs = await errorLogsDuring(run);
  return logs.map(({ event }) => event);
};

/** The `audit.gap` events in the log that name any of these row IDs. */
const gapsNaming = async (ids: readonly string[]): Promise<AuditEvent[]> => {
  const events = await loggedEvents();
  return events.filter(
    ({ action, provenance }) =>
      action === "audit.gap" && provenance.some((id) => ids.includes(id))
  );
};

/** Stores rows in core's outbox that aren't events at all. */
const storeUnreadable = async (
  ids: readonly string[],
  text = "not an event"
): Promise<void> => {
  const now = Date.now();
  await env.DB.batch(
    ids.map((id) =>
      env.DB.prepare(
        "INSERT INTO audit_outbox (id, event, created_at) VALUES (?, ?, ?)"
      ).bind(id, text, now)
    )
  );
};

/** The rows with these IDs moved to core's `audit_outbox_rejected`. */
const rejectedWith = async (
  ids: readonly string[]
): Promise<{ id: string; event: string; reason: string }[]> => {
  const { results } = await env.DB.prepare(
    "SELECT id, event, reason FROM audit_outbox_rejected ORDER BY rowid"
  ).all<{ id: string; event: string; reason: string }>();
  return results.filter(({ id }) => ids.includes(id));
};

describe("draining core's outbox", () => {
  it("appends events in the order they were stored, then removes them", async () => {
    const events = await store(newEvent(), newEvent(), newEvent());
    const ids = events.map(({ id }) => id);

    await runCron();

    await expect(storedWith(ids)).resolves.toStrictEqual(events);
    await expect(waitingIn(env.DB, ids)).resolves.toStrictEqual([]);
    await expect(auditLog(env).verify()).resolves.toMatchObject({ ok: true });
  });

  it("appends more than one batch in a cron run", async () => {
    const events = await store(
      ...Array.from({ length: 150 }, () => newEvent())
    );
    const ids = events.map(({ id }) => id);

    await runCron();

    await expect(storedWith(ids)).resolves.toStrictEqual(events);
  });

  it("takes an event stored after a batch emptied the outbox in the same run, after that batch", async () => {
    const batch = await store(
      ...Array.from({ length: auditOutboxTakeMax }, () => newEvent())
    );
    // Stored the moment the drain has removed the whole batch.
    const late = newEvent();
    await env.DB.batch([
      env.DB.prepare("CREATE TABLE late_once (done INTEGER)"),
      env.DB.prepare(
        `CREATE TRIGGER late_insert AFTER DELETE ON audit_outbox WHEN NOT EXISTS (SELECT 1 FROM audit_outbox) AND NOT EXISTS (SELECT 1 FROM late_once) BEGIN INSERT INTO audit_outbox (id, event, created_at) VALUES ('${late.id}', '${JSON.stringify(late)}', 0); INSERT INTO late_once VALUES (1); END`
      ),
    ]);
    try {
      await runCron();
    } finally {
      await env.DB.batch([
        env.DB.prepare("DROP TRIGGER late_insert"),
        env.DB.prepare("DROP TABLE late_once"),
      ]);
    }
    const ids = [...batch, late].map(({ id }) => id);

    await expect(storedWith(ids)).resolves.toStrictEqual([...batch, late]);
    await expect(waitingIn(env.DB, ids)).resolves.toStrictEqual([]);
  });

  it("appends an event once when the drain stops before removing it, and removes it on the next run", async () => {
    const [event] = await store(newEvent());
    const ids = [event?.id ?? ""];
    await env.DB.prepare(
      "CREATE TRIGGER audit_outbox_stuck BEFORE DELETE ON audit_outbox BEGIN SELECT RAISE(ABORT, 'outbox down'); END"
    ).run();
    try {
      await expect(errorsDuring(runCron)).resolves.toContain(
        "audit.outbox.drain_failed"
      );
    } finally {
      await env.DB.prepare("DROP TRIGGER audit_outbox_stuck").run();
    }
    // Appended, but still waiting.
    await expect(storedWith(ids)).resolves.toStrictEqual([event]);
    await expect(waitingIn(env.DB, ids)).resolves.toStrictEqual(ids);

    await runCron();

    await expect(storedWith(ids)).resolves.toStrictEqual([event]);
    await expect(waitingIn(env.DB, ids)).resolves.toStrictEqual([]);
  });

  it("keeps events while the log is down, and appends them once it's back", async () => {
    const events = await store(newEvent(), newEvent());
    const ids = events.map(({ id }) => id);

    await expect(
      errorsDuring(async () => {
        await runCron({ AUDIT_LOG: down(env.AUDIT_LOG) });
      })
    ).resolves.toContain("audit.outbox.drain_failed");
    await expect(waitingIn(env.DB, ids)).resolves.toStrictEqual(ids);

    await runCron();

    await expect(storedWith(ids)).resolves.toStrictEqual(events);
    await expect(waitingIn(env.DB, ids)).resolves.toStrictEqual([]);
  });

  it("removes an event the log already has without appending it again", async () => {
    const event = newEvent();
    await auditLog(env).append([event]);
    await store(event);

    await runCron();

    await expect(storedWith([event.id])).resolves.toStrictEqual([event]);
    await expect(waitingIn(env.DB, [event.id])).resolves.toStrictEqual([]);
  });

  it("moves stored events the log can't take out of the outbox, however many, and appends the ones after them in the same run", async () => {
    // More than two batches of them, ahead of everything else.
    const unreadable = Array.from({ length: 250 }, () => crypto.randomUUID());
    await storeUnreadable(unreadable);
    const after = await store(newEvent(), newEvent());
    const ids = after.map(({ id }) => id);

    const logs = await errorLogsDuring(runCron);

    const rejected = await rejectedWith(unreadable);
    const gaps = await gapsNaming(unreadable);
    expect({
      appended: await storedWith(ids),
      left: await waitingIn(env.DB, [...unreadable, ...ids]),
      rejected: rejected.length,
      kept: rejected.every(
        ({ event, reason }) => event === "not an event" && reason === "refused"
      ),
      // One gap per batch, naming each row once, in order.
      gaps: gaps.map(({ detail }) => detail),
      named: gaps.flatMap(({ provenance }) => provenance),
      logged: logs
        .filter(({ event }) => event === "audit.outbox.rejected")
        .reduce(
          (total, { count }) => total + (typeof count === "number" ? count : 0),
          0
        ),
    }).toStrictEqual({
      appended: after,
      left: [],
      rejected: unreadable.length,
      kept: true,
      gaps: [100, 100, 50].map((count) => ({
        outbox: "core",
        reason: "refused",
        count,
      })),
      named: unreadable,
      logged: unreadable.length,
    });
  });

  it("records a rejected row's gap once, when the drain stops before moving it and runs again", async () => {
    const unreadable = crypto.randomUUID();
    await storeUnreadable([unreadable]);
    await env.DB.prepare(
      "CREATE TRIGGER audit_outbox_stuck BEFORE DELETE ON audit_outbox BEGIN SELECT RAISE(ABORT, 'outbox down'); END"
    ).run();
    try {
      await errorLogsDuring(runCron);
    } finally {
      await env.DB.prepare("DROP TRIGGER audit_outbox_stuck").run();
    }
    const first = {
      gaps: await gapsNaming([unreadable]),
      left: await waitingIn(env.DB, [unreadable]),
    };

    await errorLogsDuring(runCron);

    expect({
      first: { gaps: first.gaps.length, left: first.left },
      gaps: await gapsNaming([unreadable]),
      rejected: await rejectedWith([unreadable]),
    }).toStrictEqual({
      // Recorded, but the move didn't happen.
      first: { gaps: 1, left: [unreadable] },
      gaps: first.gaps,
      rejected: [{ id: unreadable, event: "not an event", reason: "refused" }],
    });
  });

  it("keeps two rejected rows with the same ID, each with its own gap", async () => {
    const id = crypto.randomUUID();
    await storeUnreadable([id], "not an event");
    await errorLogsDuring(runCron);
    await storeUnreadable([id], "still not an event");
    await errorLogsDuring(runCron);

    const rejected = await rejectedWith([id]);
    const gaps = await gapsNaming([id]);
    expect({
      rejected: rejected.map(({ event }) => event),
      gaps: gaps.length,
      distinct: new Set(gaps.map((gap) => gap.id)).size,
    }).toStrictEqual({
      rejected: ["not an event", "still not an event"],
      gaps: 2,
      distinct: 2,
    });
  });

  it("moves an event whose ID the log holds with other content out of the outbox, as a conflict, and appends the next", async () => {
    const original = newEvent("permission.granted");
    await auditLog(env).append([original]);
    const forged = { ...original, action: "permission.revoked" };
    const [, next] = await store(forged, newEvent());

    const logs = await errorLogsDuring(runCron);

    const gaps = await gapsNaming([original.id]);
    expect({
      logged: await storedWith([original.id, next?.id ?? ""]),
      left: await waitingIn(env.DB, [original.id, next?.id ?? ""]),
      rejected: await rejectedWith([original.id]),
      gap: gaps.map(({ provenance, detail }) => ({ provenance, detail })),
      alert: logs.filter(({ event }) => event === "audit.outbox.rejected"),
    }).toStrictEqual({
      logged: [original, next],
      left: [],
      rejected: [
        { id: original.id, event: JSON.stringify(forged), reason: "conflict" },
      ],
      gap: [
        {
          provenance: [original.id],
          detail: { outbox: "core", reason: "conflict", count: 1 },
        },
      ],
      alert: [
        expect.objectContaining({
          outbox: "core",
          reason: "conflict",
          count: 1,
          ids: original.id,
        }),
      ],
    });
  });
});

describe("draining connect's outbox", () => {
  it("appends connect's events in the order connect stored them, then removes them", async () => {
    const ids = await connectRecords(3);

    await runCron();

    const appended = await storedWith(ids);
    expect(appended.map(({ id, source }) => [id, source])).toStrictEqual(
      ids.map((id) => [id, "connect"])
    );
    await expect(waitingIn(connectDb(), ids)).resolves.toStrictEqual([]);
  });

  it("moves a row of connect's the log can't take aside in connect, and records it with a gap", async () => {
    const unreadable = crypto.randomUUID();
    await connectDb()
      .prepare(
        "INSERT INTO audit_outbox (id, event, created_at) VALUES (?, ?, ?)"
      )
      .bind(unreadable, "not an event", Date.now())
      .run();

    await errorLogsDuring(runCron);

    const gaps = await gapsNaming([unreadable]);
    const moved = await connectDb()
      .prepare("SELECT reason FROM audit_outbox_rejected WHERE id = ?")
      .bind(unreadable)
      .all<{ reason: string }>();
    expect({
      left: await waitingIn(connectDb(), [unreadable]),
      moved: moved.results,
      gaps: gaps.map(({ provenance, detail }) => ({ provenance, detail })),
    }).toStrictEqual({
      left: [],
      moved: [{ reason: "refused" }],
      gaps: [
        {
          provenance: [unreadable],
          detail: { outbox: "connect", reason: "refused", count: 1 },
        },
      ],
    });
  });

  it("keeps connect's events while connect is unreachable, still drains core's, and appends connect's once it's back", async () => {
    const ids = await connectRecords(2);
    const [fromCore] = await store(newEvent());

    const errors = await errorsDuring(async () => {
      await runCron({ CONNECT: down(env.CONNECT) });
    });
    expect({
      alert: errors.includes("audit.outbox.drain_failed"),
      core: await storedWith([fromCore?.id ?? ""]),
      connect: await storedWith(ids),
      waiting: await waitingIn(connectDb(), ids),
    }).toStrictEqual({
      alert: true,
      core: [fromCore],
      connect: [],
      waiting: ids,
    });

    await runCron();

    const appended = await storedWith(ids);
    expect({
      appended: appended.map(({ id }) => id),
      waiting: await waitingIn(connectDb(), ids),
    }).toStrictEqual({ appended: ids, waiting: [] });
  });

  it("appends connect's events once when acknowledging them fails, and acknowledges them on the next run", async () => {
    const ids = await connectRecords(2);
    const unacknowledged = new Proxy(env.CONNECT, {
      get: (target, key) => {
        if (key === "ackAuditEvents") {
          throw new Error("Unavailable");
        }
        const value: unknown = Reflect.get(target, key);
        return value;
      },
    });

    await expect(
      errorsDuring(async () => {
        await runCron({ CONNECT: unacknowledged });
      })
    ).resolves.toContain("audit.outbox.drain_failed");
    // Appended, but still waiting: taken again on the next run.
    await expect(waitingIn(connectDb(), ids)).resolves.toStrictEqual(ids);

    await runCron();

    const appended = await storedWith(ids);
    expect(appended.map(({ id }) => id)).toStrictEqual(ids);
    await expect(waitingIn(connectDb(), ids)).resolves.toStrictEqual([]);
  });
});

/** What the consumer did with a message: acked, retried, or neither. */
type Outcome = "acked" | "retried" | "pending";

/**
 * Delivers `bodies` from `queue`, a queue an older release left, to core's
 * queue consumer, and returns what it did with each.
 */
const deliverLeftover = async (
  queue: "grasp-os-audit" | "grasp-os-audit-dlq",
  workerEnv: Env,
  ...bodies: unknown[]
): Promise<Outcome[]> => {
  const outcomes: Outcome[] = bodies.map(() => "pending");
  const batch: MessageBatch = {
    queue,
    messages: bodies.map((body, index): Message => ({
      id: crypto.randomUUID(),
      timestamp: new Date(),
      attempts: 1,
      body,
      ack: () => {
        outcomes[index] = "acked";
      },
      retry: () => {
        outcomes[index] = "retried";
      },
    })),
    metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    ackAll: () => {
      outcomes.fill("acked");
    },
    retryAll: () => {
      outcomes.fill("retried");
    },
  };
  await worker.queue(batch, workerEnv);
  return outcomes;
};

describe("events left on the audit queue by an older release", () => {
  it("are appended once each, and one that isn't an event is retried until it reaches the dead letter queue", async () => {
    const already = newEvent();
    await auditLog(env).append([already]);
    const fresh = newEvent();

    const outcomes = await deliverLeftover(
      "grasp-os-audit",
      env,
      fresh,
      already,
      "not an event"
    );

    expect(outcomes).toStrictEqual(["acked", "acked", "retried"]);
    await expect(storedWith([already.id, fresh.id])).resolves.toStrictEqual([
      already,
      fresh,
    ]);
  });

  it("are left on the queue, to be delivered again, while the log is down", async () => {
    const event = newEvent();

    await expect(
      deliverLeftover(
        "grasp-os-audit",
        { ...env, AUDIT_LOG: down(env.AUDIT_LOG) },
        event
      )
    ).rejects.toThrow("Unavailable");
    await expect(storedWith([event.id])).resolves.toStrictEqual([]);
  });
});

describe("events left on the dead letter queue by an older release", () => {
  it("are appended late, with the audit.gap that records them and the ones lost, as before", async () => {
    const late = newEvent();
    const { length: before } = await loggedEvents();

    const logs = await errorLogsDuring(async () => {
      await expect(
        deliverLeftover("grasp-os-audit-dlq", env, late, "not an event")
      ).resolves.toStrictEqual(["acked", "acked"]);
    });

    const all = await loggedEvents();
    const added = all.slice(before);
    expect({
      added: added.map(({ id, action, source, provenance, detail }) => ({
        id: action === "audit.gap" ? "gap" : id,
        action,
        source,
        provenance,
        detail,
      })),
      alerts: logs.filter(({ event }) => event === "audit.dead_lettered")
        .length,
    }).toStrictEqual({
      added: [
        {
          id: late.id,
          action: late.action,
          source: "core",
          provenance: [],
          detail: {},
        },
        {
          id: "gap",
          action: "audit.gap",
          source: "core",
          provenance: [late.id],
          detail: { recovered: 1, lost: 1, conflicts: 0 },
        },
      ],
      alerts: 2,
    });
  });

  it("are retried while the log is down, and nothing is recorded", async () => {
    const late = newEvent();

    const logs = await errorLogsDuring(async () => {
      await expect(
        deliverLeftover(
          "grasp-os-audit-dlq",
          { ...env, AUDIT_LOG: down(env.AUDIT_LOG) },
          late
        )
      ).resolves.toStrictEqual(["retried"]);
    });

    expect(logs.map(({ event }) => event)).toContain("audit.recovery_failed");
    await expect(storedWith([late.id])).resolves.toStrictEqual([]);
  });
});
