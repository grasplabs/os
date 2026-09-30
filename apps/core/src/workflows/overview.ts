import { workflowPaths } from "@grasp-os/compiler";
import { describeWorkflow } from "@grasp-os/sdk/describe";
import type { AppFiles } from "@grasp-os/shared/apps";
import { messageOf } from "@grasp-os/shared/errors";
import {
  appIdSchema,
  runIdSchema,
  workflowIdSchema,
} from "@grasp-os/shared/ids";
import type { AppId, WorkflowId } from "@grasp-os/shared/ids";
import { roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import {
  failedRunDays,
  runFilterStatuses,
  runsPageSize,
  workflowErrors,
} from "@grasp-os/shared/workflows";
import type {
  ListedRun,
  OutlineNode,
  RunFilterStatus,
  RunsPage,
  RunStatus,
  WorkflowDetail,
  WorkflowDryRun,
  WorkflowSummary,
} from "@grasp-os/shared/workflows";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { alias } from "drizzle-orm/sqlite-core";
import { z } from "zod";

import { appsReadableBy } from "../app-access.ts";
import { appFor, appsListedFor, versionFiles } from "../apps.ts";
import type { Member } from "../auth/identity.ts";
import { builtinOwner } from "../builtin-app-id.ts";
import {
  apps,
  appVersions,
  users,
  workflowDecisions,
  workflowRuns,
} from "../db/core/schema.ts";
import { answerableBy, stillOpen } from "../decisions/decisions.ts";
import { declaredParams, dryRunTests, hasWorkflow } from "./code.ts";
import { paramValues } from "./param-values.ts";
import { listParams } from "./params.ts";
import { runFor, shownStatus, unended, workflowInputSchema } from "./runs.ts";
import type { RunRow } from "./runs.ts";

// Every workflow a person can see, across Apps, and their runs: the
// Workflows page, its Runs tab and the workflow view. A person sees the
// workflows and runs of every App they can open (app-access.ts), with the
// built-ins' Apps left out, as nobody runs those. What each run shows
// them is what `list` shows for one App (`runFor`).
//
// A run waits when it hasn't ended and one of its decisions is still
// open, as answering decides it (`stillOpen`): open, and not past its
// deadline. It goes on once someone answers it, on the decision's own
// page. A run that waits otherwise (a sleep, an event, a feature switched
// off, a decision past its deadline that it hasn't timed out yet) goes on
// by itself, and counts as running.
//
// The queries are written for a D1 without statistics (a fresh one never
// has them), where SQLite picks indexes by the query's shape alone. Each
// list reads one index in the order it returns rows, and stops at a page:
// runs newest first by `workflow_runs_created_idx`, failed runs by
// `workflow_runs_status_ended_idx`, waiting runs from the open decisions
// (`workflow_decisions_status_opened_idx`), one App's runs by its own
// (`workflow_runs_app_idx`, `workflow_runs_app_workflow_idx`), runs that
// haven't ended by status. A filter that must not pick an index of its
// own is written `+column`, which SQLite never looks up by an index: so
// the list of Apps someone sees never turns a page into a sort of every
// run of those Apps. workflow-overview.test.ts checks the plans.

type Db = DrizzleD1Database;

const dayMs = 24 * 60 * 60 * 1000;

const invalid = () => workflowErrors.create("workflow.invalid");

/** An App as the lists need it, with its current version's workflows. */
interface ListedApp {
  id: AppId;
  name: string;
  ownerId: string;
  ownerName: string | null;
  currentVersion: number | null;
  /** The workflow IDs its current version's row keeps. */
  workflows: string[];
}

/**
 * The Apps `by` can open now, by name, the built-ins' left out: those they
 * have a role in (`appsListedFor`, which refuses users while `app_sharing`
 * is off) and whose data they can read (`appsReadableBy`).
 */
const visibleApps = async (env: Env, by: Member): Promise<ListedApp[]> => {
  const rows = await drizzle(env.DB)
    .select({
      id: apps.id,
      name: apps.name,
      ownerId: apps.ownerId,
      ownerName: users.name,
      currentVersion: apps.currentVersion,
      workflows: appVersions.workflows,
    })
    .from(apps)
    .leftJoin(users, eq(users.id, apps.ownerId))
    .leftJoin(
      appVersions,
      and(
        eq(appVersions.appId, apps.id),
        eq(appVersions.version, apps.currentVersion)
      )
    )
    .where(and(appsListedFor(env, by), sql`${apps.ownerId} <> ${builtinOwner}`))
    .orderBy(asc(apps.name), asc(apps.id));
  const readable = await appsReadableBy(
    env,
    by,
    rows.map(({ id }) => id)
  );
  return rows
    .filter(({ id }) => readable.has(id))
    .map((row) => ({
      ...row,
      id: appIdSchema.parse(row.id),
      // None without a current version, whose row the join doesn't find.
      workflows: row.workflows ?? [],
    }));
};

/** A list of values, as one bound JSON parameter (D1 binds at most 100). */
const listOf = (values: readonly string[]): SQL =>
  sql`(SELECT value FROM json_each(${JSON.stringify(values)}))`;

/** That a run is one of the Apps `ids`, never looked up by an index. */
const ofApps = (ids: readonly string[]): SQL =>
  sql`+${workflowRuns.appId} IN ${listOf(ids)}`;

/** That a run hasn't ended, never looked up by an index. */
const runUnended = (): SQL =>
  sql`+${workflowRuns.status} IN ${listOf(unended)}`;

/**
 * That a run has a decision someone can still answer at `now`
 * (`stillOpen`, `workflow_decisions_run_status_idx`). One past its
 * deadline that the run hasn't timed out yet doesn't count: nobody can
 * answer it, and the run goes on by itself once it times it out.
 */
const hasOpenDecision = (now: Date): SQL => sql`EXISTS (
  SELECT 1 FROM ${workflowDecisions}
  WHERE ${workflowDecisions.runId} = ${workflowRuns.id}
    AND ${stillOpen(workflowDecisions, now)}
)`;

/** That a run waits at `now`: it hasn't ended, and a decision of its is open. */
const waits = (now: Date): SQL =>
  sql`(${runUnended()} AND ${hasOpenDecision(now)})`;

interface AppWorkflow {
  app: ListedApp;
  workflow: WorkflowId;
}

/**
 * The workflows of each released App's current version, by App, then ID,
 * as the version's row keeps them: no files are read.
 */
const workflowsOf = (listed: readonly ListedApp[]): AppWorkflow[] =>
  listed.flatMap((app) =>
    app.currentVersion === null
      ? []
      : app.workflows
          .toSorted()
          .map((id) => ({ app, workflow: workflowIdSchema.parse(id) }))
  );

/** A key of an App's workflow, for looking its runs up. */
const keyOf = (app: string, workflow: string): string =>
  JSON.stringify([app, workflow]);

/** Counts by App workflow, as the grouped queries return them. */
const countsByKey = (
  rows: readonly { app: string; workflow: string; count: number }[]
): Map<string, number> =>
  new Map(
    rows.map(({ app, workflow, count }) => [keyOf(app, workflow), count])
  );

const latestRunSchema = z.object({
  id: z.string(),
  app: z.string(),
  workflow: z.string(),
  status: z.enum([
    "starting",
    "running",
    "paused",
    "completed",
    "failed",
    "cancelled",
  ]),
  createdAt: z.number(),
  waits: z.number(),
});

/**
 * Each of `workflows`' latest run, by App workflow: one query, which looks
 * each workflow's latest run up in `workflow_runs_app_workflow_idx`, read
 * newest first and stopped at one, so it reads one run a workflow however
 * many runs each has. (Ranking every run of the Apps in a window instead
 * reads, and sorts, them all.) Runs started in the same millisecond are
 * told apart by no one: either counts as the latest.
 */
const latestRuns = async (
  db: Db,
  workflows: readonly AppWorkflow[],
  now: Date
): Promise<Map<string, WorkflowSummary["lastRun"]>> => {
  const pairs = JSON.stringify(
    workflows.map(({ app, workflow }) => [app.id, workflow])
  );
  const rows = await db.all(sql`
    SELECT latest.id, latest.app_id AS app, latest.workflow_id AS workflow,
      latest.status, latest.created_at AS createdAt,
      (latest.status IN ${listOf(unended)} AND EXISTS (
        SELECT 1 FROM ${workflowDecisions}
        WHERE ${workflowDecisions.runId} = latest.id
          AND ${stillOpen(workflowDecisions, now)}
      )) AS waits
    FROM json_each(${pairs}) AS wanted
    INNER JOIN ${workflowRuns} AS latest ON latest.id = (
      SELECT id FROM ${workflowRuns}
      WHERE app_id = wanted.value ->> 0
        AND workflow_id = wanted.value ->> 1
      ORDER BY created_at DESC
      LIMIT 1
    )`);
  return new Map(
    z
      .array(latestRunSchema)
      .parse(rows)
      .map((row) => {
        const status: RunStatus =
          row.waits === 1 ? "waiting" : shownStatus(row.status);
        return [
          keyOf(row.app, row.workflow),
          {
            id: runIdSchema.parse(row.id),
            status,
            createdAt: new Date(row.createdAt).toISOString(),
          },
        ];
      })
  );
};

/**
 * The summaries of `workflows`: each one's latest run, its runs waiting
 * now (counted from the open decisions) and those failed lately (from the
 * failed runs ended since): three queries, whatever the number of
 * workflows.
 */
const summariesOf = async (
  env: Env,
  workflows: readonly AppWorkflow[]
): Promise<WorkflowSummary[]> => {
  if (workflows.length === 0) {
    return [];
  }
  const db = drizzle(env.DB);
  const appIds = [...new Set(workflows.map(({ app }) => app.id))];
  const byWorkflow = {
    app: workflowRuns.appId,
    workflow: workflowRuns.workflowId,
  };
  const now = new Date();
  const failedSince = new Date(now.getTime() - failedRunDays * dayMs);
  const [latest, waiting, failed] = await Promise.all([
    latestRuns(db, workflows, now),
    db
      .select({
        ...byWorkflow,
        count: sql<number>`count(DISTINCT ${workflowRuns.id})`,
      })
      .from(workflowDecisions)
      .innerJoin(workflowRuns, eq(workflowRuns.id, workflowDecisions.runId))
      .where(
        and(stillOpen(workflowDecisions, now), runUnended(), ofApps(appIds))
      )
      .groupBy(workflowRuns.appId, workflowRuns.workflowId),
    db
      .select({ ...byWorkflow, count: sql<number>`count(*)` })
      .from(workflowRuns)
      .where(
        and(
          eq(workflowRuns.status, "failed"),
          gte(workflowRuns.endedAt, failedSince),
          ofApps(appIds)
        )
      )
      .groupBy(workflowRuns.appId, workflowRuns.workflowId),
  ]);
  const waitingOf = countsByKey(waiting);
  const failedOf = countsByKey(failed);
  return workflows.map(({ app, workflow }) => ({
    app: app.id,
    appName: app.name,
    workflow,
    version: app.currentVersion ?? 0,
    owner: { userId: app.ownerId, name: app.ownerName },
    lastRun: latest.get(keyOf(app.id, workflow)) ?? null,
    waiting: waitingOf.get(keyOf(app.id, workflow)) ?? 0,
    failed: failedOf.get(keyOf(app.id, workflow)) ?? 0,
  }));
};

/**
 * Every workflow of the current version of every App `by` can open, by
 * App name, then workflow.
 */
export const workflowOverview = async (
  env: Env,
  by: Member,
  /** Only the workflows it keeps, left out before they are summed up. */
  keep: (app: string, workflow: string) => boolean = () => true
): Promise<WorkflowSummary[]> =>
  await summariesOf(
    env,
    workflowsOf(await visibleApps(env, by)).filter(({ app, workflow }) =>
      keep(app.id, workflow)
    )
  );

const runFilterSchema = z
  .strictObject({
    app: appIdSchema.optional(),
    workflow: workflowInputSchema.optional(),
    status: z.enum(runFilterStatuses).optional(),
  })
  .optional();

/** A run's row with its App's name, and the decision it waits for. */
type RunWithApp = RunRow & {
  appName: string;
  decision: { id: string; deciders: string } | null;
};

/** One more than a page: whether there are more tells itself. */
const pageAndOne = runsPageSize + 1;

const newestFirst = [desc(workflowRuns.createdAt), desc(workflowRuns.id)];
const latestEndedFirst = [desc(workflowRuns.endedAt), desc(workflowRuns.id)];

/**
 * Runs matching `where`, in `order` (an index's), each with its App's
 * name; a page and one.
 */
const runsWhere = async (
  db: Db,
  where: SQL | undefined,
  order: SQL[]
): Promise<RunWithApp[]> => {
  const rows = await db
    .select({ run: workflowRuns, appName: apps.name })
    .from(workflowRuns)
    .innerJoin(apps, eq(apps.id, workflowRuns.appId))
    .where(where)
    .orderBy(...order)
    .limit(pageAndOne);
  return rows.map(({ run, appName }) => ({ ...run, appName, decision: null }));
};

/**
 * Runs waiting for a decision, matching `where`, latest to wait first:
 * read from the open decisions, each run once, with its latest open
 * decision; a page and one.
 */
const waitingRuns = async (
  db: Db,
  where: SQL | undefined,
  now: Date
): Promise<RunWithApp[]> => {
  const later = alias(workflowDecisions, "later");
  const rows = await db
    .select({
      run: workflowRuns,
      appName: apps.name,
      decision: {
        id: workflowDecisions.id,
        deciders: workflowDecisions.deciders,
      },
    })
    .from(workflowDecisions)
    .innerJoin(workflowRuns, eq(workflowRuns.id, workflowDecisions.runId))
    .innerJoin(apps, eq(apps.id, workflowRuns.appId))
    .where(
      and(
        stillOpen(workflowDecisions, now),
        runUnended(),
        // Its latest open decision alone, so each run comes once.
        notExists(
          db
            .select({ one: sql`1` })
            .from(later)
            .where(
              and(
                eq(later.runId, workflowDecisions.runId),
                stillOpen(later, now),
                or(
                  gt(later.openedAt, workflowDecisions.openedAt),
                  and(
                    eq(later.openedAt, workflowDecisions.openedAt),
                    gt(later.id, workflowDecisions.id)
                  )
                )
              )
            )
        ),
        where
      )
    )
    .orderBy(desc(workflowDecisions.openedAt), desc(workflowDecisions.id))
    .limit(pageAndOne);
  return rows.map(({ run, appName, decision }) => ({
    ...run,
    appName,
    decision,
  }));
};

/**
 * For each of the waiting runs `runIds`, the latest of its open decisions
 * `by` may answer now (`answerableBy`), if any: one read of their open
 * decisions (`workflow_decisions_run_status_idx`).
 */
const answerableDecisions = async (
  env: Env,
  db: Db,
  by: Member,
  runIds: readonly string[],
  now: Date
): Promise<Map<string, string>> => {
  if (runIds.length === 0) {
    return new Map();
  }
  const open = await db
    .select({
      id: workflowDecisions.id,
      runId: workflowDecisions.runId,
      deciders: workflowDecisions.deciders,
    })
    .from(workflowDecisions)
    .where(
      and(
        sql`${workflowDecisions.runId} IN ${listOf(runIds)}`,
        stillOpen(workflowDecisions, now)
      )
    )
    .orderBy(desc(workflowDecisions.openedAt), desc(workflowDecisions.id));
  const answerable = await answerableBy(env, by, open);
  const byRun = new Map<string, string>();
  for (const { id, runId } of open) {
    if (answerable.has(id) && !byRun.has(runId)) {
      byRun.set(runId, id);
    }
  }
  return byRun;
};

/**
 * Runs `by` can see, as `input` (a `RunFilter`) narrows them: waiting
 * first, then failed (latest ended first), then the rest, newest first;
 * at most a page, and whether more matched. A run waiting for a decision
 * says so (`waiting`), with the decision when `by` may answer it now.
 */
export const listAllRuns = async (
  env: Env,
  by: Member,
  input?: unknown
): Promise<RunsPage> => {
  const parsed = runFilterSchema.safeParse(input);
  if (!parsed.success) {
    throw invalid();
  }
  const filter = parsed.data ?? {};
  if (filter.app !== undefined) {
    // As for one App's runs: an App they can't open isn't there.
    await appFor(env, by, filter.app, "user");
  }
  const visible = await visibleApps(env, by);
  const owners = new Map<string, string>(
    visible.flatMap(({ id, ownerId }) =>
      filter.app === undefined || id === filter.app ? [[id, ownerId]] : []
    )
  );
  if (filter.app !== undefined && !owners.has(filter.app)) {
    // A built-in's App, which nobody runs.
    return { runs: [], more: false };
  }
  const workflowIs = (checkedOnly: boolean): SQL | undefined => {
    if (filter.workflow === undefined) {
      return undefined;
    }
    return checkedOnly
      ? sql`+${workflowRuns.workflowId} = ${filter.workflow}`
      : eq(workflowRuns.workflowId, filter.workflow);
  };
  // Waiting and failed runs are read from their own indexes (the open
  // decisions, the failed runs by end), which the App and workflow only
  // narrow down.
  const checked = and(ofApps([...owners.keys()]), workflowIs(true));
  // The rest newest first: across Apps by `workflow_runs_created_idx`,
  // for one App by its own runs (`workflow_runs_app_idx`, or with a
  // workflow `workflow_runs_app_workflow_idx`), which hold them newest
  // first by start alone: runs started in the same millisecond come in
  // either order.
  const oneApp = filter.app;
  const [scoped, newest] =
    oneApp === undefined
      ? [checked, newestFirst]
      : [
          and(eq(workflowRuns.appId, oneApp), workflowIs(false)),
          [desc(workflowRuns.createdAt)],
        ];
  const db = drizzle(env.DB);
  const now = new Date();
  const notWaiting = sql`NOT ${waits(now)}`;
  const byStatus: Record<RunFilterStatus, () => Promise<RunWithApp[]>> = {
    waiting: async () => await waitingRuns(db, checked, now),
    failed: async () =>
      await runsWhere(
        db,
        and(eq(workflowRuns.status, "failed"), checked),
        latestEndedFirst
      ),
    // By status: runs that haven't ended are few, so sorting them costs
    // little.
    running: async () =>
      await runsWhere(
        db,
        and(
          inArray(workflowRuns.status, unended),
          sql`NOT ${hasOpenDecision(now)}`,
          scoped
        ),
        newest
      ),
    done: async () =>
      await runsWhere(
        db,
        and(sql`+${workflowRuns.status} IN ('completed', 'cancelled')`, scoped),
        newest
      ),
  };
  const rest = async () =>
    await runsWhere(
      db,
      and(sql`+${workflowRuns.status} <> 'failed'`, notWaiting, scoped),
      newest
    );
  const pages =
    filter.status === undefined
      ? await Promise.all([byStatus.waiting(), byStatus.failed(), rest()])
      : [await byStatus[filter.status]()];
  const matched = pages.flat();
  const rows = matched.slice(0, runsPageSize);
  const answering = await answerableDecisions(
    env,
    db,
    by,
    rows.flatMap(({ id, decision }) => (decision === null ? [] : [id])),
    now
  );
  return {
    runs: rows.map(({ appName, decision, ...row }): ListedRun => {
      const run = {
        ...runFor(env, by, row, owners.get(row.appId) ?? ""),
        appName,
      };
      if (decision === null) {
        return run;
      }
      const answered = answering.get(row.id);
      return answered === undefined
        ? { ...run, status: "waiting" }
        : { ...run, status: "waiting", decision: answered };
    }),
    more: matched.length > runsPageSize,
  };
};

/**
 * The outline without its code, for someone who doesn't build the App:
 * each step's description, name and kind, and the branches and loops
 * around them, without their conditions, heads, keys, parameters read or
 * literal options.
 */
const withoutCode = (nodes: readonly OutlineNode[]): OutlineNode[] =>
  nodes.map((node): OutlineNode => {
    if (node.type === "step") {
      const { key: _key, ...step } = node;
      return { ...step, params: [], options: {}, code: "" };
    }
    if (node.type === "loop") {
      return {
        ...node,
        header: "",
        params: [],
        steps: withoutCode(node.steps),
      };
    }
    return {
      ...node,
      condition: "",
      params: [],
      steps: withoutCode(node.steps),
      otherwise: withoutCode(node.otherwise),
    };
  });

/** Whether `by` builds App `app`: the check a builder's call makes. */
const buildsApp = async (
  env: Env,
  by: Identity,
  app: AppId
): Promise<boolean> => {
  try {
    await appFor(env, by, app, "builder");
    return true;
  } catch (error) {
    if (roleErrors.codeOf(error) === "role.forbidden") {
      return false;
    }
    throw error;
  }
};

/** A workflow's steps as its code reads, or why they can't be read. */
const stepsOf = (
  files: AppFiles,
  workflow: WorkflowId
): WorkflowDetail["steps"] => {
  try {
    return {
      ok: true,
      outline: describeWorkflow(files[workflowPaths(workflow).workflow] ?? ""),
    };
  } catch (error) {
    return { ok: false, message: messageOf(error) };
  }
};

/** A workflow of an App's current version, with the version's files. */
interface CurrentWorkflow {
  app: ListedApp;
  workflow: WorkflowId;
  version: number;
  files: AppFiles;
}

/**
 * Workflow `workflow` of App `app`'s current version, for `by` with at
 * least `needed` in the App.
 */
const currentWorkflow = async (
  env: Env,
  by: Identity,
  app: unknown,
  workflow: unknown,
  needed: "user" | "builder"
): Promise<CurrentWorkflow> => {
  const found = await appFor(env, by, app, needed);
  const id = workflowInputSchema.safeParse(workflow);
  if (!id.success) {
    throw invalid();
  }
  const version = found.currentVersion;
  if (version === null) {
    throw workflowErrors.create("workflow.not_found");
  }
  const files = await versionFiles(env, found.id, version);
  if (!hasWorkflow(files, id.data)) {
    throw workflowErrors.create("workflow.not_found");
  }
  const owner = await drizzle(env.DB)
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, found.owner))
    .get();
  return {
    app: {
      id: found.id,
      name: found.name,
      ownerId: found.owner,
      ownerName: owner?.name ?? null,
      currentVersion: version,
      workflows: [],
    },
    workflow: id.data,
    version,
    files,
  };
};

