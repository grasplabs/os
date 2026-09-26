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
import { isAdmin, roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { RpcTarget } from "capnweb";

import { actorIdsOf, auditLog } from "./audit-log.ts";
import type { SearchRange } from "./audit-log.ts";
import { actorOf, audit } from "./audit.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";

// Reading the audit log (threat model section 13, R16): admins search it,
// export it and verify its chain. Admins see all of it, so an export holds
// no more than a search shows them. Reads are recorded in the log itself
// before anything is returned, so a read that can't be recorded returns
// nothing. Grasp staff read it only through the admin role their staff
// access gives them, and are recorded as staff; they can't change retention
// or archive anything (that's deployment config and the cron trigger).

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
 * convenience columns can start with one: the event column starts with
 * `{`, so it is always exactly the stored event.
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
    event?.at,
    record.type,
    event?.action,
    event?.actor.type,
    // The most specific: a workflow run's, rather than its App's.
    event ? actorIdsOf(event.actor).at(-1) : undefined,
    event?.target?.type,
    event?.target?.id,
    event?.source,
    event?.requestId,
    record.verified,
    record.version,
    record.prevHash,
    record.hash,
    record.eventJson,
  ]);

/** A record as JSON: its event only as the stored bytes, `eventJson`. */
const jsonRecord = ({ event: _parsed, ...record }: AuditRecord): string =>
  JSON.stringify(record);

/**
 * An export, oldest first, as a stream that reads the log a page at a time
 * while the client takes it in: `json` or `csv`, per `AuditApi.export`.
 * Every read checks the session, role and flag again (`recheck`). It reads
 * the positions that matched when it began, up to the head then, so it
 * ends; if retention archives some it hasn't read yet, it stops.
 */
const exportStream = (
  env: Env,
  filter: ParsedAuditFilter,
  format: AuditExportFormat,
  recheck: () => Promise<void>
): ReadableStream<Uint8Array> => {
  const log = auditLog(env);
  const encoder = new TextEncoder();
  const unverified: number[] = [];
  let count = 0;
  let cursor: number | undefined;
  let range: SearchRange | undefined;

  /** The start of the export; fixes the positions it reads. */
  const header = async (): Promise<string> => {
    const chain = await log.head();
    const found = await log.range(filter);
    range = { low: found.low, high: Math.min(found.high, chain.seq) };
    return format === "csv"
      ? csvRow(csvColumns)
      : `{"exportedAt":${JSON.stringify(new Date().toISOString())},"filter":${JSON.stringify(filter)},"chain":${JSON.stringify(chain)},"records":[\n`;
  };

  /** The end of the export: for JSON, how its records checked out. */
  const footer = async (): Promise<string> => {
    if (format === "csv") {
      return "";
    }
    const recordCheck = {
      ok: unverified.length === 0,
      records: count,
      unverified,
    };
    const lastFullVerification = await log.lastFullVerification();
    return `\n],"recordCheck":${JSON.stringify(recordCheck)},"lastFullVerification":${JSON.stringify(lastFullVerification)}}\n`;
  };

  /** The next page of records as text, and whether it was the last. */
  const page = async (
    within: SearchRange
  ): Promise<{ text: string; done: boolean }> => {
    const found = await log.search({
      filter,
      order: "oldest",
      cursor,
      limit: exportPageSize,
      range: within,
    });
    if (found === null) {
      throw auditErrors.create("audit.export_interrupted");
    }
    if (count + found.records.length > auditExportMaxRecords) {
      throw auditErrors.create("audit.export_too_large");
    }
    const lines = found.records.map((record, index) => {
      if (!record.verified) {
        unverified.push(record.seq);
      }
      if (format === "csv") {
        return csvRecord(record);
      }
      return `${count + index === 0 ? "" : ",\n"}${jsonRecord(record)}`;
    });
    count += found.records.length;
    cursor = found.next ?? cursor;
    return { text: lines.join(""), done: found.next === null };
  };

  return new ReadableStream<Uint8Array>({
    pull: async (controller) => {
      try {
        await recheck();
        if (range === undefined) {
          controller.enqueue(encoder.encode(await header()));
          return;
        }
        // A page can match nothing: read on until there's something to send.
        let chunk = { text: "", done: false };
        while (chunk.text === "" && !chunk.done) {
          // Pages one after another, each from where the last stopped.
          // oxlint-disable-next-line no-await-in-loop
          chunk = await page(range);
        }
        const text = chunk.done ? `${chunk.text}${await footer()}` : chunk.text;
        if (text !== "") {
          controller.enqueue(encoder.encode(text));
        }
        if (chunk.done) {
          controller.close();
        }
      } catch (error) {
        controller.error(error);
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
      const page = (await auditLog(this.#env).search({
        filter: parsed,
        order: "newest",
        cursor,
        limit: searchPageSize,
      })) ?? { records: [], next: null };
      // Every search is recorded once, and so is every later page that
      // returns something: nothing is read without a record of it, and
      // paging through empty stretches doesn't fill the log.
      if (cursor === undefined || page.records.length > 0) {
        await recordRead(this.#env, person, "audit.searched", {
          ...filterDetail(parsed),
          ...(cursor === undefined ? {} : { before: cursor }),
          records: page.records.length,
        });
      }
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
      const recheck = async (): Promise<void> => {
        await withPerson(this.#check, requireAdmin);
      };
      return exportStream(this.#env, parsed, parsedFormat, recheck);
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
