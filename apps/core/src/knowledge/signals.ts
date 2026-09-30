import { actorOf } from "@grasp-os/shared/audit";
import { toHex } from "@grasp-os/shared/encoding";
import { collectionIdSchema, documentIdSchema } from "@grasp-os/shared/ids";
import type { Json } from "@grasp-os/shared/json";
import { readOnlySources } from "@grasp-os/shared/knowledge";
import {
  knowledgeSignalErrors,
  knowledgeSignalIdSchema,
  knowledgeSignalKinds,
  knowledgeSignalsPerKind,
  questionWindowDays,
  repeatedSearches,
  unreadDays,
} from "@grasp-os/shared/knowledge-signals";
import type {
  KnowledgeSignal,
  KnowledgeSignalKind,
  KnowledgeSignals,
} from "@grasp-os/shared/knowledge-signals";
import { errorFields, log } from "@grasp-os/shared/log";
import type { Identity } from "@grasp-os/shared/rpc";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { z } from "zod";

import { auditRetentionDays } from "../audit-log.ts";
import {
  auditedBatch,
  keepAuditEvent,
  outboxedIfChanged,
} from "../audit-outbox.ts";
import {
  claimComputation,
  finishComputation,
  isFinished,
  latestFinished,
  newComputation,
} from "../daily-claims.ts";
import type { Computation } from "../daily-claims.ts";
import { chunks, inList } from "../db/d1.ts";
import {
  collections,
  documents,
  knowledgeSignalComputations as computations,
  knowledgeSignalDismissals as dismissals,
  knowledgeSignals,
} from "../db/knowledge/schema.ts";
import { allowedCollections } from "./access.ts";
import type { Reader } from "./access.ts";
import type { KnowledgeTally } from "./usage-tally.ts";

// Knowledge usage signals (@grasp-os/shared/knowledge-signals has what each
// means): questions asked again and again in a collection without an
// answer, documents nobody read or changed for `unreadDays`, and documents
// past their review date, each for the owner of its collection. Read from
// the audit log (reads, and searches that found nothing) and the
// documents, never on a request: once a UTC day, by the first run of the
// 15-minute cron trigger of a day that claims it (src/daily-claims.ts),
// reading the audit log in the same pass as the improvement signals
// (src/daily-signals.ts).
//
// A computation writes its signals under its own ID, in as many batches as
// they take, and then finishes in one batch: it marks itself finished, and
// readers take the finished computation started last, so a computation's
// signals show all at once, and a half-written or failed one's never. The
// same batch drops the dismissals of signals it no longer has, or has with
// newer evidence (dismissals outlast the computations, by kind, collection
// and subject). Then it deletes the computations started before the
// finished one before it, with their signals, a chunk at a time: that one
// stays for a reader that may still be reading it. One that outlived its
// lease and was finished past finishes nothing (src/daily-claims.ts), so
// what it wrote is never read, and once its row is gone its writes fail on
// the foreign key. Computing again is idempotent: the same signals, with the same
// IDs, derived from their kind, collection and subject.
//
// Unread documents need every read of their window: `unreadDays`, or the
// audit log's retention where that is shorter. While the log doesn't hold
// them all (retention archived some meanwhile), that kind isn't computed:
// the computation carries the last one's over as they were. Questions
// count what the log holds.
//
// A question's searches by the collection's owner themselves don't count:
// they know what they asked. Collections only Grasp writes (the Grasp
// skills, the Apps collection) have no owner to tell and get no signals.

const dayMs = 24 * 60 * 60 * 1000;

/** Rows one read of documents or collections returns. */
const pageRows = 500;

/** Signals one insert writes: 9 columns each, within D1's 100 parameters. */
const rowsPerInsert = 11;

/** Inserts one batch writes. */
const insertsPerBatch = 50;

/** A signal as a computation stores it. */
interface SignalRow {
  kind: KnowledgeSignalKind;
  collectionId: string;
  subject: string;
  owner: string;
  /** Ranks it within its kind; null for an overdue document. */
  value: number | null;
  evidence: Json;
  /** When its latest evidence was seen: a question's latest search. */
  evidenceAt: Date | null;
}

/** A question's stored evidence (`UnansweredQuestion` has what each means). */
const questionEvidenceSchema = z.object({
  searches: z.int(),
  askers: z.int(),
  terms: z.int(),
  lastAt: z.iso.datetime(),
});

