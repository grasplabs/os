import type { AiBinding } from "@earendil-works/pi-ai/api/cloudflare-ai-binding";
import { appIdSchema, workflowIdSchema } from "@grasp-os/shared/ids";
import type { PermissionRequest } from "@grasp-os/shared/permissions";
import type { Role } from "@grasp-os/shared/roles";
import { workflowErrors } from "@grasp-os/shared/workflows";
import { introspectWorkflow, runInDurableObject } from "cloudflare:test";
import type { WorkflowInstanceIntrospector } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { callApp } from "../src/app.ts";
import { appHost } from "../src/durable-objects.ts";
import { ownerEventType } from "../src/workflows/dispatcher.ts";
import { startRun } from "../src/workflows/runs.ts";
import { fakeGateway } from "./ai-gateway.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { openRpc, signedInWithRole } from "./sign-in.ts";

// Workflows are code the agent writes, run for real: committed to an App,
// tested when their version is made current, and run on Cloudflare
// Workflows by the dispatcher, each in an isolate of its own. Workflows'
// test helpers skip sleeps and inject events; the model provider behind AI
// Gateway is the one outside system faked here.

const idp = mockIdp();

/** A signed-in person's API, on a connection of their own. */
const personApi = async (role: Role) => {
  const person = await signedInWithRole(idp, role);
  const { core } = await openRpc(person.session);
  return { ...person, api: core.authenticate() };
};
type Person = Awaited<ReturnType<typeof personApi>>;

/**
 * The sample App's server code: purchase orders, a ledger that books each
 * entry once per idempotency key, and counters that show how often a step
 * really ran.
 */
const server = `import { DurableObject } from "cloudflare:workers";

type Caller = { userId: string };

export class App extends DurableObject {
  hit(_caller: Caller, name: string): number {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS hits (name TEXT PRIMARY KEY, count INTEGER NOT NULL)");
    this.ctx.storage.sql.exec("INSERT INTO hits VALUES (?, 1) ON CONFLICT (name) DO UPDATE SET count = count + 1", name);
    return this.hits(_caller, name);
  }

  hits(_caller: Caller, name: string): number {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS hits (name TEXT PRIMARY KEY, count INTEGER NOT NULL)");
    const [row] = this.ctx.storage.sql.exec("SELECT count FROM hits WHERE name = ?", name).toArray();
    return Number(row?.count ?? 0);
  }

  purchaseOrder(_caller: Caller, number: string): { amount: number } | null {
    return number === "PO-1" ? { amount: 800_000 } : null;
  }

  book(caller: Caller, entry: { invoice: string; total: number }, key: string): string {
    this.hit(caller, "book:" + key);
    return "ledger-" + entry.invoice + "-for-" + caller.userId;
  }
}
`;

const extractionModel = "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/**
 * The sample invoice workflow, as an App ships it: it matches the purchase
 * order, reads the total with a model, asks a reviewer above a threshold
 * and books the invoice, through its App's server code.
 */
const invoiceWorkflow = `import { model, money, person, workflow, z } from "@grasp-os/sdk/workflow";

export default workflow(
  "invoice-approval",
  {
    input: z.object({ number: z.string(), purchaseOrder: z.string(), text: z.string() }),
    params: {
      threshold: money({ label: "Review invoices above", currency: "EUR", default: 500_000, sensitive: true }),
      reviewer: person({ label: "Reviewer", default: "finance-team" }),
      extractionModel: model({ label: "Extraction model", default: "${extractionModel}", sensitive: true }),
    },
  },
  async (step, { input, params, env }) => {
    const order = await step.do(
      "match-po",
      { description: "Find the purchase order the invoice refers to", locked: true, input: input.purchaseOrder },
      async ({ input: number }) => await env.APP.call("purchaseOrder", number)
    );
    if (!order) {
      return { status: "unmatched" };
    }
    const extracted = await step.llm("extract", {
      description: "Read the total and currency from the invoice",
      model: params.extractionModel,
      instructions: "Read the invoice's total in cents and its ISO 4217 currency.",
      input: input.text,
      schema: z.object({ total: z.int(), currency: z.string() }),
      retries: { limit: 0 },
    });
    if (extracted.total > params.threshold) {
      const decision = await step.decision("review", {
        description: "Ask the reviewer to approve invoices above the limit",
        from: params.reviewer,
        ask: async () => {},
        timeout: "7 days",
      });
      if (decision.outcome !== "approved") {
        return { status: decision.outcome };
      }
    }
    const entry = await step.do(
      "book",
      {
        description: "Book the invoice in the ledger",
        sideEffect: true,
        locked: true,
        input: { invoice: input.number, total: extracted.total },
      },
      async ({ idempotencyKey, input: booking }) => await env.APP.call("book", booking, idempotencyKey)
    );
    return { status: "booked", entry };
  }
);
`;

