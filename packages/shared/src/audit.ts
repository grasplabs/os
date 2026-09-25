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

/**
 * One audit event, sent by core and connect through the audit queue and
 * appended to the hash chain by the AuditLog object. Messages outlive a
 * release while they wait in the queue, so this schema only ever expands:
 * add optional fields, never rename or remove.
 */
export const auditEventSchema = z.object({
  /** Unique per event; the queue delivers at least once, the log dedupes. */
  id: z.uuid(),
  at: z.iso.datetime(),
  source: z.enum(["core", "connect"]),
  actor: auditActorSchema,
  /** Dotted verb, e.g. `connection.action.approved` or `model.call`. */
  action: z.string(),
  /** What was acted on, e.g. `{ type: "connection", id }`. */
  target: z.object({ type: z.string(), id: z.string() }).optional(),
  /** Ties the events of one request together. */
  requestId: z.string().optional(),
  /** Resources the action read from or was built from. */
  provenance: z.array(z.string()).default([]),
  detail: z.record(z.string(), z.json()).default({}),
});
export type AuditEvent = z.infer<typeof auditEventSchema>;
