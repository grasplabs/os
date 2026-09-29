import { appErrors } from "@grasp-os/shared/apps";
import { featureErrors } from "@grasp-os/shared/errors";
import { chatIdSchema } from "@grasp-os/shared/ids";
import { permissionErrors } from "@grasp-os/shared/permissions";
import { roleErrors } from "@grasp-os/shared/roles";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { chatOf, codeResults, codeStep, says } from "./agent-chat.ts";
import type { GatewayReply } from "./ai-gateway.ts";
import { release, requestGranted } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { signedInApi } from "./sign-in.ts";
import { workflowFiles } from "./workflow-apps.ts";

// `env.build` in a chat's code: the chat's agent building Apps for its
// person in a draft of its own, and repairing what its checks report.
// These tests start from the ways it can fail: the agent builds without a
// permission of its own, or past what its person may do (an App they
// don't build, or any App for someone who doesn't build); a chat that read
// restricted data writes it into code others read; the agent's draft and
// a builder's working copy overwrite each other; a draft that doesn't
// pass reaches the App; and a repair loop that never ends.

const idp = mockIdp();

const appName = "Invoice desk";

/** A screen whose button is restyled, which @shadcn/lint refuses. */
const restyled = `import { Button } from "@grasp-os/ui/components/button";

export default function Desk() {
  return (
    <main className="flex flex-col gap-4 p-6">
      <Button className="rounded-full">Approve</Button>
    </main>
  );
}
`;

/** The same screen with the button's own variant: what the lint asks for. */
const fixed = restyled.replace(
  '<Button className="rounded-full">',
  '<Button variant="outline">'
);

/** A workflow of the draft, with its tests. */
const intake = workflowFiles(
  "intake",
  `  return await step.do("read", { description: "Read the invoice" }, async () => 1);`,
  { read: 1 }
);

/** Code that finds the App the agent created, by its name, as `app`. */
const findApp = `const [app] = (await env.apps.list()).filter(({ name }) => name === ${JSON.stringify(appName)});`;

/** Creates the App, writes the restyled screen and a workflow, and checks. */
const firstTry = `export default async (env) => {
  const app = await env.build.create({ name: ${JSON.stringify(appName)} });
  await env.build.write(app.id, ${JSON.stringify({ "screens/desk.tsx": restyled, ...intake })});
  const check = await env.build.check(app.id);
  return {
    passed: check.passed,
    screens: check.screens.status,
    rules: check.screens.diagnostics.map(({ rule }) => rule),
    tests: check.tests.status,
    failedInARow: check.failedInARow,
  };
};`;

/** Writes the fixed screen, checks again, and dry-runs the workflow. */
const repair = `export default async (env) => {
  ${findApp}
  const written = await env.build.write(app.id, ${JSON.stringify({ "screens/desk.tsx": fixed })});
  const check = await env.build.check(app.id);
  const runs = await env.build.dryRun(app.id, "intake", {});
  const draft = await env.build.files(app.id);
  return {
    changed: written.changed,
    passed: check.passed,
    screens: check.screens.status,
    tests: check.tests.status,
    failedInARow: check.failedInARow,
    runs: runs.map(({ name, status }) => ({ name, status })),
    screen: draft.files["screens/desk.tsx"],
  };
};`;

/** What a code step returned, as JSON. */
const returned = (text: string | undefined): unknown =>
  z.unknown().parse(JSON.parse(text?.replace("Returned:\n", "") ?? "null"));

/** Code that makes each call in turn: what it returned, or its message. */
const tryEach = (calls: Record<string, string>, before = ""): string =>
  `export default async (env) => {
    ${before}
    const tried = async (call) => { try { return await call(); } catch (error) { return error.message; } };
    const results = {};
    ${Object.entries(calls)
      .map(
        ([name, call]) =>
          `results[${JSON.stringify(name)}] = await tried(async () => ${call});`
      )
      .join("\n    ")}
    return results;
  };`;

/**
 * A chat of `role`'s person (a builder unless another is given) answered
 * by `replies`, with an App a builder released so the Apps collection is
 * there, and `grant`: the agent's permission on it, to read and, with
 * `write`, to build.
 */
const setUp = async (
  replies: GatewayReply[],
  role: "builder" | "user" = "builder"
) => {
  const admin = await signedInApi(idp, "admin");
  const builder = await signedInApi(idp, "builder");
  const { id: existing } = await builder.api.apps.create({ name: "Ledger" });
  await release(builder, existing, { "AGENTS.md": "# Ledger\n" });
  const person = role === "builder" ? builder : await signedInApi(idp, role);
  const chat = await chatOf(person.userId, ...replies);
  const grant = async (actions: ("read" | "write")[] = ["read", "write"]) => {
    await requestGranted(idp, admin, {
      subject: chat.agent,
      object: { type: "collection", collectionId: "apps" },
      actions,
      binding: "APP_LIBRARY",
    });
  };
  return { admin, builder, person, existing, chat, grant };
};

