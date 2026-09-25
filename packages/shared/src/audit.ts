import { z } from "zod";

import { appIdSchema, runIdSchema, workflowIdSchema } from "./ids.ts";

/**
 * Who did something: a person, an agent acting for one, part of an App (its
 * screens or server code), a workflow run, the platform itself, or Grasp
 * staff (whose access is always logged).
 */
export const auditActorSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("person"), userId: z.string() }),
  z.object({
    type: z.literal("agent"),
    agentId: z.string(),
    onBehalfOf: z.string(),
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
  z.object({ type: z.literal("staff"), userId: z.string() }),
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
  provider: z.string(),
  model: z.string(),
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

/** Longest string a detail value may hold: room for IDs, not for content. */
const detailValueMaxLength = 256;

/**
 * One `detail` value: a flat, identifier-sized scalar, so a prompt, a message
 * body or a document can't end up in the append-only log by accident.
 */
export const auditDetailValueSchema = z.union([
  z.string().max(detailValueMaxLength),
  z.number(),
  z.boolean(),
  z.null(),
]);
export type AuditDetailValue = z.infer<typeof auditDetailValueSchema>;

/**
 * One audit event, sent by core and connect through the audit queue and
 * appended to the hash chain by the AuditLog object. Messages outlive a
 * release while they wait in the queue, so this schema only ever expands:
 * add optional fields, never rename or remove.
 *
 * Events carry identifiers, never secrets or content (prompts, message
 * bodies, tokens): the log is append-only, so nothing in it can be purged.
 */
export const auditEventSchema = z.object({
  /** Unique per event; the queue delivers at least once, the log dedupes. */
  id: z.uuid(),
  at: z.iso.datetime(),
  source: auditSourceSchema,
  actor: auditActorSchema,
  /** Dotted verb, e.g. `connection.action.approved` or `model.call`. */
  action: z.string(),
  /** What was acted on, e.g. `{ type: "connection", id }`. */
  target: z.object({ type: z.string(), id: z.string() }).optional(),
  /** Ties the events of one request together. */
  requestId: z.string().optional(),
  /** IDs of the resources the action read from or was built from. */
  provenance: z.array(z.string()).default([]),
  /** Set on model calls. */
  model: auditModelSchema.optional(),
  /** Set where the action has a cost, such as a model call. */
  cost: auditCostSchema.optional(),
  /** Anything else worth recording, as identifiers and small values. */
  detail: z.record(z.string(), auditDetailValueSchema).default({}),
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

// Web Crypto is a global in every runtime this package runs in (Workers,
// browsers, Node); the package declares no runtime types of its own.
declare const crypto: { randomUUID: () => string };

/**
 * The audit logger for one Worker: `audit.log({ actor, action, ... })`. It
 * gives each event a new ID, the time and the Worker it comes from (never the
 * caller's), validates it, so a malformed event fails where it is made
 * instead of in the dead letter queue, and sends it to the audit queue.
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
    await queue.send(event);
    return event;
  },
});
