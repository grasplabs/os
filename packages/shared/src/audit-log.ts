import { z } from "zod";

import type { AuditActor, AuditEvent } from "./audit.ts";
import { defineErrorFamily } from "./errors.ts";
import { identifierMaxLength, identifierSchema } from "./ids.ts";

// Reading the audit log: search, export and chain verification, for admins.
// Only what the log holds now is searched: events past the deployment's
// retention are archived out of it (see core's src/audit-log.ts).

/**
 * What kind of thing an event records, for filtering: a read of data, an
 * action with an effect, a decision a person made, a change to permissions,
 * a model call, a change to configuration, or an update of the platform.
 */
export const auditEventTypeSchema = z.enum([
  "read",
  "action",
  "decision",
  "permission",
  "model_call",
  "config",
  "platform_update",
]);
export type AuditEventType = z.infer<typeof auditEventTypeSchema>;

/**
 * The type of each action. The first rule whose `action` is the event's
 * action, or a dotted prefix of it, gives the type (`knowledge` covers
 * `knowledge.document.saved`); a rule with `sideEffect` applies only to an
 * event whose `detail.sideEffect` is that value. An action no rule names has
 * no type: it is still found by every other filter. New actions add a rule.
 */
const typeRules: readonly {
  action: string;
  type: AuditEventType;
  sideEffect?: boolean;
}[] = [
  // A connector call that changed something at the provider, or only read.
  { action: "connection.call", sideEffect: true, type: "action" },
  { action: "connection.call", type: "read" },
  { action: "connection.connect", type: "config" },
  { action: "connection.disconnect", type: "config" },
  { action: "knowledge.search", type: "read" },
  { action: "knowledge.collection", type: "config" },
  { action: "knowledge", type: "action" },
  { action: "model", type: "model_call" },
  { action: "permission", type: "permission" },
  { action: "decision", type: "decision" },
  { action: "app", type: "config" },
  { action: "member", type: "config" },
  { action: "team", type: "config" },
  { action: "workflow.step", type: "action" },
  { action: "platform", type: "platform_update" },
  { action: "audit.searched", type: "read" },
  { action: "audit.exported", type: "read" },
];

/** Whether `action` is `prefix` or starts with it and a dot. */
export const actionHasPrefix = (action: string, prefix: string): boolean =>
  action === prefix || action.startsWith(`${prefix}.`);

/** The event's type, by the rules above; `null` when none names it. */
export const auditEventTypeOf = (
  event: Pick<AuditEvent, "action" | "detail">
): AuditEventType | null =>
  typeRules.find(
    ({ action, sideEffect }) =>
      actionHasPrefix(event.action, action) &&
      (sideEffect === undefined || event.detail.sideEffect === sideEffect)
  )?.type ?? null;

/** A dotted action or the start of one: `connection` or `connection.call`. */
const actionPrefixPattern = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/u;

/** An ISO 8601 time, as the log writes its own (`toISOString`), to compare. */
const timeSchema = z.iso
  .datetime({ offset: true })
  .transform((time) => new Date(time).toISOString());

const actorTypes = [
  "person",
  "agent",
  "app",
  "workflow",
  "staff",
  "system",
] as const satisfies readonly AuditActor["type"][];

/**
 * Which events to find; every field narrows it, and none finds them all.
 * Times are when the log received the event, `from` included and `to` not.
 */
export const auditFilterSchema = z
  .strictObject({
    from: timeSchema.optional(),
    to: timeSchema.optional(),
    actorType: z.enum(actorTypes).optional(),
    /**
     * A person's or staff member's user ID, an agent's ID, an App's ID (its
     * screens, server code and workflow runs) or a workflow run's ID.
     */
    actorId: identifierSchema.optional(),
    type: auditEventTypeSchema.optional(),
    /** The action or a dotted prefix of it: `connection` finds `connection.call`. */
    action: z
      .string()
      .max(identifierMaxLength)
      .regex(actionPrefixPattern)
      .optional(),
    targetType: identifierSchema.optional(),
    targetId: identifierSchema.optional(),
    /** A resource the event names in its provenance or as `detail.resource`. */
    resource: identifierSchema.optional(),
  })
  .default({});
export type AuditFilter = z.input<typeof auditFilterSchema>;
export type ParsedAuditFilter = z.output<typeof auditFilterSchema>;

/** A position in the chain, from 1; 0 is before the first entry. */
export const auditPositionSchema = z.int().nonnegative();

/** One event as the log holds it, with its place in the hash chain. */
export interface AuditRecord {
  /** Position in the chain, from 1. */
  seq: number;
  /** When the log received it (ISO 8601), set by the log. */
  receivedAt: string;
  event: AuditEvent;
  type: AuditEventType | null;
  /** The hash format, the hash of the entry before it, and its own hash. */
  version: number;
  prevHash: string;
  hash: string;
  /**
   * Whether its hash matches its content and it links to the entry before
   * it as the log holds that now.
   */
  verified: boolean;
}

/** A page of search results, newest first. */
export interface AuditPage {
  records: AuditRecord[];
  /**
   * Pass as `before` for the next, older page; `null` once nothing older is
   * left. A page may hold fewer records than the most, or none, and still
   * have a next one: each page reads a bounded stretch of the log.
   */
  next: number | null;
}

export const auditExportFormatSchema = z.enum(["json", "csv"]);
export type AuditExportFormat = z.infer<typeof auditExportFormatSchema>;

/** Why the chain breaks at a position: see core's src/audit-chain.ts. */
export type ChainBreak = "missing" | "unlinked" | "altered";

/**
 * One step of verifying the chain. The chain is checked a stretch at a
 * time: a step checks the entries after position `after`, from the hash
 * the log holds for that position, and says how far it got. Pass `through`
 * as the next step's `after` until `done`. A broken step names the first
 * position where the chain breaks; nothing after it is verified.
 */
export type ChainVerification =
  | { ok: true; through: number; head: string; done: boolean }
  | { ok: false; brokenAt: number; reason: ChainBreak };

/**
 * The audit log, over `/rpc`, for admins only. Every search and export is
 * itself recorded in the log, and so is every verification that finishes
 * or finds a break.
 */
export interface AuditApi {
  /** The events that match `filter`, newest first, from before `before`. */
  search: (filter?: AuditFilter, before?: number) => Promise<AuditPage>;
  /**
   * Every event that matches `filter`, oldest first, as a download.
   *
   * `json`: one document, `{ exportedAt, filter, chain, records,
   * verification }`, where `chain` is the log's head when the export began
   * and `verification` says whether every record verified. `csv`: a header
   * and a row per record; its `verified`, `prev_hash` and `hash` columns
   * are the verification. A cell that a spreadsheet would read as a formula
   * starts with `'`.
   *
   * Either way each record carries its event as the canonical JSON that was
   * hashed (RFC 8785), so anyone can recompute its hash, and compare it with
   * the live chain. An export stops with `audit.export_too_large` past
   * {@link auditExportMaxRecords}: narrow the filter.
   */
  export: (
    filter: AuditFilter | undefined,
    format: AuditExportFormat
  ) => Promise<ReadableStream<Uint8Array>>;
  /** One step of verifying the whole chain, archived stretches included. */
  verify: (after?: number) => Promise<ChainVerification>;
}

/** Most records one export holds. */
export const auditExportMaxRecords = 100_000;

/** Why a read of the audit log was refused. */
export const auditErrors = defineErrorFamily({
  "audit.invalid": "That isn't a valid audit log query.",
  "audit.export_too_large":
    "Too many events for one export. Narrow the time range or the filter.",
});
