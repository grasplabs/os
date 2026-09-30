import { appIdSchema, workflowIdSchema } from "@grasp-os/shared/ids";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { callApp } from "../src/app.ts";
import { runEngine } from "../src/workflows/engine.ts";
import {
  batchesPerSweep,
  removedText,
  sweepRunDetails,
  sweptPerBatch,
} from "../src/workflows/retention.ts";
import { startRun } from "../src/workflows/runs.ts";
import { allEvents } from "./audit-events.ts";
import { runQuarterHourCron } from "./cron.ts";
import { asking } from "./decisions.ts";
import { mockIdp } from "./idp.ts";
import { fullScan, planOf, recordedQueries } from "./query-plans.ts";
import { racingDb } from "./racing-db.ts";
import { endLiveRuns, finished, listening, resumed, stopped } from "./runs.ts";
import { signedInApi } from "./sign-in.ts";
import { appWith, runEvents, workflowFiles } from "./workflow-apps.ts";

// Retention of workflow runs, from its threat model (src/workflows/
// retention.ts): once a run has ended for the deployment's retention, the
// 15-minute cron removes what it read and returned, and keeps the run.
// Each case below is a way that could go wrong: a run swept too early, or
// while it still waits; a run left half swept; a swept run run again; and
// a reader handed a swept run as if nothing were missing.
//
// Runs are real, on the Workflows engine (Miniflare's). Time is the
// cron's own: each sweep is run for a time that many days on, as
// Cloudflare would run it then, so no test waits or sets a clock.

const idp = mockIdp();

const personApi = async (role: Role) => await signedInApi(idp, role);
type Person = Awaited<ReturnType<typeof personApi>>;

const day = 24 * 60 * 60 * 1000;

/** What a run reads, that must not outlive its retention. */
const transcript = "TRANSCRIPT the guest said the margin is 12%";

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

