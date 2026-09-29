import { appErrors } from "@grasp-os/shared/apps";
import type { AuditEvent } from "@grasp-os/shared/audit";
import { appIdSchema } from "@grasp-os/shared/ids";
import { permissionErrors } from "@grasp-os/shared/permissions";
import { workflowErrors } from "@grasp-os/shared/workflows";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { appHost } from "../src/durable-objects.ts";
import { chatOf, codeResults, codeStep, says } from "./agent-chat.ts";
import type { GatewayReply } from "./ai-gateway.ts";
import { requestGranted } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { readCollection } from "./knowledge.ts";
import { finished } from "./runs.ts";
import { signedInApi } from "./sign-in.ts";
import { appWith, workflowFiles } from "./workflow-apps.ts";

// `env.apps` and `env.workflows` in a chat's code: the chat's agent looking
// into its person's Apps and following their workflows. These tests start
// from the ways it can fail: the agent reads an App or a workflow without a
// permission of its own, or past what its person may see (the code of an
// App they don't build); a run's output (what it read through its App's
// connections) reaches the chat; and a call leaves no trace.

const idp = mockIdp();

/** What the App lets other Apps call. */
const totalsExport = {
  access: "read",
  description: "The latest total",
  input: { type: "object" },
  output: { type: "number" },
};

/**
 * A workflow that returns what it read, and a second one of the same App
 * that the agent is never granted; and an export.
 */
const reportFiles = {
  "app/exports.json": JSON.stringify({ totals: totalsExport }),
  ...workflowFiles(
    "report",
    `  return await step.do("total", { description: "Read the total" }, async () => "total-is-secret-42");`,
    { total: "total" }
  ),
  ...workflowFiles(
    "digest",
    `  return await step.do("sum", { description: "Sum it up" }, async () => 1);`,
    { sum: 1 }
  ),
};

interface Made {
  app: string;
  run: string;
}

/**
 * A builder's App with the report workflow, run once to its end, and a
 * chat of `person`'s (the builder, unless another is given) answered by
 * the replies `script` makes for them.
 */
const setUp = async (
  script: (made: Made) => GatewayReply[],
  personRole?: "user"
) => {
  const admin = await signedInApi(idp, "admin");
  const builder = await signedInApi(idp, "builder");
  const app = await appWith(builder, reportFiles);
  const { id: run } = await builder.api.workflows.start(app, "report");
  await finished(run);
  const person =
    personRole === undefined ? builder : await signedInApi(idp, personRole);
  const chat = await chatOf(person.userId, ...script({ app, run }));
  /** Grants the agent reading the Apps collection, and the workflow. */
  const grant = async () => {
    await requestGranted(
      idp,
      admin,
      readCollection(chat.agent, "apps", "APP_LIBRARY")
    );
    await requestGranted(idp, admin, {
      subject: chat.agent,
      object: { type: "workflow", appId: app, workflowId: "report" },
      actions: ["read"],
      binding: "REPORT",
    });
  };
  return { admin, builder, person, app, run, chat, grant };
};

/** The `agent.call` events of the chat's agent, once there are `count`. */
const callsOf = async (agentId: string, count: number): Promise<AuditEvent[]> =>
  await vi.waitFor(
    async () => {
      const events = await allEvents();
      const calls = events.filter(
        ({ actor, action, detail }) =>
          action === "agent.call" &&
          // Not the catalog each turn reads for its skills.
          detail.turn !== true &&
          actor.type === "agent" &&
          actor.agentId === agentId
      );
      expect(calls).toHaveLength(count);
      return calls;
    },
    { timeout: 10_000, interval: 50 }
  );

/** A step named from what a run read, as a workflow may name one. */
const secretStep = "total-for-acme-42000";

/**
 * A run of `app`'s report that failed at {@link secretStep} with `code`,
 * as core keeps it; started by a trigger, so it acts for the App's owner.
 */
