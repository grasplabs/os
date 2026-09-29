import { appErrors } from "@grasp-os/shared/apps";
import type { AuditActor, AuditEntry } from "@grasp-os/shared/audit";
import { actorOf, runActorOf } from "@grasp-os/shared/audit";
import {
  appIdSchema,
  runIdSchema,
  workflowIdSchema,
} from "@grasp-os/shared/ids";
import type { AppId, RunId, WorkflowId } from "@grasp-os/shared/ids";
import type { Json } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import type { Identity } from "@grasp-os/shared/rpc";
import { workflowErrors } from "@grasp-os/shared/workflows";
import type {
  RunFailure,
  RunStatus,
  WorkflowRun,
} from "@grasp-os/shared/workflows";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  like,
  lt,
  ne,
  or,
  sql,
} from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { appFor, versionFiles } from "../apps.ts";
import { auditedBatch, outboxed, outboxedIfChanged } from "../audit-outbox.ts";
import type { Member } from "../auth/identity.ts";
import { apps, workflowRuns } from "../db/core/schema.ts";
import { appHost } from "../durable-objects.ts";
import { featureEnabled, requireFeature } from "../features.ts";
import type { Feature } from "../features.ts";
import { hasWorkflow } from "./code.ts";
import { runEngine } from "./engine.ts";
import type { WaitReason } from "./host.ts";
import { tellScreens } from "./run-changes.ts";
import type { TriggerType } from "./trigger-registry.ts";

// Runs of Apps' workflows, as core keeps them: one row each (the App
// version it is pinned to, who started it, where it was last seen), next
// to the run itself in the engine (engine.ts), under the same ID. The
// dispatcher (dispatcher.ts) loads a run from its row on every start and
// resume.

export type RunRow = typeof workflowRuns.$inferSelect;

/**
 * The statuses of a run that hasn't ended. A run is `starting` from its
 * row until its engine instance is known to exist (`startRun`); then
 * `running`.
 */
export const unended: RunRow["status"][] = ["starting", "running", "paused"];

/** A row's status as callers see it: a run starting shows as running. */
export const shownStatus = (
  status: RunRow["status"]
): Exclude<RunRow["status"], "starting"> =>
  status === "starting" ? "running" : status;

/** Most runs one `list` call returns. */
export const runsPerPage = 100;

/** The most input a run starts with, as JSON text. */
export const maxInputLength = 128 * 1024;

const invalid = () => workflowErrors.create("workflow.invalid");

const parse = <Schema extends z.ZodType>(
  schema: Schema,
  input: unknown
): z.output<Schema> => {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw invalid();
  }
  return parsed.data;
};

/** A workflow's ID as its file names it (`workflows/<id>.ts`). */
export const workflowInputSchema = z
  .string()
  .regex(/^[A-Za-z][\w-]{0,63}$/u)
  .pipe(workflowIdSchema);

const iso = (date: Date | null): string | null => date?.toISOString() ?? null;

/**
 * Whether `by` sees what a run read, returned and failed with: an admin,
 * or the person it acts for, who started it or, for a run a trigger
 * started, the App's owner (`ownerId`, now). A failed run's report is
 * here: `status`, and `list` for all of an App's runs.
 */
export const seesDetails = (
  by: Member,
  row: RunRow,
  ownerId: string
): boolean => by.role === "admin" || by.userId === (row.startedBy ?? ownerId);

/** What a run's row holds that its callers see. */
type RunFields = Pick<
  RunRow,
  | "id"
  | "appId"
  | "workflowId"
  | "version"
  | "startedBy"
  | "status"
  | "createdAt"
  | "endedAt"
>;

/** A run as its row has it; `status` names what the row last saw. */
const toRun = (row: RunFields): WorkflowRun => ({
  id: runIdSchema.parse(row.id),
  app: appIdSchema.parse(row.appId),
  workflow: workflowIdSchema.parse(row.workflowId),
  version: row.version,
  startedBy:
    row.startedBy === null
      ? { type: "trigger" }
      : { type: "person", userId: row.startedBy },
  status: shownStatus(row.status),
  createdAt: row.createdAt.toISOString(),
  endedAt: iso(row.endedAt),
});

