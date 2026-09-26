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
  // The log's own events, each named, so an `audit` action added later has
  // no type until it gets a rule: retention moving events out and purging
  // them, then reading the log.
  { action: "audit.archived", type: "action" },
  { action: "audit.purged", type: "action" },
  { action: "audit.searched", type: "read" },
  { action: "audit.exported", type: "read" },
  { action: "audit.verified", type: "read" },
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
  /**
   * The event exactly as it was stored and hashed: its canonical JSON
   * (RFC 8785). This, not `event`, is what the hash covers.
   */
  eventJson: string;
  /** The event, read with today's schema; `null` if what's stored isn't one. */
  event: AuditEvent | null;
  type: AuditEventType | null;
  /** The hash format, the hash of the entry before it, and its own hash. */
  version: number;
  prevHash: string;
  hash: string;
  /**
   * Whether it's an event, its hash matches `eventJson` and its other
   * fields, and it links to the entry before it as the log holds that now.
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
  | {
      ok: true;
      through: number;
      head: string;
      done: boolean;
      /**
       * Set when the step's stretch was purged by retention: the log
       * recorded the purge (`audit.purged`), and the stretch still links
       * the chain before it to the chain after it, but its entries are gone
       * and weren't checked.
       */
      purged?: true;
    }
  | { ok: false; brokenAt: number; reason: ChainBreak };

/**
 * The last pass that verified the whole chain, from its first position, in
 * unbroken steps: when it ran, and how it ended. `purgedThrough` is the
 * last position of the purged stretches it went across, if any: those it
 * found linked, but couldn't check.
 */
export type FullVerification = {
  startedAt: string;
  finishedAt: string;
  purgedThrough?: number;
} & (
  | { ok: true; through: number; head: string }
  | { ok: false; brokenAt: number; reason: ChainBreak }
);

/**
 * The audit log, over `/rpc`, for admins only. Every search that returns
 * records, every first page of a search, every export, and every
 * verification that finishes or finds a break is itself recorded in the log.
 */
export interface AuditApi {
  /** The events that match `filter`, newest first, from before `before`. */
  search: (filter?: AuditFilter, before?: number) => Promise<AuditPage>;
  /**
   * Every event that matches `filter`, oldest first, up to the head the log
   * had when the export began, as a download.
   *
   * `json`: one document, `{ exportedAt, filter, chain, records,
   * recordCheck, lastFullVerification }`. `chain` is the log's head when
   * the export began. `recordCheck` says whether each exported record
   * verified on its own and against the entry before it; that is not a
   * verification of the whole chain, which `lastFullVerification` (the last
   * full `verify` pass, or `null`) reports.
   *
   * `csv`: a header and a row per record; its `verified`, `prev_hash` and
   * `hash` columns are the record check. A cell that a spreadsheet would
   * read as a formula starts with `'`, so the CSV is for reading. The
   * `event` column is the stored event, which starts with `{`, except for a
   * stored row that isn't an event (`verified` false): it gets the `'` too
   * when it starts with a formula character. JSON is the exact form.
   *
   * Either way each record carries `eventJson`, its event byte for byte as
   * stored and hashed, so anyone can recompute its hash (see core's
   * src/audit-chain.ts) and compare it with the live chain. An export stops
   * with `audit.export_too_large` past {@link auditExportMaxRecords}, and
   * with `audit.export_interrupted` if retention archives events it hasn't
   * read yet.
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

/** Why a read of the audit log was refused or stopped. */
export const auditErrors = defineErrorFamily({
  "audit.invalid": "That isn't a valid audit log query.",
  "audit.export_too_large":
    "Too many events for one export. Narrow the time range or the filter.",
  "audit.export_interrupted":
    "Older events were archived while exporting. Export again.",
});
