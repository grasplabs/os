import { appIdSchema, workflowIdSchema } from "@grasp-os/shared/ids";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { runEngine } from "../src/workflows/engine.ts";
import { failOrphans, startRun } from "../src/workflows/runs.ts";
import { allEvents } from "./audit-events.ts";
import { runCron } from "./cron.ts";
import { mockIdp } from "./idp.ts";
import { planOf, recordedQueries } from "./query-plans.ts";
import { endLiveRuns, liveStatus } from "./runs.ts";
import { signedInApi } from "./sign-in.ts";
import { appWith, runEvents, workflowFiles } from "./workflow-apps.ts";

// A run's row says `starting` until its engine instance is created. A
// start that stopped in between (core stopped) leaves a row starting
// with nothing behind it. Core's cron trigger ends such a row once it's
// old enough: failed without an instance, running with one. Live runs
// are never starting, so the sweep never looks at them.

const idp = mockIdp();

const personApi = async (role: Role) => await signedInApi(idp, role);
type Person = Awaited<ReturnType<typeof personApi>>;

const minute = 60_000;
const day = 24 * 60 * minute;

/** The sweep's query of the runs still starting. */
const sweepQuery = /from "workflow_runs" where .*"status" = \?/u;

/**
 * A workflow that does one step, then sleeps a day:
 * a live run.
 */
const waiting = workflowFiles(
  "waits",
  `  await step.do("work", { description: "Work" }, async () => null);
  await step.sleep("go", { description: "Wait", duration: "1 day" });
  return null;`,
  { work: null }
);

/** A run's row as a start leaves it that stopped `age` ago. */
const orphanOf = async (
  person: Person | null,
  app: string,
  age: number,
  triggerKey: string | null = null,
  run: string = crypto.randomUUID()
): Promise<string> => {
  await env.DB.prepare(
    "INSERT INTO workflow_runs (id, app_id, workflow_id, version, started_by, status, created_at, trigger_key) VALUES (?, ?, 'waits', 1, ?, 'starting', ?, ?)"
  )
    .bind(run, app, person?.userId ?? null, Date.now() - age, triggerKey)
    .run();
  return run;
};

/** Sets a run's row: its status, and how long ago it was written. */
const setRow = async (
  run: string,
  status: string,
  age: number
): Promise<void> => {
  await env.DB.prepare(
    "UPDATE workflow_runs SET status = ?, created_at = ? WHERE id = ?"
  )
    .bind(status, Date.now() - age, run)
    .run();
};

/** A run's status as its row has it. */
const rowStatus = async (run: string): Promise<string | undefined> => {
  const row = await env.DB.prepare(
    "SELECT status FROM workflow_runs WHERE id = ?"
  )
    .bind(run)
    .first<{ status: string }>();
  return row?.status;
};

/** Once the run's row says `status`. */
const rowSays = async (run: string, status: string): Promise<void> => {
  await vi.waitFor(
    async () => {
      await expect(rowStatus(run)).resolves.toBe(status);
    },
    { timeout: 10_000, interval: 100 }
  );
};

/** The actions of the audit events of `run`. */
const actionsOf = async (run: string): Promise<string[]> => {
  const events = await allEvents();
  return events
    .filter(({ target }) => target?.id === run)
    .map(({ action }) => action);
};

/** Whether the audit log has `run` failing. */
const failedAtAll = async (run: string): Promise<boolean> => {
  const actions = await actionsOf(run);
  return actions.includes("workflow.run.failed");
};

/** `target`'s `key`, a method bound to it, as a proxy passes it through. */
const through = (target: object, key: PropertyKey): unknown => {
  const value: unknown = Reflect.get(target, key);
  if (typeof value !== "function") {
    return value;
  }
  const bound: unknown = value.bind(target);
  return bound;
};

/** What runs a statement against the database. */
const statementRuns = new Set<PropertyKey>(["run", "all", "raw", "first"]);

/** Marking a starting run running, as drizzle writes it. */
const marksRunning = 'update "workflow_runs" set "status" = ? where ';

/**
 * Core's database, refusing to mark a starting run running, as D1 can
 * (overloaded, timed out); everything else goes through. `refused` counts
 * the writes it refused.
 */
