import {
  auditEventMaxBytes,
  auditProvenanceMaxItems,
  auditEventSchema,
  createAuditEvent,
  isAuditEventTooLarge,
} from "@grasp-os/shared/audit";
import type { AuditActor, AuditEvent } from "@grasp-os/shared/audit";
import { actionHasPrefix, auditEventTypeOf } from "@grasp-os/shared/audit-log";
import type {
  AuditPage,
  AuditRecord,
  ChainVerification,
  FullVerification,
  ParsedAuditFilter,
} from "@grasp-os/shared/audit-log";
import { canonicalJson } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import { DurableObject } from "cloudflare:workers";
import {
  and,
  asc,
  between,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
} from "drizzle-orm";
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
import { deploymentConfig } from "./deployment-config.ts";
import { inJurisdiction } from "./durable-objects.ts";
import { jsonVar } from "./json-var.ts";

/** How many entries one read returns at most. */
const pageSize = 500;

/**
 * Most entries one step of verification checks. A step reads them in one
 * query, so they're held in memory while hashed: about 1 MB.
 */
const verifyStretch = 1000;

/**
 * Most entries one search reads, matching or not, so every call is bounded
 * however few entries match: a search that finds fewer carries on from
 * where it stopped on the next call.
 */
const searchScanMax = 5000;

/** Most entries one archive moves out: a few MB, well within memory. */
export const archiveStretch = 500;

/**
 * How long archived stretches are kept, in days from when the log received
 * their last event: at least a year, at most ten.
 */
const archiveRetentionMinDays = 365;
const archiveRetentionMaxDays = 3650;

/** Days the log keeps an event where admins search it, unless set. */
const retentionDefaultDays = 180;

/** Days the console may set: at least 30 days, at most ten years. */
const retentionSchema = z.int().min(30).max(3650);

const dayMs = 24 * 60 * 60 * 1000;

/** Most purged objects one purge deletes at once: R2's most per call. */
const deleteBatchMax = 1000;

/**
 * The deployment's retention in days (`AUDIT_RETENTION_DAYS`, see
 * src/audit-retention.ts), or `undefined` if its config is invalid.
 */
export const auditRetentionDays = (
  env: Pick<Env, "AUDIT_RETENTION_DAYS">
): number | undefined =>
  env.AUDIT_RETENTION_DAYS === undefined
    ? retentionDefaultDays
    : deploymentConfig(
        retentionSchema,
        "AUDIT_RETENTION_DAYS",
        env.AUDIT_RETENTION_DAYS
      );

/**
 * The archive retention schema for each retention: never shorter than it,
 * so an event isn't purged before it was even archived. One per retention,
 * so `deploymentConfig` parses and logs each value once.
 */
const archiveRetentionSchemas = new Map<number, z.ZodInt>();
const archiveRetentionSchema = (retention: number): z.ZodInt => {
  const known = archiveRetentionSchemas.get(retention);
  if (known) {
    return known;
  }
  const schema = z
    .int()
    .min(Math.max(archiveRetentionMinDays, retention))
    .max(archiveRetentionMaxDays);
  archiveRetentionSchemas.set(retention, schema);
  return schema;
};

/**
 * Days an event is kept in all, archive included, counted from when the
 * log received it: the `AUDIT_ARCHIVE_RETENTION_DAYS` var the console sets
 * per deployment, as the DPA states it (AU7). At least a year and at least
 * the retention, at most ten years. `undefined` while it's unset, or
 * invalid (logged as `config.invalid`), or while retention is invalid: then
 * nothing is purged. It's deployment config, so no session can shorten it.
 */
export const archiveRetentionDays = (
  env: Pick<Env, "AUDIT_ARCHIVE_RETENTION_DAYS" | "AUDIT_RETENTION_DAYS">
): number | undefined => {
  const retention = auditRetentionDays(env);
  return retention === undefined
    ? undefined
    : deploymentConfig(
        archiveRetentionSchema(retention),
        "AUDIT_ARCHIVE_RETENTION_DAYS",
        env.AUDIT_ARCHIVE_RETENTION_DAYS
      );
};

