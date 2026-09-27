import {
  auditEventSchema,
  auditOutboxTakeMax,
  auditRejectReasons,
  createAuditEvent,
  isAuditEventTooLarge,
} from "@grasp-os/shared/audit";
import type {
  AuditEntry,
  AuditEvent,
  OutboxedAuditEvent,
  OutboxRejected,
} from "@grasp-os/shared/audit";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { identifierSchema } from "@grasp-os/shared/ids";
import { canonicalJson } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import { waitUntil } from "cloudflare:workers";
import { sql } from "drizzle-orm";
import type { BatchItem, BatchResponse } from "drizzle-orm/batch";
import type { DrizzleD1Database } from "drizzle-orm/d1";

import { auditLog } from "./audit-log.ts";
import type { AuditLogEnv } from "./audit-log.ts";
import { auditOutbox } from "./db/core/schema.ts";

// A change to the core or Knowledge database that must be audited stores
// its event in that database's outbox (each has an `audit_outbox` table) in
// the same batch as the change: both are kept, or neither. Connect keeps an
// outbox of its own the same way. Draining an outbox appends its oldest
// events to the AuditLog object, in the order they were stored, and only
// then removes them: a drain cut short leaves them to append again, and the
// log keeps an event ID once. A row the log can't take is recorded in the
// chain with an `audit.gap` and moved out to `audit_outbox_rejected` in the
// same step as the removals, so every row leaves the outbox and every drain
// reads its head. Right after a change, core drains the
// outbox it wrote in the background (`waitUntil`), so the change doesn't
// wait on the log; the cron trigger drains all three every minute,
// connect's over RPC, which is how connect's events reach the log at all
// (connect can't reach core).

/** Most batches one cron drain of an outbox appends: 5,000 events. */
const drainMaxBatches = 50;

/** One outbox, as a drain reads it: its oldest events, and settling them. */
interface Outbox {
  /** Named in logs. */
  name: "core" | "knowledge" | "connect";
  /** Its oldest events, at most {@link auditOutboxTakeMax}, in order. */
  take: () => Promise<readonly OutboxedAuditEvent[]>;
  /**
   * Removes the events the log now has, and moves those it can't take to
   * `audit_outbox_rejected`, all at once.
   */
  settle: (
    appended: readonly string[],
    rejected: readonly OutboxRejected[]
  ) => Promise<void>;
}

/**
 * A database's own outbox. Its rows go in the order they were stored:
 * SQLite's rowid, which an insert sets past every row in the table, also
 * for events stored in one batch, which share their `created_at`.
 */
const databaseOutbox = (
  name: Outbox["name"],
  database: D1Database
): Outbox => ({
  name,
  take: async () => {
    const { results } = await database
      .prepare(
        "SELECT id, event, created_at AS createdAt FROM audit_outbox ORDER BY rowid LIMIT ?"
      )
      .bind(auditOutboxTakeMax)
      .all<OutboxedAuditEvent>();
    return results;
  },
  settle: async (appended, rejected) => {
    const now = Date.now();
    const ids = [...appended, ...rejected.map(({ id }) => id)];
    await database.batch([
      ...rejected.map(({ id, reason }) =>
        database
          .prepare(
            "INSERT INTO audit_outbox_rejected (id, event, reason, created_at, rejected_at) SELECT id, event, ?, created_at, ? FROM audit_outbox WHERE id = ?"
          )
          .bind(reason, now, id)
      ),
      database
        .prepare(
          `DELETE FROM audit_outbox WHERE id IN (${ids.map(() => "?").join(", ")})`
        )
        .bind(...ids),
    ]);
  },
});

/** Connect's outbox, over RPC. */
const connectOutbox = (env: Pick<Env, "CONNECT">): Outbox => ({
  name: "connect",
  take: async () => await env.CONNECT.takeAuditEvents(),
  settle: async (appended, rejected) => {
    await env.CONNECT.ackAuditEvents([...appended], [...rejected]);
  },
});

/**
 * A UUID (version 5's layout: name-based) made from a SHA-256 hex digest,
 * for an event whose ID must come out the same each time it is made.
 */
const uuidFromHash = (hash: string): string => {
  const variant = ((Number.parseInt(hash.charAt(16), 16) % 4) + 8).toString(16);
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `5${hash.slice(13, 16)}`,
    `${variant}${hash.slice(17, 20)}`,
    hash.slice(20, 32),
  ].join("-");
};

