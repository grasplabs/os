import type { AuditEvent } from "@grasp-os/shared/audit";
import { DurableObject } from "cloudflare:workers";

import { inJurisdiction } from "./durable-objects.ts";

/**
 * The client's audit log: one object per deployment, in the EU. It handles
 * one request at a time, so events are chained in the order they arrive:
 * append-only, hash-chained, deduplicated by event id.
 */
export class AuditLog extends DurableObject<Env> {
  // oxlint-disable-next-line class-methods-use-this, require-await -- stub until the hash chain lands
  async append(_events: AuditEvent[]): Promise<void> {
    throw new Error("AuditLog.append is not implemented yet");
  }
}

/** The deployment's single audit log. */
export const auditLog = (env: Env): DurableObjectStub<AuditLog> =>
  inJurisdiction(env, env.AUDIT_LOG).getByName("audit-log");