/** What runs need of their App: its current version and its owner. */
export const appRecord = async (
  env: Env,
  app: AppId
): Promise<{ currentVersion: number | null; ownerId: string }> => {
  const found = await drizzle(env.DB)
    .select({ currentVersion: apps.currentVersion, ownerId: apps.ownerId })
    .from(apps)
    .where(eq(apps.id, app))
    .get();
  if (!found) {
    throw appErrors.create("app.not_found");
  }
  return found;
};

/** The run's row, if there is one. */
export const findRun = async (
  env: Env,
  run: RunId
): Promise<RunRow | undefined> =>
  await drizzle(env.DB)
    .select()
    .from(workflowRuns)
    .where(eq(workflowRuns.id, run))
    .get();

/** The audit entry of something that happened to a run. */
export const runEntry = (
  actor: AuditActor,
  action: `workflow.run.${string}`,
  row: Pick<RunRow, "id" | "appId" | "workflowId" | "version">,
  detail: Record<string, string | number | boolean | null> = {}
): AuditEntry => ({
  actor,
  action,
  target: { type: "workflow_run", id: row.id },
  detail: {
    app: row.appId,
    workflow: row.workflowId,
    version: row.version,
    ...detail,
  },
});

/** The run's own actor in the audit log. */
export const runActor = (
  row: Pick<RunRow, "id" | "appId" | "workflowId">
): AuditActor =>
  runActorOf({ runId: row.id, app: row.appId, workflow: row.workflowId });

/** What starts a run: which workflow, with what input, for whom. */
export interface RunRequest {
  app: AppId;
  workflow: WorkflowId;
  input: Json | undefined;
  /**
   * The person who started it, whom it acts for; null for a trigger, and
   * the run acts for the App's owner (decision Q10).
   */
  startedBy: string | null;
  /** Who started it, for the audit log. */
  actor: AuditActor;
  /**
   * Where the person started it, when not directly: from one of the App's
   * screens (`screen`). The audit log says so (`via`).
   */
  via?: "screen";
  /**
   * The trigger that started it, with the key of what it started it for
   * (triggers.ts): while a run has that key, it is the run, and no other
   * starts. `version` is the App version that registered it: it starts a
   * run only of that version, while it is current.
   */
  trigger?: { type: TriggerType; key: string; version: number };
}

/**
 * How long a run's row may go without its engine instance before a
 * trigger delivered again creates it: longer than a start takes between
 * writing the row and creating the instance, so a start still under way
 * is left to finish.
 */
const orphanAfterMs = 60_000;

/**
 * Marks a starting run running, now that its engine instance exists
 * (`startRun`, `restartOrphan`, `failOrphans`, and the dispatcher, which
 * may run it first). Only a starting row changes: a run that ended
 * meanwhile stays as it ended.
 */
export const markRunning = async (env: Env, run: string): Promise<void> => {
  await drizzle(env.DB)
    .update(workflowRuns)
    .set({ status: "running" })
    .where(and(eq(workflowRuns.id, run), eq(workflowRuns.status, "starting")));
};

/**
 * Makes sure a triggered run found by its key has its engine instance.
 * A row still `starting` is a start under way, or one that stopped after
 * its row was written (core stopped in between):
 * - with its instance, it only hadn't recorded it: it is marked running;
 * - younger than `orphanAfterMs`, it may still be under way, so this
 *   refuses for now (`workflow.start_pending`): the delivery is tried
 *   again (a schedule stays due, mail and events are retried), and a
 *   start that stopped is caught once it's old enough;
 * - older, it creates the instance under the run's own ID and pinned
 *   version, so it is the same run, started once: two deliveries doing
 *   this at once both try, and the engine keeps one.
 * Manual starts have no key to be delivered again by, so this covers
 * only triggered runs; `failOrphans` ends the rest.
 */
