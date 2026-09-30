import { deploymentConfig } from "@grasp-os/shared/config";
import {
  runRetentionDefaultDays,
  runRetentionSchema,
} from "@grasp-os/shared/deployment-config";
import { log } from "@grasp-os/shared/log";
import { and, asc, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { workflowDecisions, workflowRuns } from "../db/core/schema.ts";
import { runEngine } from "./engine.ts";

// Retention of workflow runs. A run reads what its person may read (a
// message, a chat's transcript, a record) and keeps it: as its input, in
// what its steps returned and in its output, all with the engine; in the
// message its failure report quotes; and in what its decisions asked and
// were answered. Kept for ever, that outlives the retention of whatever
// it was read from. So once a run has ended for the deployment's
// retention (`RUN_RETENTION_DAYS`, 30 days unless set), the 15-minute cron
// trigger removes those details (`sweepRunDetails`).
//
// The run's row stays, with what it was and how it went: its ID, App,
// workflow and version, who started it, its status and times, and of a
// failed run the step, the error's code and the input's shape, none of
// which hold what the run read. So it is still listed and counted, the
// audit log's events of it still name a run there is, and its trigger key
// still stands for it: a trigger delivered again finds this run and starts
// no other. The row says when its details went (`details_removed_at`), and
// whoever reads the run is told so, never an empty answer passed off as
// the run's. The audit log is not touched: it has its own retention
// (audit-log.ts).
//
// What can go wrong, and why it doesn't:
// - A live run swept, which then goes on without the steps it finished
//   and does them again. Only a run whose row has ended is swept, by the
//   time it ended: a run that waits (for a decision, an event, a held
//   side effect, a feature switched back on), sleeps or is paused has not
//   ended, however long ago it started. And ending is final: every write
//   that ends a row is conditional on it not having ended, and none sets
//   one back, so a row read as ended stays ended while it is swept.
// - An ended run's instance still live (a cancel whose termination
//   failed). It takes no step anyway (dispatcher.ts refuses it on every
//   execution), and removing the instance stops it for good.
// - Details an approval still needs. A decision or a held side effect is
//   waited for by a run that hasn't ended, which isn't swept; once the
//   run has ended nothing takes an answer.
// - A swept run run again. Replaying needs the engine's record of its
//   steps, which is gone, so an instance under its ID would do every step
//   again. Nothing creates one: a start finds the run by its trigger key
//   and leaves it be unless it is still starting. If something did, the
//   dispatcher refuses a run whose details were removed, before any step.
// - The sweep stopped half-way, or run twice at once. The engine's record
//   goes first and the row is marked after, so a pass that stops between
//   the two leaves the run due, and the next removes what is left and
//   marks it: removing what is gone removes nothing. Marking is
//   conditional on the row not being marked, so two passes mark it once.
// - A deployment's config that doesn't parse. Nothing is removed, and it
//   is logged (`config.invalid`): never a guess at how long to keep.

const dayMs = 24 * 60 * 60 * 1000;

/**
 * Most runs swept at once. Their IDs are bound to one statement, with a
 * few values more, and D1 binds at most 100.
 */
export const sweptPerBatch = 50;

/**
 * Most batches one cron run sweeps: 500 runs every 15 minutes, 48,000 a
 * day, in ten calls to the engine.
 */
export const batchesPerSweep = 10;

/** The statuses of a run that has ended. */
const ended = ["completed", "failed", "cancelled"] as const;

/**
 * How many days an ended run keeps its details (`RUN_RETENTION_DAYS`), or
 * `undefined` if the deployment's config is invalid.
 */
export const runRetentionDays = (
  env: Pick<Env, "RUN_RETENTION_DAYS">
): number | undefined =>
  env.RUN_RETENTION_DAYS === undefined
    ? runRetentionDefaultDays
    : deploymentConfig(
        runRetentionSchema,
        "RUN_RETENTION_DAYS",
        env.RUN_RETENTION_DAYS
      );

/**
 * What stands where a swept run's own words were: its failure's message,
 * and its decisions' descriptions.
 */
export const removedText = (days: number): string =>
  `The details of this run were removed: they are kept for ${days} ${days === 1 ? "day" : "days"} after a run ends.`;

/**
 * Removes the details of runs that ended more than the retention before
 * `now`, longest ended first, read by the index of ended runs that still
 * have theirs: at most `batchesPerSweep` batches of `sweptPerBatch`, the
 * rest left to the next cron run. For each batch the engine's record goes
 * first, then, for the runs it has nothing of any more, in one batch: the
 * row is marked and its failure's message replaced, and its decisions'
 * descriptions and answers' payloads go. A run the engine couldn't remove
 * stays due and ends the pass, so it isn't asked again in the same one.
 *
 * It runs whether or not `workflows` is on: what runs kept goes when its
 * days are over. On-prem has no runs, and so never reaches the engine.
 */
export const sweepRunDetails = async (env: Env, now: Date): Promise<void> => {
  const days = runRetentionDays(env);
  if (days === undefined) {
    return;
  }
  const db = drizzle(env.DB);
  const before = new Date(now.getTime() - days * dayMs);
  const text = removedText(days);
  // The run has ended, longer ago than the retention, with its details.
  // Its status is checked on the row, not looked up (`+`): SQLite would
  // otherwise read the index by status and time, and sort what it found.
  const due = and(
    isNotNull(workflowRuns.endedAt),
    isNull(workflowRuns.detailsRemovedAt),
    lt(workflowRuns.endedAt, before),
    inArray(sql`+${workflowRuns.status}`, ended)
  );
  let removed = 0;
  let kept = 0;
  for (let batch = 0; batch < batchesPerSweep; batch += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one bounded batch after another
    const rows = await db
      .select({ id: workflowRuns.id })
      .from(workflowRuns)
      .where(due)
      .orderBy(asc(workflowRuns.endedAt))
      .limit(sweptPerBatch);
    if (rows.length === 0) {
      break;
    }
    const ids = rows.map(({ id }) => id);
    // oxlint-disable-next-line no-await-in-loop -- one bounded batch after another
    const gone = await runEngine(env).remove(ids);
    if (gone.length > 0) {
      // oxlint-disable-next-line no-await-in-loop -- one bounded batch after another
      await db.batch([
        db
          .update(workflowRuns)
          .set({
            detailsRemovedAt: now,
            // Null stays null: only a failed run has a report.
            failure: sql`json_set(${workflowRuns.failure}, '$.error.message', ${text})`,
          })
          .where(and(inArray(workflowRuns.id, gone), due)),
        db
          .update(workflowDecisions)
          .set({ description: text, payload: null })
          .where(inArray(workflowDecisions.runId, gone)),
      ]);
    }
    removed += gone.length;
    kept += ids.length - gone.length;
    if (rows.length < sweptPerBatch || gone.length < ids.length) {
      break;
    }
  }
  if (kept > 0) {
    log.error("workflow.run_details_not_removed", { runs: kept });
  }
  if (removed > 0) {
    log.info("workflow.run_details_removed", { runs: removed, days });
  }
};
