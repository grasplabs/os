import { appIdSchema, workflowIdSchema } from "@grasp-os/shared/ids";
import type { Role } from "@grasp-os/shared/roles";
import { workflowErrors } from "@grasp-os/shared/workflows";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { setCurrentVersion } from "../src/apps.ts";
import { setParam } from "../src/workflows/params.ts";
import { startRun } from "../src/workflows/runs.ts";
import { startDueSchedules } from "../src/workflows/triggers.ts";
import { release } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { runCron } from "./cron.ts";
import { mockIdp } from "./idp.ts";
import { racingDb } from "./racing-db.ts";
import { endLiveRuns, finished, liveStatus } from "./runs.ts";
import { outcome, signedInApi } from "./sign-in.ts";
import { appWith } from "./workflow-apps.ts";

// Triggers start workflows on their own. A schedule is a cron expression
// in a schedule parameter, read in the trigger's time zone; core's cron
// trigger starts what is due by the minute it runs for, so the tests
// drive the clock through the minute they run it for.

const idp = mockIdp();

const personApi = async (role: Role) => await signedInApi(idp, role);
type Person = Awaited<ReturnType<typeof personApi>>;

const minute = 60_000;
const day = 24 * 60 * minute;

/**
 * The weekly report workflow, on its schedule parameter `every` (Mondays
 * at 8:00 by default), with `triggers` as its code declares them.
 */
const weekly = (
  triggers = `[{ type: "schedule", param: "every", timeZone: "Europe/Amsterdam" }]`
): Record<string, string> => ({
  "workflows/weekly.ts": `import { schedule, workflow } from "@grasp-os/sdk/workflow";

export default workflow(
  "weekly",
  { params: { every: schedule({ label: "Runs", default: "0 8 * * 1" }) }, triggers: ${triggers} },
  async (step) => await step.do("report", { description: "Write the report" }, async () => "sent")
);
`,
  "workflows/weekly.workflow-tests.ts": `import { workflowTests } from "@grasp-os/sdk/testing";

import definition from "./weekly.ts";

export default workflowTests(definition, [{ name: "runs", mocks: { report: "sent" }, expect: { output: "sent" } }]);
`,
});

/** A time as a clock in Amsterdam shows it, e.g. `Mon 08:00`. */
const inAmsterdam = (time: Date): string =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Amsterdam",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
    .format(time)
    .replace(",", "");

/** When the App's schedule next fires, as core has it. */
const nextRunOf = async (app: string): Promise<Date> => {
  const row = await env.DB.prepare(
    "SELECT next_run_at FROM workflow_triggers WHERE app_id = ?"
  )
    .bind(app)
    .first<{ next_run_at: number }>();
  if (!row) {
    throw new Error(`App ${app} has no schedule`);
  }
  return new Date(row.next_run_at);
};

/** How many runs of the App there are, as its builder sees them. */
/**
 * Commits `files` as the App's next version, which isn't made current;
 * its number.
 */
const committed = async (
  builder: Person,
  app: string,
  files: Record<string, string>
): Promise<number> => {
  const { version } = await builder.api.apps.files.commit(app, files, "Next");
  return version;
};

/** The App's schedules as core has them: ID, version, cron and next time. */
const schedulesOf = async (app: string) => {
  const { results } = await env.DB.prepare(
    "SELECT id, version, cron, next_run_at, failed_starts FROM workflow_triggers WHERE app_id = ? ORDER BY id"
  )
    .bind(app)
    .all();
  return results;
};

const runCount = async (builder: Person, app: string): Promise<number> => {
  const runs = await builder.api.workflows.list(app);
  return runs.length;
};