/**
 * A receipt time held this far behind the head's is logged: the log holds
 * its clock at the last receipt time, so one far-future time (a clock that
 * jumped ahead) pins every later event's.
 */
const clockHoldLoggedMs = 5 * 60 * 1000;

/** Where the object keeps the pass of verification under way, and the last. */
const passKey = "verify.pass";
const lastPassKey = "verify.last";

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

/** The positions a search reads, both included; empty when `low > high`. */
export interface SearchRange {
  low: number;
  high: number;
}

/** A search: which events, in which order, from which position on. */
export interface SearchQuery {
  filter: ParsedAuditFilter;
  order: "newest" | "oldest";
  /** The position to continue from, not included. */
  cursor?: number;
  limit: number;
  /**
   * The positions to read, worked out once for a search read over many
   * calls (an export); by default from the filter's times, now.
   */
  range?: SearchRange;
}

/** An event ready to chain: its ID and canonical JSON. */
interface Incoming {
  id: string;
  event: string;
}

/**
 * A pass of verification under way: when it began, how far it got, and the
 * last position of the purged stretches it went across.
 */
interface Pass {
  startedAt: string;
  through: number;
  purgedThrough?: number;
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

/**
 * Whether an entry the log received at `receivedAt` matches the filter. An
 * entry that isn't an event (`null`) has nothing else to match on, so it
 * matches a filter by time alone: it is never hidden from an unfiltered
 * search or export.
 */
const matches = (
  filter: ParsedAuditFilter,
  receivedAt: string,
  event: AuditEvent | null
): boolean => {
  const { from, to, ...fields } = filter;
  const inTime =
    (from === undefined || receivedAt >= from) &&
    (to === undefined || receivedAt < to);
  if (!inTime) {
    return false;
  }
  if (event === null) {
    return Object.values(fields).every((value) => value === undefined);
  }
  return matchesWho(filter, event) && matchesWhat(filter, event);
};

/** A stored event, or `null` if what's stored isn't one. */
const parseStored = (event: string): AuditEvent | null => {
  const parsed = auditEventSchema.safeParse(jsonVar(event));
  return parsed.success ? parsed.data : null;
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

/**
 * The lines of an archived stretch's object, read as they arrive.
 * @yields {string} each non-empty line
 */
const linesOf = async function* linesOf(
  object: R2ObjectBody
): AsyncGenerator<string> {
  let rest = "";
  for await (const chunk of object.body.pipeThrough(new TextDecoderStream())) {
    const lines = `${rest}${chunk}`.split("\n");
    rest = lines.pop() ?? "";
    yield* lines.filter((line) => line !== "");
  }
  if (rest !== "") {
    yield rest;
  }
};

/** A position as archive keys write it, so keys sort by position. */
const keyPosition = (seq: number): string => String(seq).padStart(12, "0");

/** A row of `events` as raw SQL reads it, with the entry's field names. */
type EntryRow = { [Key in keyof ChainEntry]: ChainEntry[Key] };

const entryColumns =
  "seq, version, prev_hash AS prevHash, received_at AS receivedAt, event, hash";

/**
 * The client's audit log: one object per deployment, in the EU. Appends
 * events in the order they arrive, each linked to the one before it by a
 * hash chain (src/audit-chain.ts), and appends each event ID only once.
 * Nothing updates an entry. Receipt times never go backwards along the
 * chain (a clock that does is held at the last time), so a time range is
 * a range of positions.
 *
 * Retention moves the oldest entries out, a stretch at a time, to the
 * AUDIT_ARCHIVE bucket (in the EU), as they were stored, and keeps a record
 * of each stretch (`archives`): its positions, the hash before it and its
 * last hash. The chain carries on from there, so it stays one chain that
 * can be verified from its first entry to its last, archived stretches
 * included. Only `purge` deletes an archived object, and it records the
 * purge first: verification then reports the stretch as purged, and the
 * chain carries on across it. An object deleted any other way (outside the
 * product) is reported as missing.
 *
 * The log searches only what it holds now, and dedupes only against that:
 * an event redelivered after its first delivery was archived would be
 * appended again (the queue gives up long before retention).
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
    return await this.#append(batch);
  }

  /**
   * Appends events recovered from the audit queue's dead letter queue, as
   * `append` does, then `audit.gap`, recorded by the platform: how many it
   * appended late, with their IDs as its provenance, how many dead letters
   * could never be appended (`lost`), and how many it skipped as conflicts
   * (an ID the log, or the batch, already has with other content). All in
   * one transaction, so a recovered event never goes in without its gap.
   * Records nothing when it appended nothing and nothing was lost or in
   * conflict: an event the log already holds left no gap. Takes at most
   * 100 events (the queue's largest batch), as many IDs as an event's
   * provenance holds.
   */
  async recover(
    batch: readonly AuditEvent[],
    lost: number
  ): Promise<AppendResult> {
    if (!Number.isInteger(lost) || lost < 0) {
      throw new RangeError(`Lost dead letters must be a count, not ${lost}`);
    }
    if (batch.length > auditProvenanceMaxItems) {
      throw new RangeError(
        `At most ${auditProvenanceMaxItems} dead letters at a time`
      );
    }
    return await this.#append(batch, (recovered, conflicts) =>
      recovered.length === 0 && lost === 0 && conflicts === 0
        ? undefined
        : prepare(
            createAuditEvent(
              {
                actor: { type: "system" },
                action: "audit.gap",
                // The events the gap was made from, as provenance holds
                // them: IDs, found by a search for any one of them.
                provenance: [...recovered],
                detail: { recovered: recovered.length, lost, conflicts },
              },
              "core"
            )
          )
    );
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
    const { seq, hash } = this.#tail();
    return { seq, hash };
  }

