import { appIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { hoursOf } from "../blueprints/board-page/files/app/figures.ts";
import { callApp } from "../src/app.ts";
import type { AppCallerInput } from "../src/app.ts";
import { builtinAppId } from "../src/builtin-app-id.ts";
import { builtins, fingerprintOf, release } from "../src/builtins.ts";
import {
  grantReviewed,
  release as releaseFiles,
  revokeOtherCopies,
  serverBuilt,
} from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { auditedDuring, outcome, signedInApi, unique } from "./sign-in.ts";

// The board page, the built-in App (apps/core/blueprints/board-page/): an
// App created from it asks for the Playbook, and once an admin grants it,
// takes snapshots there, shows the newest, and saves its narrative and
// the decision it asks for, keeping what the snapshot froze. A snapshot
// freezes each workflow's hours as drawn, designed and as it runs, and
// the improvement signals of the App workflows the Playbook links to
// (app/figures.ts), which the workflow map keeps as records (its own
// built-in App, whose types they are). These tests go in through the
// Apps' server methods, as their screens call them, and start from the
// ways it can fail: a number that isn't what the records and runs say (a
// run outside the window counted, the designed version taken for the drawn
// one); a later save, run or day of signals changing a snapshot taken
// before it; a save of the snapshot, by the page or by a person, changing
// what it froze; a signal's subject (a person) or another App's signals
// copied into a record everyone reads; a workflow that no longer reads as
// one, or a designed one never drawn, stopping a snapshot or frozen as
// what it isn't; and someone who may not change the Playbook taking one.

const idp = mockIdp();

type Person = Awaited<ReturnType<typeof signedInApi>>;

const boardPage = builtinAppId("board-page");
const workflowMap = builtinAppId("workflow-map");

/** The collection the Playbook's built-ins declare. */
const playbook = "playbook";

const dayMs = 24 * 60 * 60 * 1000;

const as = (userId: string): AppCallerInput => ({
  userId,
  mode: "interactive",
});

/** What a server method answered (`{ ok }`), as `schema` reads it. */
const okOf = <T>(answer: unknown, schema: z.ZodType<T>): T => {
  const { ok } = z.object({ ok: schema }).parse(answer);
  return ok;
};

const listedSchema = z.object({
  access: z.enum(["none", "ok"]),
  snapshots: z.array(
    z.object({ id: z.string(), path: z.string(), title: z.string() })
  ),
});

const snapshotSchema = z.object({
  id: z.string(),
  path: z.string(),
  version: z.number(),
  record: z.record(z.string(), z.unknown()),
  body: z.string(),
});

const savedSchema = z.object({
  id: z.string(),
  path: z.string(),
  currentVersion: z.number(),
});

/** An App created from the built-in `blueprint` by `admin`, granted or not. */
const fromBuiltin = async (admin: Person, blueprint: string, grant = true) => {
  await builtins(env).ensureInstalled(await fingerprintOf(env, release));
  const created = await admin.api.apps.blueprints.create(blueprint, 1, {
    name: `Ours ${unique()}`,
  });
  const asked = created.permissions.map(({ object, actions, binding }) => ({
    object,
    actions,
    binding,
  }));
  if (grant) {
    await revokeOtherCopies(admin.api, blueprint, created.app.id);
    for (const { id } of created.permissions) {
      // oxlint-disable-next-line no-await-in-loop -- one grant at a time
      await grantReviewed(admin.api, id);
    }
  }
  await admin.api.apps.versions.setCurrent(created.app.id, 1);
  await serverBuilt(created.app.id, 1);
  return { app: appIdSchema.parse(created.app.id), asked };
};

/**
 * An admin's board page, granted or not, and their workflow map, whose
 * types the Playbook's workflows and teams are.
 */
const setUp = async (grant = true) => {
  const admin = await signedInApi(idp, "admin");
  const { app, asked } = await fromBuiltin(admin, boardPage, grant);
  const { app: map } = await fromBuiltin(admin, workflowMap);
  return { admin, app, map, asked };
};

const call = async (
  app: AppId,
  userId: string,
  method: string,
  ...args: unknown[]
): Promise<unknown> => await callApp(env, app, as(userId), method, args);

/** Saves a workflow through the map, as its screen does. */
const saveWorkflow = async (
  map: AppId,
  admin: Person,
  input: {
    documentId?: string;
    path?: string;
    ifVersion: number;
    record: Record<string, unknown>;
  }
) =>
  okOf(
    await call(map, admin.userId, "save", { ...input, body: "" }),
    savedSchema
  );

const estimated = (value: number) => ({ value, basis: "estimated" as const });
const observed = (value: number) => ({ value, basis: "observed" as const });

const workflowFile = `import { workflow, z } from "@grasp-os/sdk/workflow";

export default workflow(
  "pay",
  { input: z.unknown(), params: {} },
  async (step) => await step.do("count", { description: "Count" }, async () => 1)
);
`;

const workflowTestsFile = `import { workflowTests } from "@grasp-os/sdk/testing";

import pay from "./pay.ts";

export default workflowTests(pay, [{ name: "counts", mocks: { count: 1 }, expect: { output: 1 } }]);
`;

/** An App whose running version has the workflow `pay`, released by `admin`. */
const payablesApp = async (admin: Person): Promise<AppId> => {
  const { id } = await admin.api.apps.create({ name: `Payables ${unique()}` });
  await releaseFiles(admin, id, {
    "app/server.ts": "export class App {}\n",
    "workflows/pay.ts": workflowFile,
    "workflows/pay.workflow-tests.ts": workflowTestsFile,
  });
  return appIdSchema.parse(id);
};

/** `count` runs of `app`'s workflow `pay`, started `ago` milliseconds back. */
const seedRuns = async (
  app: AppId,
  count: number,
  ago: number
): Promise<void> => {
  const at = Date.now() - ago;
  await env.DB.batch(
    Array.from({ length: count }, () =>
      env.DB.prepare(
        "INSERT INTO workflow_runs (id, app_id, workflow_id, version, started_by, status, created_at, ended_at) VALUES (?, ?, 'pay', 1, NULL, 'completed', ?, ?)"
      ).bind(`run-${unique()}-${unique()}`, app, at, at)
    )
  );
};

/**
 * Each seeded computation starts after the one before, so the latest wins,
 * and all within the last hour: a read counts none started after its now.
 */
let computations = 0;

/**
 * A finished computation of improvement signals, the latest, with
 * `signals` as `[app, workflow, kind, subject, value]`.
 */
const seedSignals = async (
  signals: [string, string, string, string, number][]
): Promise<void> => {
  computations += 1;
  const id = `computation-${unique()}`;
  const startedAt = Date.now() - 60 * 60_000 + computations * 1000;
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO improvement_signal_computations (id, day, started_at, finished_at) VALUES (?, ?, ?, ?)"
    ).bind(
      id,
      new Date(startedAt).toISOString().slice(0, 10),
      startedAt,
      startedAt
    ),
    ...signals.map(([app, workflow, kind, subject, value]) =>
      env.DB.prepare(
        "INSERT INTO improvement_signals (computation, app_id, workflow_id, kind, subject, value, evidence) VALUES (?, ?, ?, ?, ?, ?, '{}')"
      ).bind(id, app, workflow, kind, subject, value)
    ),
  ]);
};

