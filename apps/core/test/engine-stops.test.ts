import { appIdSchema } from "@grasp-os/shared/ids";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { callApp } from "../src/app.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { endLiveRuns, finished, liveStatus, resumed } from "./runs.ts";
import { openRpc, signedInWithRole } from "./sign-in.ts";
import { appWith, workflowFiles } from "./workflow-apps.ts";

// Someone pausing or cancelling a run stops its execution mid-step: the
// engine then throws out of every call the run makes. That is the engine
// stopping the run, which it resumes or ends itself, not the run failing.
// Core tells the two apart by where the engine has the run, never by an
// error's text, which workflow code writes as it likes. The local engine
// ends a terminated run's execution outright, so there only a pause
// reaches core's check; a cancel is covered all the same. The ways it can
// fail: a pause or cancel reported as a failure (a
// failure report, a `workflow.run.failed` event, a cancelled row turned
// failed); a failure whose message reads like a stop hidden as one.
// (Apart from workflows.test.ts: one file holds only so many runs' worth
// of workers.)

const idp = mockIdp();

/** A signed-in person's API, on a connection of their own. */
const personApi = async (role: Role) => {
  const person = await signedInWithRole(idp, role);
  const { core } = await openRpc(person.session);
  return { ...person, api: core.authenticate() };
};

/**
 * A workflow whose step `block` holds until the App's `gate` counter is
 * set (`open`), once it has counted itself in (`entered`).
 */
const blocking = workflowFiles(
  "blocking",
  `  return await step.do("block", { description: "Block" }, async () => {
    await env.APP.call("hit", "entered");
    while ((await env.APP.call("hits", "gate")) === 0) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return "done";
  });`,
  { block: "done" }
);

/** How often the App counted `name`. */
const hitsOf = async (app: string, userId: string, name: string) =>
  await callApp(
    env,
    appIdSchema.parse(app),
    { userId, mode: "interactive" },
    "hits",
    [name]
  );

/** Once the run's step `block` is under way. */
const entered = async (app: string, userId: string): Promise<void> => {
  await vi.waitFor(
    async () => {
      await expect(hitsOf(app, userId, "entered")).resolves.toBeGreaterThan(0);
    },
    { timeout: 10_000, interval: 100 }
  );
};

/** Lets every `block` step of the App end. */
const open = async (app: string, userId: string): Promise<void> => {
  await callApp(
    env,
    appIdSchema.parse(app),
    { userId, mode: "interactive" },
    "hit",
    ["gate"]
  );
};

/** What the audit log has of how the run went, as `action step`. */
const runActions = async (run: string): Promise<string[]> => {
  const events = await allEvents();
  return events
    .filter(({ target }) => target?.id === run)
    .map(({ action, detail }) =>
      [action, detail.step].filter((part) => part !== undefined).join(" ")
    )
    .toSorted();
};

describe("engine stops", { timeout: 60_000 }, () => {
  afterEach(endLiveRuns);

  it("report a run cancelled mid-step as cancelled, not failed", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, blocking);
    const run = await builder.api.workflows.start(app, "blocking");
    await entered(app, builder.userId);
    await builder.api.workflows.cancel(run.id);
    await open(app, builder.userId);
    await finished(run.id);
    const { status, failure } = await builder.api.workflows.status(run.id);
    const actions = await runActions(run.id);

    expect({
      live: await liveStatus(run.id),
      status,
      failure,
      audited: actions.filter((action) => !action.startsWith("workflow.step.")),
    }).toStrictEqual({
      live: "terminated",
      status: "cancelled",
      failure: undefined,
      audited: ["workflow.run.cancelled", "workflow.run.started"],
    });
  });

  it("report a run terminated mid-step, with its row still running, as stopped, not failed", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, blocking);
    const run = await builder.api.workflows.start(app, "blocking");
    await entered(app, builder.userId);
    // Terminated in the engine only, as an operator might: core's record
    // doesn't say cancelled, so only the engine's status tells.
    const instance = await env.WORKFLOWS.get(run.id);
    await instance.terminate();
    await open(app, builder.userId);
    await finished(run.id);
    const { status, failure } = await builder.api.workflows.status(run.id);
    const actions = await runActions(run.id);

    expect({
      live: await liveStatus(run.id),
      status,
      failure,
      failed: actions.includes("workflow.run.failed"),
    }).toStrictEqual({
      live: "terminated",
      status: "cancelled",
      failure: undefined,
      failed: false,
    });
  });

  it("go on after a pause mid-step, and complete", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, blocking);
    const run = await builder.api.workflows.start(app, "blocking");
    await entered(app, builder.userId);
    const instance = await env.WORKFLOWS.get(run.id);
    await instance.pause();
    await open(app, builder.userId);
    await vi.waitFor(
      async () => {
        await expect(liveStatus(run.id)).resolves.toBe("paused");
      },
      { timeout: 10_000, interval: 100 }
    );
    await resumed(run.id);
    await finished(run.id);
    const { status, output } = await builder.api.workflows.status(run.id);
    const actions = await runActions(run.id);

    expect({
      status,
      output,
      failed: actions.includes("workflow.run.failed"),
    }).toStrictEqual({ status: "completed", output: "done", failed: false });
  });

  it("report a failure whose message reads like the engine stopping as a failure", async () => {
    const builder = await personApi("builder");
    const stop = "Aborting engine: User called terminate";
    const app = await appWith(
      builder,
      workflowFiles(
        "lookalike",
        `  await step.do("inside", { description: "Inside", retries: { limit: 0 } }, async () => {
    throw new Error(${JSON.stringify(stop)});
  }).catch(() => null);
  // Timed out: the engine throws, while nobody stopped the run.
  await step.waitFor("never", { description: "Never", type: "never", timeout: "1 second" });
  if (input === "fail") {
    throw new Error(${JSON.stringify(stop)});
  }`,
        { inside: null }
      )
    );
    const run = await builder.api.workflows.start(app, "lookalike", "fail");
    // Not `finished`: the local engine takes a run's error of exactly that
    // text for its own stop, and leaves the instance running.
    const audited = await vi.waitFor(
      async () => {
        const actions = await runActions(run.id);
        expect(actions).toContain("workflow.run.failed");
        return actions;
      },
      { timeout: 10_000, interval: 100 }
    );
    const { status, failure } = await builder.api.workflows.status(run.id);

    expect({
      status,
      message: failure?.error.message,
      audited,
    }).toStrictEqual({
      status: "failed",
      message: stop,
      audited: [
        "workflow.run.failed",
        "workflow.run.started",
        "workflow.step.completed $params",
        "workflow.step.failed inside",
      ],
    });
  });
});
