import { appErrors } from "@grasp-os/shared/apps";
import type { AuditEvent } from "@grasp-os/shared/audit";
import { permissionErrors } from "@grasp-os/shared/permissions";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

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

/** A workflow that returns what it read. */
const reportFiles = workflowFiles(
  "report",
  `  return await step.do("total", { description: "Read the total" }, async () => "total-is-secret-42");`,
  { total: "total" }
);

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
        ({ actor, action }) =>
          action === "agent.call" &&
          actor.type === "agent" &&
          actor.agentId === agentId
      );
      expect(calls).toHaveLength(count);
      return calls;
    },
    { timeout: 10_000, interval: 50 }
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
    workflows: "(await env.workflows.list()).map(({ workflow }) => workflow)",
    runs: `(await env.workflows.runs(${JSON.stringify(app)}, "report")).map(({ id, status }) => ({ id, status }))`,
    status: `await env.workflows.status(${JSON.stringify(run)})`,
  });

const denied = permissionErrors.create("permission.denied", {
  action: "read",
}).message;

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
      workflows: ["report"],
      runs: [{ id: run, status: "completed" }],
      status: {
        id: run,
        app,
        workflow: "report",
        status: "completed",
        failure: null,
      },
    });
    const calls = await callsOf(chat.agent.agentId, 6);
    expect(
      calls.map(({ detail }) => String(detail.method)).toSorted()
    ).toStrictEqual([
      "apps.files",
      "apps.list",
      "apps.versions",
      "workflows.list",
      "workflows.runs",
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
        workflows: [],
        runs: denied,
        status: denied,
      })}`
    );
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
        workflows: [],
        runs: notFound,
        status: notFound,
      })}`
    );
  });
});
