import { z } from "zod";

import {
  appIdSchema,
  identifierMaxLength,
  identifierSchema,
  runIdSchema,
  workflowIdSchema,
} from "./ids.ts";
import { errorFields, log } from "./log.ts";
import type { Authority } from "./permissions.ts";
import type { Identity } from "./rpc.ts";

// The audit log is append-only and can't be purged, so every field is bounded
// to identifier size: an event can name things, never carry their content
// (prompts, message bodies, documents, tokens).

/** Longest string any field may hold: an identifier's. */
export { identifierMaxLength as auditIdentifierMaxLength } from "./ids.ts";

/** Most resources one event names as provenance: a large retrieval, no more. */
export const auditProvenanceMaxItems = 100;

/** Most `detail` members one event holds. */
export const auditDetailMaxKeys = 32;

/**
 * Largest event the AuditLog object appends, in bytes of canonical JSON. Room
 * for a full provenance of identifier-sized IDs (about 26 KB) next to the
 * other fields, so an event that names a large retrieval is always kept; the
 * per-field bounds together allow a little more, and this caps it well below
 * a pasted document.
 */
export const auditEventMaxBytes = 32 * 1024;

/** A `detail` key: a short camelCase or dotted name, never free text. */
const detailKeyPattern = /^[a-z][a-zA-Z0-9_.]{0,63}$/u;

/** A dotted verb such as `model.call`: at least two lowercase segments. */
const actionPattern = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/u;

/**
 * Who did something: a person, an agent acting for one, part of an App (its
 * screens or server code), a workflow run, the platform itself, or Grasp
 * staff (whose access is always logged).
 */
export const auditActorSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("person"), userId: identifierSchema }),
  z.object({
    type: z.literal("agent"),
    agentId: identifierSchema,
    onBehalfOf: identifierSchema,
  }),
  z.object({
    type: z.literal("app"),
    appId: appIdSchema,
    part: z.enum(["screen", "server"]),
  }),
  z.object({
    type: z.literal("workflow"),
    appId: appIdSchema,
    workflowId: workflowIdSchema,
    runId: runIdSchema,
  }),
  z.object({ type: z.literal("staff"), userId: identifierSchema }),
  z.object({ type: z.literal("system") }),
]);
export type AuditActor = z.infer<typeof auditActorSchema>;

/** A signed-in person as the audit log names them: staff apart. */
export const actorOf = ({
  userId,
  staff,
}: Pick<Identity, "userId" | "staff">): AuditActor =>
  staff ? { type: "staff", userId } : { type: "person", userId };

/** An App or agent, acting for a person, as the audit log names it. */
export const delegateActorOf = ({
  subject,
  onBehalfOf,
}: Authority): AuditActor =>
  subject.type === "agent"
    ? { type: "agent", agentId: subject.agentId, onBehalfOf }
    : { type: "app", appId: subject.appId, part: "server" };

/** The Workers that send audit events. */
export const auditSourceSchema = z.enum(["core", "connect"]);
export type AuditSource = z.infer<typeof auditSourceSchema>;

/**
 * A model call, as metadata only: never the prompt or the response. The
 * resources that fed the prompt go in the event's `provenance`.
 */
export const auditModelSchema = z.object({
  provider: identifierSchema,
  model: identifierSchema,
  inputTokens: z.int().nonnegative(),
  outputTokens: z.int().nonnegative(),
});
export type AuditModel = z.infer<typeof auditModelSchema>;

/** What an action cost, in an ISO 4217 currency such as `USD`. */
export const auditCostSchema = z.object({
  amount: z.number().nonnegative(),
  currency: z.string().regex(/^[A-Z]{3}$/u),
});
export type AuditCost = z.infer<typeof auditCostSchema>;

/** One `detail` value: a flat, identifier-sized scalar. */
export const auditDetailValueSchema = z.union([
  z.string().max(identifierMaxLength),
  z.number(),
  z.boolean(),
  z.null(),
]);
export type AuditDetailValue = z.infer<typeof auditDetailValueSchema>;

