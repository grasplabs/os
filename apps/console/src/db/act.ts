/**
 * How the console changes anything: the change and its audit event in one
 * D1 batch, so neither lands without the other (threat model R19, CO6).
 */
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

/**
 * Runs `statements` and records `event` by `actor` in one batch: if any
 * statement fails, nothing is written, the event included.
 */
export const act = async (
  db: ConsoleDatabase,
  actor: Actor,
  statements: readonly BatchItem<"sqlite">[],
  event: ConsoleEvent
): Promise<void> => {
  if (!actionPattern.test(event.action)) {
    throw new Error(`Not an audit action: ${event.action}`);
  }
  const record = db.insert(auditEvents).values({
    id: crypto.randomUUID(),
    at: new Date(),
    actor: actor === "system" ? actor : actor.email,
    action: event.action,
    clientId: event.clientId,
    target: event.target,
    detail: event.detail === undefined ? null : JSON.stringify(event.detail),
  });
  // One batch is one transaction: the event first is as good as last.
  await db.batch([record, ...statements]);
};
