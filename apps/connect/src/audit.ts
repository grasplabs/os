import {
  auditProvenanceMaxItems,
  createAuditEvent,
} from "@grasp-os/shared/audit";
import type {
  AuditActor,
  AuditDetailValue,
  AuditEntry,
  AuditEvent,
} from "@grasp-os/shared/audit";
import type { CapabilityClaims } from "@grasp-os/shared/capability";
import type { ConnectCall } from "@grasp-os/shared/connect";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { errorFields, log } from "@grasp-os/shared/log";
import type { Authority } from "@grasp-os/shared/permissions";
import { asc, inArray, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { drizzle } from "drizzle-orm/d1";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";

import { auditOutbox } from "./db/schema.ts";

/** Most events one send takes from the outbox. */
const sendBatchSize = 100;

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
 * Sends events to the audit queue, then removes those sent from the
 * outbox. One that fails stays for the next send; one sent twice has the
 * same ID, and the log keeps it once.
 */
const send = async (
  env: Env,
  events: readonly { id: string; body: unknown }[]
): Promise<void> => {
  const results = await Promise.allSettled(
    events.map(async ({ id, body }) => {
      await env.AUDIT_QUEUE.send(body);
      return id;
    })
  );
  const sent: string[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") {
      sent.push(result.value);
    } else {
      log.error("audit.outbox.send_failed", errorFields(result.reason));
    }
  }
  if (sent.length > 0) {
    await drizzle(env.DB)
      .delete(auditOutbox)
      .where(inArray(auditOutbox.id, sent));
  }
};

/** Sends events just stored; one that fails waits for the cron trigger. */
const sendStored = async (
  env: Env,
  events: readonly AuditEvent[]
): Promise<void> => {
  try {
    await send(
      env,
      events.map((event) => ({ id: event.id, body: event }))
    );
  } catch (error) {
    log.error("audit.outbox.send_failed", errorFields(error));
  }
};

/**
 * Records events: stored in the outbox first, in one batch with
 * `alongside` (the change they record), so a change is never kept without
 * its events, then sent. A send that fails is logged, not passed on, and
 * the cron trigger sends it again.
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
  await sendStored(env, events);
};

/**
 * Records one event only if a row of `from` matches `where`, in the same
 * transaction as `writes`, which the same condition guards: the event is
 * kept exactly when its change is made, so a change that a concurrent one
 * made first isn't recorded twice. Whether it was.
 */
export const recordEventIf = async (
  env: Env,
  entry: AuditEntry,
  { from, where }: { from: SQLiteTable; where: SQL },
  writes: readonly BatchItem<"sqlite">[]
): Promise<boolean> => {
  const event = createAuditEvent(entry, "connect");
  const db = drizzle(env.DB);
  const insert = db
    .insert(auditOutbox)
    .select(
      db
        .select({
          id: sql<string>`${event.id}`.as("id"),
          event: sql<string>`${JSON.stringify(event)}`.as("event"),
          createdAt: sql<Date>`${Date.now()}`.as("created_at"),
        })
        .from(from)
        .where(where)
        .limit(1)
    )
    .returning({ id: auditOutbox.id });
  const [inserted] = await db.batch([insert, ...writes]);
  if (inserted.length === 0) {
    return false;
  }
  await sendStored(env, [event]);
  return true;
};

/**
 * How a call ended: done, answered from its stored result, refused before
 * anything was sent, failed without an effect, or failed after it may have
 * had one.
 */
export type CallOutcome = "ok" | "replayed" | "refused" | "failed" | "unknown";

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

const actorOf = (authority: Authority): AuditActor =>
  authority.subject.type === "agent"
    ? {
        type: "agent",
        agentId: authority.subject.agentId,
        onBehalfOf: authority.onBehalfOf,
      }
    : { type: "app", appId: authority.subject.appId, part: "server" };

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
    claims === undefined ? { type: "system" } : actorOf(claims.authority);
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
  add("sideEffect", sideEffect);
  add("reason", reason);
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
 * Sends the oldest events in the outbox to the audit queue: those whose
 * send failed when their call was made. The cron trigger calls it.
 */
export const sendAuditOutbox = async (env: Env): Promise<void> => {
  const rows = await drizzle(env.DB)
    .select()
    .from(auditOutbox)
    .orderBy(asc(auditOutbox.createdAt), asc(auditOutbox.id))
    .limit(sendBatchSize);
  await send(
    env,
    rows.map(({ id, event }) => ({ id, body: queueBody(event) }))
  );
};
