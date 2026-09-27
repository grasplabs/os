import { auditEventSchema } from "@grasp-os/shared/audit";
import type { AuditEvent } from "@grasp-os/shared/audit";
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import type { AuditLog } from "../src/audit-log.ts";
import { auditLog, retainAuditLog } from "../src/audit-log.ts";
import { allEvents, exportReader, verifyAll } from "./audit-events.ts";
import { runQuarterHourCron } from "./cron.ts";
import { mockIdp } from "./idp.ts";
import { outcome, signedInApi, signedInWithRole, unique } from "./sign-in.ts";

// Retention: the audit log's own alarm moves events past the deployment's
// retention out of the log into the archive, and the chain still verifies
// from its first event to its last. Config that isn't valid, or the
// feature being off, archives nothing.

const idp = mockIdp();

const dayMs = 24 * 60 * 60 * 1000;

type Log = DurableObjectStub<AuditLog>;

/** A log of its own, not the deployment's, with nothing in it yet. */
const newLog = (): Log => env.AUDIT_LOG.getByName(crypto.randomUUID());

/** An event appended to `log` (the deployment's, unless given) now. */
const logged = async (log: Log = auditLog(env)): Promise<AuditEvent> => {
  const event = auditEventSchema.parse({
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    source: "core",
    actor: { type: "system" },
    action: "test.retained",
    target: { type: "test", id: `retained-${unique()}` },
  });
  await log.append([event]);
  return event;
};

/** Whether `log` still holds the event, where admins search it. */
const held = async (
  { id }: AuditEvent,
  log: Log = auditLog(env)
): Promise<boolean> => {
  const entries = await log.entries();
  return entries.some(({ event }) => event.includes(id));
};

/** When `log` received the event: never before the entry before it. */
const receivedAtOf = async (
  { id }: AuditEvent,
  log: Log = auditLog(env)
): Promise<number> => {
  const entries = await log.entries();
  const entry = entries.find(({ event }) => event.includes(id));
  if (!entry) {
    throw new Error("The log doesn't hold the event");
  }
  return Date.parse(entry.receivedAt);
};

/**
 * Runs `run` `days` after `receivedAt`. The clock moves for the log too,
 * and its times never go back, so each test counts from its own event.
 */
const later = async <T>(
  receivedAt: number,
  days: number,
  run: () => Promise<T>
): Promise<T> => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(receivedAt + days * dayMs);
  try {
    return await run();
  } finally {
    vi.useRealTimers();
  }
};

/**
 * Fires `log`'s alarm (the deployment's, unless given) `days` after the
 * log received `event`, as it would fire then.
 */
const alarmAfter = async (
  event: AuditEvent | number,
  days: number,
  log: Log = auditLog(env)
): Promise<void> => {
  // Or when the log received it, once it no longer holds it.
  const receivedAt =
    typeof event === "number" ? event : await receivedAtOf(event, log);
  const ran = await later(
    receivedAt,
    days,
    async () => await runDurableObjectAlarm(log)
  );
  expect(ran).toBeTruthy();
};

/**
 * Runs `log`'s alarm now, on the real clock: the one an append or the cron
 * trigger armed for now, so it can't fire later, while a test has moved
 * the clock.
 */
const settled = async (log: Log): Promise<void> => {
  await runDurableObjectAlarm(log);
};

/**
 * Runs a retention pass over the deployment's log `days` after it
 * received `event`, with `changes` to the deployment's env: what the
 * log's alarm runs, under other config.
 */
const passAfter = async (
  event: AuditEvent,
  days: number,
  changes: Partial<Env>
): Promise<void> => {
  const log = auditLog(env);
  // Not the alarm the event's append armed, under the moved clock.
  await settled(log);
  await later(await receivedAtOf(event), days, async () => {
    await runInDurableObject(
      log,
      async (instance) => await retainAuditLog(instance, { ...env, ...changes })
    );
  });
};

/** When `log`'s alarm is set to fire, if it is. */
const alarmOf = async (log: Log): Promise<number | null> =>
  await runInDurableObject(
    log,
    async (_instance, state) => await state.storage.getAlarm()
  );