const restartOrphan = async (
  env: Env,
  row: RunRow,
  input: Json | undefined
): Promise<void> => {
  if (row.status !== "starting") {
    return;
  }
  if ((await runEngine(env).status(row.id)) === undefined) {
    if (Date.now() - row.createdAt.getTime() <= orphanAfterMs) {
      throw workflowErrors.create("workflow.start_pending");
    }
    log.warn("workflow.run_restarted", { runId: row.id });
    try {
      await runEngine(env).create({
        id: row.id,
        pinned: {
          app: appIdSchema.parse(row.appId),
          workflow: workflowIdSchema.parse(row.workflowId),
          version: row.version,
        },
        input,
      });
    } catch (error) {
      // Another delivery created it first: that is the run.
      if ((await runEngine(env).status(row.id)) === undefined) {
        throw error;
      }
    }
  }
  await markRunning(env, row.id);
};

/**
 * Why a run is marked failed without having run: its engine instance
 * couldn't be created (`start_failed`, `startRun`), or it was never
 * created and the row was found alone (`no_instance`, `failOrphans`).
 * Each with the message its report says it with.
 */
const unstarted = {
  start_failed: "The workflow run couldn't be started.",
  no_instance: "The engine has no record of this run.",
} as const;

/**
 * Marks a run that didn't start as failed, for `reason`, audited as a
 * failed run, once. Only a starting run: one the dispatcher has run
 * meanwhile (`markRunning`), or that was cancelled, stays as it is. Its
 * report, which its owner sees as they see any failed run's, says only
 * that it didn't start. It gives up its trigger key, so its trigger
 * delivered again starts a new run. Whether this marked it.
 */
const failStart = async (
  env: Env,
  row: Pick<RunRow, "id" | "appId" | "workflowId" | "version">,
  reason: keyof typeof unstarted
): Promise<boolean> => {
  const db = drizzle(env.DB);
  const failedAt = new Date();
  const failure: RunFailure = {
    run: runIdSchema.parse(row.id),
    app: appIdSchema.parse(row.appId),
    workflow: workflowIdSchema.parse(row.workflowId),
    version: row.version,
    step: null,
    input: null,
    error: { code: "workflow.run_failed", message: unstarted[reason] },
    failedAt: failedAt.toISOString(),
  };
  const [[failed]] = await auditedBatch(env, db, [
    db
      .update(workflowRuns)
      .set({ status: "failed", endedAt: failedAt, failure, triggerKey: null })
      .where(
        and(eq(workflowRuns.id, row.id), eq(workflowRuns.status, "starting"))
      )
      .returning({ id: workflowRuns.id }),
    outboxedIfChanged(
      db,
      runEntry(runActor(row), "workflow.run.failed", row, {
        reason,
        error: "workflow.run_failed",
      })
    ),
  ]);
  if (!failed) {
    return false;
  }
  await tellScreens(env, row);
  return true;
};

/**
 * How long a run may stay starting before `failOrphans` ends it: well
 * past `orphanAfterMs`, so a triggered run's next delivery (a schedule's
 * is a minute on) restarts it first, with the input it was delivered
 * with.
 */
const orphanFailsAfterMs = 15 * 60_000;

/**
 * Most starting runs one `failOrphans` asks the engine about: a budget
 * for one cron run. Each one it handles stops starting, so the next cron
 * run takes the next ones.
 */
const orphansPerRun = 50;

/**
 * Ends runs still `starting` `orphanFailsAfterMs` after their row was
 * written. A start that stopped between writing the row and creating
 * the engine instance (core stopped in between) leaves one; live runs
 * are never starting, so none is looked at, however old.
 * - With its instance, the start only didn't record it: it is marked
 *   running.
 * - Without, it is marked failed (`no_instance`). It isn't restarted:
 *   its row doesn't keep its input, which only the engine does, so a
 *   person's start can't be made again as they made it; they see it
 *   failed and start it again. A triggered run gets here only if nothing
 *   delivered its trigger again in that time (triggers were off, or its
 *   version was replaced); it gives up its key, so a delivery after this
 *   starts a new run.
 *
 * Each cron run takes at most `orphansPerRun` of them, in ID order from
 * a random ID (`from`), wrapping round: rows the engine keeps failing to
 * answer for can't hold every run's budget, and every row is reached in
 * time.
 *
 * An instance created after the check (its start, or a delivery racing
 * this) finds its row failed, and the dispatcher refuses it before any
 * step (dispatcher.ts); or its first execution marked the row running
 * first, and this changes nothing. So nothing needs terminating. Rarely,
 * a delivery that `restartOrphan` answered with the run just before is
 * left with a run that failed: accepted, and audited.
 */