/** An unread document's stored evidence: the days of its window. */
const unreadEvidenceSchema = z.object({ days: z.int() });

const isoDay = (at: Date): string => at.toISOString().slice(0, 10);

/** Whole days from `from` to `to`. */
const daysBetween = (from: number, to: number): number =>
  Math.floor((to - from) / dayMs);

/** Collections whose documents their owner writes: those with signals. */
const owned = notInArray(collections.source, [...readOnlySources]);

/**
 * The days without a read that make a document unread: `unreadDays`, or
 * the audit log's retention while that's shorter, as the log holds no
 * reads older than that.
 */
const unreadWindowDays = (env: Env): number =>
  Math.min(unreadDays, auditRetentionDays(env) ?? unreadDays);

/** What the audit log holds of reads and questions, added up. */
export interface KnowledgeTotals {
  /** The days of reads `read` covers. */
  unreadDays: number;
  /** Documents read in the window; null while the log lacks some. */
  read: Set<string> | null;
  /** Each question, by collection and key: each asker's searches. */
  questions: Map<
    string,
    {
      collectionId: string;
      queryKey: string;
      terms: number;
      askers: Map<string, { searches: number; lastAt: string }>;
    }
  >;
}

/**
 * What the computation of `now` reads of the audit log: reads from its
 * unread window on, questions from `questionWindowDays` before, and totals
 * of nothing yet to add the stretches to.
 */
export const knowledgeWindow = (env: Env, now: Date) => {
  const days = unreadWindowDays(env);
  return {
    readsFrom: new Date(now.getTime() - days * dayMs).toISOString(),
    questionsFrom: new Date(
      now.getTime() - questionWindowDays * dayMs
    ).toISOString(),
    totals: (): KnowledgeTotals => ({
      unreadDays: days,
      read: new Set(),
      questions: new Map(),
    }),
  };
};

/** Adds a stretch's partial totals (`AuditLog.tallyStretch`) to `totals`. */
export const addKnowledgeTally = (
  totals: KnowledgeTotals,
  tally: KnowledgeTally
): void => {
  for (const id of tally.read) {
    totals.read?.add(id);
  }
  for (const { asker, searches, lastAt, ...question } of tally.questions) {
    const key = JSON.stringify([question.collectionId, question.queryKey]);
    const found = totals.questions.get(key) ?? {
      ...question,
      askers: new Map<string, { searches: number; lastAt: string }>(),
    };
    const before = found.askers.get(asker);
    found.askers.set(asker, {
      searches: (before?.searches ?? 0) + searches,
      lastAt:
        before !== undefined && before.lastAt > lastAt ? before.lastAt : lastAt,
    });
    totals.questions.set(key, found);
  }
};

/** The owners of `ids`, of the collections among them that get signals. */
const ownersOf = async (
  db: DrizzleD1Database,
  ids: readonly string[]
): Promise<Map<string, string>> => {
  const owners = new Map<string, string>();
  for (const page of chunks(ids, pageRows)) {
    // One page after another, so a large tally never floods D1.
    // oxlint-disable-next-line no-await-in-loop
    const found = await db
      .select({ id: collections.id, owner: collections.owner })
      .from(collections)
      .where(and(inList(collections.id, page), owned));
    for (const { id, owner } of found) {
      owners.set(id, owner);
    }
  }
  return owners;
};

/** The searches of `askers`, added up. */
const total = (askers: Iterable<{ searches: number }>): number =>
  [...askers].reduce((sum, { searches }) => sum + searches, 0);

/**
 * Questions asked `repeatedSearches` times or more in one collection in
 * the window, without an answer, by others than its owner: for that
 * collection's owner. A search names its collection, or, searching every
 * collection, those it came closest in (usage-tally.ts).
 */
