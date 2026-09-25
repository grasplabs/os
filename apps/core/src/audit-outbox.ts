import { createAuditEvent } from "@grasp-os/shared/audit";
import type { AuditEntry } from "@grasp-os/shared/audit";
import { asc, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";

import { auditOutbox } from "./db/core/schema.ts";
import { errorFields, log } from "./log.ts";

// A change to the core or Knowledge database that must be audited stores
// its event in that database's outbox (each has an `audit_outbox` table) in
// the same batch as the change: both are kept, or neither.
// The event is sent right after; whatever wasn't (the queue refused it, the
// Worker stopped) goes with the next send, from the cron trigger at the
// latest. An event may reach the queue more than once, always with the same
// ID, and the log keeps it once.

/** Most events one send takes from the outbox. */
const sendBatchSize = 100;

/** Stores the event for `entry`; run it in one batch with the change. */
export const outboxed = (db: DrizzleD1Database, entry: AuditEntry) => {
  const event = createAuditEvent(entry, "core");
  return db.insert(auditOutbox).values({
    id: event.id,
    event: JSON.stringify(event),
    createdAt: new Date(),
  });
};

/**
 * Stores the event for `entry` only if the batch's previous statement
 * changed a row, so a conditional update that changed nothing records
 * nothing.
 */
export const outboxedIfChanged = (db: DrizzleD1Database, entry: AuditEntry) => {
  const event = createAuditEvent(entry, "core");
  return db
    .insert(auditOutbox)
    .select(
      sql`SELECT ${event.id}, ${JSON.stringify(event)}, ${Date.now()} WHERE changes() > 0`
    );
};

/**
 * What goes on the queue for a stored event. One that doesn't parse goes as
 * it is: the queue's consumer refuses it until it lands in the dead letter
 * queue, where it can be looked at, instead of staying here forever.
 */
const queueBody = (event: string): unknown => {
  try {
    return JSON.parse(event);
  } catch {
    return event;
  }
};

/**
 * Sends the oldest events in one database's outbox to the audit queue,
 * then removes those sent: a failure in between sends them again later,
 * and one that fails to send stays for the next time.
 */
const sendOutboxOf = async (
  env: Env,
  database: D1Database
): Promise<number> => {
  const db = drizzle(database);
  const rows = await db
    .select()
    .from(auditOutbox)
    .orderBy(asc(auditOutbox.createdAt), asc(auditOutbox.id))
    .limit(sendBatchSize);
  // Each row on its own, so one that can't be sent doesn't hold up the rest.
  const results = await Promise.allSettled(
    rows.map(async ({ id, event }) => {
      await env.AUDIT_QUEUE.send(queueBody(event));
      return id;
    })
  );
  const sent = results.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : []
  );
  for (const result of results) {
    if (result.status === "rejected") {
      log.error("audit.outbox.send_failed", errorFields(result.reason));
    }
  }
  if (sent.length > 0) {
    await db.delete(auditOutbox).where(inArray(auditOutbox.id, sent));
  }
  return sent.length;
};

/**
 * Sends the outboxes of the core and Knowledge databases, each of which
 * holds the events of its own changes. Returns how many it sent. The cron
 * trigger calls it.
 */
export const sendAuditOutbox = async (env: Env): Promise<number> => {
  const counts = await Promise.all(
    [env.DB, env.KNOWLEDGE].map(
      async (database) => await sendOutboxOf(env, database)
    )
  );
  return counts.reduce((total, count) => total + count, 0);
};

/**
 * Sends right after a change, so its event normally goes out at once. The
 * change has happened and its event is safe in the outbox, so a failure
 * here is logged, not passed on to whoever made the change.
 */
export const sendAuditOutboxNow = async (env: Env): Promise<void> => {
  try {
    await sendAuditOutbox(env);
  } catch (error) {
    log.error("audit.outbox.send_failed", errorFields(error));
  }
};