export const failOrphans = async (
  env: Env,
  from: string = crypto.randomUUID()
): Promise<void> => {
  // Nothing while the kill switch is on, nor on-prem, which has no engine.
  if (!featureEnabled(env, "workflows")) {
    return;
  }
  const db = drizzle(env.DB);
  const cutoff = new Date(Date.now() - orphanFailsAfterMs);
  const slice = async (side: SQL, limit: number): Promise<RunRow[]> =>
    await db
      .select()
      .from(workflowRuns)
      .where(
        and(
          eq(workflowRuns.status, "starting"),
          isNull(workflowRuns.endedAt),
          lt(workflowRuns.createdAt, cutoff),
          side
        )
      )
      .orderBy(asc(workflowRuns.id))
      .limit(limit);
  const onward = await slice(gte(workflowRuns.id, from), orphansPerRun);
  const rows =
    onward.length < orphansPerRun
      ? [
          ...onward,
          ...(await slice(
            lt(workflowRuns.id, from),
            orphansPerRun - onward.length
          )),
        ]
      : onward;
  // Each on its own: one the engine or D1 fails on is tried again by the
  // next cron run, and holds up none of the others.
  await Promise.all(
    rows.map(async (row) => {
      try {
        if ((await runEngine(env).status(row.id)) !== undefined) {
          await markRunning(env, row.id);
          return;
        }
        log.warn("workflow.run_orphaned", { runId: row.id });
        await failStart(env, row, "no_instance");
      } catch (error) {
        log.error("workflow.orphan_check_failed", {
          runId: row.id,
          ...errorFields(error),
        });
      }
    })
  );
};

/**
 * Starts a run on the App's current version, which it keeps until it ends.
 * The row and its audit event are written before the run is created, so
 * the dispatcher always finds the row. The row says `starting` until the
 * run is created, then `running`; a run that can't be created is marked
 * failed, audited as a failed run. A trigger's key already taken
 * returns the run that took it, whatever became of it since, once it has
 * its engine instance (`restartOrphan`; `workflow.start_pending` until
 * then); a run whose start failed gives its key up, so the delivery
 * tried again starts it anew. A trigger of a
 * version that is no longer current starts nothing
 * (`workflow.trigger_gone`): the version that replaced it may not declare
 * it. The run is pinned to the version checked, so at worst a trigger
 * starts its own version's run as that version is being replaced, as a
 * person starting it by hand then would. Input over
 * {@link maxInputLength} is refused (`workflow.invalid`), whoever starts it.
 */
export const startRun = async (
  env: Env,
  { app, workflow, input, startedBy, actor, via, trigger }: RunRequest
): Promise<WorkflowRun> => {
  // Every way a run starts, a trigger's too, stops with the kill switch.
  requireFeature(env, "workflows");
  if (input !== undefined && JSON.stringify(input).length > maxInputLength) {
    throw invalid();
  }
  const db = drizzle(env.DB);
  const { currentVersion: version } = await appRecord(env, app);
  if (version === null) {
    throw appErrors.create("app.not_running");
  }
  if (trigger && trigger.version !== version) {
    throw workflowErrors.create("workflow.trigger_gone");
  }
  if (!hasWorkflow(await versionFiles(env, app, version), workflow)) {
    throw workflowErrors.create("workflow.not_found", { workflow, version });
  }
  const row = {
    id: crypto.randomUUID(),
    appId: app,
    workflowId: workflow,
    version,
    startedBy,
    status: "starting",
    createdAt: new Date(),
    endedAt: null,
    failure: null,
    triggerKey: trigger?.key ?? null,
  } satisfies RunFields & typeof workflowRuns.$inferInsert;
  // Nothing is written, audit event included, for a key a run has.
  const [inserted] = await auditedBatch(env, db, [
    db
      .insert(workflowRuns)
      .values(row)
      .onConflictDoNothing({ target: workflowRuns.triggerKey })
      .returning({ id: workflowRuns.id }),
    outboxedIfChanged(
      db,
      runEntry(actor, "workflow.run.started", row, {
        startedBy: startedBy === null ? "trigger" : "person",
        ...(via === undefined ? {} : { via }),
        // The key names what started it: a time, a hash, an ID; never
        // what a message or event says.
        ...(trigger ? { trigger: trigger.type, key: trigger.key } : {}),
      })
    ),
  ]);
  if (inserted.length === 0) {
    const started = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.triggerKey, row.triggerKey ?? ""))
      .get();
    if (!started) {
      throw new Error(`No run has the trigger key of run ${row.id}`);
    }
    await restartOrphan(env, started, input);
    return toRun(started);
  }
  try {
    await runEngine(env).create({
      id: row.id,
      pinned: { app, workflow, version },
      input,
    });
  } catch (error) {
    // The instance may exist all the same: once the row is failed the
    // dispatcher refuses it, and one it ran first is running, which
    // `failStart` leaves be. Its report says only that it didn't start:
    // the platform's error stays in the log. It gives up its trigger key,
    // so the delivery tried again (a schedule stays due, mail and events
    // are retried) starts the run as a new one, rather than finding this
    // one.
    log.error("workflow.start_failed", {
      runId: row.id,
      ...errorFields(error),
    });
    await failStart(env, row, "start_failed");
    throw error;
  }
  try {
    await markRunning(env, row.id);
  } catch (error) {
    // The run exists: failing now would have it started again, twice.
    // Its row stays starting until its first execution, or the sweep
    // (`failOrphans`), finds the instance and marks it running.
    log.warn("workflow.running_not_recorded", {
      runId: row.id,
      ...errorFields(error),
    });
  }
  // Only now: a screen told of the run reads it from the engine too.
  await tellScreens(env, row);
  return toRun(row);
};

