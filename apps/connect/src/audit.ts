import { auditLogger, auditProvenanceMaxItems } from "@grasp-os/shared/audit";
import type {
  AuditActor,
  AuditDetailValue,
  AuditLogger,
} from "@grasp-os/shared/audit";
import type { CapabilityClaims } from "@grasp-os/shared/capability";
import type { ConnectCall } from "@grasp-os/shared/connect";
import type { Authority } from "@grasp-os/shared/permissions";

/** Records audit events from connect. */
const audit = (env: Env): AuditLogger =>
  auditLogger(env.AUDIT_QUEUE, "connect");

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
 */
export const auditCall = async (
  env: Env,
  record: CallRecord
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
  add("idempotencyKey", call?.idempotencyKey);
  add("onBehalfOf", claims?.authority.onBehalfOf);
  add("mode", claims?.authority.mode);
  add("sideEffect", sideEffect);
  add("reason", reason);
  add("provenanceCount", provenance.length);

  const [first = [], ...rest] = provenanceGroups(provenance);
  const logger = audit(env);
  const common = { actor, target, requestId: claims?.jti };
  await logger.log({
    ...common,
    action: "connection.call",
    provenance: first,
    detail,
  });
  await Promise.all(
    rest.map(
      async (group) =>
        await logger.log({
          ...common,
          action: "connection.call.provenance",
          provenance: group,
        })
    )
  );
};
