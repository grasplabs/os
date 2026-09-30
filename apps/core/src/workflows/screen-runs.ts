import { decisionErrors } from "@grasp-os/shared/decisions";
import type { DecisionView } from "@grasp-os/shared/decisions";
import { runIdSchema } from "@grasp-os/shared/ids";
import type { AppId, WorkflowId } from "@grasp-os/shared/ids";
import type { Identity } from "@grasp-os/shared/rpc";
import type { ScreenRun, WaitingDecision } from "@grasp-os/shared/screens";
import { workflowErrors } from "@grasp-os/shared/workflows";
import type { RunStatus, WorkflowRun } from "@grasp-os/shared/workflows";
import { and, desc, eq, gt, inArray } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { appFor } from "../apps.ts";
import { workflowDecisions, workflowRuns } from "../db/core/schema.ts";
import { answerableBy, answerDecision } from "../decisions/decisions.ts";
import { featureEnabled, requireFeature } from "../features.ts";
import {
  findRun,
  runFor,
  runsPerPage,
  runStatus,
  seesDetails,
  startWorkflow,
  unended,
  workflowInputSchema,
} from "./runs.ts";
import type { RunRow } from "./runs.ts";

// An App's screens and its workflows, together (`screens` in session-rpc.ts,
// through the page's bridge to one App's screen): a screen starts runs of
// its App's workflows, follows them, and answers their decisions, for the
// person using it. Within one App no permission is needed; the person needs
// a role in the App (`appFor`, as every screen call), and a decision's own
// rules decide who answers it (decisions.ts: its `from`, and never the
// run's starter unless it names exactly them).
//
// A screen acts for whoever has it open, without asking them each time:
// the App's code decides what a click starts or answers. So starts and
// answers from a screen are audited as such (`via: "screen"`), next to who
// they were for.
//
// A screen names its App's runs only: a run of another App is
// `workflow.run_not_found`, and a decision of one `decision.not_found`,
// whatever the person may do in that other App, exactly as a run or
// decision there isn't. Behind `screen_workflows`, besides `workflows`
// (and `decisions` to show or answer one).

/** A decision's name, as the workflow gives it (`step.decision(name)`). */
const decisionNameSchema = z.string().min(1).max(256);

/** Refuses while screens' calls on runs are switched off. */
export const requireScreenWorkflows = (env: Env): void => {
  requireFeature(env, "workflows");
  requireFeature(env, "screen_workflows");
};

/** A workflow's ID as a screen names it; `workflow.invalid` if it isn't one. */
export const screenWorkflow = (workflow: unknown): WorkflowId => {
  const parsed = workflowInputSchema.safeParse(workflow);
  if (!parsed.success) {
    throw workflowErrors.create("workflow.invalid");
  }
  return parsed.data;
};

/** The run `run` of `app`; `workflow.run_not_found` for any other. */
const appRun = async (env: Env, app: AppId, run: unknown): Promise<RunRow> => {
  const id = runIdSchema.safeParse(run);
  if (!id.success) {
    throw workflowErrors.create("workflow.invalid");
  }
  const row = await findRun(env, id.data);
  if (row?.appId !== app) {
    throw workflowErrors.create("workflow.run_not_found");
  }
  return row;
};

/** An open decision, as read for a screen. */
interface OpenDecision {
  id: string;
  runId: string;
  step: string;
  deciders: string;
  description: string;
  expiresAt: Date;
}

/** What a screen reads of an open decision. */
const openColumns = {
  id: workflowDecisions.id,
  runId: workflowDecisions.runId,
  step: workflowDecisions.step,
  deciders: workflowDecisions.deciders,
  description: workflowDecisions.description,
  expiresAt: workflowDecisions.expiresAt,
};

/** Open decisions of unended runs, before their deadline, as a condition. */
const openNow = (now: Date): SQL | undefined =>
  and(
    eq(workflowDecisions.status, "open"),
    gt(workflowDecisions.expiresAt, now),
    inArray(workflowRuns.status, unended)
  );

/**
 * The decisions each of `runs` waits for, as `by` sees them. A decision's
 * description is written by workflow code, and can hold what the run read
 * for its person, so it goes only to whoever sees the run's details
 * (`seesDetails`) or may answer the decision; everyone else gets its name
 * and deadline. None while `decisions` is off: nobody can answer one on a
 * screen then (`decideScreenRun`), so a run shows as running.
 */
const waitingFor = async (
  env: Env,
  by: Identity,
  owner: string,
  runs: readonly RunRow[],
  open: readonly OpenDecision[]
): Promise<Map<string, WaitingDecision[]>> => {
  if (!featureEnabled(env, "decisions")) {
    return new Map();
  }
  const detailed = new Set(
    runs.filter((row) => seesDetails(by, row, owner)).map(({ id }) => id)
  );
  const answerable = await answerableBy(
    env,
    by,
    open.filter(({ runId }) => !detailed.has(runId))
  );
  const waiting = new Map<string, WaitingDecision[]>();
  for (const decision of open) {
    const shown = detailed.has(decision.runId) || answerable.has(decision.id);
    waiting.set(decision.runId, [
      ...(waiting.get(decision.runId) ?? []),
      {
        name: decision.step,
        expiresAt: decision.expiresAt.toISOString(),
        ...(shown ? { description: decision.description } : {}),
      },
    ]);
  }
  return waiting;
};

