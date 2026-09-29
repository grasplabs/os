import { compilerVersion } from "@grasp-os/compiler";
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
import { outlook, release, requestGranted } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { signedInApi } from "./sign-in.ts";
import { server } from "./workflow-apps.ts";

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
const intake = {
  "workflows/intake.ts": `import { workflow, z } from "@grasp-os/sdk/workflow";

export default workflow("intake", { params: {}, input: z.unknown() }, async (step, { input }) => {
  return await step.do("read", { description: "Read the invoice" }, async () => input);
});
`,
  "workflows/intake.workflow-tests.ts": `import { workflowTests } from "@grasp-os/sdk/testing";

import definition from "./intake.ts";

export default workflowTests(definition, [
  { name: "runs", mocks: { read: 1 }, events: [{ type: "go", payload: null }], expect: {} },
]);
`,
};

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

/** The invoices workflow, with a limit and, when `booked`, a booking. */
const invoices = (limit: number, booked: boolean) => ({
  "workflows/invoices.ts": `import { money, workflow, z } from "@grasp-os/sdk/workflow";

export default workflow(
  "invoices",
  { input: z.unknown(), params: { limit: money({ label: "Limit", currency: "EUR", default: ${limit} }) } },
  async (step, { params }) => {
const limit = await step.do("limit", { description: "Read the limit" }, async () => params.limit);
${booked ? `await step.do("book", { description: "Book it", sideEffect: true, input: { limit } }, async () => 1);` : ""}
return limit;
  }
);
`,
  "workflows/invoices.workflow-tests.ts": `import { workflowTests } from "@grasp-os/sdk/testing";

import definition from "./invoices.ts";

export default workflowTests(definition, [{ name: "runs", mocks: { limit: 1, book: 1 }, expect: { output: 1 } }]);
`,
});

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

  it("holds checks started at once to the repair loop's limit", async () => {
    const { chat, grant } = await setUp([
      codeStep(`export default async (env) => {
        const app = await env.build.create({ name: ${JSON.stringify(appName)} });
        await env.build.write(app.id, ${JSON.stringify({ "screens/desk.tsx": restyled })});
        const tried = async () => { try { return (await env.build.check(app.id)).passed; } catch (error) { return error.message; } };
        return await Promise.all(Array.from({ length: 12 }, tried));
      };`),
      says("It still fails."),
    ]);
    await grant();

    await chat.ask("Build an invoice desk");

    const [result] = await codeResults(chat.stub, chat.chat.id);
    const outcomes = z.array(z.unknown()).parse(returned(result?.text));
    const exhausted = appErrors.create("app.checks_exhausted").message;
    // Five ran and failed; the other seven were refused before they ran.
    expect({
      ran: outcomes.filter((outcome) => outcome === false).length,
      refused: outcomes.filter((outcome) => outcome === exhausted).length,
    }).toStrictEqual({ ran: 5, refused: 7 });
  });

  it("caps a turn's dry runs apart from its checks, and the Apps it creates", async () => {
    const { chat, grant } = await setUp([
      codeStep(`export default async (env) => {
        const tried = async (call) => { try { return await call(); } catch (error) { return error.message; } };
        // Refused as invalid: it creates nothing, and takes no App's place.
        const created = [await tried(async () => (await env.build.create({ name: "" })).name)];
        for (let count = 0; count < 4; count += 1) {
          created.push(await tried(async () => (await env.build.create({ name: ${JSON.stringify(appName)} + count })).name));
        }
        const app = (await env.apps.list()).find(({ name }) => name === ${JSON.stringify(`${appName}0`)});
        await env.build.write(app.id, ${JSON.stringify({ "screens/desk.tsx": fixed, ...intake })});
        const runs = [];
        for (let count = 0; count < 11; count += 1) {
          runs.push(await tried(async () => (await env.build.dryRun(app.id, "intake")).length));
        }
        return { created, runs, check: await tried(async () => (await env.build.check(app.id)).passed) };
      };`),
      says("Done."),
    ]);
    await grant();

    await chat.ask("Build three desks");

    const [result] = await codeResults(chat.stub, chat.chat.id);
    expect(returned(result?.text)).toStrictEqual({
      created: [
        appErrors.create("app.invalid").message,
        `${appName}0`,
        `${appName}1`,
        `${appName}2`,
        appErrors.create("app.creates_exhausted").message,
      ],
      runs: [
        ...Array.from({ length: 10 }, () => 1),
        appErrors.create("app.dry_runs_exhausted").message,
      ],
      // Dry runs keep no check from running.
      check: true,
    });
  });

  it("keeps no change that leaves a file as the base has it", async () => {
    const ledger = `const [app] = (await env.apps.list()).filter(({ name }) => name === "Ledger");`;
    const { existing, chat, grant } = await setUp([
      codeStep(`export default async (env) => {
        ${ledger}
        const steps = [];
        steps.push((await env.build.write(app.id, { "notes.md": "new", "gone.md": null })).changed);
        // Back as the base has it, and a missing file deleted again.
        steps.push((await env.build.write(app.id, { "notes.md": null, "AGENTS.md": "# Ledger\\n", "gone.md": null })).changed);
        return steps;
      };`),
      says("Nothing changed."),
    ]);
    await grant();

    await chat.ask("Try some notes");

    const [result] = await codeResults(chat.stub, chat.chat.id);
    expect(returned(result?.text)).toStrictEqual([["notes.md"], []]);
    await expect(
      runInDurableObject(chat.stub, (instance) =>
        instance.draft(chatIdSchema.parse(chat.chat.id), existing)
      )
    ).resolves.toMatchObject({ changes: {}, revision: 2 });
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
      instance.saveDraft(chatId, "app-1", null, { "a.md": "a" }, [], 0),
      // Another write read revision 0 too, and lost.
      instance.saveDraft(chatId, "app-1", null, { "a.md": "b" }, [], 0),
      instance.saveDraft(chatId, "app-1", null, { "b.md": "b" }, [], 1),
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
      },
    ]);
  });

  it("keeps a draft's revisions going when its changes are all gone", async () => {
    const { chat } = await setUp([]);
    const chatId = chatIdSchema.parse(chat.chat.id);

    const saved = await runInDurableObject(chat.stub, (instance) => [
      // A write reads revision 0; meanwhile another creates the draft and
      // writes its only change back as the base has it.
      instance.saveDraft(chatId, "app-1", null, { "a.md": "a" }, [], 0),
      instance.saveDraft(chatId, "app-1", null, {}, ["a.md"], 1),
      instance.draft(chatId, "app-1"),
      // The write that read revision 0 lands on nothing.
      instance.saveDraft(chatId, "app-1", null, { "b.md": "b" }, [], 0),
      // Nor once the draft is dropped, as a proposal drops it.
      instance.saveDraft(chatId, "app-1", null, { "c.md": "c" }, [], 2),
      instance.dropDraft(chatId, "app-1", 3),
      instance.saveDraft(chatId, "app-1", null, { "d.md": "d" }, [], 0),
      instance.saveDraft(chatId, "app-1", null, { "d.md": "d" }, [], 3),
      instance.draft(chatId, "app-1"),
    ]);

    expect(saved).toStrictEqual([
      true,
      true,
      { base: null, changes: {}, revision: 2 },
      false,
      true,
      true,
      false,
      false,
      { base: null, changes: {}, revision: 4 },
    ]);
  });

  it("lands no first write that read the draft before a discard", async () => {
    const { chat } = await setUp([]);
    const chatId = chatIdSchema.parse(chat.chat.id);

    const saved = await runInDurableObject(chat.stub, (instance) => [
      // A first write reads revision 0; a discard runs before it lands.
      instance.dropDraft(chatId, "app-1"),
      instance.saveDraft(chatId, "app-1", null, { "a.md": "a" }, [], 0),
      instance.draft(chatId, "app-1"),
    ]);

    expect(saved).toStrictEqual([
      true,
      false,
      { base: null, changes: {}, revision: 1 },
    ]);
  });

  it("counts no check whose builds are still going as failed, up to ten a turn", async () => {
    const checks = `export default async (env) => {
      ${findApp}
      const checks = [];
      for (let count = 0; count < 12; count += 1) {
        try {
          const check = await env.build.check(app.id);
          checks.push({ passed: check.passed, pending: check.pending, failedInARow: check.failedInARow });
        } catch (error) {
          checks.push(error.message);
        }
      }
      return checks;
    };`;
    const { chat, grant } = await setUp([
      codeStep(`export default async (env) => {
        const app = await env.build.create({ name: ${JSON.stringify(appName)} });
        await env.build.write(app.id, ${JSON.stringify({ "screens/desk.tsx": fixed })});
      };`),
      codeStep(checks),
      says("Still building."),
      codeStep(`export default async (env) => {
        ${findApp}
        const check = await env.build.check(app.id);
        return { passed: check.passed, pending: check.pending, failedInARow: check.failedInARow };
      };`),
      says("Built."),
    ]);
    await grant();
    // The build cache answers only once the test lets it: every build waits
    // on it past a check's wait.
    const held = Promise.withResolvers<boolean>();
    const { FILES: files, CHECK_BUILD_WAIT_MS: wait } = env;
    const holding = new Proxy(files, {
      get: (target, property) => {
        const value: unknown = Reflect.get(target, property);
        if (property === "get" && typeof value === "function") {
          return async (...args: unknown[]): Promise<unknown> => {
            await held.promise;
            return Reflect.apply(value, target, args);
          };
        }
        return typeof value === "function"
          ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
          : value;
      },
    });
    try {
      env.FILES = holding;
      env.CHECK_BUILD_WAIT_MS = "50";
      await chat.ask("Build an invoice desk");
    } finally {
      env.FILES = files;
      env.CHECK_BUILD_WAIT_MS = wait;
      held.resolve(true);
    }
    await chat.ask("Check it again");

    const results = await codeResults(chat.stub, chat.chat.id);
    const pending = { passed: false, pending: true, failedInARow: 0 };
    // More than the repair loop allows to fail, none counted as failed;
    // past ten a turn, refused: each asks the compiler for work.
    const unfinished = appErrors.create("app.builds_unfinished").message;
    expect(returned(results[1]?.text)).toStrictEqual([
      ...Array.from({ length: 10 }, () => pending),
      unfinished,
      unfinished,
    ]);
    expect(returned(results[2]?.text)).toStrictEqual({
      passed: true,
      pending: false,
      failedInARow: 0,
    });
  });

  it("proposes a passing draft for review, and nothing goes live until a builder makes it current", async () => {
    const { person, chat, grant } = await setUp([
      codeStep(`export default async (env) => {
        const app = await env.build.create({ name: ${JSON.stringify(appName)} });
        await env.build.write(app.id, ${JSON.stringify({ "screens/desk.tsx": fixed, ...intake })});
        const permission = await env.build.requestPermission(app.id, {
          object: { type: "connection", connectionId: "connection-outlook" },
          actions: ["mail.list"],
          binding: "INVOICES",
        });
        const proposal = await env.build.propose(app.id, "An invoice desk for invoices@");
        const tried = async (call) => { try { await call(); return "done"; } catch (error) { return error.message; } };
        return {
          permission: permission.status,
          version: proposal.version,
          passed: proposal.check.passed,
          review: proposal.review,
          // No way to make it current, under any name.
          setCurrent: await tried(() => env.build.setCurrent(app.id, proposal.version)),
          appsSetCurrent: await tried(() => env.apps.setCurrent(app.id, proposal.version)),
          left: (await env.build.files(app.id)).changed,
        };
      };`),
      says("Proposed: a builder makes it current."),
    ]);
    await grant();

    await chat.ask("Build an invoice desk for invoices@");

    const [result] = await codeResults(chat.stub, chat.chat.id);
    const app = await createdApp(person.api);
    const review = await person.api.apps.versions.review(app.id, 1);
    const noSetCurrent = 'The RPC receiver does not implement "setCurrent".';
    expect(returned(result?.text)).toStrictEqual({
      permission: "requested",
      version: 1,
      passed: true,
      review: structuredClone(review),
      // Neither API has such a method: the call reaches nothing.
      setCurrent: noSetCurrent,
      appsSetCurrent: noSetCurrent,
      left: [],
    });
    const agent = {
      type: "agent",
      agentId: chat.agent.agentId,
      onBehalfOf: person.userId,
    };
    const proposer = {
      ...agent,
      workspaceId: chat.id,
      chatId: chat.chat.id,
    };
    expect(review).toMatchObject({
      version: {
        version: 1,
        parent: null,
        author: person.userId,
        proposedBy: proposer,
      },
      // The chat's title, for the person the agent acted for.
      proposedBy: { ...proposer, ownChat: true, chatTitle: "Questions" },
      current: null,
      files: [
        { path: "screens/desk.tsx", change: "added" },
        { path: "workflows/intake.ts", change: "added" },
        { path: "workflows/intake.workflow-tests.ts", change: "added" },
      ],
      server: null,
      serverFiles: [],
      workflows: [
        {
          id: "intake",
          change: "added",
          shared: [],
          steps: [
            { name: "read", change: "added", sideEffect: false, calls: [] },
          ],
          params: [],
        },
      ],
      permissions: [
        {
          subject: { type: "app", appId: app.id },
          binding: "INVOICES",
          status: "requested",
          requestedBy: person.userId,
          requestedVia: proposer,
        },
      ],
      grants: [],
      tests: { status: "passed", failures: [] },
    });
    // Pending, not live, until a builder makes it current.
    await expect(createdApp(person.api)).resolves.toMatchObject({
      currentVersion: null,
      pendingVersion: 1,
    });
    await expect(
      person.api.apps.versions.setCurrent(app.id, 1)
    ).resolves.toMatchObject({ currentVersion: 1, pendingVersion: null });
    // Committed and proposed by the agent, acting for the person.
    await vi.waitFor(
      async () => {
        const events = await allEvents();
        const actors = Object.fromEntries(
          events
            .filter(({ target }) => target?.id === app.id)
            .map(({ action, actor }) => [action, actor])
        );
        expect(actors).toMatchObject({
          "app.committed": agent,
          "app.version.proposed": agent,
          "app.version.current": { type: "person", userId: person.userId },
        });
      },
      { timeout: 10_000, interval: 50 }
    );
  });

  it("proposes nothing that fails its checks", async () => {
    const { person, chat, grant } = await setUp([
      codeStep(`export default async (env) => {
        const app = await env.build.create({ name: ${JSON.stringify(appName)} });
        await env.build.write(app.id, ${JSON.stringify({ "screens/desk.tsx": restyled })});
        const proposal = await env.build.propose(app.id, "A desk");
        return { version: proposal.version, passed: proposal.check.passed, review: proposal.review };
      };`),
      says("It doesn't pass yet."),
    ]);
    await grant();

    await chat.ask("Build an invoice desk");

    const [result] = await codeResults(chat.stub, chat.chat.id);
    expect(returned(result?.text)).toStrictEqual({
      version: null,
      passed: false,
      review: null,
    });
    const app = await createdApp(person.api);
    expect({
      app,
      versions: await person.api.apps.versions.list(app.id),
    }).toMatchObject({ app: { pendingVersion: null }, versions: [] });
  });

  it("proposes over what builders committed since, and never undoes it", async () => {
    const ledger = `const [app] = (await env.apps.list()).filter(({ name }) => name === "Ledger");`;
    const propose = `export default async (env) => {
      ${ledger}
      try {
        return (await env.build.propose(app.id, "Notes")).version;
      } catch (error) {
        return error.message;
      }
    };`;
    const { builder, existing, chat, grant } = await setUp([
      codeStep(`export default async (env) => {
        ${ledger}
        await env.build.write(app.id, { "notes.md": "the agent's", "AGENTS.md": "# Ledger, by the agent\\n" });
      };`),
      says("Written."),
      codeStep(propose),
      says("Someone changed it meanwhile."),
      codeStep(`export default async (env) => {
        ${ledger}
        await env.build.write(app.id, { "AGENTS.md": "# Ledger\\n\\nWith notes.\\n" });
      };`),
      codeStep(propose),
      says("Proposed."),
    ]);
    await grant();

    await chat.ask("Add notes to the Ledger");
    // A builder commits a change to a file the draft changes too, and one
    // to a file it doesn't.
    await release(builder, existing, {
      "AGENTS.md": "# Ledger\n\nWith notes.\n",
      "board.md": "the builder's",
    });
    await chat.ask("Propose it");
    await chat.ask("Take theirs, and propose again");

    const results = await codeResults(chat.stub, chat.chat.id);
    expect(results[1]?.text).toBe(
      `Returned:\n${appErrors.create("app.conflict").message}`
    );
    expect(returned(results[3]?.text)).toBe(3);
    await expect(
      builder.api.apps.files.read(existing, 3)
    ).resolves.toStrictEqual({
      "AGENTS.md": "# Ledger\n\nWith notes.\n",
      "board.md": "the builder's",
      "notes.md": "the agent's",
    });
  });

  it("reviews what a version changes against the current one, for its builders only", async () => {
    const builder = await signedInApi(idp, "builder");
    const user = await signedInApi(idp, "user");
    const { id: app } = await builder.api.apps.create({ name: "Invoices" });
    await release(builder, app, {
      ...invoices(500, false),
      "notes.md": "old",
    });
    await builder.api.apps.files.write(app, {
      ...invoices(900, true),
      "notes.md": null,
    });
    const { version } = await builder.api.apps.files.commit(app, "Book them");

    const review = await builder.api.apps.versions.review(app, version);

    expect(review).toMatchObject({
      version: { version: 2, parent: 1, message: "Book them" },
      current: 1,
      files: [
        { path: "notes.md", change: "removed" },
        { path: "workflows/invoices.ts", change: "modified" },
      ],
      workflows: [
        {
          id: "invoices",
          change: "modified",
          steps: [{ name: "book", change: "added", sideEffect: true }],
          params: [{ name: "limit", change: "modified" }],
        },
      ],
      permissions: [],
      tests: { status: "passed", failures: [] },
    });
    // Someone who uses its screens, but doesn't build it.
    await builder.api.apps.members.add(app, {
      type: "person",
      id: user.userId,
      role: "user",
    });
    await expect(user.api.apps.versions.review(app, version)).rejects.toThrow(
      roleErrors.create("role.forbidden").message
    );
  });

  it("reviews code a workflow may use, the steps that call the App, and the grants the version uses", async () => {
    const builder = await signedInApi(idp, "builder");
    const admin = await signedInApi(idp, "admin");
    const notify = {
      "workflows/notify.ts": `import { workflow, z } from "@grasp-os/sdk/workflow";

export default workflow("notify", { params: {}, input: z.unknown() }, async (step, { env }) => {
  return await step.do("save", { description: "Save it" }, async () => await env.APP.call("hits", "notify"));
});
`,
      "workflows/notify.workflow-tests.ts": `import { workflowTests } from "@grasp-os/sdk/testing";

import definition from "./notify.ts";

export default workflowTests(definition, [{ name: "runs", mocks: { save: 1 }, expect: { output: 1 } }]);
`,
    };
    const { id: app } = await builder.api.apps.create({ name: "Notes" });
    await release(builder, app, {
      "app/server.ts": server,
      "app/lib/books.ts": "export const twice = false;\n",
      ...notify,
    });
    await requestGranted(idp, builder, outlook(app));
    // Only server code the server imports changes: the workflow's steps
    // call the server.
    await builder.api.apps.files.write(app, {
      "app/lib/books.ts": "export const twice = true;\n",
    });
    const { version } = await builder.api.apps.files.commit(app, "Server");

    const review = await builder.api.apps.versions.review(app, version);

    const grant = {
      subject: { type: "app", appId: app },
      binding: "OUTLOOK",
      status: "active",
    };
    expect(review).toMatchObject({
      proposedBy: null,
      server: "modified",
      serverFiles: [{ path: "app/lib/books.ts", change: "modified" }],
      workflows: [
        {
          id: "notify",
          change: "modified",
          shared: ["app/lib/books.ts"],
          steps: [
            {
              name: "save",
              change: "modified",
              sideEffect: false,
              calls: ["APP"],
            },
          ],
          params: [],
        },
      ],
      // A builder can't grant it: making the version current asks again.
      grants: [{ permission: grant, askedAgain: true }],
      tests: { status: "passed", failures: [] },
    });
    // An admin can: nothing is asked for again.
    await expect(
      admin.api.apps.versions.review(app, version)
    ).resolves.toMatchObject({
      grants: [{ permission: grant, askedAgain: false }],
    });

    // A change to one step's function alone shows that step as changed.
    await builder.api.apps.files.write(app, {
      "workflows/notify.ts": (notify["workflows/notify.ts"] ?? "").replace(
        'call("hits", "notify")',
        'call("hits", "notified")'
      ),
    });
    const { version: bodyOnly } = await builder.api.apps.files.commit(
      app,
      "Body"
    );
    await expect(
      builder.api.apps.versions.review(app, bodyOnly)
    ).resolves.toMatchObject({
      server: "modified",
      workflows: [
        {
          id: "notify",
          steps: [{ name: "save", change: "modified", calls: ["APP"] }],
        },
      ],
    });
  });

  it("lists no grant naming an App its reviewer can't see", async () => {
    const owner = await signedInApi(idp, "builder");
    const reviewer = await signedInApi(idp, "builder");
    const { id: app } = await owner.api.apps.create({ name: "Invoicing" });
    const { id: hidden } = await owner.api.apps.create({ name: "Ledger" });
    await requestGranted(idp, owner, {
      subject: { type: "app", appId: app },
      object: { type: "app", appId: hidden },
      actions: ["read"],
      binding: "LEDGER",
    });
    await owner.api.apps.members.add(app, {
      type: "person",
      id: reviewer.userId,
      role: "builder",
    });
    await owner.api.apps.files.write(app, { "notes.md": "new" });
    const { version } = await owner.api.apps.files.commit(app, "Notes");

    const [ownReview, theirs] = await Promise.all([
      owner.api.apps.versions.review(app, version),
      reviewer.api.apps.versions.review(app, version),
    ]);

    expect({
      owner: ownReview.grants.map(({ permission }) => permission.binding),
      reviewer: theirs.grants.map(({ permission }) => permission.binding),
      named: JSON.stringify(theirs).includes(hidden),
    }).toStrictEqual({ owner: ["LEDGER"], reviewer: [], named: false });
  });

  it("runs a version's tests once, and reviews nothing while the agent's building is off", async () => {
    const builder = await signedInApi(idp, "builder");
    const { id: app } = await builder.api.apps.create({ name: "Invoices" });
    await release(builder, app, invoices(500, false));
    const [latest] = await builder.api.apps.versions.list(app);
    const kept = `apps/${app}/tests/${latest?.tree ?? ""}-${compilerVersion}.json`;

    await builder.api.apps.versions.review(app, 1);
    // What the first review kept is what the next one reads.
    await expect(env.FILES.get(kept)).resolves.not.toBeNull();
    await env.FILES.put(
      kept,
      JSON.stringify({ status: "failed", failures: ["kept"] })
    );
    await expect(
      builder.api.apps.versions.review(app, 1)
    ).resolves.toMatchObject({
      tests: { status: "failed", failures: ["kept"] },
    });

    const on = z.record(z.string(), z.boolean()).parse(env.FEATURES);
    const { FEATURES: features } = env;
    try {
      env.FEATURES = { ...on, app_builder: false };
      await expect(builder.api.apps.versions.review(app, 1)).rejects.toThrow(
        featureErrors.create("feature.disabled", { feature: "app_builder" })
          .message
      );
    } finally {
      env.FEATURES = features;
    }
  });
});