describe("schedule triggers", () => {
  afterEach(endLiveRuns);

  it("start a run at the time the schedule names where it runs, and none before", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, weekly());
    const due = await nextRunOf(app);

    expect([inAmsterdam(due), due.getTime() > Date.now()]).toStrictEqual([
      "Mon 08:00",
      true,
    ]);

    await runCron({}, new Date(due.getTime() - minute));

    await expect(runCount(builder, app)).resolves.toBe(0);

    await runCron({}, due);
    await runCron({}, new Date(due.getTime() + minute));

    await expect(runCount(builder, app)).resolves.toBe(1);
    // Then the Monday after, at 8:00 there too.
    const next = await nextRunOf(app);

    expect([inAmsterdam(next), next.getTime() > due.getTime()]).toStrictEqual([
      "Mon 08:00",
      true,
    ]);
  });

  it("start a run for the App's owner, audited as the system's", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, weekly());
    await runCron({}, await nextRunOf(app));
    const [run] = await builder.api.workflows.list(app);

    expect(run).toMatchObject({
      workflow: "weekly",
      startedBy: { type: "trigger" },
    });
    const events = await allEvents();

    expect(
      events.filter(
        ({ action, target }) =>
          action === "workflow.run.started" && target?.id === run?.id
      )
    ).toMatchObject([
      {
        actor: { type: "system" },
        detail: { startedBy: "trigger", trigger: "schedule" },
      },
    ]);
  });

  it("go on from the schedule its parameter is set to", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, weekly());
    await builder.api.workflows.params.set(
      app,
      "weekly",
      "every",
      "30 9 * * *"
    );
    const due = await nextRunOf(app);

    expect(inAmsterdam(due)).toMatch(/ 09:30$/u);
    expect(due.getTime() - Date.now()).toBeLessThanOrEqual(day);

    await runCron({}, due);

    await expect(runCount(builder, app)).resolves.toBe(1);
  });

  it("go on from the schedule its parameter is set to, whichever rows hold it by then", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, weekly());
    // Its rows registered again, under new IDs, just before the value's
    // batch lands.
    const racing = racingDb(
      async (db) =>
        await db
          .prepare(
            "UPDATE workflow_triggers SET id = lower(hex(randomblob(16))) WHERE app_id = ?"
          )
          .bind(app)
          .run()
    );

    await setParam(
      { ...env, DB: racing },
      await builder.api.whoami(),
      app,
      "weekly",
      "every",
      "30 9 * * *"
    );

    await expect(schedulesOf(app)).resolves.toMatchObject([
      { cron: "30 9 * * *" },
    ]);
  });

  it("register many at once, and say how many in the audit log", async () => {
    const builder = await personApi("builder");
    // 20 rows of 11 values each: past the 100 values D1 binds to one
    // statement, which local D1 refuses too ("too many SQL variables").
    const many = `[${Array.from({ length: 20 }, () => `{ type: "schedule", param: "every" }`).join(", ")}]`;
    const app = await appWith(builder, weekly(many));
    const events = await allEvents();

    await expect(schedulesOf(app)).resolves.toHaveLength(20);
    expect(
      events.filter(
        ({ action, target }) =>
          action === "app.version.current" && target?.id === app
      )
    ).toMatchObject([{ detail: { version: 1, schedules: 20 } }]);
  });

  it("stop once a version without them is made current", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, weekly());
    const due = await nextRunOf(app);
    // The same workflow, started only by hand.
    await release(builder, app, weekly(`[{ type: "manual" }]`));

    await runCron({}, due);

    await expect(runCount(builder, app)).resolves.toBe(0);
    await expect(nextRunOf(app)).rejects.toThrow("has no schedule");
  });

  it("start afresh when their version is made current again, whatever it left behind", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, weekly());
    await release(builder, app, weekly(`[{ type: "manual" }]`));
    // A schedule of version 1 long past due, as a release that made
    // versions current without registering triggers could leave it.
    await env.DB.prepare(
      "INSERT INTO workflow_triggers (id, app_id, version, workflow_id, position, type, param, cron, time_zone, next_run_at, created_at) VALUES (?, ?, 1, 'weekly', 0, 'schedule', 'every', '0 8 * * 1', 'Europe/Amsterdam', 0, 0)"
    )
      .bind(crypto.randomUUID(), app)
      .run();

    await builder.api.apps.versions.setCurrent(app, 1);
    await runCron();

    await expect(runCount(builder, app)).resolves.toBe(0);
    await expect(nextRunOf(app)).resolves.toSatisfy(
      (next: Date) => next.getTime() > Date.now()
    );
  });

  it("start a time missed while the cron trigger didn't run once, late", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, weekly());
    const due = await nextRunOf(app);

    await runCron({}, new Date(due.getTime() + day));
    await runCron({}, new Date(due.getTime() + day + minute));

    await expect(runCount(builder, app)).resolves.toBe(1);
  });
});

/**
 * Runs `run` while the engine takes no new run, as when Cloudflare
 * Workflows is down: every start fails once its run's row is written.
 */
