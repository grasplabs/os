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
    | "connection.consent"
    | "connection.consent.read_tools",
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

/** Most characters of names one detail value holds: a detail value's limit. */
const namesPerValueMaxLength = 256;

/**
 * Most values of names one event holds: a detail has 32 members, and the
 * event needs a few for what the names are of.
 */
const nameValuesPerEvent = 24;

/**
 * Most events one list of names takes. A Composio allowlist has at most
 * 1,000 tools of at most 64 characters, three or more to a value, so 14
 * events name them all: with this, a consent never adds more than these
 * few inserts to its batch, and nothing is cut off while those limits
 * hold.
 */
export const namesEventsMax = 16;

/**
 * `names` for the audit log, whose detail values are small: joined with
 * commas into values of at most 256 characters, as `names1`, `names2`, …,
 * up to 24 to an event's detail, in at most `maxEvents` details. Names
 * that don't fit in those are `rest`, for the caller to record as a count
 * and a hash; so is a name too long for one value, and all after it.
 */
export const packedNames = (
  names: readonly string[],
  maxEvents = namesEventsMax
): { details: Record<string, string>[]; rest: string[] } => {
  const values: string[] = [];
  let taken = 0;
  for (const name of names) {
    const last = values.at(-1);
    const joined = last === undefined ? name : `${last},${name}`;
    if (last !== undefined && joined.length <= namesPerValueMaxLength) {
      values[values.length - 1] = joined;
    } else if (
      name.length <= namesPerValueMaxLength &&
      values.length < maxEvents * nameValuesPerEvent
    ) {
      values.push(name);
    } else {
      break;
    }
    taken += 1;
  }
  const details: Record<string, string>[] = [];
  for (const [index, value] of values.entries()) {
    if (index % nameValuesPerEvent === 0) {
      details.push({});
    }
    const detail = details.at(-1);
    if (detail !== undefined) {
      detail[`names${(index % nameValuesPerEvent) + 1}`] = value;
    }
  }
  return { details, rest: names.slice(taken) };
};

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
