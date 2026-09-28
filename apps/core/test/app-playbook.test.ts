import { appIdSchema, permissionIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import { playbookCollectionId } from "@grasp-os/shared/knowledge";
import type { PermissionRequest } from "@grasp-os/shared/permissions";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { callApp } from "../src/app.ts";
import type { AppCallerInput } from "../src/app.ts";
import { setCurrentVersion } from "../src/apps.ts";
import { saveRecordAsDelegate } from "../src/knowledge/playbook.ts";
import { restrict } from "../src/restricted.ts";
import {
  grantReviewed,
  racingDb,
  release,
  requestGranted,
  reviewedOf,
  serverBuilt,
} from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { collectionWithNote, newTeam, readCollection } from "./knowledge.ts";
import {
  auditedDuring,
  openRpc,
  outcome,
  signedIn,
  signedInApi,
  staffPerson,
  unique,
} from "./sign-in.ts";

// An App's server code writing the Playbook, for the person whose call it
// runs in (knowledge/playbook.ts, through the App's collection stub). These
// tests start from the ways that can fail: the App writes without a
// permission to write, or through another collection's stub; it writes
// for someone who couldn't change the Playbook themselves (or no longer
// can, in a workflow run); it writes from a context that read restricted
// data, into a collection everyone reads; a save loses a version or
// overwrites a newer one; the write isn't traced to the App, the person it
// acted for, how and the App version; the App reads a record it can't
// parse back; the
// Playbook can't be given to an App before an admin first saved into it;
// or it can be asked for while its flag is off. And a builder who can't
// grant the permission ships other code under it: the next version they
// make current writes as the admin who uses it, under a grant that admin
// gave the code before.

const idp = mockIdp();

type Person = Awaited<ReturnType<typeof signedInApi>>;

const personApi = async (role: Role): Promise<Person> =>
  await signedInApi(idp, role);

/** Each stub call's outcome: `{ ok }` with its answer, or `{ error }` with its code. */
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
  stub(binding: string): Stub {
    return (this.env as Record<string, Stub>)[binding] ?? {};
  }

  async save(caller: Caller, binding: string, input: unknown): Promise<unknown> {
    return await outcome(async () => await this.stub(binding).saveRecord(caller, input));
  }

  async link(caller: Caller, binding: string, input: unknown): Promise<unknown> {
    return await outcome(async () => await this.stub(binding).linkWorkflow(caller, input));
  }

  async canWrite(caller: Caller, binding: string): Promise<unknown> {
    return await outcome(async () => await this.stub(binding).canWrite(caller));
  }

  async record(caller: Caller, binding: string, id: string, version?: number): Promise<unknown> {
    return await outcome(async () => await this.stub(binding).getRecord(caller, id, version));
  }

  async read(caller: Caller, binding: string, id: string): Promise<unknown> {
    return await outcome(async () => await this.stub(binding).getDocument(caller, id));
  }

  bindings(): string[] {
    return Object.keys(this.env as object).toSorted();
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

/** A new App running `serverCode`, released by `admin`. */
const playbookApp = async (admin: Person): Promise<AppId> => {
  const { id } = await admin.api.apps.create({ name: `Map ${unique()}` });
  await serverBuilt(
    id,
    await release(admin, id, { "app/server.ts": serverCode })
  );
  return appIdSchema.parse(id);
};

/** A permission for `app` to use the Playbook under `binding`. */
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

const as = (userId: string): AppCallerInput => ({
  userId,
  mode: "interactive",
});

const readsDocument = /from "documents"/iu;

/**
 * Knowledge's database, with `first` run once, just before the first
 * statement whose query `when` matches is run: another request landing
 * while a write is being prepared.
 */
const knowledgeRacing = (
  when: RegExp,
  first: () => Promise<void>
): D1Database => {
  const real = env.KNOWLEDGE;
  let done = false;
  const once = async (): Promise<void> => {
    if (!done) {
      done = true;
      await first();
    }
  };
  const racing = (statement: D1PreparedStatement): D1PreparedStatement =>
    // SAFETY: an object whose prototype is `statement` is a statement: it
    // has every member, and the ones it runs by are replaced below.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    Object.assign(Object.create(statement) as D1PreparedStatement, {
      bind: (...values: unknown[]) => racing(statement.bind(...values)),
      first: async (column?: string) => {
        await once();
        return column === undefined
          ? await statement.first()
          : await statement.first(column);
      },
      all: async () => {
        await once();
        return await statement.all();
      },
      raw: async () => {
        await once();
        return await statement.raw();
      },
      run: async () => {
        await once();
        return await statement.run();
      },
    });
  return {
    prepare: (query) => {
      const statement = real.prepare(query);
      return !done && when.test(query) ? racing(statement) : statement;
    },
    batch: async <T>(statements: D1PreparedStatement[]) =>
      await real.batch<T>(statements),
    exec: async (query) => await real.exec(query),
    // oxlint-disable-next-line typescript/no-deprecated -- D1Database still has it
    dump: async () => await real.dump(),
    withSession: (constraint) => real.withSession(constraint),
  };
};