/**
 * Starts a run of an App's workflow for the person `by`; `via` says where,
 * when not directly (`RunRequest`).
 */
export const startWorkflow = async (
  env: Env,
  by: Identity,
  app: unknown,
  workflow: unknown,
  input?: unknown,
  via?: "screen"
): Promise<WorkflowRun> => {
  await appFor(env, by, app, "user");
  return await startRun(env, {
    app: parse(appIdSchema, app),
    workflow: parse(workflowInputSchema, workflow),
    input: parse(z.json().optional(), input),
    startedBy: by.userId,
    actor: actorOf(by),
    ...(via === undefined ? {} : { via }),
  });
};

/** Where Cloudflare Workflows says a run is, as a run's status. */
const liveStatuses: Record<InstanceStatus["status"], RunStatus> = {
  queued: "running",
  running: "running",
  waitingForPause: "running",
  rollingBack: "running",
  unknown: "running",
  waiting: "waiting",
  paused: "paused",
  errored: "failed",
  terminated: "cancelled",
  complete: "completed",
};

const foundRun = async (env: Env, run: unknown): Promise<RunRow> => {
  const row = await findRun(env, parse(runIdSchema, run));
  if (!row) {
    throw workflowErrors.create("workflow.run_not_found");
  }
  return row;
};

/** A run, with its failure report when `by` sees its details. */
export const runFor = (
  by: Member,
  row: RunRow,
  ownerId: string
): WorkflowRun =>
  row.failure !== null && seesDetails(by, row, ownerId)
    ? { ...toRun(row), failure: row.failure }
    : toRun(row);

/**
 * Where the engine has a run; nothing for one still starting, or that
 * has ended without an instance to ask (its start failed), whose row
 * says all there is.
 */
const liveOf = async (
  env: Env,
  row: RunRow
): Promise<InstanceStatus | undefined> => {
  const live = await runEngine(env).status(row.id);
  if (
    live === undefined &&
    (row.status === "running" || row.status === "paused")
  ) {
    throw new Error(`The engine has no instance of run ${row.id}`);
  }
  return live;
};

/**
 * A run as it is now: where the engine has it while core last saw it
 * running. What it returned or why it failed can hold what the run read
 * for its person, so only they and admins see it (`seesDetails`).
 */
