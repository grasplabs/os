import {
  auditOutboxTakeMax,
  auditProvenanceMaxItems,
  auditRejectReasons,
  createAuditEvent,
  delegateActorOf,
} from "@grasp-os/shared/audit";
import type {
  AuditActor,
  AuditDetailValue,
  AuditEntry,
  OutboxedAuditEvent,
} from "@grasp-os/shared/audit";
import type { CapabilityClaims } from "@grasp-os/shared/capability";
import { connectErrors } from "@grasp-os/shared/connect";
import type { ConnectCall } from "@grasp-os/shared/connect";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { drizzle } from "drizzle-orm/d1";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { z } from "zod";

import { auditOutbox } from "./db/schema.ts";

/**
 * Records events: stored in the outbox, in one batch with `alongside` (the
 * change they record), so a change is never kept without its events. Core
 * takes them from there (`takeAuditEvents`).
 */
export const recordEvents = async (
  env: Env,
  entries: readonly [AuditEntry, ...AuditEntry[]],
  alongside: readonly BatchItem<"sqlite">[] = []
): Promise<void> => {
  const events = entries.map((entry) => createAuditEvent(entry, "connect"));
  const db = drizzle(env.DB);
  const createdAt = new Date();
  const [stored, ...alsoStored] = events.map((event) =>
    db
      .insert(auditOutbox)
      .values({ id: event.id, event: JSON.stringify(event), createdAt })
  );
  if (stored === undefined) {
    throw new Error("Expected an event to record");
  }
  await db.batch([stored, ...alsoStored, ...alongside]);
};

/** One change, recorded only if a row of `from` matches `where`. */
export interface GuardedChange {
  entry: AuditEntry;
  from: SQLiteTable;
  where: SQL;
  /** The change: statements the same condition guards. */
  writes: readonly BatchItem<"sqlite">[];
}

/**
 * Records each change's event only if a row of its `from` matches its
 * `where`, all in one transaction with the changes' `writes`, which the
 * same conditions guard: an event is kept exactly when its change is made,
 * so a change that a concurrent one made first isn't recorded twice.
 * Whether each was.
 */
export const recordEventsIf = async (
  env: Env,
  changes: readonly [GuardedChange, ...GuardedChange[]]
): Promise<boolean[]> => {
  const db = drizzle(env.DB);
  const events = changes.map(({ entry }) => createAuditEvent(entry, "connect"));
  const statements = changes.flatMap(({ from, where, writes }, index) => [
    db
      .insert(auditOutbox)
      .select(
        db
          .select({
            id: sql<string>`${events[index]?.id}`.as("id"),
            event: sql<string>`${JSON.stringify(events[index])}`.as("event"),
            createdAt: sql<Date>`${Date.now()}`.as("created_at"),
          })
          .from(from)
          .where(where)
          .limit(1)
      )
      .returning({ id: auditOutbox.id }),
    ...writes,
  ]);
  const [first, ...rest] = statements;
  if (first === undefined) {
    return [];
  }
  const results = await db.batch([first, ...rest]);
  // Each change's event insert comes first among its statements.
  let at = 0;
  return changes.map(({ writes }) => {
    const inserted: unknown = results[at];
    at += 1 + writes.length;
    return Array.isArray(inserted) && inserted.length > 0;
  });
};

/**
 * Records one event only if a row of `from` matches `where`, in the same
 * transaction as `writes` (`recordEventsIf`). Whether it was.
 */
export const recordEventIf = async (
  env: Env,
  entry: AuditEntry,
  { from, where }: { from: SQLiteTable; where: SQL },
  writes: readonly BatchItem<"sqlite">[]
): Promise<boolean> => {
  const [recorded = false] = await recordEventsIf(env, [
    { entry, from, where, writes },
  ]);
  return recorded;
};

/**
 * How a call ended: done, answered from its stored result, held for its
 * person to confirm, refused before anything was sent, failed without an
 * effect, or failed after it may have had one.
 */
export type CallOutcome =
  | "ok"
  | "replayed"
  | "held"
  | "refused"
  | "failed"
  | "unknown";

/** One call, as far as connect got with it. */
export interface CallRecord {
  /** The call as core stated it, once it parsed. */
  call?: Omit<ConnectCall, "capability" | "input">;
  /** What its capability says, once verified: who called, for whom. */
  claims?: CapabilityClaims;
  /** Known once the action is found, or from a stored result. */
  sideEffect?: boolean;
  outcome: CallOutcome;
  /** The error code, when it didn't end well. */
  reason?: string;
  /** The IDs of the resources it read. */
  provenance?: readonly string[];
  /** The held action it made, or the one its person confirmed. */
  pendingActionId?: string;
}

/**
 * Bytes of provenance per event: an event holds at most 8 KB, and the rest
 * of it (actor, detail) takes up to a few KB of that.
 */
const provenanceBytesPerEvent = 4096;