/** An App's server code, as the audit log names it. */
const appActor = (app: AppId) => ({ type: "app", appId: app, part: "server" });

/** Whom an App's write acted for, and how, as its audit event says. */
const actedFor = (userId: string, mode = "interactive") => ({
  onBehalfOf: userId,
  mode,
  appVersion: 1,
});

/** A drawn workflow with one step, as the workflow map writes it. */
const drawn = {
  type: "workflow",
  title: "Pay supplier invoices",
  state: "drawn",
  team: "teams/finance.md",
  steps: [
    {
      name: "Match the invoice",
      who: "Controller",
      tool: "Exact Online",
      handover: true,
      numbers: {
        frequency: { value: 40, basis: "estimated" },
        minutes: { value: 5, basis: "observed" },
        people: { value: 1, basis: "estimated" },
      },
    },
  ],
};

/** The App's `save` of `record` at `path`, from `ifVersion`. */
const saveArgs = (
  path: string,
  record: Record<string, unknown>,
  ifVersion = 0,
  binding = "PLAYBOOK"
) => [binding, { path, ifVersion, record, body: "Paid weekly." }];

/** The ID of the document a stub call (`{ ok }`) saved. */
const idOf = (called: unknown): string =>
  z.object({ ok: z.object({ id: z.string() }) }).parse(called).ok.id;

/**
 * A stub call's outcome: `{ error }` with its code, or `{ ok }` with only
 * the fields of what it answered that `shape` names.
 */
const answered = (called: unknown, shape: z.ZodRawShape) =>
  z
    .union([
      z.strictObject({ error: z.string() }),
      z.strictObject({ ok: z.object(shape) }),
    ])
    .parse(called);

/** What a test reads of a record. */
const recordShape = {
  path: z.string(),
  title: z.string(),
  currentVersion: z.number(),
  record: z.record(z.string(), z.unknown()),
  body: z.string(),
  version: z.object({ number: z.number(), author: z.string() }),
};

/** What a test reads of a save. */
const savedShape = { path: z.string(), currentVersion: z.number() };

/** The Playbook collection's owner, if it exists. */
const playbook = async () =>
  await env.KNOWLEDGE.prepare("SELECT owner FROM collections WHERE id = ?")
    .bind(playbookCollectionId)
    .first();

/** An App granted the Playbook, and the admin who set it up. */
const setUp = async () => {
  const admin = await personApi("admin");
  const app = await playbookApp(admin);
  await requestGranted(idp, admin, playbookFor(app));
  return { admin, app };
};