const failedRun = async (app: string, code: string): Promise<string> => {
  const id = `run-${crypto.randomUUID()}`;
  const at = Date.now();
  await env.DB.prepare(
    "INSERT INTO workflow_runs (id, app_id, workflow_id, version, started_by, status, created_at, ended_at, failure) VALUES (?, ?, 'report', 1, NULL, 'failed', ?, ?, ?)"
  )
    .bind(
      id,
      app,
      at,
      at,
      JSON.stringify({
        run: id,
        app,
        workflow: "report",
        version: 1,
        step: secretStep,
        input: null,
        error: { code, message: "The total was 42000." },
        failedAt: new Date(at).toISOString(),
      })
    )
    .run();
  return id;
};

/** The failures a code step returned, by run. */
const failuresById = (text: string | undefined) =>
  Object.fromEntries(
    z
      .array(
        z.object({
          id: z.string(),
          failure: z.object({
            step: z.string().nullable(),
            code: z.string(),
          }),
        })
      )
      .parse(JSON.parse(text?.replace("Returned:\n", "") ?? "[]"))
      .map(({ id, failure }) => [id, failure])
  );

/** Code that makes each call in turn: what it returned, or its message. */
const tryEach = (calls: Record<string, string>): string =>
  `export default async (env) => {
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

/** Every call of the App and its workflow, as the code makes them. */
const everyCall = ({ app, run }: Made) =>
  tryEach({
    apps: "(await env.apps.list()).map(({ id }) => id)",
    files: `Object.keys(await env.apps.files(${JSON.stringify(app)})).includes("workflows/report.ts")`,
    versions: `(await env.apps.versions(${JSON.stringify(app)})).map(({ version }) => version)`,
    exports: `await env.apps.exports(${JSON.stringify(app)})`,
    workflows:
      "(await env.workflows.list()).map(({ workflow, lastRun }) => ({ workflow, lastRun: lastRun?.id ?? null }))",
    runs: `(await env.workflows.runs(${JSON.stringify(app)}, "report")).map(({ id, status }) => ({ id, status }))`,
    status: `await env.workflows.status(${JSON.stringify(run)})`,
    // A run that doesn't exist: refused as a run the agent may not read is.
    unknown: `await env.workflows.status("run-${"0".repeat(8)}")`,
  });

const denied = permissionErrors.create("permission.denied", {
  action: "read",
}).message;

const noSuchRun = workflowErrors.create("workflow.run_not_found").message;

describe("a chat's Apps and workflows", () => {
  it("show the agent its person's App and runs, never a run's output, and record every call", async () => {
    const { app, run, chat, grant } = await setUp((made) => [
      codeStep(everyCall(made)),
      says("Here they are."),
    ]);
    await grant();

    await chat.ask("What does the report workflow do?");

    const [result] = await codeResults(chat.stub, chat.chat.id);
    expect(result?.text).not.toContain("total-is-secret-42");
    const returned = z
      .unknown()
      .parse(JSON.parse(result?.text.replace("Returned:\n", "") ?? "null"));
    expect(returned).toMatchObject({
      apps: [app],
      files: true,
      versions: [1],
      exports: { version: 1, exports: { totals: totalsExport } },
      // Only the workflow the agent may read, summed up as ever.
      workflows: [{ workflow: "report", lastRun: run }],
      runs: [{ id: run, status: "completed" }],
      status: {
        id: run,
        app,
        workflow: "report",
        status: "completed",
        failure: null,
      },
      unknown: noSuchRun,
    });
    const calls = await callsOf(chat.agent.agentId, 8);
    expect(
      calls.map(({ detail }) => String(detail.method)).toSorted()
    ).toStrictEqual([
      "apps.exports",
      "apps.files",
      "apps.list",
      "apps.versions",
      "workflows.list",
      "workflows.runs",
      "workflows.status",
      "workflows.status",
    ]);
  });

  it("read nothing without a permission of the agent's own", async () => {
    const { chat } = await setUp((made) => [
      codeStep(everyCall(made)),
      says("Nothing."),
    ]);

    await chat.ask("What's there?");

    const [result] = await codeResults(chat.stub, chat.chat.id);
    expect(result?.text).toBe(
      `Returned:\n${JSON.stringify({
        apps: denied,
        files: denied,
        versions: denied,
        exports: denied,
        workflows: [],
        runs: denied,
        // An existing run it may not read and an unknown one: the same.
        status: noSuchRun,
        unknown: noSuchRun,
      })}`
    );
    // Every call recorded once: the refused ones with why.
    const calls = await callsOf(chat.agent.agentId, 8);
    expect(
      calls
        .map(({ detail }) => ({
          method: String(detail.method),
          outcome: detail.outcome,
          reason: detail.reason,
        }))
        .toSorted((one, other) => one.method.localeCompare(other.method))
    ).toStrictEqual([
      {
        method: "apps.exports",
        outcome: "refused",
        reason: "permission.denied",
      },
      { method: "apps.files", outcome: "refused", reason: "permission.denied" },
      { method: "apps.list", outcome: "refused", reason: "permission.denied" },
      {
        method: "apps.versions",
        outcome: "refused",
        reason: "permission.denied",
      },
      { method: "workflows.list", outcome: "ok", reason: null },
      {
        method: "workflows.runs",
        outcome: "refused",
        reason: "permission.denied",
      },
      {
        method: "workflows.status",
        outcome: "refused",
        reason: "workflow.run_not_found",
      },
      {
        method: "workflows.status",
        outcome: "refused",
        reason: "workflow.run_not_found",
      },
    ]);
  });

  it("show no App while the Apps collection is switched off", async () => {
    const { chat, grant } = await setUp(() => [
      codeStep(
        "export default async (env) => { try { return await env.apps.list(); } catch (error) { return error.message; } };"
      ),
      says("None."),
    ]);
    await grant();
    const on = z.record(z.string(), z.boolean()).parse(env.FEATURES);
    const { FEATURES: features } = env;
    try {
      env.FEATURES = { ...on, apps_collection: false };
      await chat.ask("Which Apps are there?");
    } finally {
      env.FEATURES = features;
    }

    await expect(codeResults(chat.stub, chat.chat.id)).resolves.toStrictEqual([
      { isError: false, text: `Returned:\n${denied}` },
    ]);
  });

  it("show where a run failed, but of a restricted App's only a platform code", async () => {
    const { app, chat, grant } = await setUp(({ app: made }) => {
      const runsOf = `export default async (env) => (await env.workflows.runs(${JSON.stringify(made)}, "report")).filter(({ failure }) => failure !== null).map(({ id, failure }) => ({ id, failure }));`;
      return [
        codeStep(runsOf),
        says("Before."),
        codeStep(runsOf),
        says("After."),
      ];
    });
    await grant();
    // Two failed runs: one with a code of the workflow's own, one of the
    // platform's, both at a step named from what the run read.
    const own = await failedRun(app, "acme.total_mismatch");
    const platform = await failedRun(app, "connect.action_failed");

    await chat.ask("Where did the report fail?");
    await appHost(env, appIdSchema.parse(app)).restrict();
    await chat.ask("And now?");

    const [before, after] = await codeResults(chat.stub, chat.chat.id);
    expect({
      before: failuresById(before?.text),
      after: failuresById(after?.text),
    }).toStrictEqual({
      before: {
        [own]: { step: secretStep, code: "acme.total_mismatch" },
        [platform]: { step: secretStep, code: "connect.action_failed" },
      },
      after: {
        [own]: { step: null, code: "workflow.run_failed" },
        [platform]: { step: null, code: "connect.action_failed" },
      },
    });
  });

  it("read no further than the person may, with every permission granted", async () => {
    // Someone with no role in the App.
    const { chat, grant } = await setUp(
      (made) => [codeStep(everyCall(made)), says("Nothing of theirs.")],
      "user"
    );
    await grant();

    await chat.ask("What's there?");

    const [result] = await codeResults(chat.stub, chat.chat.id);
    const notFound = appErrors.create("app.not_found").message;
    expect(result?.text).toBe(
      `Returned:\n${JSON.stringify({
        apps: [],
        files: notFound,
        versions: notFound,
        exports: notFound,
        workflows: [],
        runs: notFound,
        status: noSuchRun,
        unknown: noSuchRun,
      })}`
    );
  });
});