export const runStatus = async (
  env: Env,
  by: Member,
  run: unknown
): Promise<WorkflowRun> => {
  const row = await foundRun(env, run);
  const { owner: ownerId } = await appFor(env, by, row.appId, "user");
  const live = await liveOf(env, row);
  const status =
    (row.status === "starting" || row.status === "running") && live
      ? liveStatuses[live.status]
      : shownStatus(row.status);
  const found = { ...runFor(by, row, ownerId), status };
  if (!(live && seesDetails(by, row, ownerId))) {
    return found;
  }
  const output = z.json().safeParse(live.output);
  return {
    ...found,
    ...(live.status === "complete" && output.success
      ? { output: output.data }
      : {}),
    ...(live.error === undefined
      ? {}
      : { error: { name: live.error.name, message: live.error.message } }),
  };
};

/** An App's runs, newest first; `app.not_found` for an App there isn't. */
export const listRuns = async (
  env: Env,
  by: Identity,
  app: unknown
): Promise<WorkflowRun[]> => {
  const appId = parse(appIdSchema, app);
  const { owner: ownerId } = await appFor(env, by, appId, "user");
  const rows = await drizzle(env.DB)
    .select()
    .from(workflowRuns)
    .where(eq(workflowRuns.appId, appId))
    .orderBy(desc(workflowRuns.createdAt), desc(workflowRuns.id))
    .limit(runsPerPage);
  return rows.map((row) => runFor(by, row, ownerId));
};

/** Drops the state writes an ended run applied (app.ts). */
const forgetWrites = async (env: Env, row: RunRow): Promise<void> => {
  await appHost(env, appIdSchema.parse(row.appId)).forgetWorkflowWrites(
    row.workflowId,
    row.id
  );
};

/**
 * Stops a run for good, and records who did; a run that ended otherwise
 * stays as it is. The row is marked first, so a run that ends meanwhile
 * can't mark itself otherwise and the dispatcher runs it no more; a cancel
 * whose termination failed is done again by cancelling again.
 */
export const cancelRun = async (
  env: Env,
  by: Identity,
  run: unknown
): Promise<WorkflowRun> => {
  const row = await foundRun(env, run);
  await appFor(env, by, row.appId, "builder");
  if (row.status === "cancelled") {
    await runEngine(env).terminate(row.id);
    await forgetWrites(env, row);
    return toRun(row);
  }
  if (!unended.includes(row.status)) {
    return toRun(row);
  }
  const db = drizzle(env.DB);
  const [[cancelled]] = await auditedBatch(env, db, [
    db
      .update(workflowRuns)
      .set({ status: "cancelled", endedAt: new Date() })
      .where(
        and(eq(workflowRuns.id, row.id), inArray(workflowRuns.status, unended))
      )
      .returning(),
    outboxedIfChanged(db, runEntry(actorOf(by), "workflow.run.cancelled", row)),
  ]);
  // Told first: a termination that fails leaves the row cancelled, and a
  // cancel tried again finds it so, and tells no one.
  if (cancelled) {
    await tellScreens(env, cancelled);
  }
  const now = cancelled ?? (await foundRun(env, row.id));
  if (now.status === "cancelled") {
    await runEngine(env).terminate(row.id);
    await forgetWrites(env, now);
  }
  return toRun(now);
};

/** What a run that stopped reports: where it stopped, and why. */
export type Stopped = Pick<RunFailure, "step" | "input" | "error">;

/**
 * Marks a run as it ended, once, with its audit event; a failed run keeps
 * its report (`failed`), for its owner to see. The audit event names only
 * the error's code (one the audit log can take, or a fixed one), never
 * its message, which workflow code writes.
 */
export const endRun = async (
  env: Env,
  row: RunRow,
  failed: Stopped | undefined
): Promise<void> => {
  const db = drizzle(env.DB);
  const endedAt = new Date();
  const status = failed === undefined ? "completed" : "failed";
  const failure: RunFailure | null =
    failed === undefined
      ? null
      : {
          run: runIdSchema.parse(row.id),
          app: appIdSchema.parse(row.appId),
          workflow: workflowIdSchema.parse(row.workflowId),
          version: row.version,
          ...failed,
          failedAt: endedAt.toISOString(),
        };
  const [[ended]] = await auditedBatch(env, db, [
    db
      .update(workflowRuns)
      .set({ status, endedAt, failure })
      .where(
        and(eq(workflowRuns.id, row.id), inArray(workflowRuns.status, unended))
      )
      .returning({ id: workflowRuns.id }),
    outboxedIfChanged(
      db,
      runEntry(
        runActor(row),
        `workflow.run.${status}`,
        row,
        failed === undefined ? {} : { error: failed.error.code }
      )
    ),
  ]);
  // Only when this ended it: not again for a run a cancel ended first.
  if (ended) {
    await tellScreens(env, row);
  }
  await forgetWrites(env, row);
};