/**
 * A team, a drawn workflow and a designed one linked to `pay` of a new
 * App, in a folder of their own, saved through the map.
 */
const seedPlaybook = async (admin: Person, map: AppId) => {
  const folder = `seeded-${unique()}`;
  const team = okOf(
    await call(map, admin.userId, "addTeam", `Finance ${folder}`),
    z.object({ path: z.string(), title: z.string() })
  );
  const book = await saveWorkflow(map, admin, {
    path: `${folder}/book.md`,
    ifVersion: 0,
    record: {
      type: "workflow",
      title: "Book receipts",
      state: "drawn",
      team: team.path,
      steps: [
        {
          name: "Book it",
          numbers: {
            frequency: estimated(40),
            minutes: observed(6),
            people: estimated(1),
          },
        },
      ],
    },
  });
  // Drawn at 10 hours a week, then designed, then linked to `pay`.
  const drawn = await saveWorkflow(map, admin, {
    path: `${folder}/pay.md`,
    ifVersion: 0,
    record: {
      type: "workflow",
      title: "Pay invoices",
      state: "drawn",
      steps: [
        {
          name: "Match",
          numbers: {
            frequency: estimated(30),
            minutes: estimated(10),
            people: estimated(2),
          },
        },
      ],
    },
  });
  const designed = await saveWorkflow(map, admin, {
    documentId: drawn.id,
    path: drawn.path,
    ifVersion: 1,
    record: {
      type: "workflow",
      title: "Pay invoices",
      state: "designed",
      steps: [
        {
          name: "Match",
          kind: "automated",
          numbers: { frequency: observed(30), minutes: observed(0) },
        },
        {
          name: "Approve",
          numbers: { frequency: estimated(30), minutes: estimated(5) },
        },
      ],
    },
  });
  const payables = await payablesApp(admin);
  okOf(
    await call(map, admin.userId, "link", {
      documentId: designed.id,
      ifVersion: 2,
      appId: payables,
      workflowId: "pay",
    }),
    savedSchema
  );
  return { folder, team, book, pay: designed, payables };
};

