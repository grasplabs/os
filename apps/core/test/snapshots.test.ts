import { appIdSchema, permissionIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import { playbookCollectionId } from "@grasp-os/shared/knowledge";
import type { PermissionRequest } from "@grasp-os/shared/permissions";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { callApp } from "../src/app.ts";
import type { AppCallerInput } from "../src/app.ts";
import { takeSnapshotAsDelegate } from "../src/knowledge/playbook.ts";
import { hoursOf } from "../src/knowledge/snapshots.ts";
import { release, requestGranted, serverBuilt } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { auditedDuring, outcome, signedInApi, unique } from "./sign-in.ts";

// Snapshots the platform takes (knowledge/snapshots.ts, `takeSnapshot` on
// an App's Playbook stub): a dated record that freezes every workflow's
// hours as drawn, designed and as it runs, and the improvement signals of
// the App workflows the Playbook links to. These tests seed workflow
// records, runs and signals, take a snapshot through an App's server
// code, and start from the ways it can fail: a number that isn't what the
// records and runs say (a run outside the window counted, the designed
// version taken for the drawn one); a later save, run or day of signals
// changing a snapshot taken before it; a save of the snapshot changing
// what it froze, or an App writing figures of its own; a signal's subject
// (a person) or another App's signals copied into a record everyone
// reads; a workflow that no longer reads as one, a designed one never
// drawn, or drawn many versions ago, stopping a snapshot or frozen as
// what it isn't; someone who may
// not change the Playbook taking one; and a Playbook with more workflows
// than one snapshot holds.

const idp = mockIdp();

type Person = Awaited<ReturnType<typeof signedInApi>>;

const dayMs = 24 * 60 * 60 * 1000;

const serverCode = `import { DurableObject } from "cloudflare:workers";

type Caller = { userId: string; token: string };
type Stub = Record<string, (caller: Caller, ...args: unknown[]) => Promise<unknown>>;

const outcome = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    return { ok: await run() };
  } catch (error) {
    return { error: (error as { code?: string }).code ?? "failed" };
  }
};

export class App extends DurableObject {
  get playbook(): Stub {
    return (this.env as Record<string, Stub>).PLAYBOOK ?? {};
  }

  async save(caller: Caller, input: unknown): Promise<unknown> {
    return await outcome(async () => await this.playbook.saveRecord(caller, input));
  }

  async link(caller: Caller, input: unknown): Promise<unknown> {
    return await outcome(async () => await this.playbook.linkWorkflow(caller, input));
  }

  async snapshot(caller: Caller, input: unknown): Promise<unknown> {
    return await outcome(async () => await this.playbook.takeSnapshot(caller, input));
  }

  async record(caller: Caller, id: string, version?: number): Promise<unknown> {
    return await outcome(async () => await this.playbook.getRecord(caller, id, version));
  }
}
`;

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

const as = (userId: string): AppCallerInput => ({
  userId,
  mode: "interactive",
});

/** A permission for `app` to read and write the Playbook. */
const playbookFor = (
  app: AppId,
  actions: string[] = ["read", "write"],
  binding = "PLAYBOOK"
): PermissionRequest => ({
  subject: { type: "app", appId: app },
  object: { type: "collection", collectionId: playbookCollectionId },
  actions,
  binding,
});

/** A new App running `serverCode`, granted the Playbook, released by `admin`. */
const snapshotApp = async (admin: Person): Promise<AppId> => {
  const { id } = await admin.api.apps.create({ name: `Board ${unique()}` });
  await serverBuilt(
    id,
    await release(admin, id, { "app/server.ts": serverCode })
  );
  const app = appIdSchema.parse(id);
  await requestGranted(idp, admin, playbookFor(app));
  return app;
};

/** An App whose running version has the workflow `pay`, released by `admin`. */
const payablesApp = async (admin: Person): Promise<AppId> => {
  const { id } = await admin.api.apps.create({ name: `Payables ${unique()}` });
  await release(admin, id, {
    "app/server.ts": "export class App {}\n",
    "workflows/pay.ts": workflowFile,
    "workflows/pay.workflow-tests.ts": workflowTestsFile,
  });
  return appIdSchema.parse(id);
};

const estimated = (value: number) => ({ value, basis: "estimated" as const });
const observed = (value: number) => ({ value, basis: "observed" as const });

/** `app`'s method `method`, called for `userId`. */
const call = async (
  app: AppId,
  userId: string,
  method: string,
  ...args: unknown[]
): Promise<unknown> => await callApp(env, app, as(userId), method, args);

/** What a server method answered (`{ ok }`), as `schema` reads it. */
const okOf = <T>(answer: unknown, schema: z.ZodType<T>): T => {
  const { ok } = z.object({ ok: schema }).parse(answer);
  return ok;
};

const savedSchema = z.object({
  id: z.string(),
  path: z.string(),
  title: z.string(),
  currentVersion: z.number(),
});

const recordSchema = z.object({
  version: z.object({ number: z.number() }),
  record: z.record(z.string(), z.unknown()),
  body: z.string(),
});

/** Saves `record` at `path` from `ifVersion` through `app`, for `admin`. */
const save = async (
  app: AppId,
  admin: Person,
  path: string,
  record: Record<string, unknown>,
  ifVersion = 0,
  body = ""
) =>
  okOf(
    await call(app, admin.userId, "save", { path, ifVersion, record, body }),
    savedSchema
  );

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

/** Each seeded computation starts after the one before: the latest wins. */
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
  const startedAt = Date.now() + computations * dayMs;
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

/** A team, a drawn workflow and a designed one linked to `pay`, running. */
const seedPlaybook = async (admin: Person, app: AppId) => {
  const folder = `seeded-${unique()}`;
  const team = await save(app, admin, `${folder}/finance.md`, {
    type: "team",
    title: "Finance",
  });
  // Drawn, and left so.
  const book = await save(app, admin, `${folder}/book.md`, {
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
  });
  // Drawn at 10 hours a week, then designed, then linked to `pay`.
  const payPath = `${folder}/pay.md`;
  await save(app, admin, payPath, {
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
  });
  const designed = await save(
    app,
    admin,
    payPath,
    {
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
    1
  );
  const payables = await payablesApp(admin);
  okOf(
    await call(app, admin.userId, "link", {
      documentId: designed.id,
      ifVersion: 2,
      appId: payables,
      workflowId: "pay",
    }),
    savedSchema
  );
  return { folder, book, pay: designed, payables };
};

/** How many snapshots the Playbook holds. */
const snapshotCount = async () =>
  await env.KNOWLEDGE.prepare(
    "SELECT count(*) AS count FROM documents WHERE collection_id = ? AND type = 'snapshot'"
  )
    .bind(playbookCollectionId)
    .first<{ count: number }>();

/** Where the platform puts a snapshot: by the time it was taken, to the millisecond. */
const snapshotPath = /^snapshots\/\d{4}-\d{2}-\d{2}T\d{9}Z-[0-9a-f]{8}\.md$/u;

/** Today's UTC date, as a snapshot is dated. */
const today = (): string => new Date().toISOString().slice(0, 10);

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

describe("snapshots the platform takes", { timeout: 60_000 }, () => {
  it("freeze each workflow's hours drawn, designed and as it runs, and its App workflow's signals", async () => {
    const admin = await signedInApi(idp, "admin");
    const app = await snapshotApp(admin);
    const { folder, book, pay, payables } = await seedPlaybook(admin, app);
    // 30 runs in the window: 7 a week. One before it doesn't count.
    await seedRuns(payables, 30, dayMs);
    await seedRuns(payables, 1, 40 * dayMs);
    await seedSignals([
      [payables, "pay", "failing_step", "match", 3],
      [payables, "pay", "waiting_for_person", "person:someone", 7_200_000],
      [payables, "pay", "waiting_for_person", "role:admin", 3_600_000],
      ["another-app", "pay", "failing_step", "match", 9],
    ]);

    const events = await auditedDuring(async () => {
      const dayBefore = today();
      const taken = okOf(
        await call(app, admin.userId, "snapshot", {
          maturity: 2,
          decisionNeeded: "Automate paying invoices next quarter?",
          body: "We are drawing, and one workflow runs.",
        }),
        savedSchema
      );
      const dayAfter = today();
      const { record, body } = okOf(
        await call(app, admin.userId, "record", taken.id),
        recordSchema
      );
      const date = z.string().parse(record.date);
      expect({
        // The day it was taken, whichever side of midnight the call was.
        date: [dayBefore, dayAfter].includes(date),
        path:
          snapshotPath.test(taken.path) &&
          taken.path.startsWith(`snapshots/${date}T`),
        title: taken.title,
        currentVersion: taken.currentVersion,
        maturity: record.maturity,
        decisionNeeded: record.decisionNeeded,
        body,
        frozen: z
          .array(z.object({ path: z.string(), version: z.number() }))
          .parse(record.workflows)
          .filter(({ path }) => path.startsWith(`${folder}/`)),
        book: figuresOf(record, book.path),
        pay: figuresOf(record, pay.path),
        signals: signalsOf(record, folder),
      }).toStrictEqual({
        date: true,
        path: true,
        title: `Snapshot ${date}`,
        currentVersion: 1,
        maturity: 2,
        decisionNeeded: "Automate paying invoices next quarter?",
        body: "We are drawing, and one workflow runs.",
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
          team: "Finance",
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
      });
    });
    expect(
      events
        .filter(({ action }) => action === "knowledge.document.saved")
        .map(({ actor, detail }) => ({
          actor: actor.type,
          collectionId: detail?.collectionId,
          onBehalfOf: detail?.onBehalfOf,
        }))
    ).toStrictEqual([
      {
        actor: "app",
        collectionId: playbookCollectionId,
        onBehalfOf: admin.userId,
      },
    ]);
  });

  it("keep what they froze when the workflows, runs and signals change later, and when saved again", async () => {
    const admin = await signedInApi(idp, "admin");
    const app = await snapshotApp(admin);
    const { folder, book, payables } = await seedPlaybook(admin, app);
    await seedRuns(payables, 30, dayMs);
    await seedSignals([[payables, "pay", "failing_step", "match", 3]]);
    const taken = okOf(
      await call(app, admin.userId, "snapshot", {
        maturity: 1,
        title: "Before the board",
        decisionNeeded: "",
      }),
      savedSchema
    );
    const read = async (version?: number) =>
      okOf(
        await call(app, admin.userId, "record", taken.id, version),
        recordSchema
      );
    const before = await read();
    expect({
      title: before.record.title,
      decision: "decisionNeeded" in before.record,
    }).toStrictEqual({ title: "Before the board", decision: false });

    // Later: the drawn workflow is redrawn, more runs start, a new day's
    // signals come in.
    await save(
      app,
      admin,
      book.path,
      {
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
      1
    );
    await seedRuns(payables, 60, dayMs);
    await seedSignals([[payables, "pay", "failing_step", "match", 30]]);
    const later = await read();

    // Saved again as the board page does: a new narrative and decision,
    // and a maturity and date of its own, which it keeps as taken.
    const { figures: _figures, ...rest } = before.record;
    okOf(
      await call(app, admin.userId, "save", {
        path: taken.path,
        ifVersion: 1,
        record: {
          ...rest,
          maturity: 5,
          date: "2020-01-01",
          workflows: [],
          decisionNeeded: "Hire a second controller?",
        },
        body: "Rewritten.",
      }),
      savedSchema
    );
    const saved = await read();
    const first = await read(1);
    const forged = await call(app, admin.userId, "save", {
      path: `${folder}/forged.md`,
      ifVersion: 0,
      record: { ...before.record },
      body: "",
    });
    // Saved as text, past saveRecord: what it froze is kept all the same.
    const { version: current } = await admin.api.knowledge.getDocument(
      taken.id
    );
    const raw = await outcome(
      admin.api.knowledge.saveDocument({
        collectionId: playbookCollectionId,
        path: taken.path,
        text: current.text.replace("maturity: 1", "maturity: 4"),
        ifVersion: 2,
      })
    );

    expect({
      raw,
      later: later.record,
      saved: {
        version: saved.version.number,
        body: saved.body,
        decisionNeeded: saved.record.decisionNeeded,
        frozen: {
          maturity: saved.record.maturity,
          date: saved.record.date,
          workflows: saved.record.workflows,
          figures: saved.record.figures,
        },
      },
      first: first.record,
      forged,
    }).toStrictEqual({
      raw: "knowledge.invalid",
      later: before.record,
      saved: {
        version: 2,
        body: "Rewritten.",
        decisionNeeded: "Hire a second controller?",
        frozen: {
          maturity: 1,
          date: before.record.date,
          workflows: before.record.workflows,
          figures: before.record.figures,
        },
      },
      first: before.record,
      // Only the platform writes figures.
      forged: { error: "knowledge.invalid" },
    });
  });

  it("are taken only for someone who may change the Playbook, with a maturity from 0 to 5", async () => {
    const admin = await signedInApi(idp, "admin");
    const app = await snapshotApp(admin);
    const user = await signedInApi(idp, "user");
    const count = await snapshotCount();

    expect({
      user: await call(app, user.userId, "snapshot", { maturity: 1 }),
      level: await call(app, admin.userId, "snapshot", { maturity: 6 }),
      missing: await call(app, admin.userId, "snapshot", {}),
      written: await snapshotCount(),
    }).toStrictEqual({
      user: { error: "knowledge.forbidden" },
      level: { error: "knowledge.invalid" },
      missing: { error: "knowledge.invalid" },
      written: count,
    });
  });

  it("leave out a workflow that no longer reads as one, and a drawn version a designed one never had", async () => {
    const admin = await signedInApi(idp, "admin");
    const app = await snapshotApp(admin);
    const folder = `odd-${unique()}`;
    const designedOnly = await save(app, admin, `${folder}/designed.md`, {
      type: "workflow",
      title: "Designed from the start",
      state: "designed",
      steps: [
        {
          name: "Check",
          numbers: { frequency: estimated(6), minutes: estimated(10) },
        },
      ],
    });
    const broken = await save(app, admin, `${folder}/broken.md`, {
      type: "workflow",
      title: "Broken",
      state: "drawn",
    });
    // As a rollback to a release with other schemas would leave it.
    await env.KNOWLEDGE.prepare(
      "UPDATE versions SET text = ? WHERE document_id = ?"
    )
      .bind("---\ntype: workflow\nstate: sketched\n---\n", broken.id)
      .run();

    const taken = okOf(
      await call(app, admin.userId, "snapshot", { maturity: 0 }),
      savedSchema
    );
    const { record } = okOf(
      await call(app, admin.userId, "record", taken.id),
      recordSchema
    );
    expect({
      designed: figuresOf(record, designedOnly.path),
      broken: figuresOf(record, broken.path),
      frozen: z
        .array(z.object({ path: z.string(), version: z.number() }))
        .parse(record.workflows)
        .filter(({ path }) => path.startsWith(`${folder}/`)),
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

  it("find a designed workflow's drawn version however many versions ago it was", async () => {
    const admin = await signedInApi(idp, "admin");
    const app = await snapshotApp(admin);
    const path = `long-${unique()}/designed.md`;
    const drawn = await save(app, admin, path, {
      type: "workflow",
      title: "Redesigned often",
      state: "drawn",
      steps: [
        {
          name: "Check",
          numbers: { frequency: estimated(6), minutes: estimated(20) },
        },
      ],
    });
    // 60 designed versions since, as that many saves would leave them,
    // each with a step whose name says "drawn", which isn't its state.
    const designed = [
      "---",
      "type: workflow",
      "title: Redesigned often",
      "state: designed",
      "steps:",
      "  - name: Check what was drawn",
      "    numbers:",
      "      frequency: { value: 6, basis: estimated }",
      "      minutes: { value: 5, basis: estimated }",
      "---",
      "",
    ].join("\n");
    const later = 60;
    await env.KNOWLEDGE.batch([
      env.KNOWLEDGE.prepare(
        `WITH RECURSIVE n(i) AS (SELECT 2 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
         INSERT INTO versions (document_id, number, text, author, created_at)
         SELECT ?, i, ?, ?, 0 FROM n`
      ).bind(later + 1, drawn.id, designed, admin.userId),
      env.KNOWLEDGE.prepare(
        "UPDATE documents SET current_version = ? WHERE id = ?"
      ).bind(later + 1, drawn.id),
    ]);

    const taken = okOf(
      await call(app, admin.userId, "snapshot", { maturity: 1 }),
      savedSchema
    );
    const { record } = okOf(
      await call(app, admin.userId, "record", taken.id),
      recordSchema
    );
    expect(figuresOf(record, path)).toStrictEqual({
      path,
      title: "Redesigned often",
      state: "designed",
      // 6 times × 20 minutes, as drawn 60 versions back.
      drawn: { version: 1, hoursPerWeek: 2, basis: "estimated" },
      designed: { version: later + 1, hoursPerWeek: 0.5, basis: "estimated" },
    });
  });

  it("freeze no signals while the signals are switched off", async () => {
    const admin = await signedInApi(idp, "admin");
    const app = await snapshotApp(admin);
    const { folder, payables } = await seedPlaybook(admin, app);
    await seedSignals([[payables, "pay", "failing_step", "match", 3]]);
    const permissionId = await requestGranted(
      idp,
      admin,
      playbookFor(app, ["read", "write"], "PLAYBOOK_OFF")
    );
    const off: Env = {
      ...env,
      FEATURES: {
        ...z.record(z.string(), z.boolean()).parse(env.FEATURES),
        improvement_signals: false,
      },
    };
    const taken = await takeSnapshotAsDelegate(
      off,
      {
        subject: { type: "app", appId: app },
        onBehalfOf: admin.userId,
        mode: "interactive",
        appVersion: 1,
      },
      { type: "app", appId: app },
      permissionIdSchema.parse(permissionId),
      { maturity: 1 }
    );
    const { record } = okOf(
      await call(app, admin.userId, "record", taken.id),
      recordSchema
    );
    expect(signalsOf(record, folder)).toStrictEqual([]);
  });

  // Last: it fills the Playbook past what one snapshot holds.
  it("are refused for a Playbook with more workflows than one holds", async () => {
    const admin = await signedInApi(idp, "admin");
    const app = await snapshotApp(admin);
    const text = "---\ntype: workflow\nstate: drawn\n---\n";
    /** `count` more drawn workflows, straight into the Playbook. */
    const seed = async (count: number) => {
      const bulk = `bulk-${unique()}`;
      await env.KNOWLEDGE.batch([
        env.KNOWLEDGE.prepare(
          `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
           INSERT INTO documents (id, collection_id, path, title, type, description, owner, tags, current_version, created_at, updated_at)
           SELECT ? || '-' || i, ?, ? || '/' || i || '.md', 'Bulk', 'workflow', '', ?, '[]', 1, 0, 0 FROM n`
        ).bind(count, bulk, playbookCollectionId, bulk, admin.userId),
        env.KNOWLEDGE.prepare(
          `INSERT INTO versions (document_id, number, text, author, created_at)
           SELECT id, 1, ?, ?, 0 FROM documents WHERE id LIKE ? || '-%'`
        ).bind(text, admin.userId, bulk),
      ]);
    };
    /** How many workflows a snapshot taken now holds, or why it can't be. */
    const held = async (): Promise<unknown> => {
      const answer = await call(app, admin.userId, "snapshot", { maturity: 1 });
      const taken = z
        .object({ ok: z.object({ id: z.string() }) })
        .safeParse(answer);
      if (!taken.success) {
        return answer;
      }
      const { record } = okOf(
        await call(app, admin.userId, "record", taken.data.ok.id),
        recordSchema
      );
      return z
        .object({ figures: z.object({ workflows: z.array(z.unknown()) }) })
        .parse(record).figures.workflows.length;
    };

    const before = await held();
    await seed(250 - z.number().parse(before));
    const most = await held();
    await seed(1);
    expect({ most, over: await held() }).toStrictEqual({
      most: 250,
      over: { error: "knowledge.invalid" },
    });
  });
});
