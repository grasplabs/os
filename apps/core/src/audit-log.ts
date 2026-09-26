import {
  auditEventMaxBytes,
  auditEventSchema,
  isAuditEventTooLarge,
} from "@grasp-os/shared/audit";
import type { AuditActor, AuditEvent } from "@grasp-os/shared/audit";
import { actionHasPrefix, auditEventTypeOf } from "@grasp-os/shared/audit-log";
import type {
  AuditPage,
  AuditRecord,
  ChainVerification,
  ParsedAuditFilter,
} from "@grasp-os/shared/audit-log";
import { canonicalJson } from "@grasp-os/shared/json";
import { log } from "@grasp-os/shared/log";
import { DurableObject } from "cloudflare:workers";
import { asc, between, desc, eq, gt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { z } from "zod";

import {
  chainHash,
  chainOrigin,
  chainVersion,
  hashMatches,
  verifyChain,
} from "./audit-chain.ts";
import type {
  ChainEntry,
  ChainLink,
  StretchVerification,
} from "./audit-chain.ts";
import migrations from "./db/audit-log/migrations/migrations.js";
import { archives, events } from "./db/audit-log/schema.ts";
import { migrateOnWake } from "./db/migrate.ts";
import { inJurisdiction } from "./durable-objects.ts";
import { jsonVar } from "./json-var.ts";

/** How many entries one read returns at most. */
const pageSize = 500;

/** Most entries one step of verification checks. */
const verifyStretch = 10_000;

/**
 * Most entries one search reads, matching or not, so every call is bounded
 * however few entries match: a search that finds fewer carries on from
 * where it stopped on the next call.
 */
const searchScanMax = 5000;

/** Most entries one archive moves out: a few MB, well within memory. */
export const archiveStretch = 500;

/**
 * What an append did: events added to the chain, and those it already had.
 * A conflict is a duplicate whose content differs from the stored event: a
 * bug or a forgery, never a plain redelivery.
 */
export interface AppendResult {
  appended: number;
  duplicates: number;
  conflicts: number;
}

/** A stretch one archive moved out: the positions `from` to `through`. */
export interface ArchivedStretch {
  from: number;
  through: number;
  /** The object in the AUDIT_ARCHIVE bucket that holds it. */
  key: string;
}

/** A search: which events, in which order, from which position on. */
export interface SearchQuery {
  filter: ParsedAuditFilter;
  order: "newest" | "oldest";
  /** The position to continue from, not included. */
  cursor?: number;
  limit: number;
}

/** An event ready to chain: its ID and canonical JSON. */
interface Incoming {
  id: string;
  event: string;
}

/** Validates an event and gives its canonical JSON, within the size cap. */
const prepare = (input: AuditEvent): Incoming => {
  // The object is the chain's last line of defence: it doesn't trust its
  // caller to have validated, and keeps only the fields the schema knows.
  const parsed = auditEventSchema.parse(input);
  const event = canonicalJson(parsed);
  if (isAuditEventTooLarge(event)) {
    throw new RangeError(
      `Audit event ${parsed.id} is over ${auditEventMaxBytes} bytes`
    );
  }
  return { id: parsed.id, event };
};

/**
 * The IDs an actor is found by: the person's, staff member's or agent's,
 * the App's (for its screens, server code and workflow runs alike) and the
 * workflow run's.
 */
export const actorIdsOf = (actor: AuditActor): string[] => {
  switch (actor.type) {
    case "person":
    case "staff": {
      return [actor.userId];
    }
    case "agent": {
      return [actor.agentId];
    }
    case "app": {
      return [actor.appId];
    }
    case "workflow": {
      return [actor.appId, actor.runId];
    }
    case "system": {
      return [];
    }
    default: {
      return [];
    }
  }
};

/** Whether an event is the actor, action and type the filter asks for. */
const matchesWho = (filter: ParsedAuditFilter, event: AuditEvent): boolean =>
  (filter.actorType === undefined || event.actor.type === filter.actorType) &&
  (filter.actorId === undefined ||
    actorIdsOf(event.actor).includes(filter.actorId)) &&
  (filter.action === undefined ||
    actionHasPrefix(event.action, filter.action)) &&
  (filter.type === undefined || auditEventTypeOf(event) === filter.type);

/** Whether an event is on the target and resource the filter asks for. */
const matchesWhat = (filter: ParsedAuditFilter, event: AuditEvent): boolean =>
  (filter.targetType === undefined ||
    event.target?.type === filter.targetType) &&
  (filter.targetId === undefined || event.target?.id === filter.targetId) &&
  (filter.resource === undefined ||
    event.provenance.includes(filter.resource) ||
    event.detail.resource === filter.resource);

/** Whether an event the log received at `receivedAt` matches the filter. */
const matches = (
  filter: ParsedAuditFilter,
  receivedAt: string,
  event: AuditEvent
): boolean =>
  (filter.from === undefined || receivedAt >= filter.from) &&
  (filter.to === undefined || receivedAt < filter.to) &&
  matchesWho(filter, event) &&
  matchesWhat(filter, event);

/** A stored event, or `undefined` if what's stored isn't one. */
const parseStored = (event: string): AuditEvent | undefined => {
  const parsed = auditEventSchema.safeParse(jsonVar(event));
  return parsed.success ? parsed.data : undefined;
};

/** One line of an archived stretch: an entry as the log held it. */
const archivedEntrySchema = z.strictObject({
  version: z.int(),
  seq: z.int(),
  prevHash: z.string(),
  receivedAt: z.string(),
  event: z.string(),
  hash: z.string(),
});

/** Where a stretch of entries is archived: sorts by position. */
const archiveKey = (from: number, through: number): string =>
  `audit-log/${String(from).padStart(12, "0")}-${String(through).padStart(12, "0")}.ndjson`;

/** A row of `events` as raw SQL reads it, with the entry's field names. */
type EntryRow = { [Key in keyof ChainEntry]: ChainEntry[Key] };

const entryColumns =
  "seq, version, prev_hash AS prevHash, received_at AS receivedAt, event, hash";

/**
 * The client's audit log: one object per deployment, in the EU. Appends
 * events in the order they arrive, each linked to the one before it by a
 * hash chain (src/audit-chain.ts), and appends each event ID only once.
 * Nothing updates an entry.
 *
 * Retention moves the oldest entries out, a stretch at a time, to the
 * AUDIT_ARCHIVE bucket (in the EU), as they were stored, and keeps a record
 * of each stretch (`archives`): its positions, the hash before it and its
 * last hash. The chain carries on from there, so it stays one chain that
 * can be verified from its first entry to its last, archived stretches
 * included. The log searches only what it holds now, and dedupes only
 * against that: an event redelivered after its first delivery was archived
 * would be appended again (the queue gives up long before retention).
 */
export class AuditLog extends DurableObject<Env> {
  readonly #db = drizzle(this.ctx.storage);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    migrateOnWake(ctx, migrations);
  }

  /**
   * Appends events in the given order, skipping any whose ID the log already
   * has. Validates every event first, so one malformed or oversized event
   * appends nothing from its batch.
   */
  async append(batch: readonly AuditEvent[]): Promise<AppendResult> {
    const incoming = batch.map((event) => prepare(event));
    // Hashing is async, so another append could otherwise run between
    // reading the head and writing after it, and fork the chain.
    return await this.ctx.blockConcurrencyWhile(async () => {
      const receivedAt = new Date().toISOString();
      const head = this.head();
      // Every event this call has seen, by ID: stored ones and new ones.
      const known = new Map<string, string | undefined>();
      const entries: (ChainEntry & { id: string })[] = [];
      let conflicts = 0;
      let prevHash = head.hash;
      let { seq } = head;
      for (const { id, event } of incoming) {
        if (!known.has(id)) {
          known.set(id, this.#stored(id));
        }
        const existing = known.get(id);
        if (existing === undefined) {
          known.set(id, event);
          seq += 1;
          const link = {
            version: chainVersion,
            seq,
            prevHash,
            receivedAt,
            event,
          };
          // Each hash needs the one before it.
          // oxlint-disable-next-line no-await-in-loop
          prevHash = await chainHash(link);
          entries.push({ ...link, id, hash: prevHash });
        } else if (existing !== event) {
          conflicts += 1;
          log.warn("audit.conflicting_duplicate", { eventId: id });
        }
      }
      this.#db.transaction((tx) => {
        for (const entry of entries) {
          tx.insert(events).values(entry).run();
        }
      });
      return {
        appended: entries.length,
        duplicates: incoming.length - entries.length,
        conflicts,
      };
    });
  }

  /** Entries after position `after`, oldest first, at most one page. */
  entries(after = 0): ChainEntry[] {
    return this.#page(after);
  }

  /**
   * The chain's head: its last position and hash, archived or not; before
   * the first entry while there is none.
   */
  head(): ChainLink {
    const row = this.#db
      .select({ seq: events.seq, hash: events.hash })
      .from(events)
      .orderBy(desc(events.seq))
      .limit(1)
      .get();
    return row ?? this.#lastArchived() ?? chainOrigin;
  }

  /**
   * The events that match the filter, in the order asked for, from after
   * `cursor`. Reads at most {@link searchScanMax} entries: `next` says
   * where to carry on, or is `null` when nothing is left.
   */
  async search({
    filter,
    order,
    cursor,
    limit,
  }: SearchQuery): Promise<AuditPage> {
    const range = this.#range(filter);
    const newest = order === "newest";
    const low =
      !newest && cursor !== undefined
        ? Math.max(range.low, cursor + 1)
        : range.low;
    const high =
      newest && cursor !== undefined
        ? Math.min(range.high, cursor - 1)
        : range.high;
    if (low > high) {
      return { records: [], next: null };
    }
    const matched: { entry: EntryRow; event: AuditEvent }[] = [];
    // Hashes read on the way, so most links are checked without a lookup.
    const hashes = new Map<number, string>();
    let last: number | undefined;
    // Read as a cursor, one row at a time, with nothing awaited inside.
    for (const entry of this.ctx.storage.sql.exec<EntryRow>(
      `SELECT ${entryColumns} FROM events WHERE seq BETWEEN ? AND ? ORDER BY seq ${newest ? "DESC" : "ASC"} LIMIT ?`,
      low,
      high,
      searchScanMax
    )) {
      last = entry.seq;
      hashes.set(entry.seq, entry.hash);
      const event = parseStored(entry.event);
      if (event === undefined) {
        log.warn("audit.unreadable", { seq: entry.seq });
      } else if (matches(filter, entry.receivedAt, event)) {
        matched.push({ entry, event });
        if (matched.length === limit) {
          break;
        }
      }
    }
    const end = newest ? low : high;
    const records = await Promise.all(
      matched.map(
        async ({ entry, event }) => await this.#record(entry, event, hashes)
      )
    );
    return { records, next: last === undefined || last === end ? null : last };
  }

  /**
   * Checks the chain from after position `after`, from the hash the log
   * holds there: one archived stretch, or up to {@link verifyStretch} of
   * the entries it holds. Reports how far it got, and whether that's the
   * head, or the first position where the chain breaks.
   */
  async verify(after = 0): Promise<ChainVerification> {
    const head = this.head();
    if (after >= head.seq) {
      return { ok: true, through: head.seq, head: head.hash, done: true };
    }
    const archived = this.#db
      .select()
      .from(archives)
      .where(gt(archives.lastSeq, after))
      .orderBy(asc(archives.firstSeq))
      .limit(1)
      .get();
    const result =
      archived !== undefined && archived.firstSeq <= after + 1
        ? await this.#verifyArchived(archived)
        : await this.#verifyHeld(after);
    return result.ok ? { ...result, done: result.through >= head.seq } : result;
  }

  /**
   * Moves the oldest entries the log received before `cutoff` out to the
   * archive: at most {@link archiveStretch}, and only a stretch that
   * verifies, so a break stays where it can be found. Writes the stretch
   * first, then records it and deletes its entries in one transaction: an
   * archive cut short leaves the entries in place, and the next one writes
   * the same object again.
   */
  async archive(cutoff: string): Promise<ArchivedStretch | null> {
    const oldest = this.#page(0, archiveStretch);
    // Only the oldest entries, without gaps: up to the first one to keep.
    const kept = oldest.findIndex(({ receivedAt }) => receivedAt >= cutoff);
    const expired = kept === -1 ? oldest : oldest.slice(0, kept);
    const first = expired.at(0);
    const last = expired.at(-1);
    if (first === undefined || last === undefined) {
      return null;
    }
    const start = this.#lastArchived() ?? chainOrigin;
    const checked = await verifyChain(expired, start);
    if (!checked.ok) {
      log.error("audit.archive_refused", {
        brokenAt: checked.brokenAt,
        reason: checked.reason,
      });
      return null;
    }
    const key = archiveKey(first.seq, last.seq);
    const lines = expired.map((entry) => `${JSON.stringify(entry)}\n`);
    await this.env.AUDIT_ARCHIVE.put(key, lines.join(""), {
      httpMetadata: { contentType: "application/x-ndjson" },
    });
    const recorded = this.#db.transaction((tx) => {
      // Another archive ran while this one wrote: it moved these already.
      if ((this.#lastArchived()?.seq ?? 0) !== start.seq) {
        return false;
      }
      tx.insert(archives)
        .values({
          firstSeq: first.seq,
          lastSeq: last.seq,
          prevHash: start.hash,
          lastHash: last.hash,
          lastReceivedAt: last.receivedAt,
          key,
          archivedAt: new Date().toISOString(),
        })
        .run();
      tx.delete(events)
        .where(between(events.seq, first.seq, last.seq))
        .run();
      return true;
    });
    return recorded ? { from: first.seq, through: last.seq, key } : null;
  }

  /** The last archived position and its hash, if anything is archived. */
  #lastArchived(): ChainLink | undefined {
    return this.#db
      .select({ seq: archives.lastSeq, hash: archives.lastHash })
      .from(archives)
      .orderBy(desc(archives.lastSeq))
      .limit(1)
      .get();
  }

  /** The hash of the entry at `seq`, held or archived, if the log knows it. */
  #hashAt(seq: number): string | undefined {
    if (seq === chainOrigin.seq) {
      return chainOrigin.hash;
    }
    const held = this.#db
      .select({ hash: events.hash })
      .from(events)
      .where(eq(events.seq, seq))
      .get();
    return (
      held?.hash ??
      this.#db
        .select({ hash: archives.lastHash })
        .from(archives)
        .where(eq(archives.lastSeq, seq))
        .get()?.hash
    );
  }

  /**
   * The positions a search reads, from the filter's times: every row with a
   * time in range lies between them, whatever order the times are in.
   */
  #range(filter: ParsedAuditFilter): { low: number; high: number } {
    const bound = (query: string, ...params: string[]): number | null =>
      this.ctx.storage.sql.exec<{ seq: number | null }>(query, ...params).one()
        .seq;
    const low =
      filter.from === undefined
        ? bound("SELECT min(seq) AS seq FROM events")
        : bound(
            "SELECT min(seq) AS seq FROM events WHERE received_at >= ?",
            filter.from
          );
    const high =
      filter.to === undefined
        ? bound("SELECT max(seq) AS seq FROM events")
        : bound(
            "SELECT max(seq) AS seq FROM events WHERE received_at < ?",
            filter.to
          );
    // Nothing in range reads as an empty one.
    return low === null || high === null ? { low: 1, high: 0 } : { low, high };
  }

  /** An entry as a search returns it, checked against the chain. */
  async #record(
    entry: EntryRow,
    event: AuditEvent,
    hashes: ReadonlyMap<number, string>
  ): Promise<AuditRecord> {
    const previous = hashes.get(entry.seq - 1) ?? this.#hashAt(entry.seq - 1);
    const verified =
      entry.prevHash === previous &&
      // The event as returned is exactly what was hashed.
      canonicalJson(event) === entry.event &&
      (await hashMatches(entry));
    const { seq, receivedAt, version, prevHash, hash } = entry;
    const type = auditEventTypeOf(event);
    return { seq, receivedAt, event, type, version, prevHash, hash, verified };
  }

  /** Verifies entries the log holds, from after `after`. */
  async #verifyHeld(after: number): Promise<StretchVerification> {
    const hash = this.#hashAt(after);
    if (hash === undefined) {
      return { ok: false, brokenAt: after, reason: "missing" };
    }
    return await verifyChain(this.#stretch(after, verifyStretch), {
      seq: after,
      hash,
    });
  }

  /**
   * Verifies an archived stretch: that it links to the stretch before it,
   * and that its object holds the entries from its first position to its
   * last, chained from its first hash to its last.
   */
  async #verifyArchived(
    archived: typeof archives.$inferSelect
  ): Promise<StretchVerification> {
    const { firstSeq, lastSeq, prevHash, lastHash, key } = archived;
    if (this.#hashAt(firstSeq - 1) !== prevHash) {
      return { ok: false, brokenAt: firstSeq, reason: "unlinked" };
    }
    const object = await this.env.AUDIT_ARCHIVE.get(key);
    if (object === null) {
      return { ok: false, brokenAt: firstSeq, reason: "missing" };
    }
    const text = await object.text();
    const lines = text.split("\n").filter(Boolean);
    const entries: ChainEntry[] = [];
    for (const [index, line] of lines.entries()) {
      const parsed = archivedEntrySchema.safeParse(jsonVar(line));
      if (!parsed.success) {
        return { ok: false, brokenAt: firstSeq + index, reason: "altered" };
      }
      entries.push(parsed.data);
    }
    const result = await verifyChain(entries, {
      seq: firstSeq - 1,
      hash: prevHash,
    });
    if (!result.ok) {
      return result;
    }
    if (result.through < lastSeq) {
      return { ok: false, brokenAt: result.through + 1, reason: "missing" };
    }
    // The stretch doesn't end where the chain after it picks up.
    if (result.through > lastSeq || result.head !== lastHash) {
      return { ok: false, brokenAt: lastSeq + 1, reason: "unlinked" };
    }
    return result;
  }

  /** The ID's stored canonical JSON, if the log holds an event with it. */
  #stored(id: string): string | undefined {
    return this.#db
      .select({ event: events.event })
      .from(events)
      .where(eq(events.id, id))
      .get()?.event;
  }

  #page(after: number, limit = pageSize): ChainEntry[] {
    return this.#db
      .select({
        version: events.version,
        seq: events.seq,
        prevHash: events.prevHash,
        receivedAt: events.receivedAt,
        event: events.event,
        hash: events.hash,
      })
      .from(events)
      .where(gt(events.seq, after))
      .orderBy(asc(events.seq))
      .limit(limit)
      .all();
  }

  /**
   * Up to `max` entries after position `after`, in position order, read a
   * page at a time.
   * @yields {ChainEntry} each entry, oldest first
   */
  *#stretch(after: number, max: number): Generator<ChainEntry> {
    let read = 0;
    let page = this.#page(after, Math.min(pageSize, max));
    while (page.length > 0) {
      yield* page;
      read += page.length;
      page =
        read < max
          ? this.#page(
              page.at(-1)?.seq ?? after,
              Math.min(pageSize, max - read)
            )
          : [];
    }
  }
}

/** The deployment's single audit log. */
export const auditLog = (env: Env): DurableObjectStub<AuditLog> =>
  inJurisdiction(env, env.AUDIT_LOG).getByName("audit-log");