const invoiceTests = `import { workflowTests } from "@grasp-os/sdk/testing";

import invoice from "./invoice-approval.ts";

const input = { number: "INV-7", purchaseOrder: "PO-1", text: "Total 8,000 EUR" };

export default workflowTests(invoice, [
  {
    name: "books an invoice below the threshold without asking anyone",
    input,
    mocks: { "match-po": { amount: 800_000 }, extract: { total: 400_000, currency: "EUR" }, book: "ledger-7" },
    expect: { output: { status: "booked", entry: "ledger-7" } },
  },
  {
    name: "doesn't book an invoice the reviewer rejects",
    input,
    mocks: { "match-po": { amount: 800_000 }, extract: { total: 800_000, currency: "EUR" } },
    decisions: { review: { approved: false, by: "anna" } },
    expect: { output: { status: "rejected" }, sideEffects: [{ name: "review#ask", input: { from: "finance-team", reminder: false } }] },
  },
]);
`;

/**
 * A workflow of the given steps' code, run as `id`, with a test that
 * mocks every step it names, so any workflow passes activation.
 */
const workflowFiles = (
  id: string,
  body: string,
  mocks: Record<string, unknown> = {}
): Record<string, string> => ({
  [`workflows/${id}.ts`]: `import { workflow, z } from "@grasp-os/sdk/workflow";

export default workflow("${id}", { params: {}, input: z.unknown() }, async (step, { env, state, input }) => {
${body}
});
`,
  [`workflows/${id}.workflow-tests.ts`]: `import { workflowTests } from "@grasp-os/sdk/testing";

import definition from "./${id}.ts";

export default workflowTests(definition, [
  { name: "runs", mocks: ${JSON.stringify(mocks)}, events: [{ type: "go", payload: null }], expect: {} },
]);
`,
});

/** Commits `files` as the App's next version and makes it current. */
const release = async (
  builder: Person,
  app: string,
  files: Record<string, string | null>
): Promise<number> => {
  await builder.api.apps.files.write(app, files);
  const { version } = await builder.api.apps.files.commit(app, "Release");
  await builder.api.apps.versions.setCurrent(app, version);
  return version;
};

/** A new App with the sample server and `files`. */
const appWith = async (
  builder: Person,
  files: Record<string, string>
): Promise<string> => {
  const { id } = await builder.api.apps.create({ name: "Invoices" });
  await release(builder, id, { "app/server.ts": server, ...files });
  return id;
};

/** Outlook, as a connection the App may be given. */
const outlook = (app: string): PermissionRequest => ({
  subject: { type: "app", appId: app },
  object: { type: "connection", connectionId: "connection-outlook" },
  actions: ["mail.list"],
  binding: "OUTLOOK",
});

/**
 * A step that calls Outlook: connections don't exist in connect yet, so
 * `reached` is a call that passed every check on its way.
 */
const mailStep = (
  name: string
) => `  await step.do("${name}", { description: "Read mail" }, async () => {
    try {
      await env.OUTLOOK.call("mail.list", {});
      return "sent";
    } catch (error) {
      if (error.code === "connect.connection_not_found") {
        return "reached";
      }
      throw error;
    }
  });`;

/** The run the introspector saw start, once it has. */
const onlyRun = async (
  introspector: Awaited<ReturnType<typeof introspectWorkflow>>
): Promise<WorkflowInstanceIntrospector> =>
  await vi.waitFor(async () => {
    const [instance] = await introspector.get();
    if (!instance) {
      throw new Error("No run yet");
    }
    return instance;
  });

/**
 * Stops a run's execution, as a crash or a deploy does; resuming it runs
 * the workflow again from its start, loaded anew, finished steps replayed.
 * Workflows lets a run stop between steps, here while it waits.
 */
