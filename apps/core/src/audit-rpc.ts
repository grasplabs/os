import type { AuditDetailValue } from "@grasp-os/shared/audit";
import {
  auditErrors,
  auditExportFormatSchema,
  auditExportMaxRecords,
  auditFilterSchema,
  auditPositionSchema,
} from "@grasp-os/shared/audit-log";
import type {
  AuditApi,
  AuditExportFormat,
  AuditFilter,
  AuditPage,
  AuditRecord,
  ChainVerification,
  ParsedAuditFilter,
} from "@grasp-os/shared/audit-log";
import { canonicalJson } from "@grasp-os/shared/json";
import { isAdmin, roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { RpcTarget } from "capnweb";

import { actorIdsOf, auditLog } from "./audit-log.ts";
import type { SearchQuery } from "./audit-log.ts";
import { actorOf, audit } from "./audit.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";

// Reading the audit log (threat model section 13, R16): admins search it,
// export it and verify its chain. Admins see all of it, so an export holds
// no more than a search shows them. Every read is recorded in the log
// itself before anything is returned, so a read that can't be recorded
// returns nothing. Grasp staff read it only with the admin role their
// staff access gives them, and are recorded as staff.

/** Most records one page of a search holds. */
const searchPageSize = 100;

/** Records an export reads from the log at a time. */
const exportPageSize = 500;

/** Refuses anyone but an admin. */
const requireAdmin = (by: Identity): void => {
  if (!isAdmin(by.role)) {
    throw roleErrors.create("role.forbidden");
  }
};

const parseFilter = (filter: unknown): ParsedAuditFilter =>
  auditErrors.parse("audit.invalid", auditFilterSchema, filter);

const parsePosition = (position: unknown): number | undefined =>
  position === undefined
    ? undefined
    : auditErrors.parse("audit.invalid", auditPositionSchema, position);

/**
 * A filter as audit detail: each field it sets, an identifier or a time, as
 * `filter.<field>`, so a search for a resource isn't itself found as an
 * event about that resource (`detail.resource`).
 */
const filterDetail = (
  filter: ParsedAuditFilter
): Record<string, AuditDetailValue> =>
  Object.fromEntries(
    Object.entries(filter)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [`filter.${key}`, value])
  );

/** Records that `by` read the log, before they get what they read. */
const recordRead = async (
  env: Env,
  by: Identity,
  action: "audit.searched" | "audit.exported" | "audit.verified",
  detail: Record<string, AuditDetailValue>
): Promise<void> => {
  await audit(env).log({ actor: actorOf(by), action, detail });
};

/**
 * A spreadsheet reads a cell that starts with one of these as a formula,
 * so such a cell is written with a `'` in front (CSV injection). Only
 * convenience columns can start with one: an event's JSON starts with `{`.
 */