/** The statuses of a run that has ended. */
const endedStatuses: ReadonlySet<RunStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

/**
 * A run as a screen sees it, the same whichever call read it: `waiting`
 * exactly while a decision of it is open, and `running` while it waits on
 * anything else (a sleep, a held side effect), whatever the engine calls that. An
 * ended run waits for nothing. A paused one stays paused.
 */
export const toScreenRun = (
  run: WorkflowRun,
  decisions: WaitingDecision[]
): ScreenRun => {
  if (endedStatuses.has(run.status)) {
    return { ...run, waitingFor: [] };
  }
  if (run.status === "running" || run.status === "waiting") {
    return {
      ...run,
      status: decisions.length > 0 ? "waiting" : "running",
      waitingFor: decisions,
    };
  }
  return { ...run, waitingFor: decisions };
};

/** Starts a run of the App's workflow for the person using its screen. */
export const startScreenRun = async (
  env: Env,
  by: Identity,
  app: unknown,
  workflow: unknown,
  input: unknown
): Promise<WorkflowRun> => {
  requireScreenWorkflows(env);
  return await startWorkflow(env, by, app, workflow, input, "screen");
};

/**
 * The App's latest runs of `workflow`, newest first: at most
 * `runsPerPage`, with no way to page further. Each comes with the
 * decisions it waits for now; the runs and their decisions are read in
 * one batch, so they agree with each other.
 */
export const screenRuns = async (
  env: Env,
  by: Identity,
  app: unknown,
  workflow: unknown
): Promise<ScreenRun[]> => {
  requireScreenWorkflows(env);
  const { id, owner } = await appFor(env, by, app, "user");
  const db = drizzle(env.DB);
  const ofWorkflow = and(
    eq(workflowRuns.appId, id),
    eq(workflowRuns.workflowId, screenWorkflow(workflow))
  );
  const latest = db
    .select({ id: workflowRuns.id })
    .from(workflowRuns)
    .where(ofWorkflow)
    .orderBy(desc(workflowRuns.createdAt), desc(workflowRuns.id))
    .limit(runsPerPage);
  const [rows, open] = await db.batch([
    db
      .select()
      .from(workflowRuns)
      .where(ofWorkflow)
      .orderBy(desc(workflowRuns.createdAt), desc(workflowRuns.id))
      .limit(runsPerPage),
    db
      .select(openColumns)
      .from(workflowDecisions)
      .innerJoin(workflowRuns, eq(workflowRuns.id, workflowDecisions.runId))
      .where(and(inArray(workflowDecisions.runId, latest), openNow(new Date())))
      .orderBy(workflowDecisions.openedAt, workflowDecisions.id),
  ]);
  const waiting = await waitingFor(env, by, owner, rows, open);
  return rows.map((row) =>
    toScreenRun(runFor(env, by, row, owner), waiting.get(row.id) ?? [])
  );
};

/**
 * One of the App's runs as it is now (`runStatus`), with what it waits for.
 * The run and its decisions are two reads (the engine has the one, D1 the
 * other): a change between them shows until the run is read again.
 */
export const screenRun = async (
  env: Env,
  by: Identity,
  app: unknown,
  run: unknown
): Promise<ScreenRun> => {
  requireScreenWorkflows(env);
  const { id, owner } = await appFor(env, by, app, "user");
  const row = await appRun(env, id, run);
  const found = await runStatus(env, by, row.id);
  const open = await drizzle(env.DB)
    .select(openColumns)
    .from(workflowDecisions)
    .innerJoin(workflowRuns, eq(workflowRuns.id, workflowDecisions.runId))
    .where(and(eq(workflowDecisions.runId, row.id), openNow(new Date())))
    .orderBy(workflowDecisions.openedAt, workflowDecisions.id);
  const waiting = await waitingFor(env, by, owner, [row], open);
  return toScreenRun(found, waiting.get(row.id) ?? []);
};

/**
 * Answers the decision `decision` (its name in the workflow) of the App's
 * run `run`, for the person using the screen, as the decision's page does
 * (`answerDecision`): only someone it is from, never the run's starter
 * unless it names exactly them, once, before its deadline. Audited as
 * answered on a screen.
 */
export const decideScreenRun = async (
  env: Env,
  by: Identity,
  app: unknown,
  run: unknown,
  decision: unknown,
  answer: unknown
): Promise<DecisionView> => {
  requireScreenWorkflows(env);
  requireFeature(env, "decisions");
  const { id } = await appFor(env, by, app, "user");
  const runId = runIdSchema.safeParse(run);
  if (!runId.success) {
    throw workflowErrors.create("workflow.invalid");
  }
  const name = decisionErrors.parse(
    "decision.invalid",
    decisionNameSchema,
    decision
  );
  const found = await drizzle(env.DB)
    .select({ id: workflowDecisions.id })
    .from(workflowDecisions)
    .innerJoin(workflowRuns, eq(workflowRuns.id, workflowDecisions.runId))
    .where(
      and(
        eq(workflowDecisions.runId, runId.data),
        eq(workflowDecisions.step, name),
        eq(workflowRuns.appId, id)
      )
    )
    .get();
  if (!found) {
    throw decisionErrors.create("decision.not_found");
  }
  return await answerDecision(env, by, found.id, answer, "screen");
};
