import { appIdSchema, workflowIdSchema } from "@grasp-os/shared/ids";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { runEngine } from "../src/workflows/engine.ts";
import { startRun } from "../src/workflows/runs.ts";
import { allEvents } from "./audit-events.ts";
import { runCron } from "./cron.ts";
import { mockIdp } from "./idp.ts";
import { endLiveRuns, liveStatus } from "./runs.ts";
import { signedInApi } from "./sign-in.ts";
import { appWith, runEvents, workflowFiles } from "./workflow-apps.ts";

// A start that stopped between writing its run's row and creating the
// run's engine instance (core stopped in between) leaves a row that says
// `running` with nothing behind it. Core's cron trigger marks such a row
// failed once it's old enough, as a start that failed is, and leaves
// every run the engine has alone.

const idp = mockIdp();

const personApi = async (role: Role) => await signedInApi(idp, role);
type Person = Awaited<ReturnType<typeof personApi>>;

const minute = 60_000;

/** A workflow that waits for an event it isn't sent: a live run. */
const waiting = workflowFiles(
  "waits",
  `  await step.waitFor("go", { description: "Wait", type: "go", timeout: "1 day" });
  return null;`
);

/** A run's row as a start leaves it that stopped `age` ago. */
const orphanOf = async (
  person: Person | null,
  app: string,
  age: number,
  triggerKey: string | null = null
): Promise<string> => {
  const run = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO workflow_runs (id, app_id, workflow_id, version, started_by, status, created_at, trigger_key) VALUES (?, ?, 'waits', 1, ?, 'running', ?, ?)"
  )
    .bind(run, app, person?.userId ?? null, Date.now() - age, triggerKey)
    .run();
  return run;
};

/** Makes a run's row `age` old, as a run that has been going that long. */
const aged = async (run: string, age: number): Promise<void> => {
  await env.DB.prepare("UPDATE workflow_runs SET created_at = ? WHERE id = ?")
    .bind(Date.now() - age, run)
    .run();
};

/** Where core's record has a run, as the App's run list shows it. */
const listedStatus = async (
  person: Person,
  app: string,
  run: string
): Promise<string | undefined> => {
  const runs = await person.api.workflows.list(app);
  return runs.find(({ id }) => id === run)?.status;
};

/** How many `workflow.run.failed` events the audit log has of `run`. */
const failedEvents = async (run: string): Promise<number> => {
  const events = await allEvents();
  return events.filter(
    ({ action, target }) =>
      action === "workflow.run.failed" && target?.id === run
  ).length;
};

const endedStatuses = new Set(["complete", "errored", "terminated"]);

describe("runs that never reached the engine", () => {
  afterEach(endLiveRuns);

  it("are marked failed once they're old enough, audited once, for their person to see", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, waiting);
    const orphan = await orphanOf(builder, app, 20 * minute);
    const young = await orphanOf(builder, app, 2 * minute);

    await runCron();
    await runCron();
    const { status, failure } = await builder.api.workflows.status(orphan);

    expect({
      status,
      error: failure?.error,
      young: await listedStatus(builder, app, young),
      audited: await runEvents(orphan, "workflow.run.failed"),
    }).toStrictEqual({
      status: "failed",
      error: {
        code: "workflow.run_failed",
        message: "The workflow run couldn't be started.",
      },
      // Its start may still be under way, or a delivery restart it.
      young: "running",
      audited: ["workflow.run.failed start_failed workflow.run_failed"],
    });
  });

  it("leave live runs alone, however old", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, waiting);
    const live = await builder.api.workflows.start(app, "waits");
    await aged(live.id, 20 * minute);

    await runCron();

    expect({
      listed: await listedStatus(builder, app, live.id),
      ended: endedStatuses.has(await liveStatus(live.id)),
      failed: await failedEvents(live.id),
    }).toStrictEqual({ listed: "running", ended: false, failed: 0 });
  });

  it("are left while workflows are switched off, and marked failed once they're back on", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, waiting);
    const orphan = await orphanOf(builder, app, 20 * minute);

    const on = z.record(z.string(), z.boolean()).parse(env.FEATURES);
    await runCron({ FEATURES: { ...on, workflows: false } });
    const whileOff = await listedStatus(builder, app, orphan);
    await runCron();

    expect({
      whileOff,
      after: await listedStatus(builder, app, orphan),
    }).toStrictEqual({ whileOff: "running", after: "failed" });
  });

  it("are marked failed, and their instance ended, when it's created just after the check", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, waiting);
    const orphan = await orphanOf(builder, app, 20 * minute);
    // The run's instance is created right after the sweep found none: its
    // start, or a delivery, got there in between.
    const workflows = env.WORKFLOWS;
    const get = workflows.get.bind(workflows);
    let created = false;
    const racing = vi
      .spyOn(env.WORKFLOWS, "get")
      .mockImplementation(async (id) => {
        const found = await get(id).then(
          (instance) => ({ instance }),
          (error: unknown) => ({ error })
        );
        if (id === orphan && !created) {
          created = true;
          await runEngine(env).create({
            id: orphan,
            pinned: {
              app: appIdSchema.parse(app),
              workflow: workflowIdSchema.parse("waits"),
              version: 1,
            },
            input: undefined,
          });
        }
        if ("error" in found) {
          throw found.error;
        }
        return found.instance;
      });
    try {
      await runCron();
    } finally {
      racing.mockRestore();
    }
    await runCron();

    expect({
      created,
      listed: await listedStatus(builder, app, orphan),
      ended: endedStatuses.has(await liveStatus(orphan)),
      failed: await failedEvents(orphan),
    }).toStrictEqual({
      created: true,
      listed: "failed",
      ended: true,
      failed: 1,
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
      orphan: await listedStatus(builder, app, orphan),
      newRun: again.id !== orphan,
      again: await listedStatus(builder, app, again.id),
    }).toStrictEqual({ orphan: "failed", newRun: true, again: "running" });
  });
});
