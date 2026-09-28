import { appIdSchema, workflowIdSchema } from "@grasp-os/shared/ids";
import { errorFields, log } from "@grasp-os/shared/log";
import { nextScheduledRun, workflowErrors } from "@grasp-os/shared/workflows";
import { and, asc, eq, lte } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { apps, workflowTriggers } from "../db/core/schema.ts";
import { featureEnabled } from "../features.ts";
import { startRun } from "./runs.ts";

// Starting the runs of registered triggers (trigger-registry.ts): here
// schedules; mail in inbound-email.ts.
//
// A run a trigger starts has no starter: it acts for the App's owner, and
// fails if they have left (dispatcher.ts). Its `workflow.run.started`
// event names the trigger's type, with the system as its actor. Each
// delivery carries a key of what it is for (for a schedule, the time it
// fires for), and a key starts at most one run (runs.ts): delivery is at
// least once, a start at most once per key.
//
// Schedules: core's cron trigger runs every minute and starts the runs of
// schedules due by the minute it runs for, from their rows
// (`next_run_at`). Simpler than an alarm per schedule: one query finds
// everything due, nothing is armed or disarmed when a version changes,
// and the rows are the whole state. A schedule fires to the minute, as
// cron expressions do. Its run starts first, then its next time is
// written, so a crash in between starts nothing twice: the next minute
// tries the same key again, as it does after a start that failed. A
// schedule that missed times, while triggers
// were off or the cron trigger didn't run, starts one run for them all,
// late, then goes on from the next time after. One whose parameter
// changes goes on from the next time after the change (params.ts).
//
// The `triggers` flag stops every trigger; so does `workflows`, which
// stops every run.

/** Most due schedules one cron run starts; the rest start a minute later. */
const schedulesPerRun = 50;

type DueSchedule = Pick<
  typeof workflowTriggers.$inferSelect,
  "id" | "appId" | "version" | "workflowId" | "cron" | "timeZone"
> & { nextRunAt: Date };

/** Starts the run of a due schedule, then sets when it next fires. */
const startScheduled = async (
  env: Env,
  schedule: DueSchedule,
  now: Date
): Promise<void> => {
  try {
    await startRun(env, {
      app: appIdSchema.parse(schedule.appId),
      workflow: workflowIdSchema.parse(schedule.workflowId),
      input: undefined,
      startedBy: null,
      actor: { type: "system" },
      trigger: {
        type: "schedule",
        key: `schedule:${schedule.id}:${schedule.nextRunAt.getTime()}`,
        version: schedule.version,
      },
    });
  } catch (error) {
    if (workflowErrors.codeOf(error) === "workflow.trigger_gone") {
      // Its version was replaced since the query: the batch that made
      // another current deleted its row, so nothing is left to try again.
      log.info("workflow.trigger_gone", { trigger: schedule.id });
      return;
    }
    if (workflowErrors.codeOf(error) === "workflow.start_pending") {
      // Its run is still starting, or stopped starting: the time stays
      // due, and a later minute finds it started, or starts it (runs.ts).
      log.info("workflow.start_pending", { trigger: schedule.id });
      return;
    }
    // The time stays due, so the next minute tries its key again. A run
    // whose start failed (audited as started, then as failed to start)
    // gave its key up, so that try starts the run anew.
    log.error("workflow.trigger_failed", {
      trigger: schedule.id,
      type: "schedule",
      ...errorFields(error),
    });
    return;
  }
  const next = nextScheduledRun(
    { cron: schedule.cron ?? "", timeZone: schedule.timeZone ?? "" },
    now
  );
  // Only over the time read: one changed meanwhile (params.ts) stays.
  await drizzle(env.DB)
    .update(workflowTriggers)
    .set({ nextRunAt: next ?? null })
    .where(
      and(
        eq(workflowTriggers.id, schedule.id),
        eq(workflowTriggers.nextRunAt, schedule.nextRunAt)
      )
    );
};

/**
 * Starts the runs of the schedules due by `now`, of Apps' current
 * versions. The cron trigger calls it every minute.
 */
export const startDueSchedules = async (
  env: Env,
  now = new Date()
): Promise<void> => {
  if (!(featureEnabled(env, "triggers") && featureEnabled(env, "workflows"))) {
    return;
  }
  const due = await drizzle(env.DB)
    .select({
      id: workflowTriggers.id,
      appId: workflowTriggers.appId,
      version: workflowTriggers.version,
      workflowId: workflowTriggers.workflowId,
      cron: workflowTriggers.cron,
      timeZone: workflowTriggers.timeZone,
      nextRunAt: workflowTriggers.nextRunAt,
    })
    .from(workflowTriggers)
    .innerJoin(
      apps,
      and(
        eq(apps.id, workflowTriggers.appId),
        eq(apps.currentVersion, workflowTriggers.version)
      )
    )
    .where(
      and(
        eq(workflowTriggers.type, "schedule"),
        lte(workflowTriggers.nextRunAt, now)
      )
    )
    .orderBy(asc(workflowTriggers.nextRunAt))
    .limit(schedulesPerRun);
  await Promise.all(
    due.flatMap(({ nextRunAt, ...schedule }) =>
      nextRunAt === null
        ? []
        : [startScheduled(env, { ...schedule, nextRunAt }, now)]
    )
  );
};
