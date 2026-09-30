import { deploymentConfig } from "@grasp-os/shared/config";
import {
  runRetentionDefaultDays,
  runRetentionSchema,
} from "@grasp-os/shared/deployment-config";
import { errorFields, log } from "@grasp-os/shared/log";
import { and, asc, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";

import { workflowDecisions, workflowRuns } from "../db/core/schema.ts";
import { runEngine } from "./engine.ts";

// Retention of workflow runs. A run reads what its person may read (a
// message, a chat's transcript, a record) and keeps it: as its input, in
// what its steps returned and in its output, all with the engine; in the
// message its failure report quotes; in the key of a keyed step, which
// its failure report and its decisions name; in what its decisions asked
// and were answered; and in the input of a side effect connect still
// holds for its person. Kept for ever, that outlives the retention of
// whatever it was read from. So once a run has ended for the deployment's
// retention (`RUN_RETENTION_DAYS`, 30 days unless set, never more), the
// 15-minute cron trigger removes those details (`sweepRunDetails`).
//
// The run's row stays, with what it was and how it went: its ID, App,
// workflow and version, who started it, its status and times, and of a
// failed run the step's name, the error's code and the input's shape,
// none of which hold what the run read. So it is still listed and
// counted, the audit log's events of it still name a run there is, and
// its trigger key still stands for it: a trigger delivered again finds
// this run and starts no other. The row says when its details went
// (`details_removed_at`), and whoever reads the run is told so, never an
// empty answer passed off as the run's. What went is left empty in the
// rows; readers say why, with the retention as the deployment has it when
// they read (`removedText`), so no row keeps a number that may change.
//
// Kept, each by rules of its own, not this retention's:
// - The audit log: it has its own retention (audit-log.ts), and its
//   events of a run's steps name them as the workflow did, keys and all.
// - A chat started to fix a failed run keeps the failure report it was
//   started with, message included, as the chat's attachment
//   (workspace.ts), for as long as the chat is kept.
// - What a workflow wrote elsewhere: its App's own storage, Knowledge,
//   mail it sent.
// - The engine's records of core's own runs (Knowledge's extractions),
//   which aren't Apps' runs and have no row here.
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
//   run has ended nothing takes an answer, and connect runs no held
//   action for it (pending-actions.ts).
// - A swept run run again. Replaying needs the engine's record of its
//   steps, which is gone, so an instance under its ID would do every step
//   again. Nothing creates one: a start finds the run by its trigger key
//   and leaves it be unless it is still starting. If something did, the
//   dispatcher refuses a run whose details were removed, before any step.
// - The sweep stopped half-way, or run twice at once. The engine's record
//   goes first, then connect's held actions, and the row is marked last,
//   so a pass that stops in between leaves the run due, and the next
//   removes what is left and marks it: removing what is gone removes
//   nothing. Marking is conditional on the row not being marked, so two
//   passes mark it once.
// - Runs that can't be removed holding up every run behind them: the
//   engine refuses one, can't say whether it has it, or fails for a whole
//   batch, or connect does. A pass goes on past them (a cursor on when a
//   run ended and its ID), and a batch none of which could be removed
//   doesn't count towards the pass's batches, so however many there are
//   at the head, the runs behind them are reached. They are logged and
//   tried again by the next pass.
// - The engine dropping its record before the deployment's retention is
//   over. The retention is never longer than the engine keeps an ended
//   run on the plan deployments run on (30 days, engine.ts). Where it
//   keeps less, a completed run whose record is gone says its details
//   were removed from the first time it is read (`runStatus`), and the
//   sweep marks the rest when their days are over.
// - A deployment's config that doesn't parse. Nothing is removed, and it
//   is logged (`config.invalid`): never a guess at how long to keep.

const dayMs = 24 * 60 * 60 * 1000;

/**
 * Most runs swept at once: one call to the engine and one to connect, and
 * their IDs bound to one statement, with a few values more, of the 100 D1
 * binds.
 */
export const sweptPerBatch = 50;

/**
 * Most batches one cron run sweeps runs in: 500 runs every 15 minutes,
 * 48,000 a day. A batch none of which could be removed isn't one of them.
 */
export const batchesPerSweep = 10;

/**
 * Most batches one cron run reads in all, those it could remove nothing
 * of included: so a pass ends, however many runs can't be removed.
 */
export const maxBatchesPerSweep = 4 * batchesPerSweep;

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
 * What readers say where a swept run's own words were (its failure's
 * message, its decisions' descriptions), with the retention as the
 * deployment has it now: the rows keep nothing in their place.
 */
export const removedText = (env: Pick<Env, "RUN_RETENTION_DAYS">): string => {
  const days = runRetentionDays(env);
  if (days === undefined) {
    return "The details of this run were removed when its retention ended.";
  }
  return `The details of this run were removed: they are kept for ${days} ${days === 1 ? "day" : "days"} after a run ends.`;
};

/** An ended run that still has its details. */
const withDetails = and(
  isNotNull(workflowRuns.endedAt),
  isNull(workflowRuns.detailsRemovedAt),
  // Checked on the row, not looked up (`+`): SQLite would otherwise read
  // the index by status and time, and sort what it found.
  inArray(sql`+${workflowRuns.status}`, ended)
);

/**
 * A step's name without its key: `name:key` is how a keyed step is named
 * (the SDK's, `@grasp-os/sdk/workflow`), and the key is the run's data.
 */
const unkeyed = (step: SQL): SQL =>
  sql`CASE WHEN instr(${step}, ':') > 0 THEN substr(${step}, 1, instr(${step}, ':') - 1) ELSE ${step} END`;

/**
 * The statements that mark `runs`, those of them `where` lets through, as
 * having had their details removed at `now`, and empty what their rows
 * and their decisions' kept of them: the failure's message, and the key
 * of the step it names; each decision's description, its answer's
 * payload, and the key in its step's name, replaced by the decision's own
 * ID, since a run has one decision per step name. Only the decisions of
 * runs marked, by this batch or before.
 */
const marked = (
  db: DrizzleD1Database,
  runs: string[],
  now: Date,
  where: SQL | undefined
) => {
  const step = sql`json_extract(${workflowRuns.failure}, '$.step')`;
  return [
    db
      .update(workflowRuns)
      .set({
        detailsRemovedAt: now,
        // Null stays null: only a failed run has a report.
        failure: sql`json_set(${workflowRuns.failure}, '$.error.message', '', '$.step', ${unkeyed(step)})`,
      })
      .where(and(inArray(workflowRuns.id, runs), where)),
    db
      .update(workflowDecisions)
      .set({
        description: "",
        payload: null,
        step: sql`CASE WHEN instr(${workflowDecisions.step}, ':') > 0 THEN substr(${workflowDecisions.step}, 1, instr(${workflowDecisions.step}, ':')) || ${workflowDecisions.id} ELSE ${workflowDecisions.step} END`,
      })
      .where(
        inArray(
          workflowDecisions.runId,
          db
            .select({ id: workflowRuns.id })
            .from(workflowRuns)
            .where(
              and(
                inArray(workflowRuns.id, runs),
                isNotNull(workflowRuns.detailsRemovedAt)
              )
            )
        )
      ),
  ] as const;
};

/**
 * Marks the ended run `run`, of which the engine has nothing any more, as
 * having had its details removed at `now`, and removes what its row and
 * decisions kept of them: for a run the engine dropped by itself, before
 * the sweep reached it (`runStatus`). One marked already stays as it is.
 */
export const markDetailsRemoved = async (
  env: Env,
  run: string,
  now: Date
): Promise<void> => {
  const db = drizzle(env.DB);
  await db.batch(marked(db, [run], now, withDetails));
};

/**
 * Removes what is kept of `runs` outside core's database, and answers the
 * ones nothing is kept of any more: the engine's record, then, for the
 * runs it has none of, the side effects connect still holds for them.
 */
const removedElsewhere = async (
  env: Env,
  runs: readonly { id: string; appId: string }[]
): Promise<string[]> => {
  const gone = new Set(await runEngine(env).remove(runs.map(({ id }) => id)));
  if (gone.size === 0) {
    return [];
  }
  await env.CONNECT.dropForEndedRuns({
    runs: runs
      .filter(({ id }) => gone.has(id))
      .map(({ id, appId }) => ({ appId, runId: id })),
  });
  return [...gone];
};

/**
 * Removes the details of runs that ended more than the retention before
 * `now`, longest ended first, read by the index of ended runs that still
 * have theirs: at most `batchesPerSweep` batches of `sweptPerBatch`, the
 * rest left to the next cron run. For each batch the engine's record and
 * connect's held actions go first (`removedElsewhere`), then, for the
 * runs nothing is kept of any more, the rows are marked and emptied in
 * one batch (`marked`).
 *
 * Each batch starts past the last run of the one before, by when it ended
 * and its ID. So a run that couldn't be removed is passed over for the
 * rest of the pass, and the runs behind it are still swept: it stays due,
 * is logged, and is asked for again by the next cron run. A batch none of
 * which could be removed (the engine or connect failed for it, or refused
 * every run) isn't counted, up to `maxBatchesPerSweep` batches in all, so
 * such runs at the head, however many, don't use up the pass.
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
  // The run has ended, longer ago than the retention, with its details.
  const due = and(withDetails, lt(workflowRuns.endedAt, before));
  let removed = 0;
  let kept = 0;
  let swept = 0;
  let last: { id: string; endedAt: number } | undefined;
  for (
    let batch = 0;
    batch < maxBatchesPerSweep && swept < batchesPerSweep;
    batch += 1
  ) {
    // oxlint-disable-next-line no-await-in-loop -- one bounded batch after another
    const rows = await db
      .select({
        id: workflowRuns.id,
        appId: workflowRuns.appId,
        endedAt: sql<number>`${workflowRuns.endedAt}`,
      })
      .from(workflowRuns)
      .where(
        and(
          due,
          last &&
            sql`(${workflowRuns.endedAt}, ${workflowRuns.id}) > (${last.endedAt}, ${last.id})`
        )
      )
      .orderBy(asc(workflowRuns.endedAt), asc(workflowRuns.id))
      .limit(sweptPerBatch);
    if (rows.length === 0) {
      break;
    }
    let gone: string[] = [];
    try {
      // oxlint-disable-next-line no-await-in-loop -- one bounded batch after another
      gone = await removedElsewhere(env, rows);
    } catch (error) {
      // The engine or connect failed for the batch: none of it is marked,
      // and the pass goes on with the runs behind it.
      log.error("workflow.run_details_batch_failed", {
        runs: rows.length,
        ...errorFields(error),
      });
    }
    if (gone.length > 0) {
      // oxlint-disable-next-line no-await-in-loop -- one bounded batch after another
      await db.batch(marked(db, gone, now, due));
      swept += 1;
    }
    removed += gone.length;
    kept += rows.length - gone.length;
    if (rows.length < sweptPerBatch) {
      break;
    }
    last = rows.at(-1);
  }
  if (kept > 0) {
    log.error("workflow.run_details_not_removed", { runs: kept });
  }
  if (removed > 0) {
    log.info("workflow.run_details_removed", { runs: removed, days });
  }
};
