import { actorOf } from "@grasp-os/shared/audit";
import type { AuditDetailValue, AuditEntry } from "@grasp-os/shared/audit";
import { connectionErrors } from "@grasp-os/shared/connect";
import type { ConnectionPerson } from "@grasp-os/shared/connect";
import { errorFields, log } from "@grasp-os/shared/log";

import { recordEvents } from "./audit.ts";

// Connecting, reconnecting, consenting and disconnecting, as the audit log
// records them:
// for OAuth flows (src/oauth.ts) and Composio's (src/composio-connections.ts).

/**
 * One connect, reconnect, disconnect or consent, for the audit log: IDs, never
 * tokens. Its actor is the person core named, or core itself (`null`).
 */
export const connectionEvent = (
  person: ConnectionPerson | null,
  action:
    | "connection.connect"
    | "connection.reconnected"
    | "connection.disconnect"
    | "connection.consent",
  connectionId: string | undefined,
  detail: Record<string, AuditDetailValue>
): AuditEntry => ({
  actor: person === null ? { type: "system" } : actorOf(person),
  action,
  target:
    connectionId === undefined
      ? undefined
      : { type: "connection", id: connectionId },
  detail,
});

/** Records a refused or failed attempt; if that fails too, it is logged. */
export const auditRefusal = async (
  env: Env,
  person: ConnectionPerson,
  action: "connection.connect" | "connection.disconnect",
  detail: Record<string, AuditDetailValue>,
  connectionId?: string
): Promise<void> => {
  try {
    await recordEvents(env, [
      connectionEvent(person, action, connectionId, detail),
    ]);
  } catch (error) {
    log.error("audit.record_failed", errorFields(error));
  }
};

/**
 * Grasp staff, in a staff window, can't connect anything: accounts belong
 * to the client's people and admins.
 */
export const refuseStaff = async (
  env: Env,
  person: ConnectionPerson,
  detail: Record<string, AuditDetailValue>
): Promise<void> => {
  if (!person.staff) {
    return;
  }
  await auditRefusal(env, person, "connection.connect", {
    ...detail,
    outcome: "refused",
    reason: "connection.staff_not_allowed",
  });
  throw connectionErrors.create("connection.staff_not_allowed");
};