const questionSignals = async (
  db: DrizzleD1Database,
  { questions }: KnowledgeTotals
): Promise<SignalRow[]> => {
  const repeated = [...questions.values()].filter(
    ({ askers }) => total(askers.values()) >= repeatedSearches
  );
  const owners = await ownersOf(db, [
    ...new Set(repeated.map(({ collectionId }) => collectionId)),
  ]);
  return repeated.flatMap((question) => {
    const owner = owners.get(question.collectionId);
    if (owner === undefined) {
      return [];
    }
    const others = [...question.askers].filter(
      ([asker]) => asker !== `person:${owner}`
    );
    const searches = total(others.map(([, asked]) => asked));
    const [lastAt] = others
      .map(([, asked]) => asked.lastAt)
      .toSorted()
      .toReversed();
    if (searches < repeatedSearches || lastAt === undefined) {
      return [];
    }
    const evidence: z.infer<typeof questionEvidenceSchema> = {
      searches,
      askers: others.length,
      terms: question.terms,
      lastAt,
    };
    return [
      {
        kind: "unanswered_question",
        collectionId: question.collectionId,
        subject: question.queryKey,
        owner,
        value: searches,
        evidence,
        evidenceAt: new Date(lastAt),
      },
    ];
  });
};

/** A document a signal may be about, with its collection's owner. */
interface DocumentRow {
  id: string;
  collectionId: string;
  owner: string;
  updatedAt: Date;
  reviewDate: string | null;
}

/**
 * Every document `where` finds in the collections that get signals, a page
 * at a time in `(order, id)` order: `after` is the last row of the page
 * before.
 */
const eachDocument = async (
  db: DrizzleD1Database,
  where: (after: DocumentRow | undefined) => SQL | undefined,
  order: SQL,
  each: (row: DocumentRow) => void
): Promise<void> => {
  let after: DocumentRow | undefined;
  for (;;) {
    // One page after another: each starts where the last ended.
    // oxlint-disable-next-line no-await-in-loop
    const rows = await db
      .select({
        id: documents.id,
        collectionId: documents.collectionId,
        owner: collections.owner,
        updatedAt: documents.updatedAt,
        reviewDate: documents.reviewDate,
      })
      .from(documents)
      .innerJoin(collections, eq(collections.id, documents.collectionId))
      .where(and(where(after), owned))
      .orderBy(order, asc(documents.id))
      .limit(pageRows);
    for (const row of rows) {
      each(row);
    }
    if (rows.length < pageRows) {
      return;
    }
    after = rows.at(-1);
  }
};

/**
 * Documents unchanged for the window's days that nobody read in that time
 * either, by `read`: valued at the days since they changed. Each stays a
 * signal, however long, until it is read or changed.
 */
const unreadSignals = async (
  db: DrizzleD1Database,
  now: Date,
  days: number,
  read: ReadonlySet<string>
): Promise<SignalRow[]> => {
  const cutoff = new Date(now.getTime() - days * dayMs);
  const rows: SignalRow[] = [];
  await eachDocument(
    db,
    (after) =>
      and(
        lt(documents.updatedAt, cutoff),
        after === undefined
          ? undefined
          : sql`(${documents.updatedAt}, ${documents.id}) > (${after.updatedAt.getTime()}, ${after.id})`
      ),
    asc(documents.updatedAt),
    (row) => {
      if (read.has(row.id)) {
        return;
      }
      const evidence: z.infer<typeof unreadEvidenceSchema> = { days };
      rows.push({
        kind: "unread_document",
        collectionId: row.collectionId,
        subject: row.id,
        owner: row.owner,
        value: daysBetween(row.updatedAt.getTime(), now.getTime()),
        evidence,
        evidenceAt: null,
      });
    }
  );
  return rows;
};

/**
 * Documents past their review date. Each stays a signal until its review
 * date moves on. How overdue each is, and so their order, is read from the
 * document when listed, as its review date may have moved since: it has
 * no value.
 */
const overdueSignals = async (
  db: DrizzleD1Database,
  now: Date
): Promise<SignalRow[]> => {
  const today = isoDay(now);
  const rows: SignalRow[] = [];
  await eachDocument(
    db,
    (after) =>
      and(
        isNotNull(documents.reviewDate),
        lt(documents.reviewDate, today),
        after === undefined
          ? undefined
          : sql`(${documents.reviewDate}, ${documents.id}) > (${after.reviewDate}, ${after.id})`
      ),
    asc(documents.reviewDate),
    (row) => {
      rows.push({
        kind: "overdue_review",
        collectionId: row.collectionId,
        subject: row.id,
        owner: row.owner,
        value: null,
        evidence: {},
        evidenceAt: null,
      });
    }
  );
  return rows;
};