/** The figures of `path` among a snapshot record's. */
const figuresOf = (record: Record<string, unknown>, path: string): unknown =>
  z
    .object({
      figures: z.object({
        workflows: z.array(z.looseObject({ path: z.string() })),
      }),
    })
    .parse(record)
    .figures.workflows.find((workflow) => workflow.path === path);

/** A snapshot record's signals of the workflows under `folder`. */
const signalsOf = (record: Record<string, unknown>, folder: string) =>
  z
    .object({
      figures: z.object({
        signals: z.array(z.object({ path: z.string() }).loose()),
      }),
    })
    .parse(record)
    .figures.signals.filter(({ path }) => path.startsWith(`${folder}/`));

/** The workflow versions a snapshot record froze under `folder`. */
const frozenIn = (record: Record<string, unknown>, folder: string) =>
  z
    .array(z.object({ path: z.string(), version: z.number() }))
    .parse(record.workflows)
    .filter(({ path }) => path.startsWith(`${folder}/`));

/** Where the page puts a snapshot: by the time it was taken, to the millisecond. */
const snapshotPath = /^snapshots\/\d{4}-\d{2}-\d{2}T\d{9}Z-[0-9a-f]{8}\.md$/u;

describe("a snapshot's hours", () => {
  it("take times × minutes × people over 60, one person where none is said, observed only when every number is", () => {
    expect({
      estimated: hoursOf([
        {
          numbers: {
            frequency: estimated(30),
            minutes: observed(10),
            people: estimated(2),
          },
        },
        { numbers: { frequency: observed(1), minutes: observed(30) } },
      ]),
      observed: hoursOf([
        { numbers: { frequency: observed(1), minutes: observed(30) } },
      ]),
      none: hoursOf([{}]),
      // Each step once a run, at 7 runs a week.
      perWeek: hoursOf(
        [
          { numbers: { frequency: estimated(100), minutes: estimated(30) } },
          { numbers: { minutes: estimated(30), people: estimated(2) } },
        ],
        7
      ),
      // Absurd numbers are held to what a snapshot holds.
      absurd: hoursOf([
        {
          numbers: {
            frequency: estimated(10_000),
            minutes: estimated(10_000),
            people: estimated(10_000),
          },
        },
      ]).hoursPerWeek,
    }).toStrictEqual({
      estimated: { hoursPerWeek: 10.5, basis: "estimated" },
      observed: { hoursPerWeek: 0.5, basis: "observed" },
      none: { hoursPerWeek: 0, basis: "estimated" },
      perWeek: { hoursPerWeek: 10.5, basis: "estimated" },
      absurd: 100_000,
    });
  });
});