  /**
   * The positions that hold the entries the log received in the filter's
   * times, found with the index on receipt time, as times never go
   * backwards along the chain.
   */
  range(filter: ParsedAuditFilter): SearchRange {
    const bound = (query: string, ...params: string[]): number | undefined =>
      this.ctx.storage.sql.exec<{ seq: number }>(query, ...params).toArray()[0]
        ?.seq;
    const low =
      filter.from === undefined
        ? bound("SELECT seq FROM events ORDER BY seq LIMIT 1")
        : bound(
            "SELECT seq FROM events WHERE received_at >= ? ORDER BY received_at, seq LIMIT 1",
            filter.from
          );
    const high =
      filter.to === undefined
        ? bound("SELECT seq FROM events ORDER BY seq DESC LIMIT 1")
        : bound(
            "SELECT seq FROM events WHERE received_at < ? ORDER BY received_at DESC, seq DESC LIMIT 1",
            filter.to
          );
    // Nothing in range reads as an empty one.
    return low === undefined || high === undefined
      ? { low: 1, high: 0 }
      : { low, high };
  }

  /**
   * The events that match the filter, in the order asked for, from after
   * `cursor`. Reads at most {@link searchScanMax} entries: `next` says
   * where to carry on, or is `null` when nothing is left. `null` instead of
   * a page when retention has archived where the search would read next.
   */
  async search({
    filter,
    order,
    cursor,
    limit,
    range = this.range(filter),
  }: SearchQuery): Promise<AuditPage | null> {
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
    const [oldest] = this.#page(0, 1);
    if (oldest === undefined || (newest ? high : low) < oldest.seq) {
      return null;
    }
    const matched: { entry: EntryRow; event: AuditEvent | null }[] = [];
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
      if (matches(filter, entry.receivedAt, event)) {
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
   * head, or the first position where the chain breaks. Steps that follow
   * on from one another from position 0 make a pass; the last pass to end
   * is kept (`lastFullVerification`).
   */
  async verify(after = 0): Promise<ChainVerification> {
    const head = this.head();
    const archived = this.#db
      .select()
      .from(archives)
      .where(gt(archives.lastSeq, after))
      .orderBy(asc(archives.firstSeq))
      .limit(1)
      .get();
    let result: StretchVerification & { purged?: true };
    if (after >= head.seq) {
      result = { ok: true, through: head.seq, head: head.hash };
    } else if (archived !== undefined && archived.firstSeq <= after + 1) {
      result = await this.#verifyArchived(archived);
    } else {
      result = await this.#verifyHeld(after);
    }
    const step: ChainVerification = result.ok
      ? { ...result, done: result.through >= head.seq }
      : result;
    this.#recordPass(after, step);
    return step;
  }

  /** The last full pass of verification, if one has ended. */
  lastFullVerification(): FullVerification | null {
    return this.ctx.storage.kv.get<FullVerification>(lastPassKey) ?? null;
  }

  /**
   * Moves the oldest entries the log received before `cutoff` out to the
   * archive: at most {@link archiveStretch}, and only a stretch that
   * verifies, so a break stays where it can be found. Writes the stretch
   * first, to an object only this log writes and never overwrites, then
   * records it, deletes its entries and appends `audit.archived` in one
   * transaction: an archive cut short leaves the entries in place, and the
   * next one finds the same object already written.
   */
  async archive(
    cutoff: string,
    retentionDays: number
  ): Promise<ArchivedStretch | null> {
    const [oldest] = this.#page(0, 1);
    if (oldest === undefined || oldest.receivedAt >= cutoff) {
      return null;
    }
    const page = this.#page(0, archiveStretch);
    // Only the oldest entries, without gaps: up to the first one to keep.
    const kept = page.findIndex(({ receivedAt }) => receivedAt >= cutoff);
    const expired = kept === -1 ? page : page.slice(0, kept);
    const first = expired.at(0);
    const last = expired.at(-1);
    const start = this.#lastArchived() ?? chainOrigin;
    if (first === undefined || last === undefined) {
      return null;
    }
    const checked = await verifyChain(expired, start);
    if (!checked.ok) {
      log.error("audit.archive_refused", {
        brokenAt: checked.brokenAt,
        reason: checked.reason,
      });
      return null;
    }
    const key = this.#archiveKey(first.seq, last.seq);
    if (!(await this.#write(key, expired))) {
      return null;
    }
    const archivedEvent = prepare(
      createAuditEvent(
        {
          actor: { type: "system" },
          action: "audit.archived",
          detail: { from: first.seq, through: last.seq, key, retentionDays },
        },
        "core"
      )
    );
    // Linking the event needs the head, as an append does.
    const recorded = await this.ctx.blockConcurrencyWhile(async () => {
      // Another archive moved these meanwhile.
      if ((this.#lastArchived()?.seq ?? 0) !== start.seq) {
        return false;
      }
      const { entries } = await this.#link([archivedEvent]);
      this.#db.transaction((tx) => {
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
        for (const entry of entries) {
          tx.insert(events).values(entry).run();
        }
      });
      return true;
    });
    return recorded ? { from: first.seq, through: last.seq, key } : null;
  }

  /**
   * Purges the oldest archived stretch kept longer than the deployment's
   * archive retention ({@link archiveRetentionDays}; nothing while it's
   * unset): records the purge (the stretch's `purgedAt`, and `audit.purged`
   * in the chain, in one transaction), then deletes its object.
   * Verification then reports the stretch as purged, not missing, and the
   * chain carries on across it from its recorded hashes. Only a stretch
   * that verifies is purged, so a break is never erased with it, and
   * purges go oldest first. The log works the cutoff out itself, so its
   * caller can't purge early. Every purge, also one that fails, then
   * deletes the objects of purged stretches whose delete failed before.
   * The cron trigger calls it; it isn't on the RPC API, so no session can
   * purge, staff included.
   */
  async purge(): Promise<ArchivedStretch | null> {
    const days = archiveRetentionDays(this.env);
    if (days === undefined) {
      return null;
    }
    let purged: ArchivedStretch | null;
    try {
      purged = await this.#purgeOldest(
        new Date(Date.now() - days * dayMs).toISOString()
      );
    } catch (error) {
      // Also when this purge fails, say a read of the stretch's object
      // throws: the stretches purged before still get their objects deleted.
      // The purge's error is the one thrown; the deletes' own is logged.
      try {
        await this.#deletePurged();
      } catch (cleanupError) {
        log.error("audit.purge_cleanup_failed", errorFields(cleanupError));
      }
      throw error;
    }
    await this.#deletePurged();
    return purged;
  }

  /** Records the purge of the oldest archived stretch received before `cutoff`. */
  async #purgeOldest(cutoff: string): Promise<ArchivedStretch | null> {
    const oldest = this.#db
      .select()
      .from(archives)
      .where(isNull(archives.purgedAt))
      .orderBy(asc(archives.firstSeq))
      .limit(1)
      .get();
    if (oldest === undefined || oldest.lastReceivedAt >= cutoff) {
      return null;
    }
    const { firstSeq: from, lastSeq: through, key } = oldest;
    const checked = await this.#verifyArchived(oldest);
    if (!checked.ok) {
      log.error("audit.purge_refused", {
        brokenAt: checked.brokenAt,
        reason: checked.reason,
      });
      return null;
    }
    const purgedEvent = prepare(
      createAuditEvent(
        {
          actor: { type: "system" },
          action: "audit.purged",
          detail: { from, through, key },
        },
        "core"
      )
    );
    const recorded = await this.ctx.blockConcurrencyWhile(async () => {
      const { entries } = await this.#link([purgedEvent]);
      return this.#db.transaction((tx) => {
        // Another purge recorded it meanwhile.
        const updated = tx
          .update(archives)
          .set({ purgedAt: new Date().toISOString() })
          .where(and(eq(archives.firstSeq, from), isNull(archives.purgedAt)))
          .returning({ firstSeq: archives.firstSeq })
          .all();
        if (updated.length === 0) {
          return false;
        }
        for (const entry of entries) {
          tx.insert(events).values(entry).run();
        }
        return true;
      });
    });
    return recorded ? { from, through, key } : null;
  }

  /**
   * Deletes the objects of purged stretches not deleted yet, and records
   * that they were. One that fails stays for the next purge: R2 deletes
   * are idempotent, so an object already gone is no failure.
   */
  async #deletePurged(): Promise<void> {
    const pending = this.#db
      .select({ firstSeq: archives.firstSeq, key: archives.key })
      .from(archives)
      .where(and(isNotNull(archives.purgedAt), isNull(archives.deletedAt)))
      .orderBy(asc(archives.firstSeq))
      .limit(deleteBatchMax)
      .all();
    if (pending.length === 0) {
      return;
    }
    try {
      await this.env.AUDIT_ARCHIVE.delete(pending.map(({ key }) => key));
    } catch (error) {
      log.error("audit.purge_delete_failed", {
        objects: pending.length,
        ...errorFields(error),
      });
      return;
    }
    this.#db
      .update(archives)
      .set({ deletedAt: new Date().toISOString() })
      .where(
        inArray(
          archives.firstSeq,
          pending.map(({ firstSeq }) => firstSeq)
        )
      )
      .run();
  }

  /**
   * Appends events, skipping IDs the log already holds, and then the event
   * `after` gives for the IDs it appended, if any, in one transaction.
   * Validates every event first, so one malformed or oversized event
   * appends nothing from its batch.
   */
  async #append(
    batch: readonly AuditEvent[],
    after?: (
      appended: readonly string[],
      conflicts: number
    ) => Incoming | undefined
  ): Promise<AppendResult> {
    const incoming = batch.map((event) => prepare(event));
    // Hashing is async, so another append could otherwise run between
    // reading the head and writing after it, and fork the chain.
    return await this.ctx.blockConcurrencyWhile(async () => {
      const { entries, conflicts } = await this.#link(incoming);
      const next = after?.(
        entries.map(({ id }) => id),
        conflicts
      );
      const { entries: then } =
        next === undefined
          ? { entries: [] }
          : await this.#link([next], entries.at(-1));
      this.#db.transaction((tx) => {
        for (const entry of [...entries, ...then]) {
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

  /**
   * Links events onto the head, or after `tail` (entries linked but not
   * yet written), each one after the last, skipping IDs the log already
   * holds. Receipt times never go backwards: a clock behind the head's time
   * is held at it (logged once, when linking onto the head). Call only
   * while nothing else can append.
   */
  async #link(
    incoming: readonly Incoming[],
    after?: ChainLink & { receivedAt: string }
  ): Promise<{ entries: (ChainEntry & { id: string })[]; conflicts: number }> {
    const tail = after ?? this.#tail();
    const now = new Date().toISOString();
    const receivedAt = now > tail.receivedAt ? now : tail.receivedAt;
    const heldMs = Date.parse(tail.receivedAt) - Date.parse(now);
    if (after === undefined && heldMs > clockHoldLoggedMs) {
      log.warn("audit.clock_held", { heldMs, heldAt: tail.receivedAt });
    }
    // Every event this call has seen, by ID: stored ones and new ones.
    const known = new Map<string, string | undefined>();
    const entries: (ChainEntry & { id: string })[] = [];
    let conflicts = 0;
    let prevHash = tail.hash;
    let { seq } = tail;
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
    return { entries, conflicts };
  }

  /** The last entry, held or archived: its position, hash and receipt time. */
  #tail(): ChainLink & { receivedAt: string } {
    const row = this.#db
      .select({
        seq: events.seq,
        hash: events.hash,
        receivedAt: events.receivedAt,
      })
      .from(events)
      .orderBy(desc(events.seq))
      .limit(1)
      .get();
    const archived = this.#db
      .select({
        seq: archives.lastSeq,
        hash: archives.lastHash,
        receivedAt: archives.lastReceivedAt,
      })
      .from(archives)
      .orderBy(desc(archives.lastSeq))
      .limit(1)
      .get();
    return row ?? archived ?? { ...chainOrigin, receivedAt: "" };
  }

  /**
   * Where a stretch is archived: under this object's own ID, so a log
   * created again, or restored, never writes over another's stretches.
   * Sorts by position.
   */
  #archiveKey(from: number, through: number): string {
    return `audit-log/${this.ctx.id.toString()}/${keyPosition(from)}-${keyPosition(through)}.ndjson`;
  }

  /**
   * Writes a stretch's object, only if there is none yet. One already there
   * is accepted only with exactly these bytes: an earlier archive of the
   * same stretch that stopped before recording it. Anything else is
   * refused, and the entries stay where they are.
   */
  async #write(key: string, stretch: readonly ChainEntry[]): Promise<boolean> {
    const body = stretch.map((entry) => `${JSON.stringify(entry)}\n`).join("");
    const written = await this.env.AUDIT_ARCHIVE.put(key, body, {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: "application/x-ndjson" },
    });
    if (written !== null) {
      return true;
    }
    const existing = await this.env.AUDIT_ARCHIVE.get(key);
    const text = existing === null ? undefined : await existing.text();
    if (text === body) {
      return true;
    }
    log.error("audit.archive_conflict", { key });
    return false;
  }

  /**
   * Keeps track of a pass of verification: a step from position 0 starts
   * one, a step from where it got to carries it on, and the step that ends
   * it (at the head, or at a break) keeps its result.
   */
  #recordPass(after: number, step: ChainVerification): void {
    const now = new Date().toISOString();
    const pass: Pass | undefined =
      after === 0
        ? { startedAt: now, through: 0 }
        : this.ctx.storage.kv.get<Pass>(passKey);
    if (pass?.through !== after) {
      return;
    }
    const purgedThrough =
      step.ok && step.purged ? step.through : pass.purgedThrough;
    if (step.ok && !step.done) {
      this.ctx.storage.kv.put(passKey, {
        ...pass,
        through: step.through,
        ...(purgedThrough === undefined ? {} : { purgedThrough }),
      });
      return;
    }
    const ended = {
      startedAt: pass.startedAt,
      finishedAt: now,
      ...(purgedThrough === undefined ? {} : { purgedThrough }),
    };
    const last: FullVerification = step.ok
      ? { ...ended, ok: true, through: step.through, head: step.head }
      : { ...ended, ...step };
    this.ctx.storage.kv.put(lastPassKey, last);
    this.ctx.storage.kv.delete(passKey);
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

  /** An entry as a search returns it, checked against the chain. */
  async #record(
    entry: EntryRow,
    event: AuditEvent | null,
    hashes: ReadonlyMap<number, string>
  ): Promise<AuditRecord> {
    const previous = hashes.get(entry.seq - 1) ?? this.#hashAt(entry.seq - 1);
    const verified =
      event !== null &&
      entry.prevHash === previous &&
      (await hashMatches(entry));
    const { seq, receivedAt, version, prevHash, hash } = entry;
    return {
      seq,
      receivedAt,
      eventJson: entry.event,
      event,
      type: event === null ? null : auditEventTypeOf(event),
      version,
      prevHash,
      hash,
      verified,
    };
  }

  /**
   * Verifies entries the log holds, from after `after`. Reads the hash it
   * starts from and the stretch synchronously, before hashing awaits
   * anything, so it checks one consistent copy: an archive that moves
   * these entries out meanwhile can't change what it reads.
   */
  async #verifyHeld(after: number): Promise<StretchVerification> {
    const hash = this.#hashAt(after);
    if (hash === undefined) {
      return { ok: false, brokenAt: after, reason: "missing" };
    }
    return await verifyChain(this.#page(after, verifyStretch), {
      seq: after,
      hash,
    });
  }

  /**
   * Verifies an archived stretch: that it links to the stretch before it,
   * and that its object holds the entries from its first position to its
   * last, chained from its first hash to its last. A purged stretch has no
   * object left: it verifies as purged once it links, and the chain carries
   * on from its last hash. A stretch purged while its object was read is
   * purged too, not broken.
   */
  async #verifyArchived(
    archived: typeof archives.$inferSelect
  ): Promise<StretchVerification & { purged?: true }> {
    const { firstSeq, lastSeq, prevHash, lastHash } = archived;
    if (this.#hashAt(firstSeq - 1) !== prevHash) {
      return { ok: false, brokenAt: firstSeq, reason: "unlinked" };
    }
    const purged = {
      ok: true,
      through: lastSeq,
      head: lastHash,
      purged: true,
    } as const;
    if (archived.purgedAt !== null) {
      return purged;
    }
    const result = await this.#verifyObject(archived);
    if (result.ok) {
      return result;
    }
    const now = this.#db
      .select({ purgedAt: archives.purgedAt })
      .from(archives)
      .where(eq(archives.firstSeq, firstSeq))
      .get();
    return (now?.purgedAt ?? null) === null ? result : purged;
  }

  /** Reads an archived stretch's object as it arrives, and verifies it. */
  async #verifyObject(
    archived: typeof archives.$inferSelect
  ): Promise<StretchVerification> {
    const { firstSeq, lastSeq, prevHash, lastHash, key } = archived;
    const object = await this.env.AUDIT_ARCHIVE.get(key);
    if (object === null) {
      return { ok: false, brokenAt: firstSeq, reason: "missing" };
    }
    // The position of a line that isn't an entry, where reading stopped.
    let unreadable: number | undefined;
    const entries = async function* entries(): AsyncGenerator<ChainEntry> {
      let seq = firstSeq;
      for await (const line of linesOf(object)) {
        const parsed = archivedEntrySchema.safeParse(jsonVar(line));
        if (!parsed.success) {
          unreadable = seq;
          return;
        }
        yield parsed.data;
        seq += 1;
      }
    };
    const result = await verifyChain(entries(), {
      seq: firstSeq - 1,
      hash: prevHash,
    });
    if (!result.ok) {
      return result;
    }
    if (unreadable !== undefined) {
      return { ok: false, brokenAt: unreadable, reason: "altered" };
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
}

/** The deployment's single audit log. */
export const auditLog = (env: Env): DurableObjectStub<AuditLog> =>
  inJurisdiction(env, env.AUDIT_LOG).getByName("audit-log");
