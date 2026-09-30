import type { Role } from "@grasp-os/shared/roles";
import { failedRunDays, runsPageSize } from "@grasp-os/shared/workflows";
import type {
  ListedRun,
  OutlineNode,
  RunsPage,
  WorkflowDetail,
  WorkflowDryRun,
} from "@grasp-os/shared/workflows";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { release } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { fullScan, recordedQueries } from "./query-plans.ts";
import {
  auditedDuring,
  openRpc,
  outcome,
  signedIn,
  signedInApi,
  staffPerson,
  unique,
} from "./sign-in.ts";
import { workflowFiles } from "./workflow-apps.ts";

// The Workflows page: every workflow of every App a person can open, the
// runs across them, and one workflow's view. What could go wrong: a
// workflow or run of an App someone can't open showing up, counts that
// count the wrong runs, a waiting run lost below the others, parameters
// shown to or set by someone who doesn't build the App, and a Test that
// changes something.

const idp = mockIdp();

const personApi = async (role: Role) => await signedInApi(idp, role);
type Person = Awaited<ReturnType<typeof personApi>>;

/**
 * An invoice workflow that reads the total with a model, asks a reviewer
 * above a limit, and books the invoice; its test approves the review.
 */
const approveFiles = {
  "workflows/approve.ts": `import { model, money, person, workflow, z } from "@grasp-os/sdk/workflow";

export default workflow(
  "approve",
  {
    input: z.object({ text: z.string() }),
    params: {
      limit: money({ label: "Review invoices above", currency: "EUR", default: 500_000, sensitive: true }),
      reviewer: person({ label: "Reviewer", default: "role:admin" }),
      reader: model({ label: "Reading model", default: "mistral-large" }),
    },
  },
  async (step, { input, params }) => {
    const extracted = await step.llm("extract", {
      description: "Read the invoice's total",
      model: params.reader,
      instructions: "Read the total in cents.",
      input: input.text,
      schema: z.object({ total: z.int() }),
    });
    if (extracted.total > params.limit) {
      await step.decision("review", {
        description: "Ask the reviewer to approve it",
        from: params.reviewer,
        ask: async () => {},
        timeout: "7 days",
      });
    }
    return await step.do(
      "book",
      { description: "Book the invoice", sideEffect: true, input: { total: extracted.total } },
      async () => "booked"
    );
  }
);
`,
  "workflows/approve.workflow-tests.ts": `import { workflowTests } from "@grasp-os/sdk/testing";

import definition from "./approve.ts";

export default workflowTests(definition, [
  {
    name: "books a large invoice once approved",
    input: { text: "Total €8,000" },
    mocks: { extract: { total: 800_000 } },
    decisions: { review: { approved: true, by: "anna" } },
    expect: {},
  },
]);
`,
};

/**
 * A workflow whose steps its code can't list: one inside a `try`, which
 * runs, but can't be read as a step list.
 */
const hiddenFiles = {
  "workflows/hidden.ts": `import { workflow, z } from "@grasp-os/sdk/workflow";

export default workflow("hidden", { params: {}, input: z.unknown() }, async (step) => {
  try {
    return await step.do("inside", { description: "Hidden" }, async () => 1);
  } catch {
    return 0;
  }
});
`,
  "workflows/hidden.workflow-tests.ts": `import { workflowTests } from "@grasp-os/sdk/testing";

import definition from "./hidden.ts";

export default workflowTests(definition, [{ name: "runs", mocks: { inside: 1 }, expect: { output: 1 } }]);
`,
};

/** A new App of `owner`'s named `name`, with `files` as its current version. */
const appOf = async (
  owner: Person,
  name: string,
  files: Record<string, string>
): Promise<string> => {
  const { id } = await owner.api.apps.create({ name });
  await release(owner, id, files);
  return id;
};

/** Why `hidden`'s steps can't be listed, as the SDK's describer says. */
const hiddenReason =
  "Line 4: Steps can sit in `if`/`else` and `for`/`for...of` loops only; move this step out of the construct around it";