describe("the board page", { timeout: 60_000 }, () => {
  it("asks for the Playbook, takes a snapshot there, and saves its narrative and decision keeping what it froze", async () => {
    const { admin, app, map, asked } = await setUp();
    expect(
      asked.toSorted((a, b) => a.binding.localeCompare(b.binding))
    ).toStrictEqual([
      // The runs and signals it freezes.
      {
        object: { type: "platform" },
        actions: ["statistics"],
        binding: "PLATFORM",
      },
      {
        object: { type: "collection", collectionId: playbook },
        actions: ["read", "write"],
        binding: "PLAYBOOK",
      },
    ]);
    // A drawn workflow for it to freeze: 20 times × 30 minutes, 10 hours.
    const { path } = await saveWorkflow(map, admin, {
      path: `workflows/board-${unique()}.md`,
      ifVersion: 0,
      record: {
        type: "workflow",
        title: "Answer tenders",
        state: "drawn",
        steps: [
          {
            name: "Write it",
            numbers: {
              frequency: { value: 20, basis: "estimated" },
              minutes: { value: 30, basis: "estimated" },
            },
          },
        ],
      },
    });

    const taken = okOf(
      await call(app, admin.userId, "take", {
        maturity: 2,
        decisionNeeded: "Hire a bid writer?",
      }),
      savedSchema
    );
    const listed = okOf(
      await call(app, admin.userId, "snapshots"),
      listedSchema
    );
    const opened = okOf(
      await call(app, admin.userId, "open", taken.id),
      snapshotSchema
    );
    const written = okOf(
      await call(app, admin.userId, "write", {
        id: taken.id,
        ifVersion: 1,
        decisionNeeded: "Hire two bid writers?",
        body: "Tenders take most of our hours.",
      }),
      savedSchema
    );
    // From version 1 again: someone else's save came first.
    const stale = await call(app, admin.userId, "write", {
      id: taken.id,
      ifVersion: 1,
      decisionNeeded: "",
      body: "",
    });
    // Cleared: the decision is gone.
    okOf(
      await call(app, admin.userId, "write", {
        id: taken.id,
        ifVersion: 2,
        decisionNeeded: " ",
        body: "Tenders take most of our hours.",
      }),
      savedSchema
    );
    const reopened = okOf(
      await call(app, admin.userId, "open", taken.id),
      snapshotSchema
    );
    const { decisionNeeded: _decision, ...frozen } = opened.record;

    expect({
      newest: listed.snapshots[0]?.id,
      access: listed.access,
      decision: opened.record.decisionNeeded,
      tenders: figuresOf(opened.record, path),
      written: written.currentVersion,
      stale,
      reopened: {
        version: reopened.version,
        body: reopened.body,
        record: reopened.record,
      },
    }).toStrictEqual({
      newest: taken.id,
      access: "ok",
      decision: "Hire a bid writer?",
      tenders: {
        path,
        title: "Answer tenders",
        state: "drawn",
        drawn: { version: 1, hoursPerWeek: 10, basis: "estimated" },
      },
      written: 2,
      stale: { error: "knowledge.conflict" },
      reopened: {
        version: 3,
        body: "Tenders take most of our hours.",
        record: frozen,
      },
    });
  });

  it("lists the snapshot taken last first, however many were taken that day", async () => {
    const { admin, app } = await setUp();
    const take = async () =>
      okOf(await call(app, admin.userId, "take", { maturity: 1 }), savedSchema);
    const first = await take();
    const second = await take();
    const third = await take();
    const listed = okOf(
      await call(app, admin.userId, "snapshots"),
      listedSchema
    );
    expect(
      listed.snapshots
        .map(({ id }) => id)
        .filter((id) => [first.id, second.id, third.id].includes(id))
    ).toStrictEqual([third.id, second.id, first.id]);
  });

  it("opens and writes a narrative only into a snapshot", async () => {
    const { admin, app, map } = await setUp();
    const workflow = await saveWorkflow(map, admin, {
      path: `workflows/not-a-snapshot-${unique()}.md`,
      ifVersion: 0,
      record: { type: "workflow", title: "Not a snapshot", state: "drawn" },
    });
    const written = await call(app, admin.userId, "write", {
      id: workflow.id,
      ifVersion: 1,
      decisionNeeded: "Anything?",
      body: "Overwritten?",
    });
    const after = await admin.api.knowledge.getDocument(workflow.id);
    expect({
      opened: await call(app, admin.userId, "open", workflow.id),
      written,
      after: after.currentVersion,
    }).toStrictEqual({
      opened: { error: "board.not_snapshot" },
      written: { error: "board.not_snapshot" },
      after: 1,
    });
  });

  it("refuses whoever may not change the Playbook before reading anything, and says it has no Playbook until an admin grants it", async () => {
    const { admin, app, map } = await setUp();
    // Workflows linked to an App, whose statistics a snapshot would read.
    await seedPlaybook(admin, map);
    const user = await signedInApi(idp, "user");
    const { app: ungranted } = await fromBuiltin(admin, boardPage, false);
    let refused: unknown;
    const events = await auditedDuring(async () => {
      refused = await call(app, user.userId, "take", { maturity: 1 });
    });
    expect({
      read: events.filter(({ action }) => action === "statistics.read").length,
    }).toStrictEqual({ read: 0 });
    expect({
      user: refused,
      level: await call(app, admin.userId, "take", { maturity: 6 }),
      listed: await call(ungranted, admin.userId, "snapshots"),
      take: await call(ungranted, admin.userId, "take", { maturity: 1 }),
    }).toStrictEqual({
      user: { error: "knowledge.forbidden" },
      level: { error: "knowledge.invalid" },
      listed: { ok: { access: "none", snapshots: [] } },
      take: { error: "permission.denied" },
    });
  });

  it("freezes each workflow's hours drawn, designed and as it runs, and its App workflow's signals", async () => {
    const { admin, app, map } = await setUp();
    const { folder, team, book, pay, payables } = await seedPlaybook(
      admin,
      map
    );
    // Another App a workflow links to: counted in the same reads.
    const { payables: another } = await seedPlaybook(admin, map);
    // 30 runs in the window: 7 a week. One before it doesn't count.
    await seedRuns(payables, 30, dayMs);
    await seedRuns(payables, 1, 40 * dayMs);
    await seedSignals([
      [payables, "pay", "failing_step", "match", 3],
      [payables, "pay", "waiting_for_person", "person:someone", 7_200_000],
      [payables, "pay", "waiting_for_person", "role:admin", 3_600_000],
      ["another-app", "pay", "failing_step", "match", 9],
    ]);

    let taken: z.infer<typeof savedSchema> | undefined;
    const events = await auditedDuring(async () => {
      taken = okOf(
        await call(app, admin.userId, "take", {
          maturity: 2,
          decisionNeeded: "Automate paying invoices next quarter?",
        }),
        savedSchema
      );
    });
    const { record } = okOf(
      await call(app, admin.userId, "open", taken?.id),
      snapshotSchema
    );
    const date = z.string().parse(record.date);
    expect({
      path:
        snapshotPath.test(taken?.path ?? "") &&
        taken?.path.startsWith(`snapshots/${date}T`),
      title: record.title,
      maturity: record.maturity,
      decisionNeeded: record.decisionNeeded,
      frozen: frozenIn(record, folder),
      book: figuresOf(record, book.path),
      pay: figuresOf(record, pay.path),
      signals: signalsOf(record, folder),
      // One read of the runs and one of the signals, for every App linked.
      reads: events
        .filter(({ action }) => action === "statistics.read")
        .map(({ provenance }) => ({
          payables: provenance.includes(payables),
          another: provenance.includes(another),
        })),
      saved: events
        .filter(({ action }) => action === "knowledge.document.saved")
        .map(({ actor, detail }) => ({
          actor,
          collectionId: detail?.collectionId,
          onBehalfOf: detail?.onBehalfOf,
        })),
    }).toStrictEqual({
      path: true,
      title: `Snapshot ${date}`,
      maturity: 2,
      decisionNeeded: "Automate paying invoices next quarter?",
      // Each drawn workflow at its version, a designed one at its latest
      // drawn version and its current one.
      frozen: [
        { path: book.path, version: 1 },
        { path: pay.path, version: 1 },
        { path: pay.path, version: 3 },
      ],
      // 40 times × 6 minutes: 4 hours, some numbers estimated.
      book: {
        path: book.path,
        title: "Book receipts",
        team: team.title,
        state: "drawn",
        drawn: { version: 1, hoursPerWeek: 4, basis: "estimated" },
      },
      pay: {
        path: pay.path,
        title: "Pay invoices",
        state: "designed",
        // 30 × 10 minutes × 2 people.
        drawn: { version: 1, hoursPerWeek: 10, basis: "estimated" },
        // 30 × 5 minutes, as designed.
        designed: { version: 3, hoursPerWeek: 2.5, basis: "estimated" },
        // 7 runs a week × 5 minutes: 35 minutes.
        running: {
          appId: payables,
          workflowId: "pay",
          runs: 30,
          hoursPerWeek: 0.6,
        },
      },
      // Each kind's highest, with no subject, and none of another App's.
      signals: [
        { path: pay.path, kind: "waiting_for_person", value: 7_200_000 },
        { path: pay.path, kind: "failing_step", value: 3 },
      ],
      reads: [
        { payables: true, another: true },
        { payables: true, another: true },
      ],
      saved: [
        {
          actor: { type: "app", appId: app, part: "server" },
          collectionId: playbook,
          onBehalfOf: admin.userId,
        },
      ],
    });
  });

  it("refuses to freeze figures it can't read whole, and saves nothing", async () => {
    const { admin, app, map } = await setUp();
    const { payables } = await seedPlaybook(admin, map);
    // 501 workflows of a linked App ran: more groups than a snapshot reads.
    const bulk = `bulk-${unique()}-`;
    await env.DB.prepare(
      "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 501) INSERT INTO workflow_runs (id, app_id, workflow_id, version, started_by, status, created_at, ended_at) SELECT ?1 || i, ?2, 'w' || i, 1, NULL, 'completed', ?3, ?3 FROM n"
    )
      .bind(bulk, payables, Date.now())
      .run();
    try {
      const before = listedSchema.parse(
        z
          .object({ ok: z.unknown() })
          .parse(await call(app, admin.userId, "snapshots")).ok
      ).snapshots.length;
      const taken = await call(app, admin.userId, "take", { maturity: 1 });
      const after = listedSchema.parse(
        z
          .object({ ok: z.unknown() })
          .parse(await call(app, admin.userId, "snapshots")).ok
      ).snapshots.length;
      expect({ taken, saved: after - before }).toStrictEqual({
        taken: { error: "board.figures_incomplete" },
        saved: 0,
      });
    } finally {
      // The Playbook is shared by this file's tests.
      await env.DB.prepare("DELETE FROM workflow_runs WHERE id LIKE ?")
        .bind(`${bulk}%`)
        .run();
    }
  });

  it("keeps what a snapshot froze when the workflows, runs and signals change later, and when anyone saves it again", async () => {
    const { admin, app, map } = await setUp();
    const { book, payables } = await seedPlaybook(admin, map);
    await seedRuns(payables, 30, dayMs);
    await seedSignals([[payables, "pay", "failing_step", "match", 3]]);
    const taken = okOf(
      await call(app, admin.userId, "take", { maturity: 1 }),
      savedSchema
    );
    const open = async () =>
      okOf(await call(app, admin.userId, "open", taken.id), snapshotSchema);
    const before = await open();

    // Later: the drawn workflow is redrawn, more runs start, a new day's
    // signals come in.
    await saveWorkflow(map, admin, {
      documentId: book.id,
      path: book.path,
      ifVersion: 1,
      record: {
        type: "workflow",
        title: "Book receipts",
        state: "drawn",
        steps: [
          {
            name: "Book it",
            numbers: { frequency: estimated(1), minutes: estimated(1) },
          },
        ],
      },
    });
    await seedRuns(payables, 60, dayMs);
    await seedSignals([[payables, "pay", "failing_step", "match", 30]]);
    const later = await open();

    // A person saving its text, past the page: what it froze stays.
    const { version: current } = await admin.api.knowledge.getDocument(
      taken.id
    );
    const edit = async (text: string) =>
      await outcome(
        admin.api.knowledge.saveDocument({
          collectionId: playbook,
          path: taken.path,
          text,
          ifVersion: 1,
        })
      );
    const refigured = await edit(
      current.text.replace("maturity: 1", "maturity: 4")
    );
    const narrated = await edit(`${current.text}\nA narrative by hand.\n`);
    const after = await open();
    expect({
      later: later.record,
      refigured,
      narrated,
      after: { version: after.version, record: after.record },
    }).toStrictEqual({
      later: before.record,
      refigured: "knowledge.invalid",
      narrated: "ok",
      after: { version: 2, record: before.record },
    });
  });

  it("reads each designed workflow's drawn version once, as its record names it, however many workflows", async () => {
    const { admin, app, map } = await setUp();
    const folder = `many-${unique()}`;
    // More designed workflows than a page of records, each drawn first.
    const designed = await Promise.all(
      Array.from({ length: 25 }, async (_, index) => {
        const drawn = await saveWorkflow(map, admin, {
          path: `${folder}/${index}.md`,
          ifVersion: 0,
          record: {
            type: "workflow",
            title: `Workflow ${index}`,
            state: "drawn",
            steps: [
              {
                name: "Do it",
                numbers: { frequency: estimated(6), minutes: estimated(10) },
              },
            ],
          },
        });
        return await saveWorkflow(map, admin, {
          documentId: drawn.id,
          path: drawn.path,
          ifVersion: 1,
          record: {
            type: "workflow",
            title: `Workflow ${index}`,
            state: "designed",
          },
        });
      })
    );
    let taken: z.infer<typeof savedSchema> | undefined;
    const events = await auditedDuring(async () => {
      taken = okOf(
        await call(app, admin.userId, "take", { maturity: 1 }),
        savedSchema
      );
    });
    const { record } = okOf(
      await call(app, admin.userId, "open", taken?.id),
      snapshotSchema
    );
    // Each read of one version is an event with that document as target;
    // a page of records is one with the collection.
    const readsOf = new Map<string, number>();
    for (const { action, target } of events) {
      if (action === "knowledge.read" && target?.type === "document") {
        readsOf.set(target.id, (readsOf.get(target.id) ?? 0) + 1);
      }
    }
    expect({
      frozen: frozenIn(record, folder).length,
      readOnce: designed.every(({ id }) => readsOf.get(id) === 1),
    }).toStrictEqual({ frozen: 50, readOnce: true });
  });

  it("leaves out a workflow that no longer reads as one, and a drawn version a designed one never had", async () => {
    const { admin, app, map } = await setUp();
    const folder = `odd-${unique()}`;
    const designedOnly = await saveWorkflow(map, admin, {
      path: `${folder}/designed.md`,
      ifVersion: 0,
      record: {
        type: "workflow",
        title: "Designed from the start",
        state: "designed",
        steps: [
          {
            name: "Check",
            numbers: { frequency: estimated(6), minutes: estimated(10) },
          },
        ],
      },
    });
    const broken = await saveWorkflow(map, admin, {
      path: `${folder}/broken.md`,
      ifVersion: 0,
      record: { type: "workflow", title: "Broken", state: "drawn" },
    });
    // As a type another version of the map declared would leave it.
    await env.KNOWLEDGE.prepare(
      "UPDATE versions SET text = ? WHERE document_id = ?"
    )
      .bind("---\ntype: workflow\nstate: sketched\n---\n", broken.id)
      .run();

    const taken = okOf(
      await call(app, admin.userId, "take", { maturity: 0 }),
      savedSchema
    );
    const { record } = okOf(
      await call(app, admin.userId, "open", taken.id),
      snapshotSchema
    );
    expect({
      designed: figuresOf(record, designedOnly.path),
      broken: figuresOf(record, broken.path),
      frozen: frozenIn(record, folder),
    }).toStrictEqual({
      designed: {
        path: designedOnly.path,
        title: "Designed from the start",
        state: "designed",
        designed: { version: 1, hoursPerWeek: 1, basis: "estimated" },
      },
      broken: undefined,
      frozen: [{ path: designedOnly.path, version: 1 }],
    });
  });
});