/**
 * One audit event, sent by core and connect through the audit queue and
 * appended to the hash chain by the AuditLog object. Messages outlive a
 * release while they wait in the queue, so this schema only ever expands:
 * add optional fields, never rename or remove, never tighten a bound.
 *
 * Events carry identifiers, never secrets or content: the log is
 * append-only, so nothing in it can be purged.
 */
export const auditEventSchema = z.object({
  /**
   * Unique per event; the queue delivers at least once, the log dedupes.
   * Lowercased, so a redelivery can't dodge the dedupe by changing case.
   */
  id: z.uuid().toLowerCase(),
  at: z.iso.datetime(),
  source: auditSourceSchema,
  actor: auditActorSchema,
  /** Dotted verb, e.g. `connection.action.approved` or `model.call`. */
  action: z.string().max(identifierMaxLength).regex(actionPattern),
  /** What was acted on, e.g. `{ type: "connection", id }`. */
  target: z.object({ type: identifierSchema, id: identifierSchema }).optional(),
  /** Ties the events of one request together. */
  requestId: identifierSchema.optional(),
  /** IDs of the resources the action read from or was built from. */
  provenance: z
    .array(identifierSchema)
    .max(auditProvenanceMaxItems)
    .default([]),
  /** Set on model calls. */
  model: auditModelSchema.optional(),
  /** Set where the action has a cost, such as a model call. */
  cost: auditCostSchema.optional(),
  /** Anything else worth recording, as identifiers and small values. */
  detail: z
    .record(z.string().regex(detailKeyPattern), auditDetailValueSchema)
    .refine((detail) => Object.keys(detail).length <= auditDetailMaxKeys, {
      message: `At most ${auditDetailMaxKeys} detail members`,
    })
    .default({}),
});
export type AuditEvent = z.infer<typeof auditEventSchema>;

/** What a caller records; the logger sets the ID, the time and the source. */
export type AuditEntry = Omit<
  z.input<typeof auditEventSchema>,
  "id" | "at" | "source"
>;

/** The audit queue's producer binding, as far as the logger needs it. */
export interface AuditQueue {
  send: (event: AuditEvent) => Promise<unknown>;
}

/** Records audit events for one Worker. */
export interface AuditLogger {
  log: (entry: AuditEntry) => Promise<AuditEvent>;
}

/** Whether an event's JSON is over {@link auditEventMaxBytes}. */
export const isAuditEventTooLarge = (json: string): boolean =>
  new TextEncoder().encode(json).byteLength > auditEventMaxBytes;

/**
 * An audit event ready to send: a new ID, the time and the Worker it comes
 * from, validated and within {@link auditEventMaxBytes}. For a sender that
 * stores the event first and sends it later, maybe more than once: the log
 * dedupes by ID.
 */
export const createAuditEvent = (
  entry: AuditEntry,
  source: AuditSource
): AuditEvent => {
  const event = auditEventSchema.parse({
    ...entry,
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    source,
  });
  // The log refuses it too; failing here keeps it out of the DLQ.
  // (Canonical JSON only reorders keys, so its size is the same.)
  if (isAuditEventTooLarge(JSON.stringify(event))) {
    throw new RangeError(
      `Audit event ${event.id} is over ${auditEventMaxBytes} bytes`
    );
  }
  return event;
};

/**
 * The audit logger for one Worker: `audit.log({ actor, action, ... })`. It
 * gives each event a new ID, the time and the Worker it comes from (never the
 * caller's), validates it and checks its size, so a malformed or oversized
 * event fails where it is made instead of in the dead letter queue, and
 * sends it to the audit queue. A send the queue refuses is logged and
 * thrown to the caller: an action whose event can't be recorded must not
 * look recorded.
 */
export const auditLogger = (
  queue: AuditQueue,
  source: AuditSource
): AuditLogger => ({
  log: async (entry) => {
    const event = createAuditEvent(entry, source);
    try {
      await queue.send(event);
    } catch (error) {
      log.error("audit.send_failed", {
        eventId: event.id,
        action: event.action,
        ...errorFields(error),
      });
      throw error;
    }
    return event;
  },
});
