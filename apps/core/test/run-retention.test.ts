import { appIdSchema, workflowIdSchema } from "@grasp-os/shared/ids";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { callApp } from "../src/app.ts";
import { runEngine } from "../src/workflows/engine.ts";
import {
  batchesPerSweep,
  sweepRunDetails,
  sweptPerBatch,
} from "../src/workflows/retention.ts";
import { startRun } from "../src/workflows/runs.ts";
import { release, serverBuilt } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { runQuarterHourCron } from "./cron.ts";
import {
  approvalTests,
  asksOf,
  server as approvalServer,
} from "./decisions.ts";
import { mockIdp } from "./idp.ts";
import { fullScan, planOf, recordedQueries } from "./query-plans.ts";
import { racingDb } from "./racing-db.ts";
import { endLiveRuns, finished, listening, resumed, stopped } from "./runs.ts";
import { openRpc, signedInApi } from "./sign-in.ts";
import { appWith, runEvents, workflowFiles } from "./workflow-apps.ts";

// Retention of workflow runs, from its threat model (src/workflows/
// retention.ts): once a run has ended for the deployment's retention, the
// engine removes its record of it, the 15-minute cron what core and
// connect keep of it, and the run stays. Each case below is a way that
// could go wrong: a run swept too early, or while it still waits; a run
// left half swept; a swept run run again; and a reader handed a swept run
// as if nothing were missing.
//
// Runs are real, on the Workflows engine (Miniflare's), which takes the
// retention core gives each run but doesn't act on it: that Cloudflare's
// removes an ended run's record then is checked on a real account. Here
// the tests check that core asks for it, and everything core does. Time is the
// cron's own: each sweep is run for a time that many days on, as
// Cloudflare would run it then, so no test waits or sets a clock.

const idp = mockIdp();

const personApi = async (role: Role) => await signedInApi(idp, role);
type Person = Awaited<ReturnType<typeof personApi>>;

const day = 24 * 60 * 60 * 1000;

/** What a run reads, that must not outlive its retention. */
const transcript = "TRANSCRIPT the guest said the margin is 12%";

/** What readers say in place of a swept run's words, kept `days` days. */
const removed = (days: number): string =>
  `The details of this run were removed: they are kept for ${days} days after a run ends.`;

/** The time `days` from now, for the cron to run at. */
const daysOn = (days: number): Date => new Date(Date.now() + days * day);

/**
 * A workflow that keeps what it reads in all the places a run does: its
 * input, a step's result and its output. `done` counts how often its
 * side-effect step really ran.
 */
const keeps = workflowFiles(
  "keeps",
  `  const { notes = "" } = (input ?? {}) as { notes?: string };
  const read = await step.do("read", { description: "Read", input: { notes } }, async ({ input: given }) => given.notes);
  await step.do("done", { description: "Count", sideEffect: true, input: { counter: "done" } }, async ({ input: given }) => await env.APP.call("hit", given.counter));
  return { read };`,
  { read: "notes", done: 1 }
);

/**
 * A workflow that fails, quoting what it read in its error, in a step
 * keyed by what it read.
 */
const fails = workflowFiles(
  "fails",
  `  const { notes = "none" } = (input ?? {}) as { notes?: string };
  await step.do("read", { key: notes, description: "Read", input: { notes } }, async ({ input: given }) => {
    throw new Error("Couldn't read: " + given.notes);
  });
  return null;`,
  { read: null }
);

/**
 * A workflow that does a step, waits for an event, and returns what it
 * read: a live run, until it is sent `go`.
 */
const waits = workflowFiles(
  "waits",
  `  const { notes = "" } = (input ?? {}) as { notes?: string };
  const read = await step.do("work", { description: "Work" }, async () => {
    await env.APP.call("hit", "work");
    return notes;
  });
  await step.waitFor("go", { description: "Wait", type: "go", timeout: "1 day" });
  return { read };`,
  { work: "notes" }
);

