import { statisticRowsPerDay } from "@grasp-os/shared/statistics";
import { stepIdempotencyKey } from "@grasp-os/shared/workflows";

// The statistics points of a workflow run's steps (`app_statistic_steps`):
// each attempt's are kept as they are recorded (`recordStatistic`,
// statistics.ts), and added up once, when the step completes. Here: what
// a run's engine does with them, apart from statistics.ts, which the
// engine can't import.

/**
 * Adds up the points attempt `attempt` of the step `stepKey` recorded, in
 * every App whose methods recorded them, as the step completes: added to
 * their days' rows, with the step's marker (a row of no App and no
 * measure, `committed`), in one batch. Once per step: a step with its
 * marker adds nothing again, so one the engine runs again after this (it
 * stopped before it stored the step's result) counts once, whatever it
 * records then, also when it recorded nothing the first time. The host
 * calls this only for a step that called an App, the only way to record
 * a point, so other steps get no row. Points other attempts recorded,
 * one the engine gave up on included, are never added.
 *
 * The day's bound (`statisticRowsPerDay`) is checked here, exactly: of
 * the new rows the points would make, in the order of their measure and
 * dimensions, those past the bound are left out.
 */
export const commitStepStatistics = async (
  env: Env,
  stepKey: string,
  attempt: string
): Promise<void> => {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO app_statistics (app_id, measure, day, dimensions, count, sum, min, max)
       SELECT app_id, measure, day, dimensions, count, sum, min, max FROM (
         SELECT
           s.app_id, s.measure, s.day, s.dimensions, s.count, s.sum, s.min, s.max,
           a.app_id IS NOT NULL AS known,
           -- Which of the day's new rows this one would be.
           sum(a.app_id IS NULL) OVER (
             PARTITION BY s.app_id, s.day ORDER BY s.measure, s.dimensions
           ) AS nth,
           (
             SELECT count(*) FROM (
               SELECT 1 FROM app_statistics d
               WHERE d.app_id = s.app_id AND d.day = s.day LIMIT ?3
             )
           ) AS held
         FROM app_statistic_steps s
         LEFT JOIN app_statistics a
           ON a.app_id = s.app_id AND a.measure = s.measure
           AND a.day = s.day AND a.dimensions = s.dimensions
         WHERE s.step_key = ?1 AND s.attempt = ?2
           AND NOT EXISTS (
             SELECT 1 FROM app_statistic_steps c
             WHERE c.step_key = ?1 AND c.committed = 1
           )
       )
       WHERE known OR held + nth <= ?3
       ON CONFLICT (app_id, measure, day, dimensions) DO UPDATE SET
         count = count + excluded.count,
         sum = sum + excluded.sum,
         min = min(min, excluded.min),
         max = max(max, excluded.max)`
    ).bind(stepKey, attempt, statisticRowsPerDay),
    env.DB.prepare(
      `INSERT OR IGNORE INTO app_statistic_steps
         (step_key, attempt, app_id, measure, day, dimensions, count, sum, min, max, committed)
       VALUES (?, ?, '', '', '', '', 0, 0, 0, 0, 1)`
    ).bind(stepKey, attempt),
  ]);
};

/**
 * Forgets the points the steps of run `runId` recorded, once it has ended:
 * an ended run is never replayed, so none of them is added up any more.
 * None is kept after either: a point is kept only while its run hasn't
 * ended (`recordStatistic`), and the run is marked ended before this.
 */
export const forgetStepStatistics = async (
  env: Env,
  runId: string
): Promise<void> => {
  // Every key of the run's steps starts with its ID and a colon
  // (`stepIdempotencyKey`), and no other run's does: a range of the
  // primary key, up to the character after the colon.
  const first = stepIdempotencyKey(runId, "");
  await env.DB.prepare(
    "DELETE FROM app_statistic_steps WHERE step_key >= ? AND step_key < ?"
  )
    .bind(first, `${first.slice(0, -1)};`)
    .run();
};