describe("App server code writing the Playbook", { timeout: 60_000 }, () => {
  it("saves records for an admin through the save pipeline, and reads them back as data", async () => {
    // The first test of the file: the Playbook doesn't exist yet. It can
    // be asked for and granted all the same, while its flag is on, and the
    // App's first save sets it up.
    await expect(playbook()).resolves.toBeNull();
    const { admin, app } = await setUp();
    const off: Env = {
      ...env,
      FEATURES: { apps: true, knowledge: true, permissions: true },
    };
    const { core } = await openRpc(admin.session, { coreEnv: off });
    await expect(
      outcome(
        core
          .authenticate()
          .permissions.request(playbookFor(app, ["read"], "PLAYBOOK_OFF"))
      )
    ).resolves.toBe("permission.invalid");
    const path = `workflows/pay-${unique()}.md`;

    const events = await auditedDuring(async () => {
      const first = await callApp(
        env,
        app,
        as(admin.userId),
        "save",
        saveArgs(path, drawn)
      );
      expect(first).toMatchObject({ ok: { path, currentVersion: 1 } });
    });
    const second = await callApp(
      env,
      app,
      as(admin.userId),
      "save",
      saveArgs(path, { ...drawn, title: "Pay invoices" }, 1)
    );
    // From the first version again: someone else's save came first.
    const stale = await callApp(
      env,
      app,
      as(admin.userId),
      "save",
      saveArgs(path, drawn, 1)
    );
    const savedId = idOf(second);
    const got = async (version?: number) =>
      await callApp(env, app, as(admin.userId), "record", [
        "PLAYBOOK",
        savedId,
        version,
      ]);

    expect({
      playbook: await playbook(),
      stale,
      latest: answered(await got(), recordShape),
      first: answered(await got(1), recordShape),
      audited: events
        .filter(({ action }) =>
          ["knowledge.collection.created", "knowledge.document.saved"].includes(
            action
          )
        )
        .map(({ action, actor, detail }) => ({ action, actor, detail })),
    }).toStrictEqual({
      playbook: { owner: admin.userId },
      stale: { error: "knowledge.conflict" },
      latest: {
        ok: {
          path,
          title: "Pay invoices",
          currentVersion: 2,
          record: {
            ...drawn,
            title: "Pay invoices",
            description: "",
            tags: [],
            parameters: [],
          },
          body: "Paid weekly.",
          version: { number: 2, author: admin.userId },
        },
      },
      first: {
        ok: {
          path,
          // The document's, as it is now; the version's is in its record.
          title: "Pay invoices",
          currentVersion: 2,
          record: {
            ...drawn,
            description: "",
            tags: [],
            parameters: [],
          },
          body: "Paid weekly.",
          version: { number: 1, author: admin.userId },
        },
      },
      // The version is the admin's. The audit log names the App, and the
      // person it acted for, how, and the App version that did it.
      audited: [
        {
          action: "knowledge.collection.created",
          actor: appActor(app),
          detail: {
            ...actedFor(admin.userId),
            access: "everyone",
            sensitive: false,
            source: "playbook",
          },
        },
        {
          action: "knowledge.document.saved",
          actor: appActor(app),
          detail: {
            ...actedFor(admin.userId),
            collectionId: playbookCollectionId,
            version: 1,
          },
        },
      ],
    });
  });

  it("links a designed workflow to a workflow of an App, as its admin may", async () => {
    const { admin, app } = await setUp();
    const { id: payables } = await admin.api.apps.create({
      name: `Payables ${unique()}`,
    });
    await release(admin, payables, {
      "app/server.ts": "export class App {}\n",
      "workflows/pay.ts": workflowFile,
      "workflows/pay.workflow-tests.ts": workflowTestsFile,
    });
    const designed = idOf(
      await callApp(
        env,
        app,
        as(admin.userId),
        "save",
        saveArgs(`workflows/pay-${unique()}.designed.md`, {
          ...drawn,
          state: "designed",
        })
      )
    );
    const drawnOnly = idOf(
      await callApp(
        env,
        app,
        as(admin.userId),
        "save",
        saveArgs(`workflows/pay-${unique()}.md`, drawn)
      )
    );
    const linkTo = async (
      documentId: string,
      workflowId = "pay",
      ifVersion = 1
    ) =>
      await callApp(env, app, as(admin.userId), "link", [
        "PLAYBOOK",
        { documentId, ifVersion, appId: payables, workflowId },
      ]);

    const events = await auditedDuring(async () => {
      await expect(linkTo(designed)).resolves.toMatchObject({
        ok: { currentVersion: 2 },
      });
    });
    expect({
      record: answered(
        await callApp(env, app, as(admin.userId), "record", [
          "PLAYBOOK",
          designed,
        ]),
        { record: z.object({ app: z.unknown() }) }
      ),
      drawn: await linkTo(drawnOnly),
      stale: await linkTo(designed),
      missing: await linkTo(designed, "refund", 2),
      linked: events
        .filter(({ action }) => action === "knowledge.workflow.linked")
        .map(({ actor, detail }) => ({ actor, detail })),
    }).toStrictEqual({
      record: {
        ok: { record: { app: { appId: payables, workflowId: "pay" } } },
      },
      drawn: { error: "knowledge.invalid" },
      stale: { error: "knowledge.conflict" },
      missing: { error: "knowledge.invalid" },
      linked: [
        {
          actor: appActor(app),
          detail: {
            ...actedFor(admin.userId),
            version: 2,
            appId: payables,
            workflowId: "pay",
          },
        },
      ],
    });
  });

  it("writes only under a permission to write the Playbook, and only for who may change it themselves", async () => {
    const { admin, app } = await setUp();
    const user = await personApi("user");
    const builder = await personApi("builder");
    const { collectionId } = await collectionWithNote(admin.api, {
      name: `Handbook ${unique()}`,
      access: "everyone",
    });
    await requestGranted(
      idp,
      admin,
      playbookFor(app, ["read"], "PLAYBOOK_READ")
    );
    await requestGranted(idp, admin, {
      ...readCollection({ type: "app", appId: app }, collectionId, "HANDBOOK"),
      actions: ["read", "write"],
    });
    const path = `workflows/pay-${unique()}.md`;
    const saveAs = async (userId: string, binding = "PLAYBOOK") =>
      await callApp(
        env,
        app,
        as(userId),
        "save",
        saveArgs(path, drawn, 0, binding)
      );

    // What the stub says of each before the save, which it must match.
    const mayWrite = async (userId: string, binding = "PLAYBOOK") =>
      await callApp(env, app, as(userId), "canWrite", [binding]);
    const hinted = {
      user: await mayWrite(user.userId),
      builder: await mayWrite(builder.userId),
      readOnly: await mayWrite(admin.userId, "PLAYBOOK_READ"),
      otherCollection: await mayWrite(admin.userId, "HANDBOOK"),
      admin: await mayWrite(admin.userId),
    };

    expect({
      hinted,
      user: await saveAs(user.userId),
      builder: await saveAs(builder.userId),
      readOnly: await saveAs(admin.userId, "PLAYBOOK_READ"),
      otherCollection: await saveAs(admin.userId, "HANDBOOK"),
      admin: answered(await saveAs(admin.userId), savedShape),
    }).toStrictEqual({
      hinted: {
        user: { ok: false },
        builder: { ok: false },
        readOnly: { ok: false },
        otherCollection: { ok: false },
        admin: { ok: true },
      },
      user: { error: "knowledge.forbidden" },
      builder: { error: "knowledge.forbidden" },
      readOnly: { error: "permission.denied" },
      otherCollection: { error: "permission.denied" },
      admin: { ok: { path, currentVersion: 1 } },
    });
  });

  it("writes for a workflow run as the person it runs for, while they are still an admin", async () => {
    const { admin, app } = await setUp();
    const path = `workflows/pay-${unique()}.md`;
    const inRun: AppCallerInput = {
      userId: admin.userId,
      mode: "workflow",
      idempotencyKey: `${crypto.randomUUID()}:step`,
    };
    const events = await auditedDuring(async () => {
      await expect(
        callApp(env, app, inRun, "save", saveArgs(path, drawn))
      ).resolves.toMatchObject({ ok: { path } });
    });
    await env.DB.prepare(
      "UPDATE members SET role = 'builder' WHERE user_id = ?"
    )
      .bind(admin.userId)
      .run();
    expect({
      audited: events
        .filter(({ action }) => action === "knowledge.document.saved")
        .map(({ detail }) => detail),
      demoted: await callApp(env, app, inRun, "save", saveArgs(path, drawn, 1)),
    }).toStrictEqual({
      audited: [
        {
          ...actedFor(admin.userId, "workflow"),
          collectionId: playbookCollectionId,
          version: 1,
        },
      ],
      demoted: { error: "knowledge.forbidden" },
    });
  });

  it("writes nothing when the App becomes restricted while the save is being prepared", async () => {
    const { admin, app } = await setUp();
    const permissionId = await requestGranted(
      idp,
      admin,
      playbookFor(app, ["read", "write"], "PLAYBOOK_RACE")
    );
    const authority = {
      subject: { type: "app" as const, appId: app },
      onBehalfOf: admin.userId,
      mode: "interactive" as const,
    };
    const context = { type: "app" as const, appId: app };
    const path = `workflows/pay-${unique()}.md`;
    // Knowledge's database, with a sensitive read restricting the App once
    // the save has passed its first check and is looking up the document,
    // before its batch: another request of the App's, landing meanwhile.
    let raced = false;
    const racing = knowledgeRacing(readsDocument, async () => {
      raced = true;
      await restrict(env, authority, context, ["payroll"]);
    });

    const refused = await outcome(
      saveRecordAsDelegate(
        { ...env, KNOWLEDGE: racing },
        authority,
        context,
        permissionIdSchema.parse(permissionId),
        { path, ifVersion: 0, record: drawn, body: "" }
      )
    );
    const written = await env.KNOWLEDGE.prepare(
      "SELECT count(*) AS count FROM documents WHERE collection_id = ? AND path = ?"
    )
      .bind(playbookCollectionId, path)
      .first<{ count: number }>();
    expect({ raced, refused, written: written?.count }).toStrictEqual({
      raced: true,
      refused: "permission.restricted",
      written: 0,
    });
  });

  it("refuses to read back a stored record that no longer fits its type", async () => {
    const { admin, app } = await setUp();
    const saved = await callApp(
      env,
      app,
      as(admin.userId),
      "save",
      saveArgs(`workflows/pay-${unique()}.md`, drawn)
    );
    const { ok } = z.object({ ok: z.object({ id: z.string() }) }).parse(saved);
    // As a rollback to a release with other schemas would leave it.
    await env.KNOWLEDGE.prepare(
      "UPDATE versions SET text = ? WHERE document_id = ?"
    )
      .bind("---\ntype: workflow\nstate: sketched\n---\nPaid weekly.", ok.id)
      .run();
    await expect(
      callApp(env, app, as(admin.userId), "record", ["PLAYBOOK", ok.id])
    ).resolves.toStrictEqual({ error: "knowledge.invalid" });
  });

  it("writes nothing while the Playbook is switched off", async () => {
    const { admin, app } = await setUp();
    const permissionId = await requestGranted(
      idp,
      admin,
      playbookFor(app, ["read", "write"], "PLAYBOOK_TOO")
    );
    const off: Env = {
      ...env,
      FEATURES: { apps: true, knowledge: true, permissions: true },
    };
    await expect(
      outcome(
        saveRecordAsDelegate(
          off,
          {
            subject: { type: "app", appId: app },
            onBehalfOf: admin.userId,
            mode: "interactive",
          },
          { type: "app", appId: app },
          permissionIdSchema.parse(permissionId),
          {
            path: `workflows/pay-${unique()}.md`,
            ifVersion: 0,
            record: drawn,
            body: "",
          }
        )
      )
    ).resolves.toBe("feature.disabled");
  });

  it("writes nothing once the App read restricted data, which the Playbook would pass on to everyone", async () => {
    const { admin, app } = await setUp();
    const teamId = await newTeam(admin, []);
    const payroll = await collectionWithNote(admin.api, {
      name: `Payroll ${unique()}`,
      access: "teams",
      teams: [teamId],
      sensitive: true,
    });
    await requestGranted(
      idp,
      admin,
      readCollection(
        { type: "app", appId: app },
        payroll.collectionId,
        "PAYROLL"
      )
    );
    const path = `workflows/pay-${unique()}.md`;

    const before = await callApp(
      env,
      app,
      as(admin.userId),
      "save",
      saveArgs(path, drawn)
    );
    await expect(
      callApp(env, app, as(admin.userId), "read", ["PAYROLL", payroll.noteId])
    ).resolves.toMatchObject({ ok: { path: "note.md" } });
    const after = await callApp(
      env,
      app,
      as(admin.userId),
      "save",
      saveArgs(path, drawn, 1)
    );

    expect({
      before: answered(before, savedShape),
      after,
      hinted: await callApp(env, app, as(admin.userId), "canWrite", [
        "PLAYBOOK",
      ]),
    }).toStrictEqual({
      before: { ok: { path, currentVersion: 1 } },
      after: { error: "permission.restricted" },
      hinted: { ok: false },
    });
  });
});