/** Whether a query groups what it reads (the overview's counts). */
const grouped = (query: string): boolean => /group by/iu.test(query);

/** The IDs of `runs`, in order. */
const idsOf = async (page: Promise<RunsPage>): Promise<string[]> => {
  const { runs } = await page;
  return runs.map(({ id }) => id);
};

/** What the Runs list shows of a run, and the step its report names. */
const shown = (run: ListedRun) => ({
  id: run.id,
  status: run.status,
  decision: run.decision ?? null,
  failedAt: run.failure?.step ?? null,
});

/**
 * The code an outline shows: conditions, loop heads, keys, parameters
 * read and literal options, in the order they come.
 */
const codeOf = (nodes: OutlineNode[]): string[] =>
  nodes.flatMap((node) => {
    if (node.type === "step") {
      return [
        ...(node.key === undefined ? [] : [`key ${node.key}`]),
        ...node.params.map((param) => `param ${param}`),
        ...Object.keys(node.options).map((option) => `option ${option}`),
      ];
    }
    const head = node.type === "loop" ? node.header : node.condition;
    return [
      ...(head === "" ? [] : [head]),
      ...node.params.map((param) => `param ${param}`),
      ...codeOf(node.steps),
      ...(node.type === "branch" ? codeOf(node.otherwise) : []),
    ];
  });

/** The code a workflow's outline shows (`codeOf`); none without one. */
const codeIn = (steps: WorkflowDetail["steps"]): string[] =>
  steps.ok ? codeOf(steps.outline.steps) : [];

const minute = 60_000;
const day = 24 * 60 * minute;

interface SeededRun {
  workflow: string;
  status: "running" | "paused" | "completed" | "failed" | "cancelled";
  createdAt: number;
  endedAt?: number;
  /** A decision of the run's, open unless it says otherwise. */
  decision?: "open" | "approved";
  /** Who answers the decision; the admins unless it says otherwise. */
  deciders?: string;
  /** The decision's deadline; a week after the run started unless given. */
  expiresAt?: number;
}

/**
 * A run of `app`'s as core keeps it, started by a trigger (so it acts for
 * the App's owner), and its decision; returns the run's ID and the
 * decision's.
 */
const seedRun = async (
  app: string,
  run: SeededRun
): Promise<{ id: string; decision: string }> => {
  const id = `run-${unique()}`;
  const decision = `decision-${unique()}`;
  const failure =
    run.status === "failed"
      ? JSON.stringify({
          run: id,
          app,
          workflow: run.workflow,
          version: 1,
          step: "book",
          input: null,
          error: { code: "workflow.step_failed", message: "It failed" },
          failedAt: new Date(run.endedAt ?? run.createdAt).toISOString(),
        })
      : null;
  await env.DB.prepare(
    "INSERT INTO workflow_runs (id, app_id, workflow_id, version, started_by, status, created_at, ended_at, failure) VALUES (?, ?, ?, 1, NULL, ?, ?, ?, ?)"
  )
    .bind(
      id,
      app,
      run.workflow,
      run.status,
      run.createdAt,
      run.endedAt ?? null,
      failure
    )
    .run();
  if (run.decision !== undefined) {
    await env.DB.prepare(
      "INSERT INTO workflow_decisions (id, run_id, step, deciders, description, status, opened_at, expires_at) VALUES (?, ?, 'review', ?, 'Approve it', ?, ?, ?)"
    )
      .bind(
        decision,
        id,
        run.deciders ?? "role:admin",
        run.decision,
        run.createdAt,
        run.expiresAt ?? run.createdAt + 7 * day
      )
      .run();
  }
  return { id, decision };
};

// Releasing a version compiles its workflows and runs their tests, and a
// Test runs them again in an isolate: on a loaded runner that takes
// longer than the default five seconds. Sixty is room for a slow runner,
// not for a hang.
const buildTime = { timeout: 60_000 };