/** A stored event the log can take, or `undefined`. */
const parseStored = (stored: string): AuditEvent | undefined => {
  let json: unknown;
  try {
    json = JSON.parse(stored);
  } catch {
    return undefined;
  }
  const parsed = auditEventSchema.safeParse(json);
  if (!parsed.success || isAuditEventTooLarge(canonicalJson(parsed.data))) {
    return undefined;
  }
  return parsed.data;
};

/**
 * The `audit.gap` that records rows a drain moves out of an outbox for one
 * reason: identifiers only, their row IDs as provenance, with the reason
 * and how many (the rejected table keeps their content). Its ID and time
 * come from the rows themselves, so a drain that stops before moving them
 * and runs again makes the same event, which the log keeps once.
 * `undefined` when there are none.
 */
const gapFor = async (
  outbox: Outbox["name"],
  reason: OutboxRejected["reason"],
  rows: readonly OutboxedAuditEvent[]
): Promise<AuditEvent | undefined> => {
  if (rows.length === 0) {
    return undefined;
  }
  const hash = await sha256Hex(
    JSON.stringify([
      "audit.gap",
      outbox,
      reason,
      rows.map(({ id, event, createdAt }) => [id, createdAt, event]),
    ])
  );
  const event = createAuditEvent(
    {
      actor: { type: "system" },
      action: "audit.gap",
      // A row ID too long to name is still counted.
      provenance: rows
        .map(({ id }) => id)
        .filter((id) => identifierSchema.safeParse(id).success),
      detail: { outbox, reason, count: rows.length },
    },
    "core"
  );
  return {
    ...event,
    id: uuidFromHash(hash),
    at: new Date(
      Math.max(...rows.map(({ createdAt }) => createdAt))
    ).toISOString(),
  };
};

/**
 * Appends an outbox's oldest events to the log, in order, records any it
 * moves aside with an `audit.gap` (`gapFor`), then settles them: those the log has are removed, and two kinds are moved out to
 * `audit_outbox_rejected`, logged at error level as they are:
 * - `refused`: one the log could never take (not an event to this
 *   release, or over the size cap);
 * - `conflict`: one whose ID the log already holds with other content, a
 *   bug or a forgery.
 * Returns how many it took and how many the log appended.
 */
const drainBatch = async (
  env: AuditLogEnv,
  outbox: Outbox
): Promise<{ taken: number; appended: number }> => {
  const rows = await outbox.take();
  const events: AuditEvent[] = [];
  const rejected: (OutboxRejected & { row: OutboxedAuditEvent })[] = [];
  // Each event's row, by the event's ID as the log knows it.
  const rowOf = new Map<string, OutboxedAuditEvent>();
  for (const row of rows) {
    const parsed = parseStored(row.event);
    if (parsed === undefined) {
      rejected.push({ id: row.id, reason: "refused", row });
    } else {
      events.push(parsed);
      rowOf.set(parsed.id, row);
    }
  }
  let appended = 0;
  if (events.length > 0) {
    const result = await auditLog(env).append(events);
    log.info("audit.appended", {
      outbox: outbox.name,
      events: result.appended,
      duplicates: result.duplicates,
      conflicts: result.conflicts,
    });
    for (const id of result.conflictIds) {
      const row = rowOf.get(id);
      if (row !== undefined) {
        rejected.push({ id: row.id, reason: "conflict", row });
        rowOf.delete(id);
      }
    }
    ({ appended } = result);
  }
  // The chain records what leaves it out before it is moved aside.
  const gaps = await Promise.all(
    auditRejectReasons.map(
      async (reason) =>
        await gapFor(
          outbox.name,
          reason,
          rejected.filter((row) => row.reason === reason).map(({ row }) => row)
        )
    )
  );
  const recorded = gaps.filter((gap) => gap !== undefined);
  if (recorded.length > 0) {
    await auditLog(env).append(recorded);
  }
  if (rows.length > 0) {
    await outbox.settle(
      [...rowOf.values()].map(({ id }) => id),
      rejected.map(({ id, reason }) => ({ id, reason }))
    );
  }
  for (const reason of auditRejectReasons) {
    const ids = rejected.filter((row) => row.reason === reason);
    if (ids.length > 0) {
      log.error("audit.outbox.rejected", {
        outbox: outbox.name,
        reason,
        count: ids.length,
        ids: ids.map(({ id }) => id).join(","),
      });
    }
  }
  return { taken: rows.length, appended };
};