const formulaStart = /^[=+\-@\t\r]/u;
const csvQuoted = /[",\r\n]/u;

/** One CSV cell (RFC 4180), safe to open in a spreadsheet. */
const csvCell = (value: string | number | boolean | null | undefined) => {
  const text = value === null || value === undefined ? "" : String(value);
  const safe = formulaStart.test(text) ? `'${text}` : text;
  return csvQuoted.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
};

const csvColumns = [
  "seq",
  "received_at",
  "at",
  "type",
  "action",
  "actor_type",
  "actor_id",
  "target_type",
  "target_id",
  "source",
  "request_id",
  "verified",
  "version",
  "prev_hash",
  "hash",
  "event",
];

const csvRow = (cells: readonly Parameters<typeof csvCell>[0][]): string =>
  `${cells.map((cell) => csvCell(cell)).join(",")}\r\n`;

const csvRecord = ({ event, ...record }: AuditRecord): string =>
  csvRow([
    record.seq,
    record.receivedAt,
    event.at,
    record.type,
    event.action,
    event.actor.type,
    // The most specific: a workflow run's, rather than its App's.
    actorIdsOf(event.actor).at(-1),
    event.target?.type,
    event.target?.id,
    event.source,
    event.requestId,
    record.verified,
    record.version,
    record.prevHash,
    record.hash,
    canonicalJson(event),
  ]);

/** A record as JSON, its event as the canonical JSON that was hashed. */
const jsonRecord = ({ event, ...record }: AuditRecord): string =>
  `${JSON.stringify(record).slice(0, -1)},"event":${canonicalJson(event)}}`;

/**
 * An export, oldest first, as a stream that reads the log a page at a time
 * while the client takes it in: `json` or `csv`, per `AuditApi.export`.
 */
const exportStream = (
  env: Env,
  filter: ParsedAuditFilter,
  format: AuditExportFormat
): ReadableStream<Uint8Array> => {
  const log = auditLog(env);
  const encoder = new TextEncoder();
  const unverified: number[] = [];
  let count = 0;
  let cursor: number | undefined;
  let started = false;
  return new ReadableStream<Uint8Array>({
    pull: async (controller) => {
      if (!started) {
        started = true;
        const chain = await log.head();
        controller.enqueue(
          encoder.encode(
            format === "csv"
              ? csvRow(csvColumns)
              : `{"exportedAt":${JSON.stringify(new Date().toISOString())},"filter":${JSON.stringify(filter)},"chain":${JSON.stringify(chain)},"records":[\n`
          )
        );
        return;
      }
      const query: SearchQuery = {
        filter,
        order: "oldest",
        cursor,
        limit: exportPageSize,
      };
      const { records, next } = await log.search(query);
      if (count + records.length > auditExportMaxRecords) {
        controller.error(auditErrors.create("audit.export_too_large"));
        return;
      }
      const lines = records.map((record, index) => {
        if (!record.verified) {
          unverified.push(record.seq);
        }
        if (format === "csv") {
          return csvRecord(record);
        }
        return `${count + index === 0 ? "" : ",\n"}${jsonRecord(record)}`;
      });
      count += records.length;
      if (next === null && format === "json") {
        const verification = {
          ok: unverified.length === 0,
          records: count,
          unverified,
        };
        lines.push(`\n],"verification":${JSON.stringify(verification)}}\n`);
      }
      if (lines.length > 0) {
        controller.enqueue(encoder.encode(lines.join("")));
      }
      if (next === null) {
        controller.close();
      } else {
        cursor = next;
      }
    },
  });
};

/**
 * The audit log over `/rpc`, for admins. Built once per session with core's
 * env and a session check; every method checks the session first.
 */
export class AuditRpc extends RpcTarget implements AuditApi {
  readonly #env: Env;
  readonly #check: SessionCheck;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
  }

  async search(filter?: AuditFilter, before?: number): Promise<AuditPage> {
    return await withPerson(this.#check, async (person) => {
      requireAdmin(person);
      const parsed = parseFilter(filter);
      const cursor = parsePosition(before);
      const page = await auditLog(this.#env).search({
        filter: parsed,
        order: "newest",
        cursor,
        limit: searchPageSize,
      });
      await recordRead(this.#env, person, "audit.searched", {
        ...filterDetail(parsed),
        ...(cursor === undefined ? {} : { before: cursor }),
        records: page.records.length,
      });
      return page;
    });
  }

  async export(
    filter: AuditFilter | undefined,
    format: AuditExportFormat
  ): Promise<ReadableStream<Uint8Array>> {
    return await withPerson(this.#check, async (person) => {
      requireAdmin(person);
      const parsed = parseFilter(filter);
      const parsedFormat = auditErrors.parse(
        "audit.invalid",
        auditExportFormatSchema,
        format
      );
      await recordRead(this.#env, person, "audit.exported", {
        ...filterDetail(parsed),
        format: parsedFormat,
      });
      return exportStream(this.#env, parsed, parsedFormat);
    });
  }

  async verify(after?: number): Promise<ChainVerification> {
    return await withPerson(this.#check, async (person) => {
      requireAdmin(person);
      const from = parsePosition(after) ?? 0;
      const result = await auditLog(this.#env).verify(from);
      // A pass that got to the head, or found a break, is recorded; the
      // steps along the way aren't.
      if (!result.ok || result.done) {
        await recordRead(this.#env, person, "audit.verified", {
          after: from,
          ok: result.ok,
          ...(result.ok
            ? { through: result.through, head: result.head }
            : { brokenAt: result.brokenAt, reason: result.reason }),
        });
      }
      return result;
    });
  }
}
