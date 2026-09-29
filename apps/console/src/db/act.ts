/**
 * How the console changes anything: the change and its audit event in one
 * D1 batch, so neither lands without the other (threat model R19, CO6). A
 * change outside the database (a Workflow started) is recorded first, on
 * its own (`audit`).
 */
import { sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";

import type { Staff } from "../access.ts";
import { auditEvents } from "./schema.ts";

export type ConsoleDatabase = DrizzleD1Database;

/** The console's database, through Drizzle. */
export const consoleDatabase = (d1: D1Database): ConsoleDatabase => drizzle(d1);

/** Who acted: a staff member, or the console itself (its cron and workflows). */
export type Actor = Staff | "system";

/** What happened, as the audit log records it: identifiers, never content. */
export interface ConsoleEvent {
  /** A dotted verb, such as `client.create`. */
  action: string;
  /** The client it concerns, if any. */
  clientId?: string;
  /** What it acted on within that client, such as a release or rollout id. */
  target?: string;
  /** Identifiers and counts only; never secrets, tokens or response bodies. */
  detail?: Record<string, string | number | boolean>;
}

/** A dotted verb: at least two lowercase segments, as in core's audit log. */
const actionPattern = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/u;

/** Checks `event` and builds its row. */
const rowOf = (actor: Actor, event: ConsoleEvent) => {
  if (!actionPattern.test(event.action)) {
    throw new Error(`Not an audit action: ${event.action}`);
  }
  return {
    id: crypto.randomUUID(),
    at: new Date(),
    actor: actor === "system" ? actor : actor.email,
    action: event.action,
    clientId: event.clientId ?? null,
    target: event.target ?? null,
    detail: event.detail === undefined ? null : JSON.stringify(event.detail),
  };
};

/**
 * Runs `statements`, at least one, and records `event` by `actor` in one
 * batch (one transaction): if any statement fails, nothing is written, the
 * event included. For changes that always happen when their statements
 * succeed; a conditional one goes through `actIfChanged`.
 */
export const act = async (
  db: ConsoleDatabase,
  actor: Actor,
  statements: readonly [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]],
  event: ConsoleEvent
): Promise<void> => {
  const record = db.insert(auditEvents).values(rowOf(actor, event));
  // One batch is one transaction, so where the event sits in it doesn't
  // matter. (`actIfChanged` is different: its event must follow the
  // statement whose changes it reads.)
  await db.batch([record, ...statements]);
};

/**
 * Records `event` by `actor` on its own: for an action whose change isn't
 * in the console's database, such as starting a Workflow. Recorded before
 * the action, so an action that then fails is still an audited attempt.
 */
export const audit = async (
  db: ConsoleDatabase,
  actor: Actor,
  event: ConsoleEvent
): Promise<void> => {
  await db.insert(auditEvents).values(rowOf(actor, event));
};

/**
 * Runs `statement`, a conditional change (an update or delete with a
 * `WHERE` that may match nothing, or an insert that ignores a conflict,
 * as the release import's), and records `event` by `actor` only if
 * it changed a row, in the same batch. Returns whether it did, read from
 * the batch's own results: nothing runs after the batch commits.
 * `following` runs after the event in the same batch: statements whose
 * own `WHERE` makes them depend on the change, such as rows that
 * reference one it inserted.
 *
 * The event's insert comes right after the statement and reads its
 * `changes()`. That's sound in the console's database, which has no FTS
 * tables: an FTS5 index flush sets `changes()` too (see core's
 * `outboxedIfChanged`), so this must not be used where one could run.
 */
export const actIfChanged = async (
  db: ConsoleDatabase,
  actor: Actor,
  statement: BatchItem<"sqlite">,
  event: ConsoleEvent,
  following: readonly BatchItem<"sqlite">[] = []
): Promise<boolean> => {
  const row = rowOf(actor, event);
  const record = db
    .insert(auditEvents)
    .select(
      sql`SELECT ${row.id}, ${row.at.getTime()}, ${row.actor}, ${row.action}, ${row.clientId}, ${row.target}, ${row.detail} WHERE changes() > 0`
    )
    .returning({ id: auditEvents.id });
  const [, recorded] = await db.batch([statement, record, ...following]);
  return recorded.length > 0;
};
