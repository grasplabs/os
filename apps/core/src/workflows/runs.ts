import { wrapWorkflowBinding } from "@cloudflare/dynamic-workflows";
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
import { requireBuilder } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { workflowErrors } from "@grasp-os/shared/workflows";
import type {
  RunFailure,
  RunStatus,
  WorkflowRun,
} from "@grasp-os/shared/workflows";
import { and, desc, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { versionFiles } from "../apps.ts";
import { auditedBatch, outboxed, outboxedIfChanged } from "../audit-outbox.ts";
import { apps, workflowRuns } from "../db/core/schema.ts";
import { appHost } from "../durable-objects.ts";
import { requireFeature } from "../features.ts";
import { hasWorkflow } from "./code.ts";
import type { WaitReason } from "./host.ts";

// Runs of Apps' workflows, as core keeps them: one row each (the App
// version it is pinned to, who started it, where it was last seen), next
// to the run itself in Cloudflare Workflows, under the same ID. The
// dispatcher (dispatcher.ts) loads a run from its row on every start and
// resume.

export type RunRow = typeof workflowRuns.$inferSelect;

/** The statuses of a run that hasn't ended. */
const unended: RunRow["status"][] = ["running", "paused"];

/** Most runs one `list` call returns. */
const runsPerPage = 100;

/** The most input a run starts with, as JSON text. */
const maxInputLength = 128 * 1024;

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
const workflowInputSchema = z
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
const seesDetails = (by: Identity, row: RunRow, ownerId: string): boolean =>
  by.role === "admin" || by.userId === (row.startedBy ?? ownerId);

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
  status: row.status,
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
}

/**
 * Starts a run on the App's current version, which it keeps until it ends.
 * The row and its audit event are written before the run is created, so
 * the dispatcher always finds the row; a run that can't be created is
 * marked failed, audited as a failed run.
 */
export const startRun = async (
  env: Env,
  { app, workflow, input, startedBy, actor }: RunRequest
): Promise<WorkflowRun> => {
  // Every way a run starts, a trigger's too, stops with the kill switch.
  requireFeature(env, "workflows");
  const db = drizzle(env.DB);
  const { currentVersion: version } = await appRecord(env, app);
  if (version === null) {
    throw appErrors.create("app.not_running");
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
    status: "running",
    createdAt: new Date(),
    endedAt: null,
    failure: null,
  } satisfies RunFields & typeof workflowRuns.$inferInsert;
  await auditedBatch(env, db, [
    db.insert(workflowRuns).values(row),
    outboxed(
      db,
      runEntry(actor, "workflow.run.started", row, {
        startedBy: startedBy === null ? "trigger" : "person",
      })
    ),
  ]);
  try {
    // Tagged with what the dispatcher loads it by; it reads the rest from
    // the row. Placed in the EU where the platform can.
    await wrapWorkflowBinding({ app, workflow, version }).create({
      id: row.id,
      params: input,
      locationHint: "weur",
    });
  } catch (error) {
    // The instance may exist all the same: the dispatcher refuses to run
    // a failed run's row. Its report says only that it didn't start: the
    // platform's error stays in the log.
    log.error("workflow.start_failed", {
      runId: row.id,
      ...errorFields(error),
    });
    const failedAt = new Date();
    const failure: RunFailure = {
      run: runIdSchema.parse(row.id),
      app,
      workflow,
      version,
      step: null,
      input: null,
      error: {
        code: "workflow.run_failed",
        message: "The workflow run couldn't be started.",
      },
      failedAt: failedAt.toISOString(),
    };
    await auditedBatch(env, db, [
      db
        .update(workflowRuns)
        .set({ status: "failed", endedAt: failedAt, failure })
        .where(
          and(
            eq(workflowRuns.id, row.id),
            inArray(workflowRuns.status, unended)
          )
        ),
      outboxedIfChanged(
        db,
        runEntry(runActor(row), "workflow.run.failed", row, {
          reason: "start_failed",
          error: "workflow.run_failed",
        })
      ),
    ]);
    throw error;
  }
  return toRun(row);
};

