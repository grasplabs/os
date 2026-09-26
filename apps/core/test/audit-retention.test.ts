import { auditEventSchema } from "@grasp-os/shared/audit";
import type { AuditEvent } from "@grasp-os/shared/audit";
import { createScheduledController } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { auditLog } from "../src/audit-log.ts";
import worker from "../src/index.ts";
import { allEvents, exportReader } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { outcome, signedInApi, signedInWithRole, unique } from "./sign-in.ts";

// Retention: the cron trigger moves events past the deployment's retention
// out of the log into the archive, and the chain still verifies from its
// first event to its last. Config that isn't valid, or the feature being
// off, archives nothing.

const idp = mockIdp();

const dayMs = 24 * 60 * 60 * 1000;

/** An event appended to the deployment's log now. */
const logged = async (): Promise<AuditEvent> => {
  const event = auditEventSchema.parse({
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    source: "core",
    actor: { type: "system" },
    action: "test.retained",
    target: { type: "test", id: `retained-${unique()}` },
  });
  await auditLog(env).append([event]);
  return event;
};

/** Whether the log still holds the event, where admins search it. */
const held = async ({ id }: AuditEvent): Promise<boolean> => {
  const events = await allEvents();
  return events.some((event) => event.id === id);
};

/** When the log received the event: never before the entry before it. */
const receivedAtOf = async ({ id }: AuditEvent): Promise<number> => {
  const entries = await auditLog(env).entries();
  const entry = entries.find(({ event }) => event.includes(id));
  if (!entry) {
    throw new Error("The log doesn't hold the event");
  }
  return Date.parse(entry.receivedAt);
};

/**
 * Runs the cron trigger `days` after the log received `event`, with
 * `changes` to core's env. The clock moves for the log too, and its times
 * never go back, so each test counts from its own event.
 */
const cronAfter = async (
  event: AuditEvent | number,
  days: number,
  changes: Partial<Env> = {}
) => {
  // Or when the log received it, once it no longer holds it.
  const receivedAt =
    typeof event === "number" ? event : await receivedAtOf(event);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(receivedAt + days * dayMs);
  try {
    await worker.scheduled(createScheduledController(), {
      ...env,
      ...changes,
    });
  } finally {
    vi.useRealTimers();
  }
};

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

type Api = Awaited<ReturnType<typeof signedInApi>>["api"];

/** Verifies the whole chain a step at a time, as an admin does. */
const verifyAll = async (api: Api) => {
  let result = await api.audit.verify();
  while (result.ok && !result.done) {
    // Each step starts where the one before it stopped.
    // oxlint-disable-next-line no-await-in-loop
    result = await api.audit.verify(result.through);
  }
  return result;
};

describe("audit log retention", () => {
  it("archives events past retention without breaking verification", async () => {
    const { api } = await signedInApi(idp, "admin");
    const old = await logged();
    const targetId = old.target?.id;

    // Not yet past the default of 180 days.
    await cronAfter(old, 179);
    const kept = await api.audit.search({ targetId });
    expect(kept.records.map(({ event }) => event?.id)).toStrictEqual([old.id]);

    await cronAfter(old, 181);
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
    // The archive is recorded in the log, by the platform.
    const archived = await vi.waitFor(async () => {
      const events = await allEvents();
      const found = events.find(({ action }) => action === "audit.archived");
      if (!found) {
        throw new Error("Not recorded yet");
      }
      return found;
    });
    expect(archived).toMatchObject({
      actor: { type: "system" },
      detail: { retentionDays: 180 },
    });
  });

  it("keeps events for as many days as the deployment sets", async () => {
    const event = await logged();
    await cronAfter(event, 40, { AUDIT_RETENTION_DAYS: "45" });
    await expect(held(event)).resolves.toBeTruthy();
    await cronAfter(event, 46, { AUDIT_RETENTION_DAYS: "45" });
    await expect(held(event)).resolves.toBeFalsy();
  });

  it("archives nothing while retention is below the minimum or not whole days", async () => {
    const event = await logged();
    for (const days of ["7", "a year", "90.5"]) {
      // oxlint-disable-next-line no-await-in-loop -- one config at a time
      await cronAfter(event, 400, { AUDIT_RETENTION_DAYS: days });
    }
    await expect(held(event)).resolves.toBeTruthy();
  });

  it("stops an export that hasn't read the events it archives yet", async () => {
    const { session } = await signedInWithRole(idp, "admin");
    const event = await logged();
    const reader = await exportReader(session, {});
    // The header fixes the positions the export reads: all of the log.
    await reader.read();

    await cronAfter(event, 181);
    await expect(held(event)).resolves.toBeFalsy();
    await expect(outcome(reader.read())).resolves.toBe(
      "audit.export_interrupted"
    );
  });

  it("purges archived events once the deployment's archive retention has passed", async () => {
    const event = await logged();
    const receivedAt = await receivedAtOf(event);
    const seq = await seqOf(event);
    await cronAfter(receivedAt, 181);
    // Archive retention is 365 days in tests, from when the log received it.
    await cronAfter(receivedAt, 364);
    await expect(purgesOf(seq)).resolves.toStrictEqual([]);
    await cronAfter(receivedAt, 366);
    await expect(purgesOf(seq)).resolves.toMatchObject([
      { actor: { type: "system" }, action: "audit.purged" },
    ]);
  });

  it("archives nothing while the feature is off", async () => {
    const event = await logged();
    await cronAfter(event, 400, { FEATURES: { audit: false } });
    await expect(held(event)).resolves.toBeTruthy();
  });
});