/** A workflow that fails, quoting what it read in its error. */
const fails = workflowFiles(
  "fails",
  `  const { notes = "" } = (input ?? {}) as { notes?: string };
  await step.do("read", { description: "Read", input: { notes } }, async ({ input: given }) => {
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

/**
 * Has the engine refuse to remove the runs `refused`, as when it fails
 * for them, and remove every other as ever, until the function it
 * returns is called. With `instance`, a run the engine has, it also
 * answers for each refused run as it does for that one: for rows that
 * have nothing in the engine, which it would otherwise say are gone.
 */
const refusing = (
  refused: ReadonlySet<string>,
  instance?: string
): (() => void) => {
  const deleteBatch = env.WORKFLOWS.deleteBatch.bind(env.WORKFLOWS);
  const get = env.WORKFLOWS.get.bind(env.WORKFLOWS);
  const deletes = vi
    .spyOn(env.WORKFLOWS, "deleteBatch")
    .mockImplementation(async (ids) => {
      const others = ids.filter((id) => !refused.has(id));
      const { deleted, errors } =
        others.length === 0
          ? { deleted: [], errors: [] }
          : await deleteBatch(others);
      return {
        deleted,
        errors: [
          ...errors,
          ...ids
            .filter((id) => refused.has(id))
            .map((id) => ({ id, code: 10_001, message: "internal_server" })),
        ],
      };
    });
  const gets = vi
    .spyOn(env.WORKFLOWS, "get")
    .mockImplementation(
      async (id) =>
        await get(instance !== undefined && refused.has(id) ? instance : id)
    );
  return () => {
    deletes.mockRestore();
    gets.mockRestore();
  };
};

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
      engine: [await inEngine(done.id), await inEngine(failed.id)],
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
        message: before.failed.failure?.error.message,
        error: before.failed.error?.message,
      },
      within,
      after,
      engine: [await inEngine(done.id), await inEngine(failed.id)],
      inRows: JSON.stringify(rows).includes("TRANSCRIPT"),
      listed: listed.map(({ id, status, detailsRemovedAt }) => ({
        id,
        status,
        detailsRemovedAt,
      })),
      page: page.map(({ id, detailsRemovedAt }) => ({ id, detailsRemovedAt })),
      screen: await builder.api.screens.run(app, done.id),
      // The audit log keeps its own events of the run.
      audited: await runEvents(done.id, "workflow.run.completed"),
    }).toStrictEqual({
      before: {
        output: { read: transcript },
        message: `Couldn't read: ${transcript}`,
        error: `Couldn't read: ${transcript}`,
      },
      within: { ...before, engine: [true, true] },
      after: {
        // The run as it was, without what it returned.
        done: {
          id: done.id,
          app,
          workflow: "keeps",
          version: 1,
          startedBy: { type: "person", userId: builder.userId },
          status: "completed",
          createdAt: before.done.createdAt,
          endedAt: before.done.endedAt,
          detailsRemovedAt: at.toISOString(),
        },
        // Where and how it failed, without the workflow's own words.
        failed: {
          id: failed.id,
          app,
          workflow: "fails",
          version: 1,
          startedBy: { type: "person", userId: builder.userId },
          status: "failed",
          createdAt: before.failed.createdAt,
          endedAt: before.failed.endedAt,
          detailsRemovedAt: at.toISOString(),
          failure: {
            ...before.failed.failure,
            error: {
              code: "workflow.run_failed",
              message: removedText(30),
            },
          },
        },
      },
      engine: [false, false],
      inRows: false,
      listed: [
        {
          id: failed.id,
          status: "failed",
          detailsRemovedAt: at.toISOString(),
        },
        {
          id: done.id,
          status: "completed",
          detailsRemovedAt: at.toISOString(),
        },
      ],
      page: [
        { id: failed.id, detailsRemovedAt: at.toISOString() },
        { id: done.id, detailsRemovedAt: at.toISOString() },
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
        detailsRemovedAt: at.toISOString(),
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

  it("says how long details are kept, as the deployment set it, in place of the workflow's words", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, fails);
    const failed = await endedRun(builder, app, "fails");

    await runQuarterHourCron({ RUN_RETENTION_DAYS: "7" }, daysOn(6));
    const within = await builder.api.workflows.status(failed.id);
    await runQuarterHourCron({ RUN_RETENTION_DAYS: "7" }, daysOn(8));
    const after = await builder.api.workflows.status(failed.id);

    expect({
      within: within.failure?.error.message,
      after: after.failure?.error.message,
      removed: after.detailsRemovedAt !== undefined,
    }).toStrictEqual({
      within: `Couldn't read: ${transcript}`,
      after:
        "The details of this run were removed: they are kept for 7 days after a run ends.",
      removed: true,
    });
  });

  it("removes nothing while the deployment's retention is no number of days it may be", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, keeps);
    const old = await oldRuns(builder, app, 1, 4000);

    const invalid = [];
    for (const days of ["0", "soon", "3651", "1.5"]) {
      // oxlint-disable-next-line no-await-in-loop -- one sweep after another
      await runQuarterHourCron({ RUN_RETENTION_DAYS: days });
      // oxlint-disable-next-line no-await-in-loop -- one sweep after another
      invalid.push(await sweptOf(old));
    }
    // The longest it may be: the run ended longer ago still.
    await runQuarterHourCron({ RUN_RETENTION_DAYS: "3650" });

    expect({ invalid, valid: await sweptOf(old) }).toStrictEqual({
      invalid: [0, 0, 0, 0],
      valid: 1,
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
        removed: ended.detailsRemovedAt,
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

  it("leaves a decision a run still waits for as it was asked, and removes it with the run once that has ended", async () => {
    const builder = await personApi("builder");
    const decider = await personApi("user");
    const { run, decision } = await asking(builder, {
      from: `person:${decider.userId}`,
      timeout: 7 * day,
    });

    await runQuarterHourCron({}, daysOn(400));
    const open = await decider.api.decisions.get(decision);
    await decider.api.decisions.answer(decision, {
      approved: true,
      payload: { comment: transcript },
    });
    await finished(run.id);
    const answered = await builder.api.workflows.status(run.id);
    await runQuarterHourCron({}, daysOn(31));
    const after = await decider.api.decisions.get(decision);
    const kept = await env.DB.prepare(
      "SELECT description, payload FROM workflow_decisions WHERE id = ?"
    )
      .bind(decision)
      .first();

    expect({
      open: { description: open.description, status: open.status },
      answered: answered.output,
      after: {
        description: after.description,
        status: after.status,
        by: after.decided?.by.userId,
      },
      kept,
    }).toStrictEqual({
      open: { description: "Approve the invoice", status: "open" },
      // The run got the answer it waited for, payload and all.
      answered: {
        timedOut: false,
        approved: true,
        by: decider.userId,
        payload: { comment: transcript },
      },
      // Who decided, and how, stays; what was asked and sent doesn't.
      after: {
        description: removedText(30),
        status: "approved",
        by: decider.userId,
      },
      kept: { description: removedText(30), payload: null },
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
      engine: await inEngine(failed.id),
      again,
    }).toStrictEqual({ at: true, engine: false, again: once });
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
    const at = daysOn(31);
    await runQuarterHourCron({}, at);

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
      status: { status: "completed", detailsRemovedAt: at.toISOString() },
      cancelled: { status: "completed" },
      done: 1,
      completed: 1,
    });
  });

  it("leaves a run the engine couldn't remove, or whose row couldn't be marked, for the next sweep", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, keeps);
    const stuck = await endedRun(builder, app, "keeps");
    const unmarked = await endedRun(builder, app, "keeps");

    // The engine removes every run but one.
    const mend = refusing(new Set([stuck.id]));
    // And the database fails as the rows are marked, as D1 can.
    let broken = true;
    const db = racingDb(() => {
      if (broken) {
        throw new Error("D1_ERROR: broken for the test");
      }
    });
    let first: unknown;
    try {
      first = await sweepRunDetails({ ...env, DB: db }, daysOn(31)).catch(
        (error: unknown) => error
      );
    } finally {
      mend();
    }
    const between = {
      stuck: await builder.api.workflows.status(stuck.id),
      unmarked: await rowOf(unmarked.id),
      engine: [await inEngine(stuck.id), await inEngine(unmarked.id)],
    };
    broken = false;
    await sweepRunDetails({ ...env, DB: db }, daysOn(31));

    expect({
      first: first instanceof Error && first.message,
      between: {
        // Not removed, so still there in full.
        stuck: {
          output: between.stuck.output,
          removed: between.stuck.detailsRemovedAt,
        },
        // Removed from the engine, its row not yet saying so.
        unmarked: between.unmarked?.details_removed_at,
        engine: between.engine,
      },
      swept: await sweptOf([stuck.id, unmarked.id]),
      engine: [await inEngine(stuck.id), await inEngine(unmarked.id)],
    }).toStrictEqual({
      first: "D1_ERROR: broken for the test",
      between: {
        stuck: { output: { read: transcript }, removed: undefined },
        unmarked: null,
        engine: [true, false],
      },
      swept: 2,
      engine: [false, false],
    });
  });

  it("sweeps the runs behind a batch of runs the engine keeps refusing to remove, in the same pass", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, keeps);
    // A run the engine has, for it to answer about the refused ones with.
    const held = await endedRun(builder, app, "keeps");
    // A whole batch of them, ended longest ago: first in every pass.
    const refused = await oldRuns(builder, app, sweptPerBatch, 60);
    const behind = await oldRuns(builder, app, 3, 40);

    const mend = refusing(new Set(refused), held.id);
    let during: number[];
    try {
      await runQuarterHourCron();
      during = [await sweptOf(refused), await sweptOf(behind)];
      // Still refused by the next pass, which has nothing else to do.
      await runQuarterHourCron();
      during.push(await sweptOf(refused));
    } finally {
      mend();
    }
    await runQuarterHourCron();

    expect({ during, after: await sweptOf(refused) }).toStrictEqual({
      during: [0, 3, 0],
      after: sweptPerBatch,
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
      plans,
      scans: steps.filter((step) => fullScan.test(step)),
      sorts: steps.filter((step) => step.includes("TEMP B-TREE")),
    }).toStrictEqual({
      stats: [],
      swept: sweptPerBatch + 3,
      plans: [
        [
          "SEARCH workflow_runs USING INDEX workflow_runs_details_kept_idx (ended_at>? AND ended_at<?)",
        ],
        [
          "SEARCH workflow_runs USING INDEX sqlite_autoindex_workflow_runs_1 (id=?)",
        ],
        [
          "SEARCH workflow_decisions USING INDEX workflow_decisions_run_status_idx (run_id=?)",
        ],
        // The next batch, from past the first one's last run.
        [
          "SEARCH workflow_runs USING INDEX workflow_runs_details_kept_idx ((ended_at,id)>(?,?) AND ended_at<?)",
        ],
        [
          "SEARCH workflow_runs USING INDEX sqlite_autoindex_workflow_runs_1 (id=?)",
        ],
        [
          "SEARCH workflow_decisions USING INDEX workflow_decisions_run_status_idx (run_id=?)",
        ],
      ],
      scans: [],
      sorts: [],
    });
  });
});