/** Starts a run of an App's workflow for the person `by`. */
export const startWorkflow = async (
  env: Env,
  by: Identity,
  app: unknown,
  workflow: unknown,
  input?: unknown
): Promise<WorkflowRun> => {
  requireBuilder(by);
  const json = parse(z.json().optional(), input);
  if (json !== undefined && JSON.stringify(json).length > maxInputLength) {
    throw invalid();
  }
  return await startRun(env, {
    app: parse(appIdSchema, app),
    workflow: parse(workflowInputSchema, workflow),
    input: json,
    startedBy: by.userId,
    actor: actorOf(by),
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
const runFor = (by: Identity, row: RunRow, ownerId: string): WorkflowRun =>
  row.failure !== null && seesDetails(by, row, ownerId)
    ? { ...toRun(row), failure: row.failure }
    : toRun(row);

/** How Workflows says it has no instance of that ID. */
const instanceNotFound = /\binstance\.not_found\b/u;

/**
 * Where Workflows has a run; nothing for one that has ended without an
 * instance to ask (its start failed), whose row says all there is.
 */
const liveOf = async (
  env: Env,
  row: RunRow
): Promise<InstanceStatus | undefined> => {
  try {
    const instance = await env.WORKFLOWS.get(row.id);
    return await instance.status();
  } catch (error) {
    if (
      unended.includes(row.status) ||
      !(error instanceof Error && instanceNotFound.test(error.message))
    ) {
      throw error;
    }
    return undefined;
  }
};

/**
 * A run as it is now: where the engine has it while core last saw it
 * running. What it returned or why it failed can hold what the run read
 * for its person, so only they and admins see it (`seesDetails`).
 */
export const runStatus = async (
  env: Env,
  by: Identity,
  run: unknown
): Promise<WorkflowRun> => {
  requireBuilder(by);
  const row = await foundRun(env, run);
  const { ownerId } = await appRecord(env, appIdSchema.parse(row.appId));
  const live = await liveOf(env, row);
  const status =
    row.status === "running" && live ? liveStatuses[live.status] : row.status;
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
  requireBuilder(by);
  const appId = parse(appIdSchema, app);
  const { ownerId } = await appRecord(env, appId);
  const rows = await drizzle(env.DB)
    .select()
    .from(workflowRuns)
    .where(eq(workflowRuns.appId, appId))
    .orderBy(desc(workflowRuns.createdAt), desc(workflowRuns.id))
    .limit(runsPerPage);
  return rows.map((row) => runFor(by, row, ownerId));
};

/** Where Cloudflare Workflows has a run someone paused or terminated. */
const stoppedStatuses = new Set<InstanceStatus["status"]>([
  "paused",
  "waitingForPause",
  "terminated",
]);

/**
 * Whether the engine has stopped the run: someone paused or terminated
 * (cancelled) its instance. Read from where the engine has the run, never
 * from an error's text, which workflow code can write. A cancelled row
 * needs no check here: `endRun` changes, and audits, only a run that
 * hasn't ended. When the instance can't be asked, it hasn't: a run that
 * failed is recorded as failed, if the engine still lets it.
 */
export const engineStopped = async (
  env: Env,
  row: RunRow
): Promise<boolean> => {
  try {
    const instance = await env.WORKFLOWS.get(row.id);
    const { status } = await instance.status();
    return stoppedStatuses.has(status);
  } catch (error) {
    log.error("workflow.status_unknown", {
      runId: row.id,
      ...errorFields(error),
    });
    return false;
  }
};

/** Drops the state writes an ended run applied (app.ts). */
const forgetWrites = async (env: Env, row: RunRow): Promise<void> => {
  await appHost(env, appIdSchema.parse(row.appId)).forgetWorkflowWrites(
    row.workflowId,
    row.id
  );
};

/** Where Cloudflare Workflows has a run that has ended. */
const endedStatuses = new Set<InstanceStatus["status"]>([
  "terminated",
  "complete",
  "errored",
]);

/** Terminates a run's instance; one that has ended already stays as it is. */
const terminate = async (env: Env, run: string): Promise<void> => {
  const instance = await env.WORKFLOWS.get(run);
  try {
    await instance.terminate();
  } catch (error) {
    const { status } = await instance.status();
    if (!endedStatuses.has(status)) {
      throw error;
    }
  }
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
  requireBuilder(by);
  const row = await foundRun(env, run);
  if (row.status === "cancelled") {
    await terminate(env, row.id);
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
  const now = cancelled ?? (await foundRun(env, row.id));
  if (now.status === "cancelled") {
    await terminate(env, row.id);
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
  await auditedBatch(env, db, [
    db
      .update(workflowRuns)
      .set({ status, endedAt, failure })
      .where(
        and(eq(workflowRuns.id, row.id), inArray(workflowRuns.status, unended))
      ),
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
  await forgetWrites(env, row);
};

/**
 * Records that a run waits (host.ts), with nothing else to change: while a
 * feature is switched off (`switched_off`), it goes on by itself once it's
 * back on; while a side effect of a step waits for the person it acts for
 * (`held`), once they decided.
 */
export const recordWaiting = async (
  env: Env,
  row: RunRow,
  why: WaitReason
): Promise<void> => {
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [
    outboxed(db, runEntry(runActor(row), "workflow.run.waiting", row, why)),
  ]);
};