/**
 * An App `builder` built and released, which `admin` granted the Playbook
 * to write, and to read only.
 */
const builtBy = async (builder: Person, admin: Person): Promise<AppId> => {
  const { id } = await builder.api.apps.create({ name: `Map ${unique()}` });
  const app = appIdSchema.parse(id);
  await serverBuilt(
    id,
    await release(builder, id, { "app/server.ts": serverCode })
  );
  for (const request of [
    playbookFor(app),
    playbookFor(app, ["read"], "PLAYBOOK_READ"),
  ]) {
    // oxlint-disable-next-line no-await-in-loop -- one at a time, in order
    const { id: permission } = await builder.api.permissions.request(request);
    // oxlint-disable-next-line no-await-in-loop -- as above
    await grantReviewed(admin.api, permission);
  }
  return app;
};

/** `by` releases other server code for `app`, built ahead. */
const changedBy = async (
  by: Pick<Person, "api">,
  app: AppId,
  change: string
): Promise<void> => {
  await serverBuilt(
    app,
    await release(by, app, { "app/server.ts": `${serverCode}\n// ${change}\n` })
  );
};

/** The detail of each `action` event in `events`, by its target's ID. */
const details = (
  events: Awaited<ReturnType<typeof auditedDuring>>,
  action: string
): Map<string | undefined, Record<string, unknown>> =>
  new Map(
    events
      .filter((event) => event.action === action)
      .map(({ target, detail }) => [target?.id, detail])
  );