/** Splits IDs into groups small enough for one event each. */
const provenanceGroups = (ids: readonly string[]): string[][] => {
  const groups: string[][] = [[]];
  let bytes = 0;
  for (const id of ids) {
    const size = new TextEncoder().encode(JSON.stringify(id)).byteLength + 1;
    const group = groups.at(-1) ?? [];
    if (
      group.length > 0 &&
      (group.length === auditProvenanceMaxItems ||
        bytes + size > provenanceBytesPerEvent)
    ) {
      groups.push([id]);
      bytes = size;
    } else {
      group.push(id);
      bytes += size;
    }
  }
  return groups;
};

/**
 * Records one call: who made it (the platform, while its capability isn't
 * verified), on which connection, what it did and read, and how it ended.
 * Identifiers only, never the input or the output. A call that read more
 * than one event holds continues in `connection.call.provenance` events
 * with the same request ID. `alongside` is the call's stored answer, for a
 * side effect: it is never kept without its events.
 */
export const auditCall = async (
  env: Env,
  record: CallRecord,
  alongside: readonly BatchItem<"sqlite">[] = []
): Promise<void> => {
  const { call, claims, sideEffect, outcome, reason } = record;
  const provenance = record.provenance ?? [];
  const actor: AuditActor =
    claims === undefined
      ? { type: "system" }
      : delegateActorOf(claims.authority);
  const target =
    call === undefined
      ? undefined
      : { type: "connection", id: call.connectionId };
  const detail: Record<string, AuditDetailValue> = { outcome };
  const add = (key: string, value: AuditDetailValue | undefined): void => {
    if (value !== undefined) {
      detail[key] = value;
    }
  };
  add("action", call?.action);
  add("resource", call?.resource);
  // App code chooses keys, so the log gets a hash, never the key itself.
  add(
    "idempotencyKeyHash",
    call?.idempotencyKey === undefined
      ? undefined
      : await sha256Hex(call.idempotencyKey)
  );
  add("onBehalfOf", claims?.authority.onBehalfOf);
  add("mode", claims?.authority.mode);
  // Which of the App's versions made the call, for a call from App code.
  add("appVersion", claims?.authority.appVersion);
  add("sideEffect", sideEffect);
  // Only when it is: from a context that had read restricted data.
  add("restricted", claims?.restricted === true ? true : undefined);
  add("reason", reason);
  add("pendingActionId", record.pendingActionId);
  add("provenanceCount", provenance.length);

  const [first = [], ...rest] = provenanceGroups(provenance);
  const common = { actor, target, requestId: claims?.jti };
  await recordEvents(
    env,
    [
      { ...common, action: "connection.call", provenance: first, detail },
      ...rest.map((group) => ({
        ...common,
        action: "connection.call.provenance",
        provenance: group,
      })),
    ],
    alongside
  );
};

/**
 * What core acknowledges: the events it appended, and those the log can't
 * take, with why. At most one take's worth in all.
 */
const ackSchema = z
  .object({
    appended: z.array(z.uuid()),
    rejected: z.array(
      z.object({ id: z.uuid(), reason: z.enum(auditRejectReasons) })
    ),
  })
  .refine(
    ({ appended, rejected }) =>
      appended.length + rejected.length <= auditOutboxTakeMax,
    { message: `At most ${auditOutboxTakeMax} events` }
  );

/**
 * The oldest events in the outbox, in the order they were stored (SQLite's
 * rowid, which an insert sets past every row in the table, also for events
 * stored in one batch, which share their `created_at`), at most
 * {@link auditOutboxTakeMax}: core takes them, appends them to the audit
 * log, and only then acknowledges them (`ackAuditEvents`). Taking removes
 * nothing, so events core took but didn't acknowledge are taken again.
 */
export const takeAuditEvents = async (
  env: Env
): Promise<OutboxedAuditEvent[]> => {
  const { results } = await env.DB.prepare(
    "SELECT id, event, created_at AS createdAt FROM audit_outbox ORDER BY rowid LIMIT ?"
  )
    .bind(auditOutboxTakeMax)
    .all<OutboxedAuditEvent>();
  return results;
};

/**
 * Settles events core took: removes those it appended to the audit log,
 * and moves those the log can't take to `audit_outbox_rejected`, with why,
 * in one batch. IDs no longer in the outbox are ignored, so acknowledging
 * again changes nothing.
 */
export const ackAuditEvents = async (
  env: Env,
  appended: unknown,
  rejected: unknown = []
): Promise<void> => {
  const parsed = ackSchema.safeParse({ appended, rejected });
  if (!parsed.success) {
    throw connectErrors.create("connect.invalid");
  }
  const ids = [
    ...parsed.data.appended,
    ...parsed.data.rejected.map(({ id }) => id),
  ];
  if (ids.length === 0) {
    return;
  }
  const now = Date.now();
  await env.DB.batch([
    ...parsed.data.rejected.map(({ id, reason }) =>
      env.DB.prepare(
        "INSERT INTO audit_outbox_rejected (id, event, reason, created_at, rejected_at) SELECT id, event, ?, created_at, ? FROM audit_outbox WHERE id = ?"
      ).bind(reason, now, id)
    ),
    env.DB.prepare(
      `DELETE FROM audit_outbox WHERE id IN (${ids.map(() => "?").join(", ")})`
    ).bind(...ids),
  ]);
};
