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
import { saveRecord } from "../src/knowledge/playbook.ts";
import { serverBuilt } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { signedInApi, unique } from "./sign-in.ts";

// The board page, the built-in App (apps/core/blueprints/board-page/): an
// App created from it asks for the Playbook, and once an admin grants it,
// takes snapshots there, shows the newest, and saves its narrative and
// the decision it asks for, keeping what the snapshot froze. These tests
// go in through the App's server methods, as its screen calls them.

const idp = mockIdp();

const boardPage = builtinAppId("board-page");

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

const savedSchema = z.object({ id: z.string(), currentVersion: z.number() });

/** An App created from the board page by an admin, granted or not. */
const setUp = async (grant = true) => {
  await builtins(env).ensureInstalled(await fingerprintOf(env, release));
  const admin = await signedInApi(idp, "admin");
  const created = await admin.api.apps.blueprints.create(boardPage, 1, {
    name: `Our board ${unique()}`,
  });
  const asked = created.permissions.map(({ object, actions, binding }) => ({
    object,
    actions,
    binding,
  }));
  if (grant) {
    for (const { id } of created.permissions) {
      // oxlint-disable-next-line no-await-in-loop -- one grant at a time
      await admin.api.permissions.grant(id);
    }
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

describe("the board page", { timeout: 60_000 }, () => {
  it("asks for the Playbook, takes a snapshot there, and saves its narrative and decision keeping what it froze", async () => {
    const { admin, app, asked } = await setUp();
    expect(asked).toStrictEqual([
      {
        object: { type: "collection", collectionId: playbookCollectionId },
        actions: ["read", "write"],
        binding: "PLAYBOOK",
      },
    ]);
    // A drawn workflow for it to freeze: 20 times × 30 minutes, 10 hours.
    const identity = await admin.api.whoami();
    const path = `workflows/board-${unique()}.md`;
    await saveRecord(env, identity, {
      path,
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
      body: "",
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
      tenders: z
        .object({
          figures: z.object({
            workflows: z.array(z.looseObject({ path: z.string() })),
          }),
        })
        .parse(opened.record)
        .figures.workflows.find((workflow) => workflow.path === path),
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
    const { admin, app } = await setUp();
    const identity = await admin.api.whoami();
    const workflow = await saveRecord(env, identity, {
      path: `workflows/not-a-snapshot-${unique()}.md`,
      ifVersion: 0,
      record: { type: "workflow", title: "Not a snapshot", state: "drawn" },
      body: "Kept as it is.",
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

  it("refuses whoever may not change the Playbook, and says it has no Playbook until an admin grants it", async () => {
    const { app } = await setUp();
    const user = await signedInApi(idp, "user");
    const { admin: other, app: ungranted } = await setUp(false);
    expect({
      user: await call(app, user.userId, "take", { maturity: 1 }),
      listed: await call(ungranted, other.userId, "snapshots"),
      take: await call(ungranted, other.userId, "take", { maturity: 1 }),
    }).toStrictEqual({
      user: { error: "knowledge.forbidden" },
      listed: { ok: { access: "none", snapshots: [] } },
      take: { error: "permission.denied" },
    });
  });
});
