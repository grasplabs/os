import {
  auditProvenanceMaxItems,
  createAuditEvent,
} from "@grasp-os/shared/audit";
import type { AuditActor, AuditDetailValue } from "@grasp-os/shared/audit";
import type { CapabilityClaims } from "@grasp-os/shared/capability";
import type { ConnectCall } from "@grasp-os/shared/connect";
import { errorFields, log } from "@grasp-os/shared/log";
import type { Authority } from "@grasp-os/shared/permissions";
import { asc, inArray } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { drizzle } from "drizzle-orm/d1";

import { auditOutbox } from "./db/schema.ts";

/** SHA-256 of `text`, in hex. */
const sha256 = async (text: string): Promise<string> =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
    ),
    (byte) => byte.toString(16).padStart(2, "0")
  ).join("");

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
 * with the same request ID.
 *
 * The events are stored in the outbox first, in one batch with `alongside`
 * (the call's stored answer, for a side effect), so a call's answer is
 * never kept without its events. They are sent right after; a send that
 * fails is logged, not passed on, and the cron trigger sends it again.
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
      : await sha256(call.idempotencyKey)
  );
  add("onBehalfOf", claims?.authority.onBehalfOf);
  add("mode", claims?.authority.mode);
  add("sideEffect", sideEffect);
  add("reason", reason);
  add("provenanceCount", provenance.length);

  const [first = [], ...rest] = provenanceGroups(provenance);
  const common = { actor, target, requestId: claims?.jti };
  const events = [
    createAuditEvent(
      { ...common, action: "connection.call", provenance: first, detail },
      "connect"
    ),
    ...rest.map((group) =>
      createAuditEvent(
        {
          ...common,
          action: "connection.call.provenance",
          provenance: group,
        },
        "connect"
      )
    ),
  ];

  const db = drizzle(env.DB);
  const createdAt = new Date();
  const [stored, ...alsoStored] = events.map((event) =>
    db
      .insert(auditOutbox)
      .values({ id: event.id, event: JSON.stringify(event), createdAt })
  );
  if (stored === undefined) {
    throw new Error("A call always has an event");
  }
  await db.batch([stored, ...alsoStored, ...alongside]);
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