/** The App the agent created, as the person's session finds it. */
const createdApp = async (
  api: Awaited<ReturnType<typeof signedInApi>>["api"]
) => {
  const listed = await api.apps.list();
  const app = listed.find(({ name }) => name === appName);
  if (app === undefined) {
    throw new Error("The agent created no App");
  }
  return app;
};

describe("building Apps from a chat", { timeout: 120_000 }, () => {
  it("repairs a restyled button without the person, in a draft nobody else sees, and puts nothing live", async () => {
    const { builder, person, chat, grant } = await setUp([
      codeStep(firstTry),
      codeStep(repair),
      says("The invoice desk passes its checks."),
    ]);
    await grant();

    // One question: every step after it is the agent's own.
    const answer = await chat.ask("Build an invoice desk for invoices@");

    expect(answer.outcome).toBe("answered");
    const results = await codeResults(chat.stub, chat.chat.id);
    expect(results.map(({ isError }) => isError)).toStrictEqual([false, false]);
    const [first, second] = results;
    expect(returned(first?.text)).toStrictEqual({
      passed: false,
      screens: "failed",
      rules: ["shadcn/no-restyle"],
      tests: "passed",
      failedInARow: 1,
    });
    expect(returned(second?.text)).toStrictEqual({
      changed: [
        "screens/desk.tsx",
        "workflows/intake.ts",
        "workflows/intake.workflow-tests.ts",
      ],
      passed: true,
      screens: "ok",
      tests: "passed",
      failedInARow: 0,
      runs: [{ name: "runs", status: "completed" }],
      screen: fixed,
    });

    // The App is the person's, and has nothing of the draft: no version,
    // nothing current, and an empty working copy for its builders.
    const app = await createdApp(person.api);
    expect({
      app,
      versions: await builder.api.apps.versions.list(app.id),
      workingCopy: await builder.api.apps.files.read(app.id),
    }).toMatchObject({
      app: { owner: person.userId, currentVersion: null, pendingVersion: null },
      versions: [],
      workingCopy: {},
    });
    // Created by the agent acting for the person, as the audit log says.
    await vi.waitFor(
      async () => {
        const events = await allEvents();
        const created = events.find(
          ({ action, target }) =>
            action === "app.created" && target?.id === app.id
        );
        expect(created?.actor).toStrictEqual({
          type: "agent",
          agentId: chat.agent.agentId,
          onBehalfOf: person.userId,
        });
      },
      { timeout: 10_000, interval: 50 }
    );
  });

  it("keeps the draft apart from a builder's working copy, both ways", async () => {
    const ledger = `const [app] = (await env.apps.list()).filter(({ name }) => name === "Ledger");`;
    const { builder, existing, chat, grant } = await setUp([
      codeStep(`export default async (env) => {
        ${ledger}
        await env.build.write(app.id, { "notes.md": "the agent's" });
        return await env.build.files(app.id);
      };`),
      says("Written."),
      codeStep(`export default async (env) => {
        ${ledger}
        const draft = await env.build.files(app.id);
        return { notes: draft.files["notes.md"], builder: draft.files["builder.md"] ?? null };
      };`),
      says("Still mine."),
    ]);
    await grant();

    await chat.ask("Add notes to the Ledger");
    // A builder writes to the working copy meanwhile, the same file too.
    await builder.api.apps.files.write(existing, {
      "notes.md": "the builder's",
      "builder.md": "mine",
    });
    await chat.ask("Are your notes still there?");

    const [draft, after] = await codeResults(chat.stub, chat.chat.id);
    expect(returned(draft?.text)).toStrictEqual({
      base: 1,
      changed: ["notes.md"],
      files: { "AGENTS.md": "# Ledger\n", "notes.md": "the agent's" },
    });
    expect(returned(after?.text)).toStrictEqual({
      notes: "the agent's",
      builder: null,
    });
    await expect(builder.api.apps.files.read(existing)).resolves.toStrictEqual({
      "AGENTS.md": "# Ledger\n",
      "notes.md": "the builder's",
      "builder.md": "mine",
    });
  });

  it("stops the repair loop after five failed checks in a row, until the next question", async () => {
    const checks = `export default async (env) => {
      ${findApp}
      const outcomes = [];
      for (let attempt = 0; attempt < 6; attempt += 1) {
        try {
          const check = await env.build.check(app.id);
          outcomes.push(check.failedInARow);
        } catch (error) {
          outcomes.push(error.message);
        }
      }
      return outcomes;
    };`;
    const { chat, grant } = await setUp([
      codeStep(`export default async (env) => {
        const app = await env.build.create({ name: ${JSON.stringify(appName)} });
        await env.build.write(app.id, ${JSON.stringify({ "screens/desk.tsx": restyled })});
      };`),
      codeStep(checks),
      says("It still fails: the button is restyled."),
      codeStep(`export default async (env) => {
        ${findApp}
        return (await env.build.check(app.id)).failedInARow;
      };`),
      says("Checked again."),
    ]);
    await grant();

    await chat.ask("Build an invoice desk");
    await chat.ask("Try once more");

    const results = await codeResults(chat.stub, chat.chat.id);
    const exhausted = appErrors.create("app.checks_exhausted").message;
    expect(returned(results[1]?.text)).toStrictEqual([
      1,
      2,
      3,
      4,
      5,
      exhausted,
    ]);
    // A new question gives the loop its count back.
    expect(returned(results[2]?.text)).toBe(1);
  });

  it("refuses to build without the agent's own permission, or for someone who doesn't build", async () => {
    const calls = tryEach({
      create: `(await env.build.create({ name: "Refused" })).name`,
    });
    const resultOf = async (
      role: "builder" | "user",
      actions: ("read" | "write")[]
    ) => {
      const { chat, grant } = await setUp([codeStep(calls), says("No.")], role);
      await grant(actions);
      await chat.ask("Build something");
      const [result] = await codeResults(chat.stub, chat.chat.id);
      return returned(result?.text);
    };
    const denied = permissionErrors.create("permission.denied", {
      action: "write",
    }).message;
    const forbidden = roleErrors.create("role.forbidden").message;

    // Reading the Apps collection is not building.
    await expect(resultOf("builder", ["read"])).resolves.toStrictEqual({
      create: denied,
    });
    // The agent's permission reaches no further than its person.
    await expect(resultOf("user", ["read", "write"])).resolves.toStrictEqual({
      create: forbidden,
    });
  });

  it("changes only the Apps its person builds", async () => {
    const other = await signedInApi(idp, "builder");
    const { id: shared } = await other.api.apps.create({ name: "Shared" });
    const { id: unshared } = await other.api.apps.create({ name: "Other" });
    const { person, chat, grant } = await setUp([
      codeStep(
        tryEach({
          shared: `await env.build.write(${JSON.stringify(shared)}, { "a.md": "a" })`,
          unshared: `await env.build.write(${JSON.stringify(unshared)}, { "a.md": "a" })`,
        })
      ),
      says("No."),
    ]);
    await grant();
    // They use the shared App's screens, but don't build it.
    await other.api.apps.members.add(shared, {
      type: "person",
      id: person.userId,
      role: "user",
    });

    await chat.ask("Change the other Apps");

    const [result] = await codeResults(chat.stub, chat.chat.id);
    expect(returned(result?.text)).toStrictEqual({
      shared: roleErrors.create("role.forbidden").message,
      unshared: appErrors.create("app.not_found").message,
    });
  });

  it("writes no App code from a restricted chat, or while switched off", async () => {
    const calls = tryEach({
      create: `(await env.build.create({ name: "Refused" })).name`,
    });
    const { chat, grant } = await setUp([
      codeStep(calls),
      says("No."),
      codeStep(calls),
      says("No."),
    ]);
    await grant();
    const on = z.record(z.string(), z.boolean()).parse(env.FEATURES);
    const { FEATURES: features } = env;
    try {
      env.FEATURES = { ...on, app_builder: false };
      await chat.ask("Build something");
    } finally {
      env.FEATURES = features;
    }
    await runInDurableObject(chat.stub, (instance) =>
      instance.restrictChat(chatIdSchema.parse(chat.chat.id))
    );
    await chat.ask("Build something now");

    const [off, restricted] = await codeResults(chat.stub, chat.chat.id);
    expect(returned(off?.text)).toStrictEqual({
      create: featureErrors.create("feature.disabled", {
        feature: "app_builder",
      }).message,
    });
    expect(returned(restricted?.text)).toStrictEqual({
      create: permissionErrors.create("permission.restricted").message,
    });
  });

  it("lands a draft write only over the revision it read", async () => {
    const { chat } = await setUp([]);
    const chatId = chatIdSchema.parse(chat.chat.id);

    const saved = await runInDurableObject(chat.stub, (instance) => [
      instance.saveDraft(chatId, "app-1", null, { "a.md": "a" }, 0),
      // Another write read revision 0 too, and lost.
      instance.saveDraft(chatId, "app-1", null, { "a.md": "b" }, 0),
      instance.saveDraft(chatId, "app-1", null, { "b.md": "b" }, 1),
      instance.draft(chatId, "app-1"),
    ]);

    expect(saved).toStrictEqual([
      true,
      false,
      true,
      {
        base: null,
        changes: { "a.md": "a", "b.md": "b" },
        revision: 2,
        failedChecks: 0,
      },
    ]);
  });
});
