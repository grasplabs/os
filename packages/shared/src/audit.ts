import { z } from "zod";

import { appIdSchema, runIdSchema, workflowIdSchema } from "./ids.ts";

// The audit log is append-only and can't be purged, so every field is bounded
// to identifier size: an event can name things, never carry their content
// (prompts, message bodies, documents, tokens).

/**
 * Longest string any field may hold: room for provider IDs (Microsoft Graph
 * item IDs run past 100 characters), not for content.
 */
export const auditIdentifierMaxLength = 256;

/** Most resources one event names as provenance: a large retrieval, no more. */
export const auditProvenanceMaxItems = 100;

/** Most `detail` members one event holds. */
export const auditDetailMaxKeys = 32;

/**
 * Largest event the AuditLog object appends, in bytes of canonical JSON. The
 * per-field bounds allow more in theory; this caps the whole event at a few
 * KB, well above a real one and well below a pasted document.
 */
export const auditEventMaxBytes = 8192;

/** A `detail` key: a short camelCase or dotted name, never free text. */
const detailKeyPattern = /^[a-z][a-zA-Z0-9_.]{0,63}$/u;

/** A dotted verb such as `model.call`: at least two lowercase segments. */
const actionPattern = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/u;

/** An identifier: non-empty and at most identifier-sized. */
const identifier = () => z.string().min(1).max(auditIdentifierMaxLength);

/**
 * Who did something: a person, an agent acting for one, part of an App (its
 * screens or server code), a workflow run, the platform itself, or Grasp
 * staff (whose access is always logged).
 */
export const auditActorSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("person"), userId: identifier() }),
  z.object({
    type: z.literal("agent"),
    agentId: identifier(),
    onBehalfOf: identifier(),
  }),
  z.object({
    type: z.literal("app"),
    appId: identifier().pipe(appIdSchema),
    part: z.enum(["screen", "server"]),
  }),
  z.object({
    type: z.literal("workflow"),
    appId: identifier().pipe(appIdSchema),
    workflowId: identifier().pipe(workflowIdSchema),
    runId: identifier().pipe(runIdSchema),
  }),
  z.object({ type: z.literal("staff"), userId: identifier() }),
  z.object({ type: z.literal("system") }),
]);
export type AuditActor = z.infer<typeof auditActorSchema>;

/** The Workers that send audit events. */
export const auditSourceSchema = z.enum(["core", "connect"]);
export type AuditSource = z.infer<typeof auditSourceSchema>;

/**
 * A model call, as metadata only: never the prompt or the response. The
 * resources that fed the prompt go in the event's `provenance`.
 */
export const auditModelSchema = z.object({
  provider: identifier(),
  model: identifier(),
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
  z.string().max(auditIdentifierMaxLength),
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
  action: z.string().max(auditIdentifierMaxLength).regex(actionPattern),
  /** What was acted on, e.g. `{ type: "connection", id }`. */
  target: z.object({ type: identifier(), id: identifier() }).optional(),
  /** Ties the events of one request together. */
  requestId: identifier().optional(),
  /** IDs of the resources the action read from or was built from. */
  provenance: z.array(identifier()).max(auditProvenanceMaxItems).default([]),
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

// Web Crypto and the Encoding API are globals in every runtime this package
// runs in (Workers, browsers, Node); the package declares no runtime types.
declare const crypto: { randomUUID: () => string };
declare const TextEncoder: new () => {
  encode: (input: string) => Uint8Array;
};

/** Whether an event's JSON is over {@link auditEventMaxBytes}. */
export const isAuditEventTooLarge = (json: string): boolean =>
  new TextEncoder().encode(json).byteLength > auditEventMaxBytes;

/**
 * The audit logger for one Worker: `audit.log({ actor, action, ... })`. It
 * gives each event a new ID, the time and the Worker it comes from (never the
 * caller's), validates it and checks its size, so a malformed or oversized
 * event fails where it is made instead of in the dead letter queue, and
 * sends it to the audit queue.
 */
export const auditLogger = (
  queue: AuditQueue,
  source: AuditSource
): AuditLogger => ({
  log: async (entry) => {
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
    await queue.send(event);
    return event;
  },
});