/** The App's permissions, as an admin lists them. */
const permissionsOf = async (admin: Person, app: AppId) => {
  const listed = await admin.api.permissions.list({ type: "app", appId: app });
  return listed.map(({ id, binding, status, requestedBy, grantedBy }) => ({
    id,
    binding,
    status,
    requestedBy,
    grantedBy,
  }));
};

describe("An App's next version", { timeout: 60_000 }, () => {
  it("is asked again for its permission to write the Playbook when a builder makes it current, and keeps reading", async () => {
    const [admin, builder] = await Promise.all([
      personApi("admin"),
      personApi("builder"),
    ]);
    const app = await builtBy(builder, admin);
    const [write, read] = await permissionsOf(admin, app);
    const path = `workflows/pay-${unique()}.md`;
    const before = await callApp(
      env,
      app,
      as(admin.userId),
      "save",
      saveArgs(path, drawn)
    );

    // The attack: the builder ships other code, which the admin's next
    // call runs, under the grant the admin gave the code before.
    const events = await auditedDuring(async () => {
      await changedBy(builder, app, "Rewrites every rule.");
    });
    const after = await callApp(
      env,
      app,
      as(admin.userId),
      "save",
      saveArgs(path, drawn, 1)
    );

    expect({
      before: answered(before, savedShape),
      after,
      bindings: await callApp(env, app, as(admin.userId), "bindings", []),
      permissions: await permissionsOf(admin, app),
      audited: events
        .filter(({ action }) => action.startsWith("permission."))
        .map(({ action, actor, target, detail }) => ({
          action,
          actor,
          target,
          detail,
        })),
    }).toStrictEqual({
      before: { ok: { path, currentVersion: 1 } },
      // The new version has no Playbook stub to write with.
      after: { error: "failed" },
      bindings: ["PLAYBOOK_READ"],
      // Asked for again, it is the newest request, and still says who
      // granted it before: not a first request.
      permissions: [
        read,
        {
          id: write?.id,
          binding: "PLAYBOOK",
          status: "requested",
          requestedBy: builder.userId,
          grantedBy: admin.userId,
        },
      ],
      audited: [
        {
          action: "permission.requested",
          actor: { type: "person", userId: builder.userId },
          target: { type: "permission", id: write?.id },
          detail: {
            subjectType: "app",
            subjectId: app,
            objectType: "collection",
            collectionId: playbookCollectionId,
            actions: "read write",
            binding: "PLAYBOOK",
            version: 2,
            previous: 1,
            grantedBy: admin.userId,
          },
        },
      ],
    });

    // Granted again, by an admin who saw the new code, it writes again.
    await grantReviewed(admin.api, write?.id ?? "");
    await expect(
      callApp(env, app, as(admin.userId), "save", saveArgs(path, drawn, 1))
    ).resolves.toMatchObject({ ok: { path, currentVersion: 2 } });
  });

  it("records each permission it asks for again by the IDs its grant was recorded with", async () => {
    const [admin, builder] = await Promise.all([
      personApi("admin"),
      personApi("builder"),
    ]);
    const app = await builtBy(builder, admin);
    const subject = { type: "app", appId: app } as const;
    const requests: PermissionRequest[] = [
      {
        subject,
        object: {
          type: "connection",
          connectionId: "connection-outlook",
          resource: "inbox",
          mask: ["body", "subject"],
        },
        actions: ["mail.list", "mail.send"],
        binding: "OUTLOOK",
      },
      {
        subject,
        object: { type: "connection", connectionId: "connection-shared" },
        actions: ["mail.list"],
        binding: "SHARED",
      },
      {
        subject,
        object: { type: "workflow", appId: app, workflowId: "pay" },
        actions: ["start"],
        binding: "PAY",
      },
    ];
    const granted = await auditedDuring(async () => {
      for (const request of requests) {
        // oxlint-disable-next-line no-await-in-loop -- one at a time
        const { id } = await builder.api.permissions.request(request);
        // oxlint-disable-next-line no-await-in-loop -- as above
        await grantReviewed(admin.api, id);
      }
    });
    const events = await auditedDuring(async () => {
      await changedBy(builder, app, "Uses everything.");
    });
    const requested = details(events, "permission.requested");

    expect({
      count: requested.size,
      asked: [...details(granted, "permission.granted")].map(
        ([id, detail]) => requested.get(id) ?? { missing: id, detail }
      ),
    }).toStrictEqual({
      // With the Playbook's permission to write.
      count: 4,
      asked: [...details(granted, "permission.granted").values()].map(
        ({ requestedBy: _requestedBy, ...detail }) => ({
          ...detail,
          version: 2,
          previous: 1,
          grantedBy: admin.userId,
        })
      ),
    });
  });

  it("is asked again for a permission an admin grants just before the batch that makes it current", async () => {
    const [admin, builder] = await Promise.all([
      personApi("admin"),
      personApi("builder"),
    ]);
    const app = await builtBy(builder, admin);
    const late = await builder.api.permissions.request(
      playbookFor(app, ["read", "write"], "PLAYBOOK_LATE")
    );
    await builder.api.apps.files.write(app, {
      "app/server.ts": `${serverCode}\n// Asks for more.\n`,
    });
    const { version } = await builder.api.apps.files.commit(app, "More");
    // The admin grants the request after everything the change reads, and
    // before its batch lands.
    const racing: Env = {
      ...env,
      DB: racingDb(async () => {
        await grantReviewed(admin.api, late.id);
      }, /^update "apps"/iu),
    };

    const events = await auditedDuring(async () => {
      await setCurrentVersion(racing, await builder.api.whoami(), app, version);
    });
    const listed = await permissionsOf(admin, app);

    expect({
      // Asked for again at the same time: in no particular order.
      permissions: listed
        .map(({ binding, status }) => ({ binding, status }))
        .toSorted((a, b) => a.binding.localeCompare(b.binding)),
      audited: events
        .filter(({ action }) => action === "permission.requested")
        .map(({ actor, detail }) => ({
          actor,
          binding: detail.binding,
          version: detail.version,
          grantedBy: detail.grantedBy,
        }))
        .toSorted((a, b) => String(a.binding).localeCompare(String(b.binding))),
    }).toStrictEqual({
      permissions: [
        { binding: "PLAYBOOK", status: "requested" },
        { binding: "PLAYBOOK_LATE", status: "requested" },
        { binding: "PLAYBOOK_READ", status: "active" },
      ],
      audited: ["PLAYBOOK", "PLAYBOOK_LATE"].map((binding) => ({
        actor: { type: "person", userId: builder.userId },
        binding,
        version,
        grantedBy: admin.userId,
      })),
    });
  });

  it("is refused a grant for the version the admin reviewed once a builder made another current", async () => {
    const [admin, builder] = await Promise.all([
      personApi("admin"),
      personApi("builder"),
    ]);
    const app = await builtBy(builder, admin);
    const more = await builder.api.permissions.request(
      playbookFor(app, ["read", "write"], "PLAYBOOK_MORE")
    );
    // The admin reviews version 1; meanwhile the builder swaps the code.
    const reviewed = await reviewedOf(admin.api, more.id);
    await changedBy(builder, app, "Swapped while the admin looked.");

    const refused = await outcome(
      admin.api.permissions.grant(more.id, reviewed)
    );
    const listed = await permissionsOf(admin, app);
    const approved = await env.DB.prepare(
      "SELECT approved FROM app_versions WHERE app_id = ? AND version = 2"
    )
      .bind(app)
      .first("approved");

    expect({
      reviewed,
      refused,
      more: listed.find(({ binding }) => binding === "PLAYBOOK_MORE")?.status,
      approved,
    }).toStrictEqual({
      reviewed: { version: 1 },
      refused: "app.conflict",
      more: "requested",
      approved: 0,
    });
  });

  it("is asked again for the first version of a copy of code no admin approved", async () => {
    const [admin, builder] = await Promise.all([
      personApi("admin"),
      personApi("builder"),
    ]);
    // A version never made current, marked as a blueprint.
    const { id } = await builder.api.apps.create({ name: `Map ${unique()}` });
    const source = appIdSchema.parse(id);
    await builder.api.apps.files.write(source, { "app/server.ts": serverCode });
    const { version } = await builder.api.apps.files.commit(
      source,
      "Never run"
    );
    await builder.api.permissions.request(playbookFor(source));
    await builder.api.apps.blueprints.mark(source, version);
    const created = await builder.api.apps.blueprints.create(source, version, {
      name: `Copy ${unique()}`,
    });
    const copy = appIdSchema.parse(created.app.id);
    const [asked] = created.permissions;
    await grantReviewed(admin.api, asked?.id ?? "");

    await builder.api.apps.versions.setCurrent(copy, 1);
    const listed = await permissionsOf(admin, copy);

    expect(listed.map(({ status }) => status)).toStrictEqual(["requested"]);
  });

  it("is asked again for its first version whatever blueprint its creator names", async () => {
    const [admin, builder] = await Promise.all([
      personApi("admin"),
      personApi("builder"),
    ]);
    // A label anyone creating an App may give: not a copy of anything.
    const { id } = await builder.api.apps.create({
      name: `Map ${unique()}`,
      blueprint: "builtin-workflow-map@1",
    });
    const app = appIdSchema.parse(id);
    const asked = await builder.api.permissions.request(playbookFor(app));
    await grantReviewed(admin.api, asked.id);
    await changedBy(builder, app, "Its own code.");

    const [write] = await permissionsOf(admin, app);
    expect(write?.status).toBe("requested");
  });

  it("asks for nothing again when another request made the same version current first", async () => {
    const [admin, builder] = await Promise.all([
      personApi("admin"),
      personApi("builder"),
    ]);
    const app = await builtBy(builder, admin);
    const granted = await permissionsOf(admin, app);
    await builder.api.apps.files.write(app, {
      "app/server.ts": `${serverCode}\n// Reviewed.\n`,
    });
    const { version } = await builder.api.apps.files.commit(app, "Reviewed");
    // The admin makes it current after the builder's request read the
    // App, and before its batch lands: that batch changes nothing.
    const racing: Env = {
      ...env,
      DB: racingDb(async () => {
        await admin.api.apps.versions.setCurrent(app, version);
      }, /^update "apps"/iu),
    };

    let refused = "";
    const events = await auditedDuring(async () => {
      refused = await outcome(
        setCurrentVersion(racing, await builder.api.whoami(), app, version)
      );
    });

    expect({
      refused,
      permissions: await permissionsOf(admin, app),
      audited: events.filter(({ action }) => action.startsWith("permission.")),
    }).toStrictEqual({
      refused: "app.conflict",
      permissions: granted,
      audited: [],
    });
  });

  it("is asked again when the admin making it current is no longer one as the change lands", async () => {
    const [admin, builder] = await Promise.all([
      personApi("admin"),
      personApi("builder"),
    ]);
    const app = await builtBy(builder, admin);
    await builder.api.apps.files.write(app, {
      "app/server.ts": `${serverCode}\n// Demoted.\n`,
    });
    const { version } = await builder.api.apps.files.commit(app, "Demoted");
    const racing: Env = {
      ...env,
      DB: racingDb(async () => {
        await env.DB.prepare(
          "UPDATE members SET role = 'builder' WHERE user_id = ?"
        )
          .bind(admin.userId)
          .run();
      }, /^update "apps"/iu),
    };

    // Checked as an admin when the request came in.
    await setCurrentVersion(racing, await admin.api.whoami(), app, version);
    const statuses = await env.DB.prepare(
      "SELECT binding, status FROM permissions WHERE subject_id = ? ORDER BY binding"
    )
      .bind(app)
      .all();
    const approved = await env.DB.prepare(
      "SELECT approved FROM app_versions WHERE app_id = ? AND version = ?"
    )
      .bind(app, version)
      .first("approved");

    expect({ statuses: statuses.results, approved }).toStrictEqual({
      statuses: [
        { binding: "PLAYBOOK", status: "requested" },
        { binding: "PLAYBOOK_READ", status: "active" },
      ],
      approved: 0,
    });
  });

  it("keeps its permissions when an admin makes it current, as they could grant them, and not when Grasp staff do", async () => {
    const [admin, builder] = await Promise.all([
      personApi("admin"),
      personApi("builder"),
    ]);
    const app = await builtBy(builder, admin);
    const granted = await permissionsOf(admin, app);

    const events = await auditedDuring(async () => {
      await changedBy(admin, app, "Reviewed by an admin.");
    });
    const path = `workflows/pay-${unique()}.md`;

    expect({
      permissions: await permissionsOf(admin, app),
      audited: events.filter(({ action }) => action.startsWith("permission.")),
      saved: answered(
        await callApp(
          env,
          app,
          as(admin.userId),
          "save",
          saveArgs(path, drawn)
        ),
        savedShape
      ),
    }).toStrictEqual({
      permissions: granted,
      audited: [],
      saved: { ok: { path, currentVersion: 1 } },
    });

    // Grasp staff are admins, but never decide a client's permissions.
    const { core } = await openRpc(
      await signedIn(idp, "grasp-staff", staffPerson())
    );
    await changedBy({ api: core.authenticate() }, app, "Changed by staff.");
    const byStaff = await permissionsOf(admin, app);
    expect(
      byStaff.map(({ binding, status }) => ({ binding, status }))
    ).toStrictEqual([
      { binding: "PLAYBOOK_READ", status: "active" },
      { binding: "PLAYBOOK", status: "requested" },
    ]);
  });
});