/**
 * A workflow that waits for one decision, keyed by a note it read, which
 * its description quotes too, and returns how it ended.
 */
const keyedApproval = `import { workflow, z } from "@grasp-os/sdk/workflow";

export default workflow(
  "approval",
  {
    params: {},
    input: z.object({ from: z.string(), timeout: z.number(), note: z.string().optional() }),
  },
  async (step, { input, env }) =>
    await step.decision("review", {
      key: input.note ?? "none",
      description: "Approve: " + (input.note ?? "nothing"),
      from: input.from,
      ask: async ({ recipients, reminder }) => {
        await env.APP.call("remember", recipients, reminder);
      },
      timeout: input.timeout,
    })
);
`;

/** How often the App counted `name` (its server's `hit`). */
const hitsOf = async (app: string, person: Person, name: string) =>
  await callApp(
    env,
    appIdSchema.parse(app),
    { userId: person.userId, mode: "interactive" },
    "hits",
    [name]
  );

/** A run's row, as the database has it. */
const rowOf = async (run: string) =>
  await env.DB.prepare("SELECT * FROM workflow_runs WHERE id = ?")
    .bind(run)
    .first<Record<string, string | number | null>>();

/** Whether the engine still has anything of the run. */
const inEngine = async (run: string): Promise<boolean> =>
  (await runEngine(env).status(run)) !== undefined;

/** A run of `workflow` reading the transcript, once it has ended. */
const endedRun = async (person: Person, app: string, workflow: string) => {
  const run = await person.api.workflows.start(app, workflow, {
    notes: transcript,
  });
  await finished(run.id);
  return run;
};

/**
 * Rows of runs that ended `daysAgo` days ago, as old releases left them:
 * `count` of them, with nothing in the engine.
 */
const oldRuns = async (
  person: Person,
  app: string,
  count: number,
  daysAgo: number
): Promise<string[]> => {
  const ids = Array.from({ length: count }, () => crypto.randomUUID());
  const endedAt = Date.now() - daysAgo * day;
  const statement = env.DB.prepare(
    "INSERT INTO workflow_runs (id, app_id, workflow_id, version, started_by, status, created_at, ended_at) VALUES (?, ?, 'keeps', 1, ?, 'completed', ?, ?)"
  );
  await env.DB.batch(
    ids.map((id) => statement.bind(id, app, person.userId, endedAt, endedAt))
  );
  return ids;
};

/** How many of `runs` have had their details removed. */
const sweptOf = async (runs: readonly string[]): Promise<number> => {
  const { results } = await env.DB.prepare(
    "SELECT id FROM workflow_runs WHERE details_removed_at IS NOT NULL"
  ).all<{ id: string }>();
  const swept = new Set(results.map(({ id }) => id));
  return runs.filter((id) => swept.has(id)).length;
};

/** What a read says of a run's details. */
const detailsOf = ({
  output,
  error,
  failure,
  detailsRemoved,
}: {
  output?: unknown;
  error?: unknown;
  failure?: { step: string | null; error: { message: string } };
  detailsRemoved?: boolean;
}) => ({
  output,
  error,
  step: failure?.step,
  message: failure?.error.message,
  detailsRemoved,
});