const whileEngineDown = async <T>(run: () => Promise<T>): Promise<T> => {
  const down = vi
    .spyOn(env.WORKFLOWS, "create")
    .mockRejectedValue(new Error("Workflows unavailable"));
  try {
    return await run();
  } finally {
    down.mockRestore();
  }
};

/**
 * Runs the cron trigger for each of `minutes` after `due`, in order; how
 * many runs the App has after each: one more wherever a start was tried.
 */
const triedAt = async (
  builder: Person,
  app: string,
  due: Date,
  minutes: readonly number[]
): Promise<number[]> => {
  const counts: number[] = [];
  for (const after of minutes) {
    // oxlint-disable-next-line no-await-in-loop -- one minute after another
    await runCron({}, new Date(due.getTime() + after * minute));
    // oxlint-disable-next-line no-await-in-loop -- as above
    counts.push(await runCount(builder, app));
  }
  return counts;
};

/** The minutes after a schedule is due at which its 8 starts are tried. */
const tries = [0, 1, 3, 7, 15, 31, 63, 127];

/** Whether the Workflows page and the workflow's view say it stopped. */
const shownStopped = async (builder: Person, app: string) => {
  const overview = await builder.api.workflows.overview();
  const { summary } = await builder.api.workflows.get(app, "weekly");
  return [
    overview.find((workflow) => workflow.app === app)?.scheduleStopped,
    summary.scheduleStopped,
  ];
};

describe("a schedule whose run keeps failing to start", () => {
  afterEach(endLiveRuns);

  it("is tried again after twice as long each time, then stops, audited once and shown with its workflow", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, weekly());
    const due = await nextRunOf(app);

    const counts = await whileEngineDown(
      async () =>
        await triedAt(
          builder,
          app,
          due,
          // Each try, the minute before the later ones, and well after
          // the last.
          [0, 1, 2, 3, 6, 7, 14, 15, 30, 31, 62, 63, 126, 127, 128, 24 * 60]
        )
    );

    expect(counts).toStrictEqual([
      1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 8,
    ]);
    // The engine back, it still starts nothing.
    await expect(
      triedAt(builder, app, due, [2 * 24 * 60])
    ).resolves.toStrictEqual([8]);
    await expect(schedulesOf(app)).resolves.toMatchObject([
      { next_run_at: null },
    ]);
    await expect(shownStopped(builder, app)).resolves.toStrictEqual([
      true,
      true,
    ]);
    const events = await allEvents();
    expect(
      events.filter(
        ({ action, target }) =>
          action === "workflow.schedule.stopped" && target?.id === app
      )
    ).toMatchObject([
      {
        actor: { type: "system" },
        detail: { workflow: "weekly", version: 1, failedStarts: 8 },
      },
    ]);
  });

  it("is found in the audit log as an action once it stopped", async () => {
    const builder = await personApi("builder");
    const admin = await personApi("admin");
    const app = await appWith(builder, weekly());
    const due = await nextRunOf(app);
    await whileEngineDown(async () => await triedAt(builder, app, due, tries));
    await allEvents();

    // A search by type, page after page.
    const found: string[] = [];
    let before;
    do {
      // oxlint-disable-next-line no-await-in-loop -- one page after another
      const page = await admin.api.audit.search(
        { type: "action", targetType: "app", targetId: app },
        before
      );
      found.push(...page.records.flatMap(({ event }) => event?.action ?? []));
      before = page.next ?? undefined;
    } while (before !== undefined);

    expect(found).toContain("workflow.schedule.stopped");
  });

  it("counts one failed start for one due time, however many deliveries try it", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, weekly());
    const due = await nextRunOf(app);
    // A second delivery of the same minute, between this one's reading
    // the schedule and its first write: both read it with no failed start.
    let raced = false;
    const racing = racingDb(async () => {
      if (!raced) {
        raced = true;
        await startDueSchedules(env, due);
      }
    });

    await whileEngineDown(async () => {
      await startDueSchedules({ ...env, DB: racing }, due);
    });

    expect(raced).toBeTruthy();
    await expect(schedulesOf(app)).resolves.toMatchObject([
      { failed_starts: 1, next_run_at: due.getTime() },
    ]);
  });

  it("starts from nothing again once a start works", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, weekly());
    const due = await nextRunOf(app);

    await whileEngineDown(
      async () => await triedAt(builder, app, due, tries.slice(0, 3))
    );
    // The fourth try works: the schedule goes on to its next time.
    await expect(triedAt(builder, app, due, [7])).resolves.toStrictEqual([4]);
    const next = await nextRunOf(app);

    expect(next.getTime()).toBeGreaterThan(due.getTime());
    await expect(shownStopped(builder, app)).resolves.toStrictEqual([
      false,
      false,
    ]);
    // A failed start then is its first: tried again the minute after.
    await expect(
      whileEngineDown(async () => await triedAt(builder, app, next, [0, 1]))
    ).resolves.toStrictEqual([5, 6]);
  });

  it.each([
    [
      "its schedule is set",
      async (builder: Person, app: string) => {
        await builder.api.workflows.params.set(
          app,
          "weekly",
          "every",
          "30 9 * * *"
        );
      },
    ],
    [
      "a new version is made current",
      async (builder: Person, app: string) => {
        await release(
          builder,
          app,
          weekly(`[{ type: "schedule", param: "every" }]`)
        );
      },
    ],
  ])("starts again once %s", async (_, fix) => {
    const builder = await personApi("builder");
    const app = await appWith(builder, weekly());
    const due = await nextRunOf(app);
    await whileEngineDown(async () => await triedAt(builder, app, due, tries));

    await fix(builder, app);

    await expect(shownStopped(builder, app)).resolves.toStrictEqual([
      false,
      false,
    ]);
    const next = await nextRunOf(app);
    await expect(triedAt(builder, app, next, [0])).resolves.toStrictEqual([9]);
    // And a failed start is its first again.
    await expect(schedulesOf(app)).resolves.toMatchObject([
      { failed_starts: 0 },
    ]);
  });
});