describe("the Workflows page", buildTime, () => {
  it("lists every workflow of every App the person can open, with its latest run and its waiting and failed runs", async () => {
    const [owner, other, user, admin] = await Promise.all([
      personApi("builder"),
      personApi("builder"),
      personApi("user"),
      personApi("admin"),
    ]);
    const appName = `Invoices ${unique()}`;
    const invoices = await appOf(owner, appName, {
      ...approveFiles,
      ...workflowFiles("chase", "  return 1;"),
      ...workflowFiles("remind", "  return 1;"),
    });
    const payroll = await appOf(
      other,
      `Payroll ${unique()}`,
      workflowFiles("pay", "  return 1;")
    );
    await owner.api.apps.members.add(invoices, {
      type: "person",
      id: user.userId,
      role: "user",
    });
    const now = Date.now();
    await seedRun(invoices, {
      workflow: "approve",
      status: "failed",
      createdAt: now - 2 * day,
      endedAt: now - day,
    });
    // Failed before the window: not counted.
    await seedRun(invoices, {
      workflow: "approve",
      status: "failed",
      createdAt: now - (failedRunDays + 2) * day,
      endedAt: now - (failedRunDays + 1) * day,
    });
    await seedRun(invoices, {
      workflow: "approve",
      status: "running",
      createdAt: now - 3 * minute,
      decision: "open",
    });
    // Its decision is still open, but it has ended: it waits no more.
    await seedRun(invoices, {
      workflow: "approve",
      status: "cancelled",
      createdAt: now - 2 * minute,
      endedAt: now - 2 * minute,
      decision: "open",
    });
    const latest = await seedRun(invoices, {
      workflow: "approve",
      status: "completed",
      createdAt: now - minute,
      endedAt: now,
    });
    // Its latest run waits.
    const chasing = await seedRun(invoices, {
      workflow: "chase",
      status: "running",
      createdAt: now - minute,
      decision: "open",
    });

    const listed = async (person: Person) => {
      const all = await person.api.workflows.overview();
      return all.filter(({ app }) => app === invoices || app === payroll);
    };
    const owned = {
      app: invoices,
      appName,
      version: 1,
      owner: { userId: owner.userId, name: owner.person.name },
      scheduleStopped: false,
    };
    const invoiceWorkflows = [
      {
        ...owned,
        workflow: "approve",
        lastRun: {
          id: latest.id,
          status: "completed",
          createdAt: new Date(now - minute).toISOString(),
        },
        waiting: 1,
        failed: 1,
      },
      {
        ...owned,
        workflow: "chase",
        lastRun: {
          id: chasing.id,
          status: "waiting",
          createdAt: new Date(now - minute).toISOString(),
        },
        waiting: 1,
        failed: 0,
      },
      { ...owned, workflow: "remind", lastRun: null, waiting: 0, failed: 0 },
    ];
    await expect(listed(owner)).resolves.toStrictEqual(invoiceWorkflows);
    await expect(listed(user)).resolves.toStrictEqual(invoiceWorkflows);
    const asAdmin = await listed(admin);
    expect(asAdmin.map(({ app, workflow }) => [app, workflow])).toStrictEqual([
      [invoices, "approve"],
      [invoices, "chase"],
      [invoices, "remind"],
      [payroll, "pay"],
    ]);
  });

  it("lists workflows from their versions' rows, reading no App's files", async () => {
    const owner = await personApi("builder");
    const id = unique();
    const first = await appOf(
      owner,
      `A first ${id}`,
      workflowFiles("pay", "  return 1;")
    );
    const second = await appOf(
      owner,
      `B second ${id}`,
      workflowFiles("remind", "  return 1;")
    );
    // Both Apps' files as stored no longer match the hashes that name
    // them: a read of them would fail.
    await Promise.all(
      [first, second].map(async (app) => {
        const { tree } = await owner.api.apps.versions.get(app, 1);
        await env.FILES.put(`apps/${app}/trees/${tree}.json`, "damaged");
      })
    );
    const rows = await owner.api.workflows.overview();
    expect(rows.map(({ app, workflow }) => [app, workflow])).toStrictEqual([
      [first, "pay"],
      [second, "remind"],
    ]);
  });

  it("lists runs waiting first, then failed, then the rest, newest first, as filtered", async () => {
    const [owner, other, user] = await Promise.all([
      personApi("builder"),
      personApi("builder"),
      personApi("user"),
    ]);
    const app = await appOf(owner, `Invoices ${unique()}`, {
      ...approveFiles,
      ...workflowFiles("remind", "  return 1;"),
    });
    const hidden = await appOf(
      other,
      `Payroll ${unique()}`,
      workflowFiles("pay", "  return 1;")
    );
    await owner.api.apps.members.add(app, {
      type: "person",
      id: user.userId,
      role: "user",
    });
    const now = Date.now();
    const at = (minutes: number) => now - minutes * minute;
    const cancelled = await seedRun(app, {
      workflow: "remind",
      status: "cancelled",
      createdAt: at(7),
      endedAt: at(7),
    });
    // Asking the owner: they may answer it, the App's user may not.
    const waiting = await seedRun(app, {
      workflow: "approve",
      status: "paused",
      createdAt: at(6),
      decision: "open",
      deciders: `person:${owner.userId}`,
    });
    // Its decision was answered: it runs on.
    const answered = await seedRun(app, {
      workflow: "approve",
      status: "running",
      createdAt: at(5.5),
      decision: "approved",
    });
    // Its decision is still open, but it has ended: it waits no more.
    const completed = await seedRun(app, {
      workflow: "approve",
      status: "completed",
      createdAt: at(5),
      endedAt: at(4),
      decision: "open",
    });
    const failedLast = await seedRun(app, {
      workflow: "approve",
      status: "failed",
      createdAt: at(4),
      endedAt: at(1),
    });
    const failedFirst = await seedRun(app, {
      workflow: "remind",
      status: "failed",
      createdAt: at(3),
      endedAt: at(2),
    });
    const running = await seedRun(app, {
      workflow: "approve",
      status: "running",
      createdAt: at(0),
    });
    const hiddenRun = await seedRun(hidden, {
      workflow: "pay",
      status: "running",
      createdAt: now,
    });

    const { runs, more } = await owner.api.workflows.runs({ app });
    expect({ more, runs: runs.map(shown) }).toStrictEqual({
      more: false,
      runs: [
        {
          id: waiting.id,
          status: "waiting",
          decision: waiting.decision,
          failedAt: null,
        },
        // A failed run's report, for the person it acts for: here the owner.
        {
          id: failedLast.id,
          status: "failed",
          decision: null,
          failedAt: "book",
        },
        {
          id: failedFirst.id,
          status: "failed",
          decision: null,
          failedAt: "book",
        },
        { id: running.id, status: "running", decision: null, failedAt: null },
        {
          id: completed.id,
          status: "completed",
          decision: null,
          failedAt: null,
        },
        { id: answered.id, status: "running", decision: null, failedAt: null },
        {
          id: cancelled.id,
          status: "cancelled",
          decision: null,
          failedAt: null,
        },
      ],
    });
    // The same runs for a user of the App, without the failure reports,
    // and waiting without the decision they may not answer.
    const asUser = await user.api.workflows.runs({ app });
    expect(asUser.runs.map(shown)).toStrictEqual(
      runs.map((run) => ({ ...shown(run), decision: null, failedAt: null }))
    );

    const everything = await idsOf(owner.api.workflows.runs());
    await expect(
      Promise.all([
        idsOf(owner.api.workflows.runs({ app, status: "waiting" })),
        idsOf(owner.api.workflows.runs({ app, status: "failed" })),
        idsOf(owner.api.workflows.runs({ app, status: "running" })),
        idsOf(owner.api.workflows.runs({ app, status: "done" })),
        idsOf(owner.api.workflows.runs({ app, workflow: "remind" })),
        idsOf(other.api.workflows.runs()),
      ])
    ).resolves.toStrictEqual([
      [waiting.id],
      [failedLast.id, failedFirst.id],
      [running.id, answered.id],
      [completed.id, cancelled.id],
      [failedFirst.id, cancelled.id],
      [hiddenRun.id],
    ]);
    // Across the owner's Apps, waiting first, and none of another's App.
    expect({
      first: everything[0],
      hidden: everything.includes(hiddenRun.id),
    }).toStrictEqual({ first: waiting.id, hidden: false });

    await expect(
      Promise.all([
        outcome(owner.api.workflows.runs({ app: hidden })),
        outcome(
          owner.api.workflows.runs(
            // SAFETY: invalid on purpose: anything a client can send, as
            // Cap'n Web checks no types, so core must.
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
            { status: "stuck" } as never
          )
        ),
      ])
    ).resolves.toStrictEqual(["app.not_found", "workflow.invalid"]);
  });

  it("counts a run whose open decision is past its deadline as running, with nothing to decide", async () => {
    const owner = await personApi("builder");
    const app = await appOf(owner, `Invoices ${unique()}`, approveFiles);
    const now = Date.now();
    // Its deadline has passed, and the run hasn't timed it out yet: nobody
    // can answer it any more, its owner neither.
    const expired = await seedRun(app, {
      workflow: "approve",
      status: "running",
      createdAt: now - 8 * day,
      decision: "open",
      deciders: `person:${owner.userId}`,
      expiresAt: now - day,
    });
    const [all, waiting, running, overview] = await Promise.all([
      owner.api.workflows.runs({ app }),
      owner.api.workflows.runs({ app, status: "waiting" }),
      owner.api.workflows.runs({ app, status: "running" }),
      owner.api.workflows.overview(),
    ]);
    const approve = overview.find((row) => row.app === app);
    expect({
      all: all.runs.map(shown),
      waiting: waiting.runs.length,
      running: running.runs.map(({ id }) => id),
      counted: approve?.waiting,
      last: approve?.lastRun?.status,
    }).toStrictEqual({
      all: [
        { id: expired.id, status: "running", decision: null, failedAt: null },
      ],
      waiting: 0,
      running: [expired.id],
      counted: 0,
      last: "running",
    });
  });

  it("returns a page of runs, and says when more matched", async () => {
    const owner = await personApi("builder");
    const app = await appOf(
      owner,
      `Invoices ${unique()}`,
      workflowFiles("remind", "  return 1;")
    );
    const now = Date.now();
    const seeded = (count: number, from: number) =>
      Array.from({ length: count }, (_, index) =>
        env.DB.prepare(
          "INSERT INTO workflow_runs (id, app_id, workflow_id, version, started_by, status, created_at, ended_at) VALUES (?, ?, 'remind', 1, NULL, 'completed', ?, ?)"
        ).bind(`run-${unique()}`, app, now - from - index, now)
      );
    await env.DB.batch(seeded(runsPageSize, 0));
    const full = await owner.api.workflows.runs({ app });
    await env.DB.batch(seeded(1, runsPageSize));
    const past = await owner.api.workflows.runs({ app });
    expect({
      full: [full.runs.length, full.more],
      past: [past.runs.length, past.more],
    }).toStrictEqual({
      full: [runsPageSize, false],
      past: [runsPageSize, true],
    });
  });

  it("reads runs by an index in the order they are listed, with no statistics to go by", async () => {
    const owner = await personApi("admin");
    const app = await appOf(owner, `Invoices ${unique()}`, approveFiles);
    const now = Date.now();
    await seedRun(app, {
      workflow: "approve",
      status: "running",
      createdAt: now,
      decision: "open",
    });
    await seedRun(app, {
      workflow: "approve",
      status: "failed",
      createdAt: now,
      endedAt: now,
    });
    // A fresh D1 has no statistics: SQLite goes by the queries alone.
    const stats = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE name LIKE 'sqlite_stat%'"
    ).all();
    const { api } = owner;
    // Each call, and the plans of its statements that read runs or
    // triggers.
    const calls = {
      all: async () => await api.workflows.runs(),
      done: async () => await api.workflows.runs({ status: "done" }),
      overview: async () => await api.workflows.overview(),
      // Narrow: none of them may walk every run newest first.
      app: async () => await api.workflows.runs({ app }),
      appWorkflow: async () =>
        await api.workflows.runs({ app, workflow: "approve" }),
      appDone: async () => await api.workflows.runs({ app, status: "done" }),
      running: async () => await api.workflows.runs({ status: "running" }),
    };
    const narrow = new Set(["app", "appWorkflow", "appDone", "running"]);
    const plans = [];
    for (const [call, run] of Object.entries(calls)) {
      // oxlint-disable-next-line no-await-in-loop -- one call's statements at a time
      const queries = await recordedQueries(run);
      // oxlint-disable-next-line no-await-in-loop -- as above
      const planned = await Promise.all(
        queries
          .filter(
            ({ query }) =>
              query.includes('"workflow_runs"') ||
              query.includes('"workflow_triggers"')
          )
          .map(async ({ query, values }) => {
            const { results } = await env.DB.prepare(
              `EXPLAIN QUERY PLAN ${query}`
            )
              .bind(...values)
              .all<{ detail: string }>();
            return { call, query, plan: results.map(({ detail }) => detail) };
          })
      );
      plans.push(...planned);
    }
    // A list reads no table whole, and sorts nothing but the runs that
    // haven't ended: it reads an index in its own order and stops at a
    // page. The overview's counts group what they count, which the open
    // decisions and the failed runs since the window already bound. A
    // narrow list reads its own runs, never every run newest first until
    // enough of them match.
    expect({
      stats: stats.results,
      calls: [...new Set(plans.map(({ call }) => call))],
      fullScans: plans.filter(({ plan }) =>
        plan.some((step) => fullScan.test(step))
      ),
      sorts: plans.filter(
        ({ call, query, plan }) =>
          call !== "running" &&
          !grouped(query) &&
          plan.some((step) => step.includes("TEMP B-TREE"))
      ),
      walks: plans.filter(
        ({ call, plan }) =>
          narrow.has(call) &&
          plan.some((step) => step.includes("workflow_runs_created_idx"))
      ),
    }).toStrictEqual({
      stats: [],
      calls: Object.keys(calls),
      fullScans: [],
      sorts: [],
      walks: [],
    });
  });

  it("shows a workflow's steps as its code reads, and its parameters only to its builders", async () => {
    const [owner, user] = await Promise.all([
      personApi("builder"),
      personApi("user"),
    ]);
    const app = await appOf(owner, `Invoices ${unique()}`, {
      ...approveFiles,
      ...hiddenFiles,
    });
    await owner.api.apps.members.add(app, {
      type: "person",
      id: user.userId,
      role: "user",
    });
    const { core } = await openRpc(
      await signedIn(idp, "grasp-staff", staffPerson())
    );
    const staff = core.authenticate();

    const detail = await owner.api.workflows.get(app, "approve");
    expect(detail).toMatchObject({
      summary: { app, workflow: "approve", version: 1 },
      steps: {
        ok: true,
        outline: {
          steps: [
            { type: "step", name: "extract", kind: "ai" },
            {
              type: "branch",
              condition: "extracted.total > params.limit",
              params: ["limit"],
              steps: [{ type: "step", name: "review", kind: "decision" }],
              otherwise: [],
            },
            { type: "step", name: "book", kind: "exact", sideEffect: true },
          ],
        },
      },
      setsParams: true,
    });
    expect(
      detail.params?.map(({ name, sensitive }) => [name, sensitive])
    ).toStrictEqual([
      ["limit", true],
      ["reviewer", false],
      ["reader", false],
    ]);

    const [asUser, asStaff, hiddenSteps, missing] = await Promise.all([
      user.api.workflows.get(app, "approve"),
      staff.workflows.get(app, "approve"),
      owner.api.workflows.get(app, "hidden"),
      outcome(owner.api.workflows.get(app, "missing")),
    ]);
    expect({
      userSees: asUser.params,
      userSets: asUser.setsParams,
      userCode: codeIn(asUser.steps),
      ownerCode: codeIn(detail.steps),
      // Staff build it, but set nothing.
      staffSees: asStaff.params?.length,
      staffSets: asStaff.setsParams,
      hidden: hiddenSteps.steps.ok ? "listed" : hiddenSteps.steps.message,
      missing,
    }).toStrictEqual({
      userSees: null,
      userSets: false,
      userCode: [],
      ownerCode: [
        "param reader",
        "option instructions",
        "extracted.total > params.limit",
        "param limit",
        "param reviewer",
        "option timeout",
      ],
      staffSees: 3,
      staffSets: false,
      hidden: hiddenReason,
      missing: "workflow.not_found",
    });
  });

  it("never runs a side effect in a Test, even where the workflow's test asks for it", async () => {
    const owner = await personApi("builder");
    const app = await appOf(owner, `Cards ${unique()}`, {
      "workflows/charge.ts": `import { workflow, z } from "@grasp-os/sdk/workflow";

export default workflow("charge", { params: {}, input: z.unknown() }, async (step) =>
  await step.do(
    "charge",
    { description: "Charge the card", sideEffect: true, input: { amount: 5 } },
    async () => "charged"
  )
);
`,
      // Its test asks for its side effects to run, as the SDK's test
      // engine can: no test or dry run of a workflow's own does.
      "workflows/charge.workflow-tests.ts": `import { workflowTests } from "@grasp-os/sdk/testing";

import definition from "./charge.ts";

export default workflowTests(definition, [
  { name: "charges", sideEffects: "run", expect: {} },
] as never);
`,
    });
    const { runs } = await owner.api.workflows.test(app, "charge");
    const [charges] = runs;
    expect({
      recorded: charges?.report.includes(
        '- charge {"amount":5}: would change something, not run'
      ),
      ran: charges?.report.includes('"charged"'),
    }).toStrictEqual({ recorded: true, ran: false });
  });

  it("tests a workflow with the values set now, changing nothing, for its builders only", async () => {
    const [owner, user] = await Promise.all([
      personApi("builder"),
      personApi("user"),
    ]);
    const app = await appOf(owner, `Invoices ${unique()}`, approveFiles);
    await owner.api.apps.members.add(app, {
      type: "person",
      id: user.userId,
      role: "user",
    });

    const tests: WorkflowDryRun[] = [];
    const events = await auditedDuring(async () => {
      tests.push(await owner.api.workflows.test(app, "approve"));
    });
    // Above the invoice's total, no review is asked for.
    await owner.api.workflows.params.set(app, "approve", "limit", 1_000_000);
    tests.push(await owner.api.workflows.test(app, "approve"));
    const [first, raised] = tests.map(({ version, runs }) => ({
      version,
      runs: runs.map(({ name, status, report }) => ({
        name,
        status,
        asks: report.includes("review#ask"),
        books: report.includes('- book {"total":800000}'),
      })),
    }));
    const run = {
      name: "books a large invoice once approved",
      status: "completed",
      books: true,
    };
    expect({ events, first, raised }).toStrictEqual({
      events: [],
      first: { version: 1, runs: [{ ...run, asks: true }] },
      raised: { version: 1, runs: [{ ...run, asks: false }] },
    });
    await expect(
      outcome(user.api.workflows.test(app, "approve"))
    ).resolves.toBe("role.forbidden");
  });
});