describe("run retention", { timeout: 60_000 }, () => {
  afterEach(endLiveRuns);

  it("removes what an ended run read and returned once its retention is over, not a day before, and keeps the run", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, { ...keeps, ...fails });
    const done = await endedRun(builder, app, "keeps");
    const failed = await endedRun(builder, app, "fails");
    const before = {
      done: await builder.api.workflows.status(done.id),
      failed: await builder.api.workflows.status(failed.id),
    };

    await runQuarterHourCron({}, daysOn(29));
    const within = {
      done: await builder.api.workflows.status(done.id),
      failed: await builder.api.workflows.status(failed.id),
    };
    const at = daysOn(31);
    await runQuarterHourCron({}, at);
    const after = {
      done: await builder.api.workflows.status(done.id),
      failed: await builder.api.workflows.status(failed.id),
    };
    const rows = [await rowOf(done.id), await rowOf(failed.id)];
    const listed = await builder.api.workflows.list(app);
    const { runs: page } = await builder.api.workflows.runs({ app });

    expect({
      before: {
        output: before.done.output,
        step: before.failed.failure?.step,
        message: before.failed.failure?.error.message,
        error: before.failed.error?.message,
      },
      within,
      after,
      markedAt: rows.map((row) => row?.details_removed_at),
      inRows: JSON.stringify(rows).includes("TRANSCRIPT"),
      listed: listed.map(({ id, status, detailsRemoved }) => ({
        id,
        status,
        detailsRemoved,
      })),
      page: page.map(({ id, detailsRemoved }) => ({ id, detailsRemoved })),
      screen: await builder.api.screens.run(app, done.id),
      // The audit log keeps its own events of the run.
      audited: await runEvents(done.id, "workflow.run.completed"),
    }).toStrictEqual({
      before: {
        output: { read: transcript },
        step: `read:${encodeURIComponent(transcript)}`,
        message: `Couldn't read: ${transcript}`,
        error: `Couldn't read: ${transcript}`,
      },
      within: before,
      after: {
        // The run as it was, without what it returned: nothing the local
        // engine, which keeps its record, still has of it.
        done: {
          id: done.id,
          app,
          workflow: "keeps",
          version: 1,
          startedBy: { type: "person", userId: builder.userId },
          status: "completed",
          createdAt: before.done.createdAt,
          endedAt: before.done.endedAt,
          detailsRemoved: true,
        },
        // Where and how it failed, without the workflow's own words, or
        // the key it gave the step.
        failed: {
          id: failed.id,
          app,
          workflow: "fails",
          version: 1,
          startedBy: { type: "person", userId: builder.userId },
          status: "failed",
          createdAt: before.failed.createdAt,
          endedAt: before.failed.endedAt,
          detailsRemoved: true,
          failure: {
            ...before.failed.failure,
            step: "read",
            error: { code: "workflow.run_failed", message: removed(30) },
          },
        },
      },
      markedAt: [at.getTime(), at.getTime()],
      inRows: false,
      listed: [
        { id: failed.id, status: "failed", detailsRemoved: true },
        { id: done.id, status: "completed", detailsRemoved: true },
      ],
      page: [
        { id: failed.id, detailsRemoved: true },
        { id: done.id, detailsRemoved: true },
      ],
      screen: {
        id: done.id,
        app,
        workflow: "keeps",
        version: 1,
        startedBy: { type: "person", userId: builder.userId },
        status: "completed",
        createdAt: before.done.createdAt,
        endedAt: before.done.endedAt,
        detailsRemoved: true,
        waitingFor: [],
      },
      audited: [
        "workflow.run.completed",
        "workflow.run.started",
        "workflow.step.completed $params",
        "workflow.step.completed done",
        "workflow.step.completed read",
      ],
    });
  });

  it("says how long details are kept as the deployment has it when the run is read, and keeps no number in the row", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, fails);
    const failed = await endedRun(builder, app, "fails");
    const shorter = { ...env, RUN_RETENTION_DAYS: "7" };

    await runQuarterHourCron(shorter, daysOn(6));
    const within = await builder.api.workflows.status(failed.id);
    await runQuarterHourCron(shorter, daysOn(8));
    // Read where the retention is 7 days, and where it is the default.
    const { core } = await openRpc(builder.session, { coreEnv: shorter });
    const asSet = await core.authenticate().workflows.status(failed.id);
    const byDefault = await builder.api.workflows.status(failed.id);
    const row = await rowOf(failed.id);

    expect({
      within: within.failure?.error.message,
      asSet: asSet.failure?.error.message,
      byDefault: byDefault.failure?.error.message,
      removed: byDefault.detailsRemoved,
      kept: z
        .object({ error: z.object({ message: z.string() }) })
        .parse(JSON.parse(String(row?.failure))).error.message,
    }).toStrictEqual({
      within: `Couldn't read: ${transcript}`,
      asSet: removed(7),
      byDefault: removed(30),
      removed: true,
      kept: "",
    });
  });

  it("removes nothing while the deployment's retention is no number of days it may be", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, keeps);
    const old = await oldRuns(builder, app, 1, 4000);

    const invalid = [];
    // Over 30 days the engine no longer has the run's record to keep.
    for (const days of ["0", "soon", "31", "1.5"]) {
      // oxlint-disable-next-line no-await-in-loop -- one sweep after another
      await runQuarterHourCron({ RUN_RETENTION_DAYS: days });
      // oxlint-disable-next-line no-await-in-loop -- one sweep after another
      invalid.push(await sweptOf(old));
    }
    // The longest it may be.
    await runQuarterHourCron({ RUN_RETENTION_DAYS: "30" });

    expect({ invalid, valid: await sweptOf(old) }).toStrictEqual({
      invalid: [0, 0, 0, 0],
      valid: 1,
    });
  });

  it("has the engine keep each run's record for the deployment's retention, and no longer", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, keeps);
    const start = {
      app: appIdSchema.parse(app),
      workflow: workflowIdSchema.parse("keeps"),
      input: { notes: transcript },
      startedBy: builder.userId,
      actor: { type: "system" },
    } as const;

    const create = vi.spyOn(env.WORKFLOWS, "create");
    let asked: unknown[];
    try {
      const byDefault = await startRun(env, start);
      const shorter = await startRun(
        { ...env, RUN_RETENTION_DAYS: "7" },
        start
      );
      // A config core can't read: the engine keeps it as long as it may.
      const unset = await startRun(
        { ...env, RUN_RETENTION_DAYS: "soon" },
        start
      );
      asked = [byDefault, shorter, unset].map(
        ({ id }) =>
          create.mock.calls.find(([options]) => options?.id === id)?.[0]
            ?.retention
      );
      await Promise.all(
        [byDefault, shorter, unset].map(async ({ id }) => {
          await finished(id);
        })
      );
    } finally {
      create.mockRestore();
    }

    expect(asked).toStrictEqual([
      { successRetention: "30 days", errorRetention: "30 days" },
      { successRetention: "7 days", errorRetention: "7 days" },
      undefined,
    ]);
  });

  it("reads the same everywhere once its retention is over, swept or not: details removed, and nothing it returned or said", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, { ...keeps, ...fails });
    const done = await endedRun(builder, app, "keeps");
    const failed = await endedRun(builder, app, "fails");
    const before = await builder.api.workflows.status(done.id);

    // Their retention is over, and the sweep hasn't reached them: the
    // engine and their rows still have all of both.
    await env.DB.prepare(
      "UPDATE workflow_runs SET ended_at = ? WHERE id IN (?, ?)"
    )
      .bind(Date.now() - 31 * day, done.id, failed.id)
      .run();
    const status = {
      done: await builder.api.workflows.status(done.id),
      failed: await builder.api.workflows.status(failed.id),
    };
    const listed = await builder.api.workflows.list(app);
    const { runs: page } = await builder.api.workflows.runs({ app });
    const onScreen = [
      await builder.api.screens.run(app, done.id),
      await builder.api.screens.run(app, failed.id),
      ...(await builder.api.screens.runs(app, "keeps")),
      ...(await builder.api.screens.runs(app, "fails")),
    ];
    const gone = {
      output: undefined,
      error: undefined,
      step: undefined,
      message: undefined,
      detailsRemoved: true,
    };
    const goneFailed = { ...gone, step: "read", message: removed(30) };

    expect({
      before: { output: before.output, removed: before.detailsRemoved },
      status: [detailsOf(status.done), detailsOf(status.failed)],
      listed: listed.map(detailsOf),
      page: page.map(detailsOf),
      onScreen: onScreen.map(detailsOf),
      swept: await sweptOf([done.id, failed.id]),
    }).toStrictEqual({
      before: { output: { read: transcript }, removed: undefined },
      status: [gone, goneFailed],
      // Newest first: the failed run, then the one that completed.
      listed: [goneFailed, gone],
      page: [goneFailed, gone],
      onScreen: [gone, goneFailed, gone, goneFailed],
      swept: 0,
    });
  });

  it("never touches a run that hasn't ended, however long ago it started, stopped or not, and it goes on with all it did", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, waits);
    const run = await builder.api.workflows.start(app, "waits", {
      notes: transcript,
    });
    await listening(run.id, "go");
    // Started long before any retention.
    await env.DB.prepare("UPDATE workflow_runs SET created_at = ? WHERE id = ?")
      .bind(Date.now() - 400 * day, run.id)
      .run();

    // While it waits for its event.
    await runQuarterHourCron({}, daysOn(400));
    const waiting = await rowOf(run.id);
    // While it is stopped, as by a deploy or a crash.
    await stopped(run.id);
    await runQuarterHourCron({}, daysOn(400));
    const whileStopped = {
      row: await rowOf(run.id),
      engine: await inEngine(run.id),
    };
    // Resumed, it replays the step it did from the engine's record.
    await resumed(run.id);
    await finished(run.id, { type: "go", payload: null });
    const ended = await builder.api.workflows.status(run.id);

    expect({
      waiting: waiting?.details_removed_at,
      whileStopped: {
        removed: whileStopped.row?.details_removed_at,
        status: whileStopped.row?.status,
        engine: whileStopped.engine,
      },
      ended: {
        status: ended.status,
        output: ended.output,
        removed: ended.detailsRemoved,
      },
      worked: await hitsOf(app, builder, "work"),
    }).toStrictEqual({
      waiting: null,
      whileStopped: { removed: null, status: "running", engine: true },
      ended: {
        status: "completed",
        output: { read: transcript },
        removed: undefined,
      },
      worked: 1,
    });
  });

  it("leaves a decision a run still waits for as it was asked, and removes it with the run once that has ended, its key too", async () => {
    const builder = await personApi("builder");
    const decider = await personApi("user");
    const { id: app } = await builder.api.apps.create({ name: "Approvals" });
    const version = await release(builder, app, {
      "app/server.ts": approvalServer,
      "workflows/approval.ts": keyedApproval,
      "workflows/approval.workflow-tests.ts": approvalTests,
    });
    await serverBuilt(app, version);
    const run = await builder.api.workflows.start(app, "approval", {
      from: `person:${decider.userId}`,
      timeout: 7 * day,
      note: transcript,
    });
    // Asked: its decision is open.
    await asksOf(app);
    const decisionRow = async () =>
      await env.DB.prepare(
        "SELECT id, step, description, payload FROM workflow_decisions WHERE run_id = ?"
      )
        .bind(run.id)
        .first<Record<string, string | null>>();

    await runQuarterHourCron({}, daysOn(400));
    const asked = await decisionRow();
    const decision = asked?.id ?? "";
    const open = await decider.api.decisions.get(decision);
    await decider.api.decisions.answer(decision, {
      approved: true,
      payload: { comment: transcript },
    });
    await finished(run.id);
    const answered = await builder.api.workflows.status(run.id);
    await runQuarterHourCron({}, daysOn(31));
    const after = await decider.api.decisions.get(decision);
    const kept = await decisionRow();

    expect({
      asked: { step: asked?.step, description: asked?.description },
      open: { description: open.description, status: open.status },
      answered: answered.output,
      after: {
        description: after.description,
        status: after.status,
        by: after.decided?.by.userId,
      },
      kept,
      inRow: JSON.stringify(kept).includes("TRANSCRIPT"),
    }).toStrictEqual({
      asked: {
        step: `review:${encodeURIComponent(transcript)}`,
        description: `Approve: ${transcript}`,
      },
      open: { description: `Approve: ${transcript}`, status: "open" },
      // The run got the answer it waited for, payload and all.
      answered: {
        timedOut: false,
        approved: true,
        by: decider.userId,
        payload: { comment: transcript },
      },
      // Who decided, and how, stays; what was asked and sent doesn't.
      after: {
        description: removed(30),
        status: "approved",
        by: decider.userId,
      },
      // Its step keeps its name, with the decision's ID for its key.
      kept: {
        id: decision,
        step: `review:${decision}`,
        description: "",
        payload: null,
      },
      inRow: false,
    });
  });

  it("marks a run once when two sweeps run at once, and changes nothing when one runs again", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, fails);
    const failed = await endedRun(builder, app, "fails");
    const [early, late] = [daysOn(31), daysOn(32)];

    await Promise.all([
      sweepRunDetails(env, early),
      sweepRunDetails(env, late),
    ]);
    const once = await rowOf(failed.id);
    await runQuarterHourCron({}, daysOn(60));
    const again = await rowOf(failed.id);

    expect({
      at: [early.getTime(), late.getTime()].includes(
        Number(once?.details_removed_at)
      ),
      again,
    }).toStrictEqual({ at: true, again: once });
  });

  it("takes no step when a swept run is started again: its trigger finds the run, and an instance under its ID is refused", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, keeps);
    const key = `schedule:${crypto.randomUUID()}`;
    const delivery = {
      app: appIdSchema.parse(app),
      workflow: workflowIdSchema.parse("keeps"),
      input: { notes: transcript },
      startedBy: null,
      actor: { type: "system" },
      trigger: { type: "schedule", key, version: 1 },
    } as const;
    const run = await startRun(env, delivery);
    await finished(run.id);
    await runQuarterHourCron({}, daysOn(31));
    // The engine's record went as its retention ended.
    const record = await env.WORKFLOWS.get(run.id);
    await record.delete();

    // Its trigger delivered again: this run, no new one.
    const again = await startRun(env, delivery);
    // And an instance under its ID, as nothing in core creates one.
    await runEngine(env).create({
      id: run.id,
      pinned: { app: run.app, workflow: run.workflow, version: run.version },
      input: { notes: transcript },
    });
    await finished(run.id);
    const events = await allEvents();
    const { results: rows } = await env.DB.prepare(
      "SELECT id FROM workflow_runs WHERE app_id = ?"
    )
      .bind(app)
      .all();

    expect({
      again: { id: again.id, status: again.status },
      rows: rows.length,
      instance: await runEngine(env).status(run.id),
      status: await builder.api.workflows.status(run.id),
      cancelled: await builder.api.workflows.cancel(run.id),
      done: await hitsOf(app, builder, "done"),
      completed: events.filter(
        ({ action, target }) =>
          action === "workflow.run.completed" && target?.id === run.id
      ).length,
    }).toMatchObject({
      again: { id: run.id, status: "completed" },
      rows: 1,
      instance: { status: "errored" },
      // Still the run that completed, its details gone: not failed anew.
      status: { status: "completed", detailsRemoved: true },
      cancelled: { status: "completed" },
      done: 1,
      completed: 1,
    });
  });

  it("finishes a sweep that stopped before its rows were marked", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, fails);
    const failed = await endedRun(builder, app, "fails");

    // The database fails as the rows are marked, as D1 can.
    let broken = true;
    const db = racingDb(() => {
      if (broken) {
        throw new Error("D1_ERROR: broken for the test");
      }
    });
    const first = await sweepRunDetails({ ...env, DB: db }, daysOn(31)).catch(
      (error: unknown) => error
    );
    const between = await builder.api.workflows.status(failed.id);
    broken = false;
    await sweepRunDetails({ ...env, DB: db }, daysOn(31));
    const after = await builder.api.workflows.status(failed.id);

    expect({
      first: first instanceof Error && first.message,
      // Not marked, so still there in full.
      between: {
        message: between.failure?.error.message,
        removed: between.detailsRemoved,
      },
      after: {
        message: after.failure?.error.message,
        removed: after.detailsRemoved,
      },
    }).toStrictEqual({
      first: "D1_ERROR: broken for the test",
      between: { message: `Couldn't read: ${transcript}`, removed: undefined },
      after: { message: removed(30), removed: true },
    });
  });

  it("removes the instance of a cancelled run the engine never ended, and leaves one it can't remove for the next sweep, sweeping the rest", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, { ...waits, ...keeps });
    const done = await endedRun(builder, app, "keeps");
    const run = await builder.api.workflows.start(app, "waits", {
      notes: transcript,
    });
    await listening(run.id, "go");
    // A cancel whose termination failed: the row has ended, the instance
    // waits on, and the engine's own retention never starts for it.
    await env.DB.prepare(
      "UPDATE workflow_runs SET status = 'cancelled', ended_at = ? WHERE id = ?"
    )
      .bind(Date.now(), run.id)
      .run();

    // The engine fails for that run, and only for it.
    const get = env.WORKFLOWS.get.bind(env.WORKFLOWS);
    const failing = vi
      .spyOn(env.WORKFLOWS, "get")
      .mockImplementation(async (id) => {
        if (id === run.id) {
          throw new Error("The engine is unavailable");
        }
        return await get(id);
      });
    let between: unknown;
    try {
      await runQuarterHourCron({}, daysOn(31));
      between = {
        cancelled: await sweptOf([run.id]),
        other: await sweptOf([done.id]),
      };
    } finally {
      failing.mockRestore();
    }
    const stillThere = await inEngine(run.id);
    await runQuarterHourCron({}, daysOn(31));

    expect({
      between,
      stillThere,
      after: {
        cancelled: await sweptOf([run.id]),
        engine: await inEngine(run.id),
      },
    }).toStrictEqual({
      between: { cancelled: 0, other: 1 },
      stillThere: true,
      after: { cancelled: 1, engine: false },
    });
  });

  it("sweeps a bounded number of runs at a time, and the rest the next time", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, keeps);
    const perSweep = batchesPerSweep * sweptPerBatch;
    const runs = await oldRuns(builder, app, perSweep + 1, 40);

    await runQuarterHourCron();
    const first = await sweptOf(runs);
    await runQuarterHourCron();

    expect({ first, second: await sweptOf(runs) }).toStrictEqual({
      first: perSweep,
      second: perSweep + 1,
    });
  });

  it("finds the runs to sweep by an index, reading no table whole and sorting nothing", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, keeps);
    // More than a batch, so the sweep pages on from its first.
    const runs = await oldRuns(builder, app, sweptPerBatch + 3, 40);
    // A fresh D1 has no statistics: SQLite goes by the queries alone.
    const stats = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE name LIKE 'sqlite_stat%'"
    ).all();

    const queries = await recordedQueries(async () => {
      await sweepRunDetails(env, new Date());
    });
    const plans = await Promise.all(
      queries
        .filter(({ query }) => /workflow_(?:runs|decisions)/u.test(query))
        .map(async (recorded) => await planOf(recorded))
    );
    const steps = plans.flat();

    expect({
      stats: stats.results,
      swept: await sweptOf(runs),
      // The first batch, and the next from past its last run.
      byIndex: steps.filter((step) =>
        step.includes("workflow_runs_details_kept_idx")
      ).length,
      scans: steps.filter((step) => fullScan.test(step)),
      sorts: steps.filter((step) => step.includes("TEMP B-TREE")),
    }).toStrictEqual({
      stats: [],
      swept: sweptPerBatch + 3,
      byIndex: 2,
      scans: [],
      sorts: [],
    });
  });
});