describe("activations racing", () => {
  afterEach(endLiveRuns);

  it("leave the winner's schedules alone when another activation of the same version got there first", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, weekly());
    const next = await committed(builder, app, {
      "workflows/weekly.ts":
        weekly()["workflows/weekly.ts"]?.replace("0 8 * * 1", "0 9 * * 1") ??
        "",
    });
    const winner = crypto.randomUUID();
    // The other activation lands just before this one's batch: after this
    // one read which version was current and worked out its schedules.
    const racing = racingDb(
      async (db) =>
        await db.batch([
          db
            .prepare("UPDATE apps SET current_version = ? WHERE id = ?")
            .bind(next, app),
          db
            .prepare("DELETE FROM workflow_triggers WHERE app_id = ?")
            .bind(app),
          db
            .prepare(
              "INSERT INTO workflow_triggers (id, app_id, version, workflow_id, position, type, param, cron, time_zone, next_run_at, created_at) VALUES (?, ?, ?, 'weekly', 0, 'schedule', 'every', '0 9 * * 1', 'Europe/Amsterdam', 1, 0)"
            )
            .bind(winner, app, next),
        ])
    );

    const refused = await outcome(
      setCurrentVersion(
        { ...env, DB: racing },
        await builder.api.whoami(),
        app,
        next
      )
    );
    const after = await schedulesOf(app);

    expect({ refused, schedules: after.map(({ id }) => id) }).toStrictEqual({
      refused: "app.conflict",
      schedules: [winner],
    });
  });

  it("refuse, and write nothing, when a schedule parameter is set meanwhile", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, weekly());
    const before = await schedulesOf(app);
    const next = await committed(builder, app, {
      "workflows/weekly.ts":
        weekly()["workflows/weekly.ts"]?.replace("0 8 * * 1", "0 9 * * 1") ??
        "",
    });

    // Set just before the activation's batch: after it read the value.
    const racing = racingDb(
      async (db) =>
        await db
          .prepare(
            `INSERT INTO workflow_param_values (app_id, workflow_id, param, value, set_by, set_at) VALUES (?, 'weekly', 'every', '"30 7 * * *"', 'someone', 0)`
          )
          .bind(app)
          .run()
    );

    const refused = await outcome(
      setCurrentVersion(
        { ...env, DB: racing },
        await builder.api.whoami(),
        app,
        next
      )
    );

    expect(refused).toBe("app.conflict");
    await expect(schedulesOf(app)).resolves.toStrictEqual(before);
  });

  it("start nothing for a trigger of a version that is no longer current", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, weekly());
    await release(builder, app, weekly(`[{ type: "manual" }]`));

    await expect(
      outcome(
        startRun(env, {
          app: appIdSchema.parse(app),
          workflow: workflowIdSchema.parse("weekly"),
          input: undefined,
          startedBy: null,
          actor: { type: "system" },
          trigger: { type: "schedule", key: "schedule:gone:0", version: 1 },
        })
      )
    ).resolves.toBe("workflow.trigger_gone");
    await expect(runCount(builder, app)).resolves.toBe(0);
  });
});

