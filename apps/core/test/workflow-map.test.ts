import { appIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import { playbookCollectionId } from "@grasp-os/shared/knowledge";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { callApp } from "../src/app.ts";
import type { AppCallerInput } from "../src/app.ts";
import { builtinAppId } from "../src/builtin-app-id.ts";
import { builtins, fingerprintOf, release } from "../src/builtins.ts";
import { grantReviewed, release as releaseFiles, serverBuilt } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { auditedDuring, signedInApi, unique } from "./sign-in.ts";

// The workflow map, the built-in App (apps/core/blueprints/workflow-map/):
// an App created from it asks for the Playbook, and once an admin grants
// it, keeps its workflows there as records, round trip: drawn, designed
// with the drawn version beside it, and linked to an App workflow. These
// tests go in through the App's server methods, as its screen calls them.

const idp = mockIdp();

const workflowMap = builtinAppId("workflow-map");

const as = (userId: string): AppCallerInput => ({
  userId,
  mode: "interactive",
});

/** What a server method answered (`{ ok }`), as `schema` reads it. */
const okOf = <T>(answer: unknown, schema: z.ZodType<T>): T => {
  const { ok } = z.object({ ok: schema }).parse(answer);
  return ok;
};

const workflowSchema = z.object({
  id: z.string(),
  path: z.string(),
  version: z.number(),
  record: z.record(z.string(), z.unknown()),
  body: z.string(),
});

const openedSchema = z.object({
  current: workflowSchema,
  drawn: workflowSchema.nullable(),
});

const overviewSchema = z.object({
  access: z.enum(["none", "ok"]),
  writable: z.boolean(),
  workflows: z.array(workflowSchema),
  unreadable: z.array(z.object({ path: z.string(), title: z.string() })),
  teams: z.array(z.object({ path: z.string(), title: z.string() })),
});

/** The most records one read of the overview lists. */
const pageMax = 20;

/** The fewest reads that list `records`: at least one, even for none. */
const readsFor = (records: number): number =>
  Math.max(1, Math.ceil(records / pageMax));

const savedSchema = z.object({
  id: z.string(),
  path: z.string(),
  currentVersion: z.number(),
});

const numbers = (frequency: number, minutes: number, people: number) => ({
  frequency: { value: frequency, basis: "estimated" },
  minutes: { value: minutes, basis: "estimated" },
  people: { value: people, basis: "estimated" },
});

/** A drawn workflow as the map's screen saves it. */
const drawn = {
  type: "workflow",
  title: "Pay supplier invoices",
  state: "drawn",
  steps: [
    {
      name: "Match the invoice",
      who: "Controller",
      handover: true,
      numbers: numbers(30, 10, 2),
    },
  ],
  parameters: [{ name: "Approval limit", value: "5000" }],
};

/** An admin's App created from the workflow map, its Playbook granted. */
const setUp = async () => {
  await builtins(env).ensureInstalled(await fingerprintOf(env, release));
  const admin = await signedInApi(idp, "admin");
  const created = await admin.api.apps.blueprints.create(workflowMap, 1, {
    name: `Our map ${unique()}`,
  });
  const asked = created.permissions.map(
    ({ object, actions, binding, status }) => ({
      object,
      actions,
      binding,
      status,
    })
  );
  for (const { id } of created.permissions) {
    // oxlint-disable-next-line no-await-in-loop -- one grant at a time
    await grantReviewed(admin.api, id);
  }
  await admin.api.apps.versions.setCurrent(created.app.id, 1);
  await serverBuilt(created.app.id, 1);
  return { admin, app: appIdSchema.parse(created.app.id), asked };
};

const call = async (
  app: AppId,
  userId: string,
  method: string,
  ...args: unknown[]
): Promise<unknown> => await callApp(env, app, as(userId), method, args);

describe("the workflow map", { timeout: 60_000 }, () => {
  it("asks for the Playbook, and keeps a workflow there as it is drawn, then designed beside the drawn version", async () => {
    const { admin, app, asked } = await setUp();
    expect(asked).toStrictEqual([
      {
        object: { type: "collection", collectionId: playbookCollectionId },
        actions: ["read", "write"],
        binding: "PLAYBOOK",
        status: "requested",
      },
    ]);

    const team = okOf(
      await call(app, admin.userId, "addTeam", "Finance"),
      z.object({ path: z.string(), title: z.string() })
    );
    const first = okOf(
      await call(app, admin.userId, "save", {
        ifVersion: 0,
        record: { ...drawn, team: team.path },
        body: "Pay what we owe.",
      }),
      savedSchema
    );
    const listed = okOf(
      await call(app, admin.userId, "overview"),
      overviewSchema
    );
    const openedDrawn = okOf(
      await call(app, admin.userId, "open", first.id),
      openedSchema
    );

    const designedSteps = [
      {
        name: "Match the invoice",
        handover: false,
        kind: "automated",
        numbers: numbers(30, 1, 1),
      },
    ];
    okOf(
      await call(app, admin.userId, "save", {
        documentId: first.id,
        path: openedDrawn.current.path,
        ifVersion: 1,
        record: {
          ...drawn,
          team: team.path,
          state: "designed",
          steps: designedSteps,
          gain: { hoursPerWeek: 9.5 },
        },
        body: "Pay what we owe.",
        message: "Designed",
      }),
      savedSchema
    );
    const openedDesigned = okOf(
      await call(app, admin.userId, "open", first.id),
      openedSchema
    );

    // Saved again without its team, as the editor does once "No team" is
    // picked: the team is gone. From version 2 again, someone else's save
    // came first.
    const { team: _team, ...withoutTeam } = openedDesigned.current.record;
    okOf(
      await call(app, admin.userId, "save", {
        documentId: first.id,
        path: openedDesigned.current.path,
        ifVersion: 2,
        record: withoutTeam,
        body: "Pay what we owe.",
      }),
      savedSchema
    );
    const stale = await call(app, admin.userId, "save", {
      documentId: first.id,
      path: openedDesigned.current.path,
      ifVersion: 2,
      record: withoutTeam,
      body: "Pay what we owe.",
    });
    const cleared = okOf(
      await call(app, admin.userId, "open", first.id),
      openedSchema
    );

    expect({
      listed: listed.workflows
        .filter(({ id }) => id === first.id)
        .map(({ version, record }) => ({
          version,
          title: record.title,
          team: record.team,
        })),
      teams: listed.teams.filter(({ path }) => path === team.path),
      drawn: [openedDrawn.current.record, openedDrawn.drawn],
      designed: {
        version: openedDesigned.current.version,
        state: openedDesigned.current.record.state,
        steps: openedDesigned.current.record.steps,
        gain: openedDesigned.current.record.gain,
        besideVersion: openedDesigned.drawn?.version,
        besideSteps: openedDesigned.drawn?.record.steps,
      },
      cleared: [cleared.current.version, "team" in cleared.current.record],
      stale,
    }).toStrictEqual({
      listed: [{ version: 1, title: "Pay supplier invoices", team: team.path }],
      teams: [{ path: team.path, title: "Finance" }],
      drawn: [{ ...drawn, team: team.path, description: "", tags: [] }, null],
      designed: {
        version: 2,
        state: "designed",
        steps: designedSteps,
        gain: { hoursPerWeek: 9.5 },
        besideVersion: 1,
        besideSteps: drawn.steps,
      },
      cleared: [3, false],
      stale: { error: "knowledge.conflict" },
    });
  });

  it("links a designed workflow to an App workflow, and refuses whoever may not change the Playbook", async () => {
    const { admin, app } = await setUp();
    const user = await signedInApi(idp, "user");
    const { id: payables } = await admin.api.apps.create({
      name: `Payables ${unique()}`,
    });
    await releaseFiles(admin, payables, {
      "app/server.ts": "export class App {}\n",
      "workflows/pay.ts": `import { workflow, z } from "@grasp-os/sdk/workflow";

export default workflow(
  "pay",
  { input: z.unknown(), params: {} },
  async (step) => await step.do("count", { description: "Count" }, async () => 1)
);
`,
      "workflows/pay.workflow-tests.ts": `import { workflowTests } from "@grasp-os/sdk/testing";

import pay from "./pay.ts";

export default workflowTests(pay, [{ name: "counts", mocks: { count: 1 }, expect: { output: 1 } }]);
`,
    });
    const designed = okOf(
      await call(app, admin.userId, "save", {
        ifVersion: 0,
        record: { ...drawn, state: "designed" },
        body: "",
      }),
      savedSchema
    );

    const linked = okOf(
      await call(app, admin.userId, "link", {
        documentId: designed.id,
        ifVersion: 1,
        appId: payables,
        workflowId: "pay",
      }),
      savedSchema
    );
    const opened = okOf(
      await call(app, admin.userId, "open", designed.id),
      openedSchema
    );
    const writableFor = async (userId: string) => {
      const listed = okOf(await call(app, userId, "overview"), overviewSchema);
      return listed.writable;
    };
    expect({
      linked: linked.currentVersion,
      app: opened.current.record.app,
      // The map is read only for whoever may not change the Playbook.
      writable: {
        admin: await writableFor(admin.userId),
        user: await writableFor(user.userId),
      },
      user: await call(app, user.userId, "save", {
        ifVersion: 0,
        record: drawn,
        body: "",
      }),
      team: await call(app, user.userId, "addTeam", "Finance"),
    }).toStrictEqual({
      linked: 2,
      app: { appId: payables, workflowId: "pay" },
      writable: { admin: true, user: false },
      user: { error: "knowledge.forbidden" },
      team: { error: "knowledge.forbidden" },
    });
  });

  it("lists the workflows it can read when some can't be, and names those", async () => {
    const { admin, app } = await setUp();
    const save = async (title: string) =>
      okOf(
        await call(app, admin.userId, "save", {
          ifVersion: 0,
          record: { ...drawn, title },
          body: "",
        }),
        savedSchema
      );
    const kept = await save(`Kept ${unique()}`);
    const unfit = await save(`Unfit ${unique()}`);
    const gone = await save(`Gone ${unique()}`);
    // As a rollback to a release with other schemas would leave it.
    await env.KNOWLEDGE.prepare(
      "UPDATE versions SET text = ? WHERE document_id = ?"
    )
      .bind("---\ntype: workflow\nstate: sketched\n---\n", unfit.id)
      .run();
    // Its current version gone: listed, with no text to read.
    await env.KNOWLEDGE.prepare("DELETE FROM versions WHERE document_id = ?")
      .bind(gone.id)
      .run();

    const listed = okOf(
      await call(app, admin.userId, "overview"),
      overviewSchema
    );
    const unreadable = new Set(listed.unreadable.map(({ path }) => path));
    expect({
      kept: listed.workflows.some(({ id }) => id === kept.id),
      listed: listed.workflows.some(
        ({ id }) => id === unfit.id || id === gone.id
      ),
      unreadable: [unfit.path, gone.path].map((path) => unreadable.has(path)),
    }).toStrictEqual({ kept: true, listed: false, unreadable: [true, true] });
  });

  it("reads its overview a page of records at a time, each page one read in the audit log", async () => {
    const { admin, app } = await setUp();
    // More than a page (20), so the overview reads at least two.
    await Promise.all(
      Array.from(
        { length: 21 },
        async (_, index) =>
          await call(app, admin.userId, "save", {
            ifVersion: 0,
            record: { ...drawn, title: `Paged ${index} ${unique()}` },
            body: "",
          })
      )
    );

    let listed: z.infer<typeof overviewSchema> | undefined;
    const events = await auditedDuring(async () => {
      listed = okOf(await call(app, admin.userId, "overview"), overviewSchema);
    });
    const reads = events.filter(({ action }) => action === "knowledge.read");
    const counted = z.object({ read: z.string(), count: z.number() });
    const workflows =
      (listed?.workflows.length ?? 0) + (listed?.unreadable.length ?? 0);
    const teams = listed?.teams.length ?? 0;
    const counts = reads.map(({ detail }) => counted.parse(detail).count);
    expect({
      kinds: [
        ...new Set(reads.map(({ detail }) => counted.parse(detail).read)),
      ],
      read: counts.reduce((sum, count) => sum + count, 0),
      pageFits: counts.every((count) => count <= pageMax),
      // One read for each page, never one for each workflow.
      events: reads.length,
    }).toStrictEqual({
      kinds: ["records"],
      read: workflows + teams,
      pageFits: true,
      events: readsFor(workflows) + readsFor(teams),
    });
  });

  it("opens and saves only workflows, never turning another record into one", async () => {
    const { admin, app } = await setUp();
    const team = okOf(
      await call(app, admin.userId, "addTeam", `Finance ${unique()}`),
      z.object({ path: z.string(), title: z.string() })
    );
    const teamRow = await env.KNOWLEDGE.prepare(
      "SELECT id FROM documents WHERE collection_id = ? AND path = ?"
    )
      .bind(playbookCollectionId, team.path)
      .first<{ id: string }>();
    const teamId = teamRow?.id ?? "";
    const workflow = okOf(
      await call(app, admin.userId, "save", {
        ifVersion: 0,
        record: drawn,
        body: "",
      }),
      z.object({ id: z.string(), path: z.string() })
    );
    const saveOver = async (input: Record<string, unknown>) =>
      await call(app, admin.userId, "save", {
        ifVersion: 1,
        record: drawn,
        body: "",
        ...input,
      });

    expect({
      openTeam: await call(app, admin.userId, "open", teamId),
      overTeam: await saveOver({ documentId: teamId, path: team.path }),
      unnamed: await saveOver({ path: workflow.path }),
      elsewhere: await saveOver({
        documentId: workflow.id,
        path: team.path,
      }),
      asTeam: await call(app, admin.userId, "save", {
        ifVersion: 0,
        record: { type: "team", title: "Not a workflow" },
        body: "",
      }),
      // What it may: the workflow, by its ID at its path.
      workflow: okOf(
        await saveOver({ documentId: workflow.id, path: workflow.path }),
        z.object({ currentVersion: z.number() })
      ),
    }).toStrictEqual({
      openTeam: { error: "map.not_workflow" },
      overTeam: { error: "map.not_workflow" },
      unnamed: { error: "map.not_workflow" },
      elsewhere: { error: "map.not_workflow" },
      asTeam: { error: "map.not_workflow" },
      workflow: { currentVersion: 2 },
    });
    // The team is as it was: one version, still a team.
    const { results } = await env.KNOWLEDGE.prepare(
      "SELECT type, current_version AS version FROM documents WHERE id = ?"
    )
      .bind(teamId)
      .all();
    expect(results).toStrictEqual([{ type: "team", version: 1 }]);
  });

  it("says it has no Playbook until an admin grants it", async () => {
    await builtins(env).ensureInstalled(await fingerprintOf(env, release));
    const admin = await signedInApi(idp, "admin");
    const created = await admin.api.apps.blueprints.create(workflowMap, 1, {
      name: `Ungranted ${unique()}`,
    });
    await admin.api.apps.versions.setCurrent(created.app.id, 1);
    await serverBuilt(created.app.id, 1);
    const app = appIdSchema.parse(created.app.id);
    expect({
      overview: await call(app, admin.userId, "overview"),
      save: await call(app, admin.userId, "save", {
        ifVersion: 0,
        record: drawn,
        body: "",
      }),
    }).toStrictEqual({
      overview: {
        ok: {
          access: "none",
          writable: false,
          workflows: [],
          unreadable: [],
          teams: [],
        },
      },
      save: { error: "permission.denied" },
    });
  });
});
