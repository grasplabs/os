import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { release } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import {
  approvalApp,
  asking,
  asksOf,
  deadlinePassed,
  linkOf,
  outputOf,
  reminding,
  server,
  waitingFor,
  week,
} from "./decisions.ts";
import type { Ask, Person } from "./decisions.ts";
import { mockIdp } from "./idp.ts";
import { endLiveRuns, finished, resumed, stepDone, stopped } from "./runs.ts";
import { signedInApi } from "./sign-in.ts";

// Decisions while their kill switches are off: a run waits, before a step
// that opens or asks a decision, or any wait while workflows are off, and
// goes on once they are back on. A wait never ends in an approval, and
// nobody is asked once a decision's deadline has passed. (Apart from
// decisions.test.ts: one file holds only so many runs' worth of workers.)

const idp = mockIdp();

const personApi = async (role: Role): Promise<Person> =>
  await signedInApi(idp, role);

describe("decisions while switched off", { timeout: 60_000 }, () => {
  afterEach(endLiveRuns);

  it("keep a waiting run going while decisions are switched off, remind once they are back on, and time out, never approve", async () => {
    const builder = await personApi("builder");
    const decider = await personApi("user");
    const { app, run, decision } = await asking(builder, {
      from: `person:${decider.userId}`,
      ...reminding,
    });
    // Switched off once it waits for the answer, past the time to remind.
    await stepDone(run.id, "review#asked");
    const { FEATURES: features } = env;
    let whileOff: { status: string } | null;
    let askedWhileOff: Ask[];
    try {
      env.FEATURES = {
        ...z.record(z.string(), z.boolean()).parse(features),
        decisions: false,
      };
      // It waits to remind: asking is a decision step.
      await waitingFor(run.id, "decisions");
      whileOff = await env.DB.prepare(
        "SELECT status FROM workflow_decisions WHERE id = ?"
      )
        .bind(decision)
        .first<{ status: string }>();
      askedWhileOff = await asksOf(app);
    } finally {
      env.FEATURES = features;
    }
    // Back on: it reminds, and ends as the timeout it is.
    const output = await outputOf(builder, run.id);
    const asked = await asksOf(app, 2);

    expect({
      whileOff: whileOff?.status,
      remindedWhileOff: askedWhileOff.map(({ reminder }) => reminder),
      output,
      reminded: asked.map(({ reminder }) => reminder),
    }).toStrictEqual({
      whileOff: "open",
      remindedWhileOff: [false],
      output: { timedOut: true },
      reminded: [false, true],
    });
  });

  it("ask nobody once a decision's deadline has passed", async () => {
    const builder = await personApi("builder");
    await personApi("admin");
    // Written against the engine: it opens a decision, stops until told to
    // go on, then asks who may answer, as a reminder late in a run does.
    const { id: app } = await builder.api.apps.create({ name: "Late" });
    await release(builder, app, {
      "app/server.ts": server,
      "workflows/late.ts": `export default {
  metadata: { id: "late", params: [] },
  run: async (engine) => {
    const { decision } = await engine.do("open", {}, async () =>
      await engine.openDecision({ step: "open", from: "role:admin", description: "Late", timeout: 500 })
    );
    await engine.waitForEvent("gate", { type: "gate", timeout: 86400000 });
    const before = await engine.do("before", {}, async () => await engine.decisionRecipients(decision, true));
    return before.length;
  },
};
`,
      "workflows/late.workflow-tests.ts": `import { workflowTests } from "@grasp-os/sdk/testing";
import definition from "./late.ts";
export default workflowTests(definition, [{ name: "runs", events: [{ type: "gate", payload: null }], expect: {} }]);
`,
    });
    const run = await builder.api.workflows.start(app, "late");
    const decision = await vi.waitFor(async () => {
      const row = await env.DB.prepare(
        "SELECT id FROM workflow_decisions WHERE run_id = ?"
      )
        .bind(run.id)
        .first<{ id: string }>();
      if (!row) {
        throw new Error("No decision yet");
      }
      return row.id;
    });
    await vi.waitFor(
      async () => {
        await expect(deadlinePassed(decision)).resolves.toBeTruthy();
      },
      { timeout: 10_000, interval: 100 }
    );
    await finished(run.id, { type: "gate", payload: null });
    const { output } = await builder.api.workflows.status(run.id);
    expect(output).toBe(0);
  });

  it("wait to open a decision while decisions are switched off, and go on once they are back on", async () => {
    const builder = await personApi("builder");
    const decider = await personApi("user");
    const app = await approvalApp(builder);
    const { FEATURES: features } = env;
    let run: Awaited<ReturnType<typeof builder.api.workflows.start>>;
    let openedWhileOff: { count: number } | null;
    try {
      env.FEATURES = {
        ...z.record(z.string(), z.boolean()).parse(features),
        decisions: false,
      };
      run = await builder.api.workflows.start(app, "approval", {
        from: `person:${decider.userId}`,
        timeout: week,
      });
      await waitingFor(run.id, "decisions");
      openedWhileOff = await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM workflow_decisions WHERE run_id = ?"
      )
        .bind(run.id)
        .first<{ count: number }>();
    } finally {
      env.FEATURES = features;
    }
    // Back on: it opens it, asks, and takes the answer.
    const [ask] = await asksOf(app);
    const { decision } = linkOf(ask, decider.userId);
    await decider.api.decisions.answer(decision, { approved: true });
    const output = await outputOf(builder, run.id);
    const events = await allEvents();
    expect({
      openedWhileOff: openedWhileOff?.count,
      output,
      failed: events.some(
        ({ action, target }) =>
          target?.id === run.id && action.endsWith(".failed")
      ),
    }).toStrictEqual({
      openedWhileOff: 0,
      output: {
        timedOut: false,
        approved: true,
        by: decider.userId,
        payload: null,
      },
      failed: false,
    });
  });

  it("record each switched-off feature a run waits on before a decision, once each", async () => {
    const builder = await personApi("builder");
    const decider = await personApi("user");
    const app = await approvalApp(builder);
    const on = z.record(z.string(), z.boolean()).parse(env.FEATURES);
    const { FEATURES: features } = env;
    let run: Awaited<ReturnType<typeof builder.api.workflows.start>>;
    try {
      env.FEATURES = { ...on, decisions: false };
      run = await builder.api.workflows.start(app, "approval", {
        from: `person:${decider.userId}`,
        timeout: week,
      });
      // Held before it opens the decision, for decisions.
      await waitingFor(run.id, "decisions");
      // Workflows off too: it waits on them now, recorded as well.
      env.FEATURES = { ...on, decisions: false, workflows: false };
      await waitingFor(run.id, "workflows");
      // Decisions back on, workflows still off: nothing new to record.
      env.FEATURES = { ...on, workflows: false };
    } finally {
      env.FEATURES = features;
    }
    const [ask] = await asksOf(app);
    const { decision } = linkOf(ask, decider.userId);
    await decider.api.decisions.answer(decision, { approved: true });
    const output = await outputOf(builder, run.id);
    const events = await allEvents();
    expect({
      output,
      waited: events
        .filter(
          ({ action, target }) =>
            action === "workflow.run.waiting" && target?.id === run.id
        )
        .map(({ detail }) => String(detail.feature))
        .toSorted(),
    }).toStrictEqual({
      output: {
        timedOut: false,
        approved: true,
        by: decider.userId,
        payload: null,
      },
      waited: ["decisions", "workflows"],
    });
  });

  it("end a decision wait held past its deadline as timed out at once, without reminding anyone", async () => {
    const builder = await personApi("builder");
    const decider = await personApi("user");
    const { app, run, decision } = await asking(builder, {
      from: `person:${decider.userId}`,
      ...reminding,
    });
    await stepDone(run.id, "review#asked");
    // Stopped while it waits for the answer, and resumed with workflows
    // off: the new execution is held before that wait begins again, past
    // the decision's deadline.
    await stopped(run.id);
    const { FEATURES: features } = env;
    try {
      env.FEATURES = {
        ...z.record(z.string(), z.boolean()).parse(features),
        workflows: false,
      };
      await resumed(run.id);
      await waitingFor(run.id, "workflows");
      await vi.waitFor(
        async () => {
          await expect(deadlinePassed(decision)).resolves.toBeTruthy();
        },
        { timeout: 2 * reminding.timeout, interval: 100 }
      );
    } finally {
      env.FEATURES = features;
    }
    const output = await outputOf(builder, run.id);
    const closed = await env.DB.prepare(
      "SELECT status FROM workflow_decisions WHERE id = ?"
    )
      .bind(decision)
      .first<{ status: string }>();
    const asked = await asksOf(app);
    expect({
      output,
      decision: closed?.status,
      reminded: asked.map(({ reminder }) => reminder),
    }).toStrictEqual({
      output: { timedOut: true },
      decision: "timed_out",
      reminded: [false],
    });
  });
});