describe("trigger deliveries", () => {
  afterEach(endLiveRuns);

  it("start one run for one key, however often it is delivered", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, weekly());
    const delivery = {
      app: appIdSchema.parse(app),
      workflow: workflowIdSchema.parse("weekly"),
      input: undefined,
      startedBy: null,
      actor: { type: "system" },
      trigger: {
        type: "schedule",
        key: `schedule:${crypto.randomUUID()}`,
        version: 1,
      },
    } as const;

    // Two at once: the one that finds the other's run still starting is
    // told to try again, rather than handed a run with no instance yet.
    const atOnce = await Promise.all(
      [1, 2].map(async () => {
        try {
          const { id } = await startRun(env, delivery);
          return id;
        } catch (error) {
          return workflowErrors.codeOf(error) ?? String(error);
        }
      })
    );
    const again = await startRun(env, delivery);

    expect(
      atOnce.map((got) => (got === again.id ? "the run" : got)).toSorted()
    ).toSatisfy(
      (got: string[]) =>
        got.includes("the run") &&
        got.every(
          (one) => one === "the run" || one === "workflow.start_pending"
        )
    );
    await expect(runCount(builder, app)).resolves.toBe(1);
    const events = await allEvents();

    expect(
      events.filter(
        ({ action, detail }) =>
          action === "workflow.run.started" && detail.app === app
      )
    ).toHaveLength(1);
  });

  it("start the run a crash left without its engine instance, once, when delivered again", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, weekly());
    const key = `schedule:${crypto.randomUUID()}`;
    // What a start leaves when core stops between writing the run's row
    // and creating its instance, two minutes ago.
    const orphan = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO workflow_runs (id, app_id, workflow_id, version, started_by, status, created_at, trigger_key) VALUES (?, ?, 'weekly', 1, NULL, 'starting', ?, ?)"
    )
      .bind(orphan, app, Date.now() - 2 * minute, key)
      .run();
    const delivery = {
      app: appIdSchema.parse(app),
      workflow: workflowIdSchema.parse("weekly"),
      input: undefined,
      startedBy: null,
      actor: { type: "system" },
      trigger: { type: "schedule", key, version: 1 },
    } as const;

    const [first, second] = await Promise.all([
      startRun(env, delivery),
      startRun(env, delivery),
    ]);
    await finished(orphan);

    expect([first.id, second.id]).toStrictEqual([orphan, orphan]);
    await expect(runCount(builder, app)).resolves.toBe(1);
    await expect(liveStatus(orphan)).resolves.toBe("complete");
  });

  it("keep a schedule due while its run is left without an instance, and start that run once it's old enough", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, weekly());
    const due = await nextRunOf(app);
    const [schedule] = await schedulesOf(app);
    // A start for this time stopped between the run's row and its
    // instance, just now: the next minute comes before it counts as stopped.
    const orphan = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO workflow_runs (id, app_id, workflow_id, version, started_by, status, created_at, trigger_key) VALUES (?, ?, 'weekly', 1, NULL, 'starting', ?, ?)"
    )
      .bind(
        orphan,
        app,
        Date.now(),
        `schedule:${String(schedule?.id)}:${due.getTime()}`
      )
      .run();

    await runCron({}, due);

    await expect(nextRunOf(app)).resolves.toStrictEqual(due);
    await expect(outcome(liveStatus(orphan))).resolves.toBe(
      "Error: instance.not_found"
    );

    // Two minutes on, as a stopped start would be by the next tries.
    await env.DB.prepare("UPDATE workflow_runs SET created_at = ? WHERE id = ?")
      .bind(Date.now() - 2 * minute, orphan)
      .run();
    await runCron({}, new Date(due.getTime() + minute));
    await finished(orphan);

    await expect(runCount(builder, app)).resolves.toBe(1);
    await expect(nextRunOf(app)).resolves.toSatisfy(
      (next: Date) => next.getTime() > due.getTime()
    );
  });
});
