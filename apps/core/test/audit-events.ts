import {
  auditDetailMaxKeys,
  auditEventSchema,
  auditIdentifierMaxLength,
  auditProvenanceMaxItems,
} from "@grasp-os/shared/audit";
import type { AuditEvent } from "@grasp-os/shared/audit";
import type {
  AuditApi,
  AuditFilter,
  ChainVerification,
} from "@grasp-os/shared/audit-log";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";

import { chainHash } from "../src/audit-chain.ts";
import type { AuditLog } from "../src/audit-log.ts";
import { auditLog } from "../src/audit-log.ts";
import { drainAuditOutboxes } from "../src/audit-outbox.ts";
import { AuditRpc } from "../src/audit-rpc.ts";
import { identify } from "../src/auth/identity.ts";

/** The log's events after position `after`, oldest first, with positions. */
const entriesAfter = async (
  after = 0
): Promise<{ seq: number; event: AuditEvent }[]> => {
  const log = auditLog(env);
  const entries: { seq: number; event: AuditEvent }[] = [];
  let page = await log.entries(after);
  while (page.length > 0) {
    for (const { seq, event } of page) {
      entries.push({ seq, event: auditEventSchema.parse(JSON.parse(event)) });
    }
    // Pages are read one after another.
    // oxlint-disable-next-line no-await-in-loop
    page = await log.entries(page.at(-1)?.seq);
  }
  return entries;
};

/**
 * Every event in the deployment's log, oldest first, as it is: without
 * draining the outboxes into it first.
 */
export const loggedEvents = async (): Promise<AuditEvent[]> => {
  const entries = await entriesAfter();
  return entries.map(({ event }) => event);
};

/**
 * Drains every outbox into the log, connect's included, as the cron trigger
 * does. A change drains its own outbox in the background, so a test that
 * reads the log drains first rather than wait for that.
 */
const drained = async (): Promise<void> => {
  await drainAuditOutboxes(env);
};

/** The events the deployment's log appended after position `after`. */
export const eventsAfter = async (after: number): Promise<AuditEvent[]> => {
  await drained();
  const entries = await entriesAfter(after);
  return entries.map(({ event }) => event);
};

/** Every event in the deployment's log, oldest first, outboxes drained. */
export const allEvents = async (): Promise<AuditEvent[]> => {
  await drained();
  return await loggedEvents();
};

/** The position of the log's latest event, outboxes drained: 0 while empty. */
export const logHead = async (): Promise<number> => {
  await drained();
  const entries = await entriesAfter();
  return entries.at(-1)?.seq ?? 0;
};

/**
 * The JSON export `session` asks for, read here in the Worker a chunk at a
 * time, as a client pulls it: a connection reads ahead, so this is how a
 * test changes something between two reads. The session is checked on
 * every read, as a connection checks it.
 */
export const exportReader = async (
  session: string,
  filter: AuditFilter
): Promise<ReadableStreamDefaultReader<Uint8Array>> => {
  const headers = new Headers({ cookie: session });
  const rpc = new AuditRpc(env, async () => {
    const identity = await identify(env, headers);
    if (!identity) {
      throw new Error("Session ended");
    }
    return identity;
  });
  const stream = await rpc.export(filter, "json");
  return stream.getReader();
};

const full = "r".repeat(auditIdentifierMaxLength);

/**
 * Provenance and detail each at their bounds: valid to the event schema, but
 * together over the log's size cap.
 */
export const oversizedFields = {
  provenance: Array.from({ length: auditProvenanceMaxItems }, () => full),
  detail: Object.fromEntries(
    Array.from({ length: auditDetailMaxKeys }, (_, i) => [`key${i}`, full])
  ),
};

/** Verifies the whole chain a step at a time, as an admin does. */
export const verifyAll = async (api: {
  audit: Pick<AuditApi, "verify">;
}): Promise<ChainVerification> => {
  let result = await api.audit.verify();
  while (result.ok && !result.done) {
    // Each step starts where the one before it stopped.
    // oxlint-disable-next-line no-await-in-loop
    result = await api.audit.verify(result.through);
  }
  return result;
};

/**
 * Appends a stored entry at the head as the log would have, with its hash,
 * holding `event` as its stored text: what an older release wrote, or
 * something that isn't an event at all.
 */
export const appendStored = async (
  log: DurableObjectStub<AuditLog>,
  event: string,
  id: string = crypto.randomUUID()
): Promise<void> => {
  await runInDurableObject(log, async (instance, state) => {
    const head = instance.head();
    const entry = {
      version: 1,
      seq: head.seq + 1,
      prevHash: head.hash,
      receivedAt: new Date().toISOString(),
      event,
    };
    state.storage.sql.exec(
      "INSERT INTO events (seq, id, version, received_at, event, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?)",
      entry.seq,
      id,
      entry.version,
      entry.receivedAt,
      event,
      entry.prevHash,
      await chainHash(entry)
    );
  });
};