const stopped = async (run: string): Promise<void> => {
  const instance = await env.WORKFLOWS.get(run);
  await vi.waitFor(
    async () => {
      await instance.pause();
      await expect(instance.status()).resolves.toMatchObject({
        status: "paused",
      });
    },
    { timeout: 10_000, interval: 100 }
  );
};

/** Resumes a run `stopped` stopped. */
const resumed = async (run: string): Promise<void> => {
  const instance = await env.WORKFLOWS.get(run);
  await instance.resume();
};

/** Once the run's step `step` has completed, as the audit log has it. */
const stepDone = async (run: string, step: string): Promise<void> => {
  await vi.waitFor(
    async () => {
      const events = await allEvents();
      expect(
        events.some(
          ({ action, target, detail }) =>
            action === "workflow.step.completed" &&
            target?.id === run &&
            detail.step === step
        )
      ).toBeTruthy();
    },
    { timeout: 10_000, interval: 100 }
  );
};

/** Sends `event` until the run ends: it may not wait for it yet. */
const finished = async (
  run: string,
  event?: { type: string; payload: unknown }
): Promise<void> => {
  const instance = await env.WORKFLOWS.get(run);
  await vi.waitFor(
    async () => {
      if (event) {
        await instance.sendEvent(event);
      }
      const { status } = await instance.status();
      expect(["complete", "errored", "terminated"]).toContain(status);
    },
    { timeout: 20_000, interval: 200 }
  );
};

/** Where the engine has a run now. */
const liveStatus = async (run: string): Promise<string> => {
  const instance = await env.WORKFLOWS.get(run);
  const { status } = await instance.status();
  return status;
};

/** Where core's record has a run now. */
const rowStatus = async (run: string): Promise<string | undefined> => {
  const row = await env.DB.prepare(
    "SELECT status FROM workflow_runs WHERE id = ?"
  )
    .bind(run)
    .first<{ status: string }>();
  return row?.status;
};

/** How often the App counted `name` (its server's `hit`). */
const hitsOf = async (app: string, userId: string, name: string) =>
  await callApp(
    env,
    appIdSchema.parse(app),
    { userId, mode: "interactive" },
    "hits",
    [name]
  );

/** Removes a person from the organization; returns how to bring them back. */
const leave = async (userId: string): Promise<() => Promise<void>> => {
  const membership = await env.DB.prepare(
    "SELECT * FROM members WHERE user_id = ?"
  )
    .bind(userId)
    .first<Record<string, string | number>>();
  await env.DB.prepare("DELETE FROM members WHERE user_id = ?")
    .bind(userId)
    .run();
  return async () => {
    await env.DB.prepare(
      "INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)"
    )
      .bind(
        membership?.id,
        membership?.organization_id,
        membership?.user_id,
        membership?.role,
        membership?.created_at
      )
      .run();
  };
};

/** A run a trigger started, which acts for the App's owner. */
const triggered = async (app: string, workflow: string) =>
  await startRun(env, {
    app: appIdSchema.parse(app),
    workflow: workflowIdSchema.parse(workflow),
    input: undefined,
    startedBy: null,
    actor: { type: "system" },
  });

const refusal = async (promise: Promise<unknown>): Promise<unknown> =>
  await promise.then(
    () => "ok",
    (error: unknown) => error
  );

