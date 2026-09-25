import {
  auditDetailMaxKeys,
  auditEventSchema,
  auditIdentifierMaxLength,
  auditProvenanceMaxItems,
} from "@grasp-os/shared/audit";
import type { AuditEvent } from "@grasp-os/shared/audit";
import { env } from "cloudflare:workers";

import { auditLog } from "../src/audit-log.ts";

/** Every event in the deployment's log, oldest first. */
export const allEvents = async (): Promise<AuditEvent[]> => {
  const log = auditLog(env);
  const events: AuditEvent[] = [];
  let page = await log.entries();
  while (page.length > 0) {
    for (const { event } of page) {
      events.push(auditEventSchema.parse(JSON.parse(event)));
    }
    // Pages are read one after another.
    // oxlint-disable-next-line no-await-in-loop
    page = await log.entries(page.at(-1)?.seq);
  }
  return events;
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
