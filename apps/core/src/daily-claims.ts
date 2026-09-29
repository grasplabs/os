import { and, eq, isNull, lt, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";

import type { improvementSignalComputations } from "./db/core/schema.ts";
import type { knowledgeSignalComputations } from "./db/knowledge/schema.ts";

// Claiming a UTC day's computation, for what is computed once a day from
// the 15-minute cron trigger: the improvement signals (signals.ts) and
// Knowledge's usage signals (knowledge/signals.ts). Each has a table of
// computations with the same columns (id, day, started_at, finished_at),
// one row per attempt.
//
// The first cron run of a day claims it: a claim is a row inserted only
// while the day has no finished computation, no claim younger than
// `claimLeaseMs` and fewer than `claimsPerDay` claims, in one statement,
// so two cron runs never both claim, and a computation that failed is
// claimed again once its lease is up, a few times a day at most.
//
// Each attempt has an ID of its own. A computation finishes in one batch
// that marks its row finished and deletes every computation started before
// it (Knowledge keeps the finished one before it, for its readers): one
// that outlived its lease and was finished past has lost its row, or finds
// a later one of its day finished, so its finishing batch changes nothing
// (every statement in it goes by `isFinished`). Both write their signals
// under their computation's ID, and readers read only the finished one
// started last: what one that never finishes wrote is never read, and
// where its row is gone, its writes fail on the foreign key.

/** How long a claim holds its day before another may claim it. */
// Longer than the 15 minutes between cron runs, so a run that starts a
// little early never finds a claim lapsed that is still running.
export const claimLeaseMs = 20 * 60 * 1000;

/** The most claims of one day: a computation that keeps failing stops. */
export const claimsPerDay = 3;

/** A table of daily computations. */
type Computations =
  | typeof improvementSignalComputations
  | typeof knowledgeSignalComputations;

/** A claimed computation. */
export interface Computation {
  id: string;
  /** The UTC day, such as `2026-09-29`. */
  day: string;
  startedAt: Date;
}

/** A new computation of `now`'s UTC day, to claim. */
export const newComputation = (now: Date): Computation => ({
  id: crypto.randomUUID(),
  day: now.toISOString().slice(0, 10),
  startedAt: now,
});

/** Earlier days' claims that never finished: the claim drops them. */
export const unfinishedBefore = (
  table: Computations,
  computation: Computation
): SQL | undefined =>
  and(lt(table.day, computation.day), isNull(table.finishedAt));

/**
 * The insert that claims `computation`'s day, returning its ID only if it
 * did (see above).
 */
export const claimComputation = (
  db: DrizzleD1Database,
  table: Computations,
  { id, day, startedAt }: Computation
) =>
  db
    .insert(table)
    .select(
      sql`SELECT ${id}, ${day}, ${startedAt.getTime()}, NULL
          WHERE NOT EXISTS (
            SELECT 1 FROM ${table}
            WHERE ${table.day} = ${day}
              AND (${table.finishedAt} IS NOT NULL
                OR ${table.startedAt} > ${startedAt.getTime() - claimLeaseMs})
          )
          AND (
            SELECT count(*) FROM ${table} WHERE ${table.day} = ${day}
          ) < ${claimsPerDay}`
    )
    .returning({ id: table.id });

/**
 * Marks `computation` finished, if its row is still there and no
 * computation of its day started after it has finished: one that lapsed
 * and was finished past never finishes.
 */
export const finishComputation = (
  db: DrizzleD1Database,
  table: Computations,
  computation: Computation
) =>
  db
    .update(table)
    .set({ finishedAt: new Date() })
    .where(
      and(
        eq(table.id, computation.id),
        sql`NOT EXISTS (
          SELECT 1 FROM ${table}
          WHERE ${table.day} = ${computation.day}
            AND ${table.finishedAt} IS NOT NULL
            AND ${table.startedAt} > ${computation.startedAt.getTime()}
        )`
      )
    );

/** Whether `computation` is marked finished, in the same batch. */
export const isFinished = (
  table: Computations,
  computation: Computation
): SQL => sql`EXISTS (
  SELECT 1 FROM ${table}
  WHERE ${table.id} = ${computation.id} AND ${table.finishedAt} IS NOT NULL
)`;

/** The computations started before `computation`. */
export const claimedBefore = (
  table: Computations,
  computation: Computation
): SQL | undefined => lt(table.startedAt, computation.startedAt);

/** The finished computation started last: whose results are current. */
export const latestFinished = (table: Computations): SQL => sql`(
  SELECT ${table.id} FROM ${table}
  WHERE ${table.finishedAt} IS NOT NULL
  ORDER BY ${table.startedAt} DESC, ${table.id} DESC
  LIMIT 1
)`;