/**
 * One workflow of an App's current version, for anyone with a role in the
 * App; its code (the outline's conditions, options and the like) and its
 * parameters only for its builders.
 */
export const workflowDetail = async (
  env: Env,
  by: Identity,
  app: unknown,
  workflow: unknown
): Promise<WorkflowDetail> => {
  const current = await currentWorkflow(env, by, app, workflow, "user");
  const [[summary], builds] = await Promise.all([
    summariesOf(env, [current]),
    buildsApp(env, by, current.app.id),
  ]);
  if (summary === undefined) {
    throw workflowErrors.create("workflow.not_found");
  }
  const steps = stepsOf(current.files, current.workflow);
  return {
    summary,
    steps:
      builds || !steps.ok
        ? steps
        : { ok: true, outline: { steps: withoutCode(steps.outline.steps) } },
    params: builds
      ? await listParams(env, by, current.app.id, current.workflow)
      : null,
    setsParams: builds && !by.staff,
  };
};

/**
 * Dry-runs a workflow's tests at its App's current version, with the
 * parameter values set now, as that version declares them; for the App's
 * builders. It makes no state changes, and records nothing.
 */
export const dryRunWorkflow = async (
  env: Env,
  by: Identity,
  app: unknown,
  workflow: unknown
): Promise<WorkflowDryRun> => {
  const current = await currentWorkflow(env, by, app, workflow, "builder");
  const { app: found, version, files } = current;
  const values = await paramValues(
    env,
    found.id,
    current.workflow,
    await declaredParams(env, found.id, version, current.workflow, files)
  );
  return {
    version,
    runs: await dryRunTests(
      env,
      found.id,
      version,
      current.workflow,
      files,
      Object.fromEntries(values)
    ),
  };
};
