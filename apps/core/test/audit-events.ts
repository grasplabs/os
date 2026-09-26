import {
  auditDetailMaxKeys,
  auditEventSchema,
  auditIdentifierMaxLength,
  auditProvenanceMaxItems,
} from "@grasp-os/shared/audit";
import type { AuditEvent } from "@grasp-os/shared/audit";
import type { AuditFilter } from "@grasp-os/shared/audit-log";
import { env } from "cloudflare:workers";
import { vi } from "vite-plus/test";

import { auditLog } from "../src/audit-log.ts";
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

/** The events the deployment's log appended after position `after`. */
export const eventsAfter = async (after: number): Promise<AuditEvent[]> => {
  const entries = await entriesAfter(after);
  return entries.map(({ event }) => event);
};

/** Every event in the deployment's log, oldest first. */
export const allEvents = async (): Promise<AuditEvent[]> => {
  const entries = await entriesAfter();
  return entries.map(({ event }) => event);
};

/** The position of the log's latest event: 0 while it's empty. */
export const logHead = async (): Promise<number> => {
  const entries = await entriesAfter();
  return entries.at(-1)?.seq ?? 0;
};

/**
 * The events with these IDs as the audit log stored them, in log order,
 * once it has all of them: the queue delivers them a moment after they're
 * sent. Reads only what the log appended after position `after`.
 */
export const loggedEvents = async (
  ids: readonly string[],
  after = 0
): Promise<AuditEvent[]> => {
  if (ids.length === 0) {
    return [];
  }
  return await vi.waitFor(
    async () => {
      const entries = await entriesAfter(after);
      const logged = entries
        .map(({ event }) => event)
        .filter(({ id }) => ids.includes(id));
      if (logged.length < new Set(ids).size) {
        throw new Error(`${logged.length} of ${ids.length} events logged`);
      }
      return logged;
    },
    { timeout: 5000 }
  );
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