const refusingRunning = (): { db: D1Database; refused: () => number } => {
  let refused = 0;
  const refusing = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get: (target, key) => {
        if (statementRuns.has(key)) {
          return async () => {
            refused += 1;
            await Promise.resolve();
            throw new Error("D1_ERROR: broken for the test");
          };
        }
        if (key === "bind") {
          return (...values: unknown[]) => refusing(target.bind(...values));
        }
        return through(target, key);
      },
    });
  const db = new Proxy(env.DB, {
    get: (target, key) => {
      if (key === "prepare") {
        return (query: string) => {
          const statement = target.prepare(query);
          return query.startsWith(marksRunning)
            ? refusing(statement)
            : statement;
        };
      }
      return through(target, key);
    },
  });
  return { db, refused: () => refused };
};

const endedStatuses = new Set(["complete", "errored", "terminated"]);

/** The run's engine instance, created as its start would have. */
const createInstance = async (app: string, run: string): Promise<void> => {
  await runEngine(env).create({
    id: run,
    pinned: {
      app: appIdSchema.parse(app),
      workflow: workflowIdSchema.parse("waits"),
      version: 1,
    },
    input: undefined,
  });
};

describe("runs that never reached the engine", () => {
  afterEach(endLiveRuns);

  it("are marked failed once they're old enough, however long ago, audited once, for their person to see", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, waiting);
    const orphan = await orphanOf(builder, app, 20 * minute);
    // Left by a start as core went down for a month.
    const afterOutage = await orphanOf(builder, app, 30 * day);
    const young = await orphanOf(builder, app, 2 * minute);

    await runCron();
    const { status, failure } = await builder.api.workflows.status(orphan);
    const outage = await builder.api.workflows.status(afterOutage);
    const youngShown = await builder.api.workflows.status(young);
    // Once more: it is marked, and audited, once.
    await runCron();

    expect({
      status,
      error: failure?.error,
      outage: outage.status,
      // Its start may still be under way, or a delivery restart it; it
      // shows as running meanwhile.
      young: await rowStatus(young),
      youngShown: youngShown.status,
      audited: await runEvents(orphan, "workflow.run.failed"),
    }).toStrictEqual({
      status: "failed",
      error: {
        code: "workflow.run_failed",
        message: "The engine has no record of this run.",
      },
      outage: "failed",
      young: "starting",
      youngShown: "running",
      // Its person is told, as of any failed run.
      audited: [
        "workflow.run.failed no_instance workflow.run_failed",
        "workflow.run.notified",
      ],
    });
  });

  it("are found by an index, reading no table whole and sorting nothing", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, waiting);
    await orphanOf(builder, app, 20 * minute);
    // A fresh D1 has no statistics: SQLite goes by the queries alone.
    const stats = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE name LIKE 'sqlite_stat%'"
    ).all();

    const queries = await recordedQueries(async () => {
      await runCron();
    });
    const plans = await Promise.all(
      queries
        .filter(({ query }) => sweepQuery.test(query))
        .map(async (recorded) => await planOf(recorded))
    );

    expect({ stats: stats.results, plans }).toStrictEqual({
      stats: [],
      // From a random ID on, then, one row being fewer than a sweep
      // takes, up to it.
      plans: [
        [
          "SEARCH workflow_runs USING INDEX workflow_runs_status_ended_idx (status=? AND ended_at=? AND id>?)",
        ],
        [
          "SEARCH workflow_runs USING INDEX workflow_runs_status_ended_idx (status=? AND ended_at=? AND id<?)",
        ],
      ],
    });
  });

  it("never include a run started as ever, however old", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, waiting);
    const live = await builder.api.workflows.start(app, "waits");
    const started = await rowStatus(live.id);
    await setRow(live.id, "running", 20 * day);

    await runCron();

    expect({
      started,
      row: await rowStatus(live.id),
      ended: endedStatuses.has(await liveStatus(live.id)),
      failed: await failedAtAll(live.id),
    }).toStrictEqual({
      started: "running",
      row: "running",
      ended: false,
      failed: false,
    });
  });

  it("are marked running when their instance exists, a start that didn't record it", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, waiting);
    const slow = await orphanOf(builder, app, 20 * minute);
    await createInstance(app, slow);
    await rowSays(slow, "running");
    // As if neither the start nor the instance had recorded it.
    await setRow(slow, "starting", 20 * minute);

    await runCron();

    expect({
      row: await rowStatus(slow),
      ended: endedStatuses.has(await liveStatus(slow)),
      failed: await failedAtAll(slow),
    }).toStrictEqual({ row: "running", ended: false, failed: false });
  });

  it("take no step when their instance is created after they were marked failed", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, waiting);
    const orphan = await orphanOf(builder, app, 20 * minute);

    await runCron();
    // The start that stopped goes on after all, and creates the instance.
    await createInstance(app, orphan);
    await vi.waitFor(
      async () => {
        expect(endedStatuses.has(await liveStatus(orphan))).toBeTruthy();
      },
      { timeout: 10_000, interval: 100 }
    );

    expect({
      row: await rowStatus(orphan),
      engine: await liveStatus(orphan),
      actions: await actionsOf(orphan),
    }).toStrictEqual({
      row: "failed",
      // The dispatcher refused it before its first step.
      engine: "errored",
      actions: ["workflow.run.failed", "workflow.run.notified"],
    });
  });

  it("give up a triggered run's key, so its trigger delivered again starts a new run", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, waiting);
    // A delivery whose start stopped, with nothing delivering it again
    // since (triggers were off).
    const key = `event:${crypto.randomUUID()}`;
    const orphan = await orphanOf(null, app, 20 * minute, key);

    await runCron();
    const again = await startRun(env, {
      app: appIdSchema.parse(app),
      workflow: workflowIdSchema.parse("waits"),
      input: undefined,
      startedBy: null,
      actor: { type: "system" },
      trigger: { type: "schedule", key, version: 1 },
    });

    expect({
      orphan: await rowStatus(orphan),
      newRun: again.id !== orphan,
      again: await rowStatus(again.id),
    }).toStrictEqual({ orphan: "failed", newRun: true, again: "running" });
  });

  it("start a run whose running can't be recorded, and record it once it runs", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, waiting);
    const { db, refused } = refusingRunning();

    const run = await startRun(
      { ...env, DB: db },
      {
        app: appIdSchema.parse(app),
        workflow: workflowIdSchema.parse("waits"),
        input: undefined,
        startedBy: builder.userId,
        actor: { type: "system" },
      }
    );
    // Its first execution records it.
    await rowSays(run.id, "running");

    expect({
      status: run.status,
      refused: refused(),
      ended: endedStatuses.has(await liveStatus(run.id)),
      failed: await failedAtAll(run.id),
    }).toStrictEqual({
      status: "running",
      refused: 1,
      ended: false,
      failed: false,
    });
  });

  it("reach a later orphan past rows the engine keeps failing to answer for", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, waiting);
    // As many as a sweep takes, first in ID order.
    const unanswered = await Promise.all(
      Array.from(
        { length: 50 },
        async (_, index) =>
          await orphanOf(
            builder,
            app,
            20 * minute,
            null,
            `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`
          )
      )
    );
    const orphan = await orphanOf(
      builder,
      app,
      20 * minute,
      null,
      "80000000-0000-4000-8000-000000000000"
    );
    const failing = new Set(unanswered);
    const workflows = env.WORKFLOWS;
    const get = workflows.get.bind(workflows);
    const broken = vi.spyOn(workflows, "get").mockImplementation(async (id) => {
      if (failing.has(id)) {
        throw new Error("The engine can't be reached");
      }
      return await get(id);
    });
    let fromFirst: string | undefined;
    try {
      // From the first ID, the rows it can't check fill the sweep.
      await failOrphans(env, "00000000-0000-4000-8000-000000000000");
      fromFirst = await rowStatus(orphan);
      // From an ID past them, the orphan comes first.
      await failOrphans(env, "40000000-0000-4000-8000-000000000000");
    } finally {
      broken.mockRestore();
    }
    const stillStarting = await Promise.all(
      unanswered.map(async (run) => await rowStatus(run))
    );

    expect({
      fromFirst,
      fromLater: await rowStatus(orphan),
      unanswered: new Set(stillStarting),
    }).toStrictEqual({
      fromFirst: "starting",
      fromLater: "failed",
      unanswered: new Set(["starting"]),
    });
  });
});
