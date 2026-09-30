import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { release } from "./apps.ts";
import {
  asking,
  asksOf,
  deadlinePassed,
  outputOf,
  reminding,
  server,
} from "./decisions.ts";
import type { Person } from "./decisions.ts";
import { mockIdp } from "./idp.ts";
import {
  endLiveRuns,
  finished,
  resumed,
  stepDone,
  stopped,
  woken,
} from "./runs.ts";
import { signedInApi } from "./sign-in.ts";

// Decisions past their deadline: nobody is asked once it has passed, and a
// wait resumed after it ends timed out at once, never approved. (Apart
// from decisions.test.ts: one file holds only so many runs' worth of
// workers.)

const idp = mockIdp();

const personApi = async (role: Role): Promise<Person> =>
  await signedInApi(idp, role);

describe("decisions past their deadline", { timeout: 60_000 }, () => {
  afterEach(endLiveRuns);

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
    await engine.sleep("gate", 86400000);
    const before = await engine.do("before", {}, async () => await engine.decisionRecipients(decision, true));
    return before.length;
  },
};
`,
      "workflows/late.workflow-tests.ts": `import { workflowTests } from "@grasp-os/sdk/testing";
import definition from "./late.ts";
export default workflowTests(definition, [{ name: "runs", expect: {} }]);
`,
    });
    const run = await builder.api.workflows.start(app, "late");
    const decision = await vi.waitFor(
      async () => {
        const row = await env.DB.prepare(
          "SELECT id FROM workflow_decisions WHERE run_id = ?"
        )
          .bind(run.id)
          .first<{ id: string }>();
        if (!row) {
          throw new Error("No decision yet");
        }
        return row.id;
      },
      { timeout: 10_000 }
    );
    await vi.waitFor(
      async () => {
        await expect(deadlinePassed(decision)).resolves.toBeTruthy();
      },
      { timeout: 10_000, interval: 100 }
    );
    await woken(run.id, "gate");
    await finished(run.id);
    const { output } = await builder.api.workflows.status(run.id);
    expect(output).toBe(0);
  });

  it("end a decision wait resumed past its deadline as timed out at once, without reminding anyone", async () => {
    const builder = await personApi("builder");
    const decider = await personApi("user");
    const { app, run, decision } = await asking(builder, {
      from: `person:${decider.userId}`,
      ...reminding,
    });
    await stepDone(run.id, "review#asked");
    // Paused while it waits for the answer, and resumed only once the
    // decision's deadline has passed: the new execution's wait would
    // otherwise run for the whole timeout the SDK worked out.
    await stopped(run.id);
    await vi.waitFor(
      async () => {
        await expect(deadlinePassed(decision)).resolves.toBeTruthy();
      },
      { timeout: 2 * reminding.timeout, interval: 100 }
    );
    await resumed(run.id);
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
