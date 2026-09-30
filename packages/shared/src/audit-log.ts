import { z } from "zod";

import type { AuditActor, AuditEvent } from "./audit.ts";
import { defineErrorFamily } from "./errors.ts";
import { identifierMaxLength, identifierSchema } from "./ids.ts";

// Reading the audit log: search, export and chain verification, for admins.
// Only what the log holds now is searched: events past the deployment's
// retention are archived out of it (see core's src/audit-log.ts).

/**
 * What kind of thing an event records, for filtering: a read of data, an
 * action with an effect, a decision put to a person or made by one, a
 * change to permissions, a model call, a change to configuration, or an
 * update of the platform.
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
 * `knowledge.document.saved`); a rule with `sideEffect` or `access` applies
 * only to an event whose `detail.sideEffect` or `detail.access` is that
 * value. An action no rule names has no type: it is still found by every
 * other filter. New actions add a rule.
 *
 * Actions are stored in the hash-chained log, so they are a data contract:
 * never rename one, add a rule instead. A new action is `noun.verbed`, in
 * dotted segments from the general to the specific (`knowledge.document.
 * saved`, `workflow.run.started`), so a prefix finds its family. Older
 * actions that don't follow it (`connection.call`, `connection.offer_changed`)
 * keep their names.
 */
const typeRules: readonly {
  action: string;
  type: AuditEventType;
  sideEffect?: boolean;
  access?: "read" | "write";
}[] = [
  // A connector call that changed something at the provider, or only read.
  { action: "connection.call", sideEffect: true, type: "action" },
  { action: "connection.call", type: "read" },
  { action: "connection.connect", type: "config" },
  { action: "connection.disconnect", type: "config" },
  // An admin consenting to Composio holding a connection's tokens.
  { action: "connection.consent", type: "config" },
  // An admin changing which connectors are offered.
  { action: "connection.offer_changed", type: "config" },
  // A connection's tokens stopped working: it needs signing in again.
  { action: "connection.needs_reauth", type: "config" },
  // Connect reading what changed at a connection for workflows' event
  // triggers, dropping an event it couldn't deliver, and starting or
  // stopping listening there, being refused it, or failing to read it.
  { action: "connection.events.read", type: "read" },
  // An event dropped, after its last try or because core can't take it: a
  // workflow it would have started didn't start.
  { action: "connection.events.dropped", type: "action" },
  { action: "connection.events", type: "config" },
  // A held action dropped because nobody can confirm it any more, then a
  // person confirming or declining one (or being refused that).
  { action: "connection.action.dropped", type: "action" },
  { action: "connection.action", type: "decision" },
  { action: "knowledge.search", type: "read" },
  { action: "knowledge.read", type: "read" },
  // Knowledge usage signals: the daily computation, an owner reading those
  // of their collections, and dismissing one.
  { action: "knowledge.signals.computed", type: "action" },
  { action: "knowledge.signals.read", type: "read" },
  { action: "knowledge.signal.dismissed", type: "decision" },
  { action: "knowledge.collection", type: "config" },
  // An owner deciding on a proposed change to a shared memory file.
  { action: "knowledge.proposal.approved", type: "decision" },
  { action: "knowledge.proposal.declined", type: "decision" },
  { action: "knowledge", type: "action" },
  // A person making, renaming or deleting one of their chats.
  { action: "chat", type: "action" },
  // A call of the chat agent's code that nothing else records: a listing,
  // a catalog or a run's status, or a call refused before it did anything.
  // Its calls that can change something (a connector call, an App's
  // export) record themselves under their own actions.
  { action: "agent.call", type: "read" },
  // A spending budget crossing its alert threshold or running out: filed
  // with the budgets it belongs to, not as a model call.
  { action: "model.budget", type: "config" },
  { action: "model", type: "model_call" },
  { action: "permission", type: "permission" },
  // A chat or run whose context read restricted sources, and so is held to
  // them, and a staff member signing in to the deployment.
  { action: "context.restricted", type: "permission" },
  { action: "staff.session", type: "permission" },
  // A call of another App's export, by the calling App (`app.call`) and
  // as the called App records it (`app.called`): a read for an export
  // that only reads, and an action for one that writes, or one refused
  // before its access was known.
  { action: "app.call", access: "read", type: "read" },
  { action: "app.call", type: "action" },
  { action: "app.called", access: "read", type: "read" },
  { action: "app.called", type: "action" },
  { action: "app", type: "config" },
  { action: "member", type: "config" },
  { action: "team", type: "config" },
  // A decision a run put to people: opened, asked, answered, timed out.
  { action: "workflow.decision", type: "decision" },
  // A run reading an attachment of a message its email trigger kept.
  { action: "workflow.email.read", type: "read" },
  { action: "workflow.run", type: "action" },
  { action: "workflow.step", type: "action" },
  { action: "workflow.param", type: "config" },
  { action: "platform", type: "platform_update" },
  // Improvement signals: the daily computation, and reading them.
  { action: "improvement.signals.computed", type: "action" },
  { action: "improvement.signals.read", type: "read" },
  // An App reading a measure the platform publishes of an App's runs
  // (src/statistics.ts): counts and sums only.
  { action: "statistics.read", type: "read" },
  // Guest chats (core's src/guests.ts): an App inviting someone, revoking
  // the link, and reading back what they wrote; the guest opening the
  // chat, sending a message and finishing it.
  { action: "guest.read", type: "read" },
  { action: "guest.invited", type: "permission" },
  { action: "guest.revoked", type: "permission" },
  { action: "guest", type: "action" },
  // The log's own events, each named, so an `audit` action added later has
  // no type until it gets a rule: retention moving events out and purging
  // them, gaps (outbox rows the log can't take, moved aside), then reading
  // the log.
  { action: "audit.archived", type: "action" },
  { action: "audit.purged", type: "action" },
  { action: "audit.gap", type: "action" },
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
    ({ action, sideEffect, access }) =>
      actionHasPrefix(event.action, action) &&
      (sideEffect === undefined || event.detail.sideEffect === sideEffect) &&
      (access === undefined || event.detail.access === access)
  )?.type ?? null;

/** A dotted action or the start of one: `connection` or `connection.call`. */
export const auditActionPrefixSchema = z
  .string()
  .max(identifierMaxLength)
  .regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/u);

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
  "guest",
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
    action: auditActionPrefixSchema.optional(),
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

/**
 * Where a browser downloads an export: `GET` with `format` (`json` or
 * `csv`) and the filter's fields as query parameters, on the admin's
 * session cookie. The same export as `AuditApi.export`, written to disk as
 * it arrives.
 */
export const auditExportPath = "/api/audit/export";

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