/** The event's position in the chain. */
const seqOf = async ({ id }: AuditEvent): Promise<number> => {
  const entries = await auditLog(env).entries();
  const entry = entries.find(({ event }) => event.includes(id));
  if (!entry) {
    throw new Error("The log doesn't hold the event");
  }
  return entry.seq;
};

/** The purges the log recorded of the stretch holding position `seq`. */
const purgesOf = async (seq: number): Promise<AuditEvent[]> => {
  const events = await allEvents();
  return events.filter(
    ({ action, detail }) =>
      action === "audit.purged" &&
      Number(detail.from) <= seq &&
      seq <= Number(detail.through)
  );
};

describe("audit log retention", () => {
  it("archives events past retention without breaking verification", async () => {
    const { api } = await signedInApi(idp, "admin");
    const old = await logged();
    const targetId = old.target?.id;

    // Not yet past the default of 180 days.
    await alarmAfter(old, 179);
    const kept = await api.audit.search({ targetId });
    expect(kept.records.map(({ event }) => event?.id)).toStrictEqual([old.id]);

    await alarmAfter(old, 181);
    await expect(api.audit.search({ targetId })).resolves.toStrictEqual({
      records: [],
      next: null,
    });
    await expect(held(old)).resolves.toBeFalsy();
    // The chain carries on after the archive, and verifies across it.
    await logged();
    await expect(verifyAll(api)).resolves.toMatchObject({
      ok: true,
      done: true,
    });
    // The archive is recorded in the log, by the platform, in the same
    // transaction that archived: it is there once the alarm has run.
    const events = await allEvents();
    const archived = events.find(({ action }) => action === "audit.archived");
    expect(archived).toMatchObject({
      actor: { type: "system" },
      detail: { retentionDays: 180 },
    });
  });

  it("keeps events for as many days as the deployment sets", async () => {
    const event = await logged();
    await passAfter(event, 40, { AUDIT_RETENTION_DAYS: "45" });
    await expect(held(event)).resolves.toBeTruthy();
    await passAfter(event, 46, { AUDIT_RETENTION_DAYS: "45" });
    await expect(held(event)).resolves.toBeFalsy();
  });

  it("archives nothing while retention is below the minimum or not whole days", async () => {
    const event = await logged();
    for (const days of ["7", "a year", "90.5"]) {
      // oxlint-disable-next-line no-await-in-loop -- one config at a time
      await passAfter(event, 400, { AUDIT_RETENTION_DAYS: days });
    }
    await expect(held(event)).resolves.toBeTruthy();
  });

  it("stops an export that hasn't read the events it archives yet", async () => {
    const { session } = await signedInWithRole(idp, "admin");
    const event = await logged();
    const reader = await exportReader(session, {});
    // The header fixes the positions the export reads: all of the log.
    await reader.read();

    await alarmAfter(event, 181);
    await expect(held(event)).resolves.toBeFalsy();
    await expect(outcome(reader.read())).resolves.toBe(
      "audit.export_interrupted"
    );
  });

  it("purges archived events once the deployment's archive retention has passed", async () => {
    const event = await logged();
    const receivedAt = await receivedAtOf(event);
    const seq = await seqOf(event);
    await alarmAfter(receivedAt, 181);
    // Archive retention is 365 days in tests, from when the log received it.
    await alarmAfter(receivedAt, 364);
    await expect(purgesOf(seq)).resolves.toStrictEqual([]);
    await alarmAfter(receivedAt, 366);
    await expect(purgesOf(seq)).resolves.toMatchObject([
      { actor: { type: "system" }, action: "audit.purged" },
    ]);
  });

  it("archives only while retention is switched on, whatever the audit search flag says", async () => {
    const event = await logged();
    await passAfter(event, 400, {
      FEATURES: { audit: true, audit_retention: false },
    });
    const whileOff = await held(event);
    await passAfter(event, 400, {
      FEATURES: { audit: false, audit_retention: true },
    });
    expect({ whileOff, whileOn: await held(event) }).toStrictEqual({
      whileOff: true,
      whileOn: false,
    });
  });

  it("arms its alarm on its first event, and archives once the event passes retention", async () => {
    const log = newLog();
    await expect(alarmOf(log)).resolves.toBeNull();
    const event = await logged(log);
    // Armed for now, and then, once that pass has run, for a day later: set
    // either way, apart from the moment the pass starts.
    await expect.poll(async () => await alarmOf(log)).not.toBeNull();
    await settled(log);

    const receivedAt = await receivedAtOf(event, log);
    await alarmAfter(receivedAt, 181, log);
    await expect(held(event, log)).resolves.toBeFalsy();
  });

  it("starts retention at once in a log that holds events from before its alarm", async () => {
    const log = newLog();
    const old = await logged(log);
    await settled(log);
    const receivedAt = await receivedAtOf(old, log);
    // As a log from a release before the alarm: events, no alarm, and an
    // object started afresh by the release.
    await runInDurableObject(log, async (_instance, state) => {
      await state.storage.deleteAlarm();
    });
    await evictDurableObject(log);

    await later(receivedAt, 181, async () => {
      await logged(log);
    });
    // Due at once.
    await expect(alarmOf(log)).resolves.toBe(receivedAt + 181 * dayMs);
    await alarmAfter(receivedAt, 181, log);
    await expect(held(old, log)).resolves.toBeFalsy();
  });

  it("arms the deployment's log from the 15-minute cron trigger, also when nothing is appended", async () => {
    const log = auditLog(env);
    await logged();
    await settled(log);
    // As after a release: no alarm, an object started afresh, no appends.
    await runInDurableObject(log, async (_instance, state) => {
      await state.storage.deleteAlarm();
    });
    await evictDurableObject(log);

    await runQuarterHourCron();
    await expect.poll(async () => await alarmOf(log)).not.toBeNull();
    await settled(log);
  });

  it("works off a backlog larger than one pass takes, a pass after another", async () => {
    const log = newLog();
    const first = await logged(log);
    await settled(log);
    const receivedAt = await receivedAtOf(first, log);
    // More than ten full stretches of 500, what one pass archives at most.
    for (let batch = 0; batch < 10; batch += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one batch after another
      await log.append(
        Array.from({ length: 500 }, () =>
          auditEventSchema.parse({
            id: crypto.randomUUID(),
            at: new Date().toISOString(),
            source: "core",
            actor: { type: "system" },
            action: "test.retained",
          })
        )
      );
    }
    const last = await logged(log);

    await alarmAfter(receivedAt, 181, log);
    await expect(held(last, log)).resolves.toBeTruthy();
    // It moved stretches, and may have stopped at its cap: the next pass
    // is due at once.
    await expect(alarmOf(log)).resolves.toBe(receivedAt + 181 * dayMs);
    await alarmAfter(receivedAt, 181, log);
    await expect(held(last, log)).resolves.toBeFalsy();
    // That pass moved the rest; the one after it moves nothing, and waits
    // a day.
    await alarmAfter(receivedAt, 181, log);
    await expect(alarmOf(log)).resolves.toBe(receivedAt + 182 * dayMs);
  });

  it("keeps its daily alarm through a pass that fails, and archives on the next", async () => {
    const log = newLog();
    const event = await logged(log);
    await settled(log);
    const receivedAt = await receivedAtOf(event, log);

    // The archive bucket is down.
    const down = vi
      .spyOn(env.AUDIT_ARCHIVE, "put")
      .mockRejectedValue(new Error("R2 unavailable"));
    try {
      await alarmAfter(receivedAt, 181, log);
    } finally {
      down.mockRestore();
    }
    await expect(held(event, log)).resolves.toBeTruthy();
    await expect(alarmOf(log)).resolves.toBe(receivedAt + 182 * dayMs);

    // Up again: the next day's pass archives it.
    await alarmAfter(receivedAt, 182, log);
    await expect(held(event, log)).resolves.toBeFalsy();
  });
});