/**
 * Drains an outbox a batch at a time, each from its head, until it is empty
 * or `maxBatches` went. Returns how many events the log appended.
 */
const drain = async (
  env: AuditLogEnv,
  outbox: Outbox,
  maxBatches: number
): Promise<number> => {
  let appended = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    // Each batch after the one before it, so events keep their order.
    // oxlint-disable-next-line no-await-in-loop
    const result = await drainBatch(env, outbox);
    appended += result.appended;
    if (result.taken < auditOutboxTakeMax) {
      break;
    }
  }
  return appended;
};

/**
 * Drains an outbox, and logs a drain that fails (`audit.outbox.drain_failed`)
 * instead of throwing: it is drained again later. Returns how many events
 * it appended.
 */
const drainLogged = async (
  env: AuditLogEnv,
  outbox: Outbox,
  maxBatches: number
): Promise<number> => {
  try {
    return await drain(env, outbox, maxBatches);
  } catch (error) {
    log.error("audit.outbox.drain_failed", {
      outbox: outbox.name,
      ...errorFields(error),
    });
    return 0;
  }
};

/**
 * Drains every outbox: the core and Knowledge databases' and connect's,
 * each on its own, so one that fails (connect unreachable, say) is logged
 * and leaves the others to drain. Returns how many events it appended.
 * The cron trigger calls it.
 */
export const drainAuditOutboxes = async (env: Env): Promise<number> => {
  const counts = await Promise.all(
    [
      databaseOutbox("core", env.DB),
      databaseOutbox("knowledge", env.KNOWLEDGE),
      connectOutbox(env),
    ].map(async (outbox) => await drainLogged(env, outbox, drainMaxBatches))
  );
  return counts.reduce((total, count) => total + count, 0);
};

/** What draining core's own outboxes needs. */
type OutboxEnv = AuditLogEnv & Pick<Env, "KNOWLEDGE">;

/** Core's or Knowledge's database, as `drizzle` gives it: with its binding. */
type AuditedDatabase = DrizzleD1Database & { $client: D1Database };

/**
 * Drains `db`'s outbox, the one a change just wrote, one batch, in the
 * background: the change doesn't wait on the log, and its event normally
 * reaches it a moment later. A drain that fails is logged; the cron
 * trigger drains the event later.
 */
const drainSoon = (env: OutboxEnv, db: AuditedDatabase): void => {
  const name = db.$client === env.KNOWLEDGE ? "knowledge" : "core";
  waitUntil(drainLogged(env, databaseOutbox(name, db.$client), 1));
};

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
 * Appends the event for `entry` straight to the log, with no outbox: for
 * what changes no database of ours, such as reading the log, which must be
 * recorded before the reader gets what they read. Throws when the log
 * can't take it.
 */
export const appendAuditEvent = async (
  env: AuditLogEnv,
  entry: AuditEntry
): Promise<void> => {
  await auditLog(env).append([createAuditEvent(entry, "core")]);
};

/**
 * Stores the event for a change that has already happened outside a batch
 * of ours, so the event can't join it, and drains it: in `db`'s outbox
 * (drained in the background, as `auditedBatch` does); if
 * the database refuses it, straight to the log; and if that fails too, in
 * the logs (an event is identifiers only, so the logs may keep it). Never
 * throws: the change is done, and failing its caller wouldn't undo it.
 */
export const keepAuditEvent = async (
  env: OutboxEnv,
  db: AuditedDatabase,
  entry: AuditEntry
): Promise<void> => {
  try {
    await outboxed(db, entry);
  } catch (outboxError) {
    log.error("audit.outbox.store_failed", errorFields(outboxError));
    try {
      await appendAuditEvent(env, entry);
    } catch (appendError) {
      log.error("audit.lost", {
        ...errorFields(appendError),
        entry: canonicalJson(entry),
      });
    }
    return;
  }
  drainSoon(env, db);
};

/**
 * Runs an audited change: `statements` (the change and its `outboxed`
 * events) in one batch on `db`, core's or Knowledge's database, then drains
 * its outbox in the background. A batch that fails stores and drains
 * nothing.
 */
export const auditedBatch = async <
  U extends BatchItem<"sqlite">,
  T extends Readonly<[U, ...U[]]>,
>(
  env: Env,
  db: AuditedDatabase,
  statements: T
): Promise<BatchResponse<T>> => {
  const results = await db.batch(statements);
  drainSoon(env, db);
  return results;
};