/**
 * Claims the usage signals of `now`'s UTC day (src/daily-claims.ts).
 * Earlier days' claims
 * that never finished go once a later computation finishes, with anything
 * they wrote.
 */
export const claimKnowledgeSignals = async (
  env: Env,
  now: Date
): Promise<Computation | undefined> => {
  const db = drizzle(env.KNOWLEDGE);
  const computation = newComputation(now);
  const claimed = await claimComputation(db, computations, computation);
  return claimed.length === 0 ? undefined : computation;
};

/**
 * A signal's ID: derived from its kind, collection and subject, so it is
 * the same in every computation, in the form of a UUID (version 8).
 */
const stableId = async (
  row: Pick<SignalRow, "kind" | "collectionId" | "subject">
): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      JSON.stringify([row.kind, row.collectionId, row.subject])
    )
  );
  const hex = toHex(new Uint8Array(digest)).slice(0, 32);
  // The version, 8, and the variant, 10 followed by the digest's bits.
  const variant = ((Number.parseInt(hex.charAt(16), 16) % 4) + 8).toString(16);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `8${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
};

/** The finished computation started last, whose signals are the current ones. */
const latestComputation = async (db: DrizzleD1Database) =>
  await db
    .select({
      id: computations.id,
      startedAt: computations.startedAt,
      finishedAt: computations.finishedAt,
    })
    .from(computations)
    .where(eq(computations.id, latestFinished(computations)))
    .get();

/** Signal rows one statement of the clean-up deletes. */
const deletesPerStatement = 1000;

/**
 * Once `computation` finished, deletes the computations started before the
 * finished one before it, with their signals: it keeps that one, whose
 * signals a reader may still be reading. The signals go a chunk at a time,
 * then what is left of them and the computations in one batch, so no
 * signal is left without its computation. Each statement only while
 * `computation` is finished. A failure is logged: the next computation's
 * clean-up takes what is left.
 */
const cleanUp = async (
  db: DrizzleD1Database,
  computation: Computation
): Promise<void> => {
  const finished = isFinished(computations, computation);
  const previous = sql`(
    SELECT ${computations.startedAt} FROM ${computations}
    WHERE ${computations.finishedAt} IS NOT NULL
      AND ${computations.startedAt} < ${computation.startedAt.getTime()}
    ORDER BY ${computations.startedAt} DESC, ${computations.id} DESC
    LIMIT 1
  )`;
  const beforePrevious = lt(computations.startedAt, previous);
  const older = db
    .select({ id: computations.id })
    .from(computations)
    .where(beforePrevious);
  const ofOlder = and(finished, inArray(knowledgeSignals.computation, older));
  try {
    for (;;) {
      // One chunk after another, each within D1's limits.
      // oxlint-disable-next-line no-await-in-loop
      const deleted = await db.run(sql`
        DELETE FROM ${knowledgeSignals}
        WHERE (${knowledgeSignals.computation}, ${knowledgeSignals.id}) IN (
          SELECT ${knowledgeSignals.computation}, ${knowledgeSignals.id}
          FROM ${knowledgeSignals} WHERE ${ofOlder}
          LIMIT ${deletesPerStatement}
        )`);
      if (deleted.meta.changes < deletesPerStatement) {
        break;
      }
    }
    await db.batch([
      db.delete(knowledgeSignals).where(ofOlder),
      db.delete(computations).where(and(finished, beforePrevious)),
    ]);
  } catch (error) {
    log.warn("knowledge.signals.clean_up_failed", errorFields(error));
  }
};

/**
 * Writes the signals the claimed computation finds with `totals` (what the
 * audit log holds of its window) under its ID, and, while unread
 * documents aren't computed, those of the latest finished computation.
 * Then finishes it in one batch with its audit event, only if it is still
 * there to mark: marks it finished, which shows its signals, and drops
 * the dismissals of signals it doesn't have, or has with newer evidence.
 * Then cleans up the computations before it.
 */
export const storeKnowledgeSignals = async (
  env: Env,
  computation: Computation,
  totals: KnowledgeTotals
): Promise<void> => {
  const now = computation.startedAt;
  const db = drizzle(env.KNOWLEDGE);
  const [questions, overdue, unread] = await Promise.all([
    questionSignals(db, totals),
    overdueSignals(db, now),
    totals.read === null
      ? []
      : unreadSignals(db, now, totals.unreadDays, totals.read),
  ]);
  const found = [...questions, ...overdue, ...unread];
  const rows = await Promise.all(
    found.map(async (row) => ({
      ...row,
      id: await stableId(row),
      computation: computation.id,
    }))
  );
  const inserts = chunks(rows, rowsPerInsert).map((chunk) =>
    db.insert(knowledgeSignals).values(chunk)
  );
  const previous =
    totals.read === null ? await latestComputation(db) : undefined;
  const carried =
    previous === undefined
      ? []
      : [
          db.insert(knowledgeSignals).select(
            sql`SELECT ${computation.id}, ${knowledgeSignals.id},
                ${knowledgeSignals.kind}, ${knowledgeSignals.collectionId},
                ${knowledgeSignals.subject}, ${knowledgeSignals.owner},
                ${knowledgeSignals.value}, ${knowledgeSignals.evidence},
                ${knowledgeSignals.evidenceAt}
              FROM ${knowledgeSignals}
              WHERE ${knowledgeSignals.computation} = ${previous.id}
                AND ${knowledgeSignals.kind} = 'unread_document'`
          ),
        ];
  for (const [first, ...rest] of chunks(
    [...inserts, ...carried],
    insertsPerBatch
  )) {
    if (first !== undefined) {
      // Batches one after another, each within D1's limits.
      // oxlint-disable-next-line no-await-in-loop
      await db.batch([first, ...rest]);
    }
  }
  const finished = isFinished(computations, computation);
  await auditedBatch(env, db, [
    finishComputation(db, computations, computation),
    outboxedIfChanged(db, {
      actor: { type: "system" },
      action: "knowledge.signals.computed",
      target: { type: "knowledge_signals", id: computation.id },
      detail: {
        day: computation.day,
        signals: rows.length,
        // The days of reads unread documents were computed from; null
        // when they weren't, as the log lacked some.
        unreadDays: totals.read === null ? null : totals.unreadDays,
      },
    }),
    db.delete(dismissals).where(
      and(
        finished,
        inArray(dismissals.kind, [...knowledgeSignalKinds]),
        sql`NOT EXISTS (
          SELECT 1 FROM ${knowledgeSignals}
          WHERE ${knowledgeSignals.computation} = ${computation.id}
            AND ${knowledgeSignals.collectionId} = ${dismissals.collectionId}
            AND ${knowledgeSignals.kind} = ${dismissals.kind}
            AND ${knowledgeSignals.subject} = ${dismissals.subject}
            AND (${knowledgeSignals.evidenceAt} IS NULL
              OR ${knowledgeSignals.evidenceAt} <= ${dismissals.dismissedAt})
        )`
      )
    ),
  ]);
  await cleanUp(db, computation);
};

/**
 * A signal nobody dismissed, or with evidence newer than its dismissal: a
 * question asked again since.
 */
const shown = or(
  isNull(dismissals.dismissedAt),
  gt(knowledgeSignals.evidenceAt, dismissals.dismissedAt)
);

/** A signal's dismissal, if any, joined by kind, collection and subject. */
const ofDismissal = and(
  eq(dismissals.kind, knowledgeSignals.kind),
  eq(dismissals.collectionId, knowledgeSignals.collectionId),
  eq(dismissals.subject, knowledgeSignals.subject)
);

/**
 * Reads of the signals of the finished computation started last, and when
 * it finished, for `owner`, `where` holds for their collection: joined
 * with the collection, which `owner` must still own, and for a document,
 * with the document, which must still be one the signal is about. Each
 * selects no column name twice, as a batch returns rows by name.
 */
const signalReads = (
  db: DrizzleD1Database,
  owner: string,
  where: SQL | undefined,
  today: string
) => {
  const latest = latestFinished(computations);
  const ofKind = (kind: KnowledgeSignalKind) =>
    and(
      eq(knowledgeSignals.computation, latest),
      eq(knowledgeSignals.owner, owner),
      eq(knowledgeSignals.kind, kind),
      shown,
      where
    );
  const ofCollection = and(
    eq(collections.id, knowledgeSignals.collectionId),
    eq(collections.owner, knowledgeSignals.owner)
  );
  const ofDocument = and(
    eq(documents.id, knowledgeSignals.subject),
    eq(documents.collectionId, knowledgeSignals.collectionId)
  );
  const order = [desc(knowledgeSignals.value), desc(knowledgeSignals.id)];
  const aboutDocument = {
    id: knowledgeSignals.id,
    collectionId: knowledgeSignals.collectionId,
    name: collections.name,
    documentId: knowledgeSignals.subject,
    path: documents.path,
    title: documents.title,
  };
  return {
    computed: db
      .select({ finishedAt: computations.finishedAt })
      .from(computations)
      .where(eq(computations.id, latest)),
    questions: db
      .select({
        id: knowledgeSignals.id,
        collectionId: knowledgeSignals.collectionId,
        name: collections.name,
        queryKey: knowledgeSignals.subject,
        value: knowledgeSignals.value,
        evidence: knowledgeSignals.evidence,
      })
      .from(knowledgeSignals)
      .innerJoin(collections, ofCollection)
      .leftJoin(dismissals, ofDismissal)
      .where(ofKind("unanswered_question"))
      .orderBy(...order)
      .limit(knowledgeSignalsPerKind),
    // Still unread, as far as the document says: one changed since the
    // computation isn't.
    unread: db
      .select({
        ...aboutDocument,
        value: knowledgeSignals.value,
        evidence: knowledgeSignals.evidence,
        updatedAt: documents.updatedAt,
      })
      .from(knowledgeSignals)
      .innerJoin(collections, ofCollection)
      .innerJoin(documents, ofDocument)
      .leftJoin(dismissals, ofDismissal)
      .where(
        and(
          ofKind("unread_document"),
          lt(
            documents.updatedAt,
            sql`(SELECT ${computations.startedAt} FROM ${computations} WHERE ${computations.id} = ${latest})`
          )
        )
      )
      .orderBy(...order)
      .limit(knowledgeSignalsPerKind),
    // Most overdue first by the review date each document has now, which
    // may have moved since the computation: from the owner's overdue
    // signals (their index) to their documents, sorted by that date. The
    // sort holds only this owner's overdue signals.
    overdue: db
      .select({ ...aboutDocument, reviewDate: documents.reviewDate })
      .from(knowledgeSignals)
      .innerJoin(collections, ofCollection)
      .innerJoin(documents, ofDocument)
      .leftJoin(dismissals, ofDismissal)
      .where(
        and(
          ofKind("overdue_review"),
          isNotNull(documents.reviewDate),
          lt(documents.reviewDate, today)
        )
      )
      .orderBy(asc(documents.reviewDate), asc(documents.id))
      .limit(knowledgeSignalsPerKind),
  };
};

/** A document signal's row, as `signalReads` returns it. */
interface DocumentSignalRow {
  id: string;
  collectionId: string;
  name: string;
  documentId: string;
  path: string;
  title: string;
}

/** The collection and document of a document signal's row. */
const aboutOf = (row: DocumentSignalRow) => ({
  id: row.id,
  collection: {
    id: collectionIdSchema.parse(row.collectionId),
    name: row.name,
  },
  document: {
    id: documentIdSchema.parse(row.documentId),
    path: row.path,
    title: row.title,
  },
});

/**
 * The signals for `owner` of the collections `where` holds for, as of the
 * finished computation started last: read in one batch with it, so a
 * computation finishing or being cleaned up meanwhile can't change them.
 */
const signalsFor = async (
  env: Env,
  owner: string,
  where?: SQL
): Promise<KnowledgeSignals> => {
  const db = drizzle(env.KNOWLEDGE);
  const today = isoDay(new Date());
  const reads = signalReads(db, owner, where, today);
  const [computed, questions, unread, overdue] = await db.batch([
    reads.computed,
    reads.questions,
    reads.unread,
    reads.overdue,
  ]);
  const signals: KnowledgeSignal[] = [
    ...questions.flatMap((row): KnowledgeSignal[] => {
      const evidence = questionEvidenceSchema.safeParse(row.evidence);
      // One that no longer reads as a question is left out.
      if (!evidence.success || row.value === null) {
        return [];
      }
      const { value } = row;
      return [
        {
          kind: "unanswered_question",
          id: row.id,
          collection: {
            id: collectionIdSchema.parse(row.collectionId),
            name: row.name,
          },
          value,
          evidence: { queryKey: row.queryKey, ...evidence.data },
        },
      ];
    }),
    ...unread.flatMap((row): KnowledgeSignal[] => {
      const evidence = unreadEvidenceSchema.safeParse(row.evidence);
      if (!evidence.success || row.value === null) {
        return [];
      }
      const { value } = row;
      const { document, ...about } = aboutOf(row);
      return [
        {
          kind: "unread_document",
          ...about,
          value,
          evidence: {
            document,
            updatedAt: row.updatedAt.toISOString(),
            days: evidence.data.days,
          },
        },
      ];
    }),
    ...overdue.flatMap((row): KnowledgeSignal[] => {
      if (row.reviewDate === null) {
        return [];
      }
      const { document, ...about } = aboutOf(row);
      return [
        {
          kind: "overdue_review",
          ...about,
          value: daysBetween(Date.parse(row.reviewDate), Date.parse(today)),
          evidence: { document, reviewDate: row.reviewDate },
        },
      ];
    }),
  ];
  return {
    computedAt: computed[0]?.finishedAt?.toISOString() ?? null,
    signals,
  };
};

/**
 * The signals about the collections `person` owns, but those they
 * dismissed with nothing new since. Audited, never refused for it.
 */
export const listKnowledgeSignals = async (
  env: Env,
  person: Identity
): Promise<KnowledgeSignals> => {
  await keepAuditEvent(env, drizzle(env.KNOWLEDGE), {
    actor: actorOf(person),
    action: "knowledge.signals.read",
  });
  return await signalsFor(env, person.userId);
};

/**
 * The signals a chat's agent (`reader`) surfaces to its person, `owner`:
 * theirs, as `listKnowledgeSignals` has them, of only the collections the
 * agent may read, and none of a sensitive one, as the catalog holds none
 * (tools.ts): what a signal names is then nothing it couldn't read, and
 * reading it restricts no chat. The agent's call is audited with the chat.
 */
export const agentKnowledgeSignals = async (
  env: Env,
  reader: Reader,
  owner: string
): Promise<KnowledgeSignals> => {
  const db = drizzle(env.KNOWLEDGE);
  const allowed = await allowedCollections(env, db, reader);
  return await signalsFor(
    env,
    owner,
    and(allowed, eq(collections.sensitive, false))
  );
};

/**
 * Dismisses the signal `signalId`, of the latest computation, for
 * `person`, who must own its collection, until it has newer evidence:
 * audited in the same batch. Dismissing one already dismissed changes
 * nothing.
 */
export const dismissKnowledgeSignal = async (
  env: Env,
  person: Identity,
  signalId: unknown
): Promise<void> => {
  const id = knowledgeSignalErrors.parse(
    "knowledge_signal.invalid",
    knowledgeSignalIdSchema,
    signalId
  );
  const db = drizzle(env.KNOWLEDGE);
  const theirs = and(
    eq(knowledgeSignals.computation, latestFinished(computations)),
    eq(knowledgeSignals.id, id),
    eq(knowledgeSignals.owner, person.userId),
    sql`EXISTS (
      SELECT 1 FROM ${collections}
      WHERE ${collections.id} = ${knowledgeSignals.collectionId}
        AND ${collections.owner} = ${person.userId}
    )`
  );
  const [dismissed] = await auditedBatch(env, db, [
    db
      .insert(dismissals)
      .select(
        sql`SELECT ${knowledgeSignals.kind}, ${knowledgeSignals.collectionId},
            ${knowledgeSignals.subject}, ${Date.now()}
          FROM ${knowledgeSignals}
          LEFT JOIN ${dismissals} ON ${ofDismissal}
          WHERE ${theirs} AND ${shown}`
      )
      .onConflictDoUpdate({
        target: [dismissals.kind, dismissals.collectionId, dismissals.subject],
        set: { dismissedAt: sql`excluded.dismissed_at` },
      })
      .returning({ kind: dismissals.kind }),
    outboxedIfChanged(db, {
      actor: actorOf(person),
      action: "knowledge.signal.dismissed",
      target: { type: "knowledge_signal", id },
    }),
  ]);
  if (dismissed.length > 0) {
    return;
  }
  const found = await db
    .select({ id: knowledgeSignals.id })
    .from(knowledgeSignals)
    .where(theirs)
    .get();
  if (found === undefined) {
    throw knowledgeSignalErrors.create("knowledge_signal.not_found");
  }
};