describe("workflow runs", { timeout: 60_000 }, () => {
  it("run the sample invoice workflow end to end, and audit it", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, {
      "workflows/invoice-approval.ts": invoiceWorkflow,
      "workflows/invoice-approval.workflow-tests.ts": invoiceTests,
    });
    await using introspector = await introspectWorkflow(env.WORKFLOWS);
    await introspector.modifyAll(async (modifier) => {
      await modifier.mockStepResult(
        { name: "extract" },
        { total: 800_000, currency: "EUR" }
      );
      await modifier.mockEvent({
        type: "decision:review",
        payload: { approved: true, by: "anna" },
      });
    });
    const invoice = {
      number: "INV-7",
      purchaseOrder: "PO-1",
      text: "Total 8,000 EUR",
    };
    const run = await builder.api.workflows.start(
      app,
      "invoice-approval",
      invoice
    );
    const instance = await onlyRun(introspector);
    await instance.waitForStatus("complete");
    const audited = await vi.waitFor(async () => {
      const events = await allEvents();
      const ofRun = events.filter(({ target }) => target?.id === run.id);
      expect(ofRun.map(({ action }) => action)).toContain(
        "workflow.run.completed"
      );
      return ofRun;
    });

    expect({
      output: await instance.getOutput(),
      matched: await instance.waitForStepResult({ name: "match-po" }),
      status: await builder.api.workflows.status(run.id),
      runs: await builder.api.workflows.list(app),
      audited: audited
        .map(({ action, detail }) => `${action} ${detail.step ?? ""}`.trim())
        .toSorted(),
      auditedFor: new Set(
        audited.map(({ detail }) => `${detail.app}/${detail.version}`)
      ),
    }).toMatchObject({
      output: {
        status: "booked",
        entry: `ledger-INV-7-for-${builder.userId}`,
      },
      matched: { amount: 800_000 },
      status: { status: "completed", version: 1, workflow: "invoice-approval" },
      runs: [{ id: run.id, status: "completed" }],
      // The extraction is mocked, so it ran no step of its own.
      audited: [
        "workflow.run.completed",
        "workflow.run.started",
        "workflow.step.completed $params",
        "workflow.step.completed book",
        "workflow.step.completed match-po",
        "workflow.step.completed review",
        "workflow.step.completed review#ask",
        "workflow.step.completed review#asked",
      ],
      auditedFor: new Set([`${app}/1`]),
    });
  });

  it("keep the version they started on after a new one is current", async () => {
    const builder = await personApi("builder");
    const versioned = (label: number) =>
      workflowFiles(
        "pinned",
        `  await step.waitFor("go", { description: "Wait", type: "go", timeout: "1 day" });
  return { version: ${label} };`
      );
    const app = await appWith(builder, versioned(1));
    const first = await builder.api.workflows.start(app, "pinned");
    await stopped(first.id);

    await release(builder, app, versioned(2));
    const second = await builder.api.workflows.start(app, "pinned");
    // The first run loads again only now, with version 2 current.
    await resumed(first.id);
    const outputs = await Promise.all(
      [first, second].map(async ({ id }) => {
        await finished(id, { type: "go", payload: null });
        return await builder.api.workflows.status(id);
      })
    );
    expect(outputs).toMatchObject([
      { version: 1, status: "completed", output: { version: 1 } },
      { version: 2, status: "completed", output: { version: 2 } },
    ]);
  });

  it("fail the next step with a permission error once a permission is revoked mid-run", async () => {
    const admin = await personApi("admin");
    const app = await appWith(
      admin,
      workflowFiles(
        "mailer",
        `${mailStep("before")}
  await step.waitFor("go", { description: "Wait", type: "go", timeout: "1 day" });
${mailStep("after")}`,
        { before: "reached", after: "reached" }
      )
    );
    const { id: permission } = await admin.api.permissions.request(
      outlook(app)
    );
    await admin.api.permissions.grant(permission);
    const run = await admin.api.workflows.start(app, "mailer");
    await stepDone(run.id, "before");
    await stopped(run.id);

    await admin.api.permissions.revoke(permission);
    await resumed(run.id);
    await finished(run.id, { type: "go", payload: null });
    const { status, error } = await admin.api.workflows.status(run.id);
    const events = await allEvents();
    const steps = events.flatMap(({ action, target, detail }) =>
      action.startsWith("workflow.step.") && target?.id === run.id
        ? [{ action, step: detail.step, errorCode: detail.errorCode }]
        : []
    );
    expect({
      status,
      clearError: error?.message.includes(
        "This workflow has no permission named OUTLOOK: it was never granted, or it was revoked."
      ),
      steps,
    }).toMatchObject({
      status: "failed",
      clearError: true,
      steps: [
        { action: "workflow.step.completed", step: "$params" },
        { action: "workflow.step.completed", step: "before" },
        {
          action: "workflow.step.failed",
          step: "after",
          errorCode: "permission.denied",
        },
      ],
    });
  });

  it("check a model's answer against the step's schema, formats included", async () => {
    const builder = await personApi("builder");
    const app = await appWith(
      builder,
      workflowFiles(
        "reader",
        `  return await step.llm("extract", {
    description: "Read the total",
    model: "${extractionModel}",
    instructions: "Read the total in cents.",
    input: "Total 12.34 EUR",
    schema: z.object({ total: z.int(), from: z.email(), on: z.iso.date() }),
    retries: { limit: 0 },
  });`,
        { extract: { total: 1234, from: "anna@example.com", on: "2026-09-26" } }
      )
    );
    const runWithAnswers = async (...texts: string[]) => {
      const gateway = fakeGateway(
        ...texts.map((text) => ({ text, inputTokens: 10, outputTokens: 5 }))
      );
      // The binding the gateway sends through; the provider answers fake.
      const ai: AiBinding = env.AI;
      const answering = vi
        .spyOn(ai, "fetch")
        .mockImplementation(gateway.binding.fetch);
      try {
        const run = await builder.api.workflows.start(app, "reader");
        await finished(run.id);
        return await builder.api.workflows.status(run.id);
      } finally {
        answering.mockRestore();
      }
    };
    // The gateway asks once more when an answer doesn't fit.
    const unfit = await runWithAnswers('{"total": "lots"}', '{"total": 12.34}');
    const fit = await runWithAnswers(
      '{"total": 1234, "from": "anna@example.com", "on": "2026-09-26"}'
    );
    expect({ unfit, fit }).toMatchObject({
      unfit: {
        status: "failed",
        error: {
          message:
            "The model's answer didn't match the expected shape, also when asked again.",
        },
      },
      fit: {
        status: "completed",
        output: { total: 1234, from: "anna@example.com", on: "2026-09-26" },
      },
    });
  });

  it("go on after a crash without running finished steps again, and retry a step killed mid-way", async () => {
    const builder = await personApi("builder");
    const app = await appWith(
      builder,
      workflowFiles(
        "durable",
        `  await step.do("before", { description: "Before" }, async () => await env.APP.call("hit", "before"));
  await step.waitFor("go", { description: "Wait", type: "go", timeout: "1 day" });
  const attempt = await step.do(
    "work",
    { description: "Work", sideEffect: true, input: null, timeout: "1 second", retries: { limit: 1, delay: 10 } },
    async ({ idempotencyKey }) => {
      const attempt = await env.APP.call("hit", "work:" + idempotencyKey);
      if (attempt === 1) {
        // Hangs until the engine gives up on this attempt.
        await new Promise(() => {});
      }
      return attempt;
    }
  );
  await step.do("after", { description: "After" }, async () => await env.APP.call("hit", "after"));
  return attempt;`,
        { before: 1, work: 2, after: 1 }
      )
    );
    const run = await builder.api.workflows.start(app, "durable");
    await stepDone(run.id, "before");
    await stopped(run.id);
    await resumed(run.id);
    await finished(run.id, { type: "go", payload: null });

    const hits = async (name: string) =>
      await callApp(
        env,
        appIdSchema.parse(app),
        { userId: builder.userId, mode: "interactive" },
        "hits",
        [name]
      );
    expect({
      status: await builder.api.workflows.status(run.id),
      before: await hits("before"),
      work: await hits(`work:${run.id}:work`),
      after: await hits("after"),
    }).toMatchObject({
      status: { status: "completed", output: 2 },
      before: 1,
      work: 2,
      after: 1,
    });
  });

  it("pause a triggered run while its App's owner is gone, at its start or mid-way, and go on with an owner", async () => {
    const owner = await personApi("builder");
    const app = await appWith(
      owner,
      workflowFiles(
        "triggered",
        `  await step.do("first", { description: "First" }, async () => await env.APP.call("hit", "first"));
  await step.waitFor("go", { description: "Wait", type: "go", timeout: "1 day" });
  return await step.do("book", { description: "Book" }, async () => await env.APP.call("book", { invoice: "INV-9", total: 1 }, "key"));`,
        { first: 1, book: "booked" }
      )
    );
    const pausedUntilRejoined = async (
      run: string,
      rejoin: () => Promise<void>
    ) => {
      await vi.waitFor(
        async () => {
          await expect(rowStatus(run)).resolves.toBe("paused");
        },
        { timeout: 10_000, interval: 100 }
      );
      await rejoin();
      const waiting = await env.WORKFLOWS.get(run);
      await waiting.sendEvent({ type: ownerEventType, payload: null });
    };

    // Gone before the run starts.
    const rejoinBefore = await leave(owner.userId);
    const atStart = await triggered(app, "triggered");
    await pausedUntilRejoined(atStart.id, rejoinBefore);
    await finished(atStart.id, { type: "go", payload: null });

    // Gone while the run waits between two steps.
    const midWay = await triggered(app, "triggered");
    await stepDone(midWay.id, "first");
    const rejoinMidWay = await leave(owner.userId);
    const instance = await env.WORKFLOWS.get(midWay.id);
    await instance.sendEvent({ type: "go", payload: null });
    await pausedUntilRejoined(midWay.id, rejoinMidWay);
    await finished(midWay.id);

    const outcomes = await Promise.all(
      [atStart, midWay].map(async ({ id }) => ({
        live: await liveStatus(id),
        row: await rowStatus(id),
      }))
    );
    expect(outcomes).toStrictEqual([
      { live: "complete", row: "completed" },
      { live: "complete", row: "completed" },
    ]);
  });

  it("fail a person's run once they have left, at its next load", async () => {
    const admin = await personApi("admin");
    const leaver = await personApi("builder");
    const app = await appWith(
      leaver,
      workflowFiles(
        "waiting",
        `  await step.waitFor("go", { description: "Wait", type: "go", timeout: "1 day" });
  return "went on";`
      )
    );
    const run = await leaver.api.workflows.start(app, "waiting");
    await stopped(run.id);
    await env.DB.prepare("DELETE FROM members WHERE user_id = ?")
      .bind(leaver.userId)
      .run();
    await resumed(run.id);
    await finished(run.id, { type: "go", payload: null });
    const { status, error } = await admin.api.workflows.status(run.id);
    expect({
      status,
      personGone: error?.message.includes(
        "The person this acts for no longer has access to this deployment."
      ),
    }).toStrictEqual({ status: "failed", personGone: true });
  });

  it("run with only their App's permissions, no network, and their App's restricted mode", async () => {
    const admin = await personApi("admin");
    const app = await appWith(
      admin,
      workflowFiles(
        "probe",
        `  return await step.do("probe", { description: "Probe" }, async () => {
    let fetched;
    try {
      await fetch("https://example.com/");
      fetched = "fetched";
    } catch (error) {
      fetched = String(error);
    }
    let mail;
    try {
      await env.OUTLOOK.call("mail.list", {});
    } catch (error) {
      mail = error.code;
    }
    return { env: Object.keys(env).toSorted(), fetched, mail };
  });`,
        { probe: null }
      )
    );
    const { id: permission } = await admin.api.permissions.request(
      outlook(app)
    );
    await admin.api.permissions.grant(permission);
    await appHost(env, appIdSchema.parse(app)).restrict();
    const run = await admin.api.workflows.start(app, "probe");
    await finished(run.id);
    const { status, output } = await admin.api.workflows.status(run.id);
    expect({
      status,
      output,
      offline: JSON.stringify(output).includes(
        "not permitted to access the internet"
      ),
    }).toMatchObject({
      status: "completed",
      output: { env: ["APP", "OUTLOOK"], mail: "permission.restricted" },
      offline: true,
    });
  });

  it("sleep durably, time out waiting, and share their workflow's state between runs", async () => {
    const builder = await personApi("builder");
    const app = await appWith(
      builder,
      workflowFiles(
        "counter",
        `  await step.sleep("nap", { description: "Wait a day", duration: "1 day" });
  const seen = (await state.get("runs")) ?? 0;
  await state.set("runs", seen + 1);
  const late = await step.waitFor("late", { description: "Wait a moment", type: "never", timeout: 500 });
  return { seen, late: late.received };`
      )
    );
    await using introspector = await introspectWorkflow(env.WORKFLOWS);
    await introspector.modifyAll(async (modifier) => {
      await modifier.disableSleeps();
    });
    const outputs: unknown[] = [];
    for (let count = 0; count < 2; count += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one run after another
      const run = await builder.api.workflows.start(app, "counter");
      // oxlint-disable-next-line no-await-in-loop -- one run after another
      await finished(run.id);
      // oxlint-disable-next-line no-await-in-loop -- one run after another
      const { output } = await builder.api.workflows.status(run.id);
      outputs.push(output);
    }
    // What guards the ended runs' writes against a replay goes with them.
    const guards = await runInDurableObject(
      appHost(env, appIdSchema.parse(app)),
      async (_app, state) => {
        const writes = await state.storage.list({ prefix: "workflow-write:" });
        return writes.size;
      }
    );
    expect({ outputs, guards }).toStrictEqual({
      outputs: [
        { seen: 0, late: false },
        { seen: 1, late: false },
      ],
      guards: 0,
    });
  });

  it("can't be made current while their tests fail or are missing", async () => {
    const builder = await personApi("builder");
    const { id: app } = await builder.api.apps.create({ name: "Untested" });
    const failing = workflowFiles("failing", `  return 1;`);
    failing["workflows/failing.workflow-tests.ts"] =
      `import { workflowTests } from "@grasp-os/sdk/testing";
import definition from "./failing.ts";
export default workflowTests(definition, [{ name: "returns two", expect: { output: 2 } }]);
`;
    const setCurrent = async (files: Record<string, string | null>) => {
      await builder.api.apps.files.write(app, files);
      const { version } = await builder.api.apps.files.commit(app, "Try");
      return await refusal(builder.api.apps.versions.setCurrent(app, version));
    };
    const outcomes = [
      await setCurrent({ "app/server.ts": server, ...failing }),
      await setCurrent({ "workflows/failing.workflow-tests.ts": null }),
    ];
    // Also while workflows are switched off: switching them on runs
    // nothing untested.
    const { FEATURES: features } = env;
    try {
      env.FEATURES = { apps: true };
      outcomes.push(await setCurrent({ "workflows/other.ts": "export {};\n" }));
    } finally {
      env.FEATURES = features;
    }
    expect(
      outcomes.map((outcome) => workflowErrors.codeOf(outcome))
    ).toStrictEqual([
      "workflow.tests_failed",
      "workflow.tests_failed",
      "workflow.tests_failed",
    ]);
    await expect(builder.api.apps.get(app)).resolves.toMatchObject({
      currentVersion: null,
    });
  });

  it("can't replay core's steps, and audit every step with only well-formed error codes", async () => {
    const admin = await personApi("admin");
    // Written by hand, past the SDK: the host is the boundary, not the SDK.
    const rogue = {
      "workflows/rogue.ts": `export default {
  metadata: { id: "rogue" },
  run: async (engine) => {
    await engine.do("$sneaky", {}, async () => "sneaked");
    let hijack = "ran";
    try {
      await engine.do("$grasp:end", {}, async () => null);
    } catch (error) {
      hijack = error.code;
    }
    try {
      await engine.do("failing", { retries: { limit: 0 } }, async () => {
        throw Object.assign(new Error("no"), { code: "x".repeat(300) });
      });
    } catch {}
    throw Object.assign(new Error("bad: " + hijack), {
      code: "Invoice for Anna de Vries",
      name: "n".repeat(300),
    });
  },
};
`,
      "workflows/rogue.workflow-tests.ts": `import { workflowTests } from "@grasp-os/sdk/testing";
import definition from "./rogue.ts";
export default workflowTests(definition, [{ name: "fails", expect: { error: "bad" } }]);
`,
    };
    const app = await appWith(admin, rogue);
    const run = await admin.api.workflows.start(app, "rogue");
    await finished(run.id);
    const events = await vi.waitFor(async () => {
      const all = await allEvents();
      const ofRun = all.filter(({ target }) => target?.id === run.id);
      expect(ofRun.map(({ action }) => action)).toContain(
        "workflow.run.failed"
      );
      return ofRun;
    });
    const { status, error } = await admin.api.workflows.status(run.id);
    expect({
      status,
      row: await rowStatus(run.id),
      hijack: error?.message.includes("bad: workflow.invalid"),
      audited: events
        .filter(({ action }) => action !== "workflow.run.started")
        .map(({ action, detail }) =>
          [action, detail.step ?? "", detail.errorCode ?? detail.error ?? ""]
            .join(" ")
            .trim()
        )
        .toSorted(),
    }).toStrictEqual({
      status: "failed",
      row: "failed",
      hijack: true,
      audited: [
        "workflow.run.failed  workflow.run_failed",
        "workflow.step.completed $sneaky",
        "workflow.step.failed failing workflow.step_failed",
      ],
    });
  });

  it("stop for good when cancelled, running or paused, and not run a cancelled row again", async () => {
    const builder = await personApi("builder");
    const app = await appWith(
      builder,
      workflowFiles(
        "cancellable",
        `  await step.waitFor("go", { description: "Wait", type: "go", timeout: "1 day" });
  return await step.do("after", { description: "After" }, async () => await env.APP.call("hit", "after"));`,
        { after: 1 }
      )
    );
    const waiting = await builder.api.workflows.start(app, "cancellable");
    const paused = await builder.api.workflows.start(app, "cancellable");
    await stopped(paused.id);
    const cancelled = await Promise.all(
      [waiting, paused].map(
        async ({ id }) => await builder.api.workflows.cancel(id)
      )
    );

    // A cancel whose termination failed: the row says cancelled, and the
    // instance goes on. Its next load does nothing more, and cancelling
    // again terminates it.
    const leftOver = await builder.api.workflows.start(app, "cancellable");
    await stopped(leftOver.id);
    await env.DB.prepare(
      "UPDATE workflow_runs SET status = 'cancelled' WHERE id = ?"
    )
      .bind(leftOver.id)
      .run();
    await resumed(leftOver.id);
    await finished(leftOver.id, { type: "go", payload: null });
    const afterLoad = await liveStatus(leftOver.id);
    await builder.api.workflows.cancel(leftOver.id);

    const events = await allEvents();
    expect({
      cancelled: cancelled.map(({ status }) => status),
      live: await Promise.all(
        [waiting, paused].map(async ({ id }) => await liveStatus(id))
      ),
      audited: events.filter(
        ({ action, target }) =>
          action === "workflow.run.cancelled" &&
          (target?.id === waiting.id || target?.id === paused.id)
      ).length,
      afterLoad,
      after: await hitsOf(app, builder.userId, "after"),
    }).toStrictEqual({
      cancelled: ["cancelled", "cancelled"],
      live: ["terminated", "terminated"],
      audited: 2,
      afterLoad: "errored",
      after: 0,
    });
  });

  it("pause runs while workflows are switched off, and go on when they are on", async () => {
    const builder = await personApi("builder");
    const app = await appWith(
      builder,
      workflowFiles(
        "switchable",
        `  return await step.do("work", { description: "Work" }, async () => await env.APP.call("hit", "work"));`,
        { work: 1 }
      )
    );
    const { FEATURES: features } = env;
    let run: Awaited<ReturnType<typeof triggered>>;
    try {
      env.FEATURES = { apps: true, permissions: true, knowledge: true };
      run = await triggered(app, "switchable");
      await vi.waitFor(
        async () => {
          await expect(liveStatus(run.id)).resolves.toBe("paused");
        },
        { timeout: 10_000, interval: 100 }
      );
    } finally {
      env.FEATURES = features;
    }
    const whileOff = {
      row: await rowStatus(run.id),
      work: await hitsOf(app, builder.userId, "work"),
    };
    await resumed(run.id);
    await finished(run.id);
    expect({
      whileOff,
      live: await liveStatus(run.id),
      work: await hitsOf(app, builder.userId, "work"),
    }).toStrictEqual({
      whileOff: { row: "running", work: 0 },
      live: "complete",
      work: 1,
    });
  });

  it("show what a run returned only to the person who started it, and admins", async () => {
    const starter = await personApi("builder");
    const other = await personApi("builder");
    const admin = await personApi("admin");
    const app = await appWith(
      starter,
      workflowFiles(
        "private",
        `  return await step.do("read", { description: "Read" }, async () => "what the starter may read");`,
        { read: "x" }
      )
    );
    const run = await starter.api.workflows.start(app, "private");
    await finished(run.id);
    const seen = await Promise.all(
      [starter, other, admin].map(async ({ api }) => {
        const { status, output } = await api.workflows.status(run.id);
        return { status, output };
      })
    );
    expect(seen).toStrictEqual([
      { status: "completed", output: "what the starter may read" },
      { status: "completed", output: undefined },
      { status: "completed", output: "what the starter may read" },
    ]);
  });
});