/**
 * Records that a run waits (host.ts): while a feature is switched off
 * (`switched_off`), it goes on by itself once it's back on; while a side
 * effect of a step waits for the person it acts for (`held`), once they
 * decided.
 *
 * A held wait is recorded in a step named after the step it holds, which
 * every execution replays, so it is recorded once. A switched-off wait
 * can't count on that: an execution that starts while the feature is off
 * (a deploy, a crash, a resume) waits before the first step it replays,
 * not where the run was waiting, in steps of its own. So the run's row
 * keeps the feature it waits on (`waiting_for`), and the wait is recorded
 * only when that changes: once per wait, whatever the executions, until
 * the run goes on (`recordGoingOn`).
 *
 * A run already waiting when `waiting_for` was added has it empty, so if
 * it restarts during that wait, the wait is recorded once more. That is
 * accepted rather than backfilled: it happens at most once, only to runs
 * waiting across that deploy, and only adds an entry, never loses one.
 * (Backfilling would mean reading each run's open wait back out of the
 * audit log.)
 */
export const recordWaiting = async (
  env: Env,
  row: RunRow,
  why: WaitReason
): Promise<void> => {
  const db = drizzle(env.DB);
  const entry = runEntry(runActor(row), "workflow.run.waiting", row, why);
  if (why.reason === "held") {
    await auditedBatch(env, db, [outboxed(db, entry)]);
    return;
  }
  await auditedBatch(env, db, [
    db
      .update(workflowRuns)
      .set({ waitingFor: why.feature })
      .where(
        and(
          eq(workflowRuns.id, row.id),
          or(
            isNull(workflowRuns.waitingFor),
            ne(workflowRuns.waitingFor, why.feature)
          )
        )
      ),
    outboxedIfChanged(db, entry),
  ]);
};

/**
 * Records that a run goes on past a wait for `features`, none of them off
 * now: the next time one holds it is a new wait (`recordWaiting`).
 */
export const recordGoingOn = async (
  env: Env,
  row: RunRow,
  features: readonly Feature[]
): Promise<void> => {
  await drizzle(env.DB)
    .update(workflowRuns)
    .set({ waitingFor: null })
    .where(
      and(
        eq(workflowRuns.id, row.id),
        inArray(workflowRuns.waitingFor, [...features])
      )
    );
};

/**
 * The most runs mail, or connector events, start of one workflow in an
 * hour, each counted on its own.
 */
const triggeredRunsPerHour = 60;

const hourMs = 60 * 60 * 1000;

/**
 * Whether App `app`'s workflow `workflow` is at its hourly limit for the
 * message or event whose run has trigger key `key`: triggers of `type`
 * started `triggeredRunsPerHour` of its runs in the past hour (counted on
 * its index by App, workflow and time), and none of them is this one's. A
 * workflow that has this one's run already is never capped for it, so a
 * delivery tried again because another workflow was capped isn't refused
 * by the run it started itself. Checked before the starts, not with them,
 * so what's delivered at the same moment can go a few over.
 */
export const atHourlyCap = async (
  env: Env,
  app: string,
  workflow: string,
  key: string,
  type: "email" | "event"
): Promise<boolean> => {
  const recent = and(
    gte(workflowRuns.createdAt, new Date(Date.now() - hourMs)),
    like(workflowRuns.triggerKey, `${type}:%`)
  );
  const mine = eq(workflowRuns.triggerKey, key);
  const counted = await drizzle(env.DB)
    .select({
      runs: sql<number | null>`sum(case when ${recent} then 1 else 0 end)`,
      delivered: sql<number | null>`max(case when ${mine} then 1 else 0 end)`,
    })
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.appId, app),
        eq(workflowRuns.workflowId, workflow),
        or(recent, mine)
      )
    )
    .get();
  return (
    counted?.delivered !== 1 && (counted?.runs ?? 0) >= triggeredRunsPerHour
  );
};
