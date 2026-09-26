import type { AiBinding } from "@earendil-works/pi-ai/api/cloudflare-ai-binding";
import { appErrors } from "@grasp-os/shared/apps";
import { featureErrors } from "@grasp-os/shared/errors";
import { appIdSchema, workflowIdSchema } from "@grasp-os/shared/ids";
import type { PermissionRequest } from "@grasp-os/shared/permissions";
import type { Role } from "@grasp-os/shared/roles";
import { workflowErrors } from "@grasp-os/shared/workflows";
import { introspectWorkflow, runInDurableObject } from "cloudflare:test";
import type { WorkflowInstanceIntrospector } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { callApp } from "../src/app.ts";
import { appHost } from "../src/durable-objects.ts";
import { ownerEventType } from "../src/workflows/dispatcher.ts";
import { startRun } from "../src/workflows/runs.ts";
import { fakeGateway } from "./ai-gateway.ts";
import { requestGranted, serverBuilt } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { collectionWithNote, readCollection } from "./knowledge.ts";
import { mailControlUrl, mailServerUrl } from "./mail-server.ts";
import type { MailAnswer } from "./mail-server.ts";
import {
  endLiveRuns,
  finished,
  leave,
  liveStatus,
  resumed,
  stepDone,
  stopped,
} from "./runs.ts";
import { openRpc, refusal, signedInWithRole } from "./sign-in.ts";
import { connectDb, testBinding } from "./test-env.ts";

// Workflows are code the agent writes, run for real: committed to an App,
// tested when their version is made current, and run on Cloudflare
// Workflows by the dispatcher, each in an isolate of its own. Workflows'
// test helpers skip sleeps and inject events; the outside systems faked
// here are the model provider behind AI Gateway, and a mail provider's MCP
// server behind the real connect (test/mail-server.ts).

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

type Caller = { userId: string; idempotencyKey?: string };

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

  // Mails the invoice with the caller's key, or with a key of its own.
  async mail(caller: Caller, ownKey: boolean): Promise<unknown> {
    const idempotencyKey = ownKey ? crypto.randomUUID() : caller.idempotencyKey;
    try {
      const { output } = await (this.env as any).MAIL.call(
        caller,
        "mail.send",
        { to: "ben@acme.test", subject: "Invoice INV-7" },
        { idempotencyKey }
      );
      return JSON.parse(output);
    } catch (error) {
      return { refused: (error as { code?: string }).code };
    }
  }
}
`;

/**
 * App server code that reads a collection and calls a connection for its
 * caller, and says how each went: "ok", or the code it was refused with.
 */
const probeServer = `import { DurableObject } from "cloudflare:workers";

const codeOf = async (call) => {
  try {
    await call();
    return "ok";
  } catch (error) {
    return error.code;
  }
};

export class App extends DurableObject {
  async probe(caller) {
    return {
      knowledge: await codeOf(async () => await this.env.HANDBOOK.listDocuments(caller)),
      connections: await codeOf(async () => await this.env.OUTLOOK.call(caller, "mail.list", {})),
    };
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
      reviewer: person({ label: "Reviewer", default: "role:admin" }),
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
      if (decision.timedOut || !decision.approved) {
        return { status: decision.timedOut ? "timedOut" : "rejected" };
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
    expect: { output: { status: "rejected" }, sideEffects: [{ name: "review#ask", input: { from: "role:admin", reminder: false } }] },
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

/** A run a trigger started, which acts for the App's owner. */
const triggered = async (app: string, workflow: string) =>
  await startRun(env, {
    app: appIdSchema.parse(app),
    workflow: workflowIdSchema.parse(workflow),
    input: undefined,
    startedBy: null,
    actor: { type: "system" },
  });

/**
 * A run's audit events, once the log has `last` of them, each as its
 * action and what it says of the step, the reason and the error, sorted.
 */
const runEvents = async (run: string, last: string): Promise<string[]> =>
  await vi.waitFor(
    async () => {
      const events = await allEvents();
      const ofRun = events.filter(({ target }) => target?.id === run);
      expect(ofRun.map(({ action }) => action)).toContain(last);
      return ofRun
        .map(({ action, detail }) =>
          [action, detail.reason, detail.feature, detail.step, detail.error]
            .filter((part) => part !== undefined)
            .join(" ")
        )
        .toSorted();
    },
    { timeout: 10_000, interval: 100 }
  );

const isFetcher = (value: unknown): value is Fetcher =>
  typeof value === "object" && value !== null && "fetch" in value;

/** The outside systems connect reaches (test/connect-providers.ts). */
const providers = (): Fetcher => {
  const fetcher = testBinding("CONNECT_PROVIDERS");
  if (!isFetcher(fetcher)) {
    throw new TypeError("Expected the providers Worker as CONNECT_PROVIDERS");
  }
  return fetcher;
};

const mailServerStateSchema = z.object({
  calls: z.number(),
  sent: z.array(z.object({ to: z.string(), subject: z.string() })),
});

/**
 * A shared mail connection in connect's registry, as a Composio toolkit's,
 * to a mail server of its own that answers its next calls as `plan` says
 * (then sends mail), and tells what it did.
 */
const mailConnection = async (plan: MailAnswer[] = []) => {
  const name = `mail-${crypto.randomUUID()}`;
  const id = `connection-${name}`;
  const now = Date.now();
  await connectDb()
    .prepare(
      "INSERT INTO connections (id, provider, scope, status, server_kind, server, created_at, updated_at) VALUES (?, 'mail', 'shared', 'active', 'composio', ?, ?, ?)"
    )
    .bind(id, mailServerUrl(name), now, now)
    .run();
  await providers().fetch(mailControlUrl(name), {
    method: "POST",
    body: JSON.stringify({ plan }),
  });
  return {
    id,
    /** What the mail server did: calls that reached its tool, mail sent. */
    did: async () => {
      const response = await providers().fetch(mailControlUrl(name));
      return mailServerStateSchema.parse(await response.json());
    },
  };
};

/** Gives the App `MAIL`, for sending on the connection; an admin grants it. */
const grantMail = async (
  requester: Person,
  app: string,
  connectionId: string
): Promise<void> => {
  await requestGranted(idp, requester, {
    subject: { type: "app", appId: app },
    object: { type: "connection", connectionId },
    actions: ["mail.send"],
    binding: "MAIL",
  });
};

/** The mail each test's workflow sends. */
const invoiceMail = { to: "ben@acme.test", subject: "Invoice INV-7" };

/**
 * A workflow `mailer` that sends the invoice mail in its side-effect step
 * `send`, with the step's idempotency key, with the step's `options`; then
 * runs `after` in the step, with the connector's answer as `sent`.
 */
const mailer = (options: string, after = "") =>
  workflowFiles(
    "mailer",
    `  return await step.do(
    "send",
    { description: "Send the invoice", sideEffect: true, input: ${JSON.stringify(invoiceMail)}, ${options} },
    async ({ idempotencyKey, input: mail }) => {
      const sent = JSON.parse((await env.MAIL.call("mail.send", mail, { idempotencyKey })).output);
${after}
      return sent;
    }
  );`,
    { send: { messageId: "mocked" } }
  );

describe("workflow runs", { timeout: 60_000 }, () => {
  afterEach(endLiveRuns);

  it("run the sample invoice workflow end to end, and audit it", async () => {
    const builder = await personApi("builder");
    const reviewer = await personApi("admin");
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
    // An admin, as the reviewer parameter says, approves.
    const decision = await vi.waitFor(async () => {
      const opened = await env.DB.prepare(
        "SELECT id FROM workflow_decisions WHERE run_id = ?"
      )
        .bind(run.id)
        .first<{ id: string }>();
      if (!opened) {
        throw new Error("No decision yet");
      }
      return opened.id;
    });
    await reviewer.api.decisions.answer(decision, { approved: true });
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
    const permission = await requestGranted(idp, admin, outlook(app));
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

  it("go on after a crash without running finished steps again, also when resumed at once, and retry a step killed mid-way", async () => {
    const builder = await personApi("builder");
    const app = await appWith(
      builder,
      workflowFiles(
        "durable",
        `  await step.do("before", { description: "Before" }, async () => await env.APP.call("hit", "before"));
  try {
    await step.waitFor("go", { description: "Wait", type: "go", timeout: "1 day" });
  } finally {
    // Winds down slowly: the stopped execution is still ending when the
    // run, resumed at once, goes on in the next.
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
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

  it("record a step failure the workflow caught once, not again on every later execution", async () => {
    const builder = await personApi("builder");
    const app = await appWith(
      builder,
      workflowFiles(
        "caught",
        // A failure trying again may fix, out of retries: the engine goes
        // on (it ends a run at a failure that can't be retried).
        `  try {
    await step.do("flaky", { description: "Fail", retries: { limit: 0 } }, async () => {
      throw Object.assign(new Error("busy"), { code: "connect.server_unavailable" });
    });
  } catch {}
  await step.waitFor("go", { description: "Wait", type: "go", timeout: "1 day" });
  return await step.do("after", { description: "After" }, async () => "done");`,
        { after: "done" }
      )
    );
    const run = await builder.api.workflows.start(app, "caught");
    await runEvents(run.id, "workflow.step.failed");
    // Stopped and resumed while it waits: the new execution replays the
    // caught failure.
    await stopped(run.id);
    await resumed(run.id);
    await finished(run.id, { type: "go", payload: null });
    const audited = await runEvents(run.id, "workflow.run.completed");
    expect(
      audited.filter((event) => event.startsWith("workflow.step."))
    ).toStrictEqual([
      "workflow.step.completed $params",
      "workflow.step.completed after",
      "workflow.step.failed flaky",
    ]);
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

  it("pause a triggered run once an admin removes its App's owner", async () => {
    const admin = await personApi("admin");
    const owner = await personApi("builder");
    const app = await appWith(
      owner,
      workflowFiles(
        "triggered",
        `  return await step.do("first", { description: "First" }, async () => await env.APP.call("hit", "first"));`,
        { first: 1 }
      )
    );
    await admin.api.members.remove(owner.userId);
    const run = await triggered(app, "triggered");
    await vi.waitFor(
      async () => {
        await expect(rowStatus(run.id)).resolves.toBe("paused");
      },
      { timeout: 10_000, interval: 100 }
    );
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
    // Offboarded by an admin, as in the product.
    await admin.api.members.remove(leaver.userId);
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
    await requestGranted(idp, admin, outlook(app));
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

  it("can't replay core's steps or take ones the engine refuses, and audit every step with only well-formed error codes", async () => {
    const admin = await personApi("admin");
    // Written by hand, past the SDK: the host is the boundary, not the SDK.
    const rogue = {
      "workflows/rogue.ts": `export default {
  metadata: { id: "rogue", params: [] },
  run: async (engine) => {
    await engine.do("$sneaky", {}, async () => "sneaked");
    // Steps the engine would refuse, which it fails the whole run for:
    // caught here, they must fail no more than their step.
    try {
      await engine.do("bell\u0007", {}, async () => null);
    } catch {}
    try {
      await engine.do("huge", { retries: { limit: 0 } }, async () => "x".repeat(1_100_000));
    } catch {}
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
    const { status, error, failure } = await admin.api.workflows.status(run.id);
    expect({
      status,
      row: await rowStatus(run.id),
      hijack: error?.message.includes("bad: workflow.invalid"),
      // It failed after the step it caught, outside any step.
      failure: { step: failure?.step, code: failure?.error.code },
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
      failure: { step: null, code: "workflow.run_failed" },
      audited: [
        "workflow.run.failed  workflow.run_failed",
        "workflow.step.completed $sneaky",
        "workflow.step.failed failing workflow.step_failed",
        "workflow.step.failed huge workflow.step_failed",
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

  it("retry a step while a feature it uses is switched off, go on once it's back on, and start no run while workflows are off", async () => {
    const admin = await personApi("admin");
    const app = await appWith(
      admin,
      workflowFiles(
        "switchable",
        `  return await step.do("work", { description: "Work" }, async () => {
    try {
      await env.OUTLOOK.call("mail.list", {});
    } catch (error) {
      if (error.code === "connect.connection_not_found") {
        return "reached";
      }
      await env.APP.call("hit", "refused");
      throw error;
    }
    return "sent";
  });`,
        { work: "reached" }
      )
    );
    await requestGranted(idp, admin, outlook(app));
    const on = z.record(z.string(), z.boolean()).parse(env.FEATURES);
    const { FEATURES: features } = env;
    let startedWhileOff: unknown;
    let run: Awaited<ReturnType<typeof triggered>>;
    try {
      env.FEATURES = { ...on, workflows: false };
      startedWhileOff = await refusal(triggered(app, "switchable"));
      env.FEATURES = { ...on, connections: false };
      run = await triggered(app, "switchable");
      // Its first attempt was refused the connection.
      await vi.waitFor(
        async () => {
          await expect(
            hitsOf(app, admin.userId, "refused")
          ).resolves.toBeGreaterThan(0);
        },
        { timeout: 10_000, interval: 100 }
      );
    } finally {
      env.FEATURES = features;
    }
    // Back on: the step's retry goes through.
    await finished(run.id);
    const { status, output } = await admin.api.workflows.status(run.id);
    expect({
      startedWhileOff: featureErrors.codeOf(startedWhileOff),
      status,
      output,
      refused: await hitsOf(app, admin.userId, "refused"),
      audited: await runEvents(run.id, "workflow.run.completed"),
    }).toStrictEqual({
      startedWhileOff: "feature.disabled",
      status: "completed",
      output: "reached",
      refused: 1,
      audited: [
        "workflow.run.completed",
        "workflow.run.started",
        "workflow.step.completed $params",
        "workflow.step.completed work",
      ],
    });
  });

  it("wait before a step while workflows are switched off, and go on by themselves once they are back on", async () => {
    const builder = await personApi("builder");
    const app = await appWith(
      builder,
      workflowFiles(
        "held",
        `  await step.waitFor("go", { description: "Wait", type: "go", timeout: "1 day" });
  return await step.do("work", { description: "Work" }, async () => await env.APP.call("hit", "work"));`,
        { work: 1 }
      )
    );
    const run = await builder.api.workflows.start(app, "held");
    const { FEATURES: features } = env;
    let whileOff: unknown;
    try {
      env.FEATURES = {
        ...z.record(z.string(), z.boolean()).parse(features),
        workflows: false,
      };
      const instance = await env.WORKFLOWS.get(run.id);
      await instance.sendEvent({ type: "go", payload: null });
      await runEvents(run.id, "workflow.run.waiting");
      // Stopped and resumed while it waits: the new execution replays the
      // wait so far, records nothing new, and waits on.
      await stopped(run.id);
      await resumed(run.id);
      // Nothing marks the replay (that is the point), so give the new
      // execution a few of the test's checks (WORKFLOW_OFF_WAIT_MS) to
      // replay the wait and record any second event.
      await scheduler.wait(1000);
      whileOff = await hitsOf(app, builder.userId, "work");
    } finally {
      env.FEATURES = features;
    }
    // Back on: nobody resumes it; it checks again, and goes on.
    await finished(run.id);
    expect({
      whileOff,
      live: await liveStatus(run.id),
      work: await hitsOf(app, builder.userId, "work"),
      audited: await runEvents(run.id, "workflow.run.completed"),
    }).toStrictEqual({
      whileOff: 0,
      live: "complete",
      work: 1,
      audited: [
        "workflow.run.completed",
        "workflow.run.started",
        "workflow.run.waiting switched_off workflows",
        "workflow.step.completed $params",
        "workflow.step.completed work",
      ],
    });
  });

  it("hold a wait for an event while workflows are switched off, and take the event sent meanwhile once they are back on", async () => {
    const builder = await personApi("builder");
    const app = await appWith(
      builder,
      workflowFiles(
        "gated",
        `  await step.waitFor("ready", { description: "Ready", type: "ready", timeout: "1 day" });
  const go = await step.waitFor("go", { description: "Go", type: "go", timeout: "1 day" });
  return await step.do("after", { description: "After" }, async () => go);`,
        { after: null }
      )
    );
    const run = await builder.api.workflows.start(app, "gated");
    // Past its first step, it waits for "ready".
    await stepDone(run.id, "$params");
    const instance = await env.WORKFLOWS.get(run.id);
    const { FEATURES: features } = env;
    try {
      env.FEATURES = {
        ...z.record(z.string(), z.boolean()).parse(features),
        workflows: false,
      };
      // The wait under way takes its event; the next is held before it
      // begins, and the event sent for it meanwhile waits.
      await instance.sendEvent({ type: "ready", payload: null });
      await runEvents(run.id, "workflow.run.waiting");
      await instance.sendEvent({ type: "go", payload: "sent while off" });
    } finally {
      env.FEATURES = features;
    }
    await finished(run.id);
    const { status, output } = await builder.api.workflows.status(run.id);
    expect({
      status,
      output,
      audited: await runEvents(run.id, "workflow.run.completed"),
    }).toStrictEqual({
      status: "completed",
      output: { received: true, payload: "sent while off" },
      audited: [
        "workflow.run.completed",
        "workflow.run.started",
        "workflow.run.waiting switched_off workflows",
        "workflow.step.completed $params",
        "workflow.step.completed after",
      ],
    });
  });

  it("refuse Knowledge, connection and App calls, their own and their App's, while that feature is switched off", async () => {
    const admin = await personApi("admin");
    const { id: app } = await admin.api.apps.create({ name: "Probes" });
    await release(admin, app, {
      "app/server.ts": probeServer,
      ...workflowFiles(
        "probe",
        `  return await step.do("probe", { description: "Probe" }, async () => ({
    knowledge: await codeOf(async () => await env.HANDBOOK.listDocuments()),
    connections: await codeOf(async () => await env.OUTLOOK.call("mail.list", {})),
    app: await env.APP.call("probe").catch((error) => error.code),
  }));
  async function codeOf(call) {
    try {
      await call();
      return "ok";
    } catch (error) {
      return error.code;
    }
  }`,
        { probe: null }
      ),
    });
    const { collectionId } = await collectionWithNote(admin.api, {
      name: "Handbook",
      access: "everyone",
    });
    await requestGranted(idp, admin, outlook(app));
    await requestGranted(
      idp,
      admin,
      readCollection(
        { type: "app", appId: appIdSchema.parse(app) },
        collectionId
      )
    );
    const on = z.record(z.string(), z.boolean()).parse(env.FEATURES);
    const probedWith = async (off: string[]) => {
      const { FEATURES: features } = env;
      let run: Awaited<ReturnType<typeof triggered>>;
      try {
        env.FEATURES = {
          ...on,
          ...Object.fromEntries(off.map((feature) => [feature, false])),
        };
        run = await triggered(app, "probe");
        await finished(run.id);
      } finally {
        env.FEATURES = features;
      }
      const { output } = await admin.api.workflows.status(run.id);
      return output;
    };
    const reached = "connect.connection_not_found";
    expect({
      allOn: await probedWith([]),
      knowledgeAndConnectionsOff: await probedWith([
        "knowledge",
        "connections",
      ]),
      appsOff: await probedWith(["apps"]),
    }).toStrictEqual({
      allOn: {
        knowledge: "ok",
        connections: reached,
        app: { knowledge: "ok", connections: reached },
      },
      knowledgeAndConnectionsOff: {
        knowledge: "feature.disabled",
        connections: "feature.disabled",
        app: { knowledge: "feature.disabled", connections: "feature.disabled" },
      },
      appsOff: {
        knowledge: "ok",
        connections: reached,
        app: "feature.disabled",
      },
    });
  });

  it("audit a run whose start failed as failed", async () => {
    const builder = await personApi("builder");
    const app = await appWith(
      builder,
      workflowFiles(
        "unstartable",
        `  return await step.do("work", { description: "Work" }, async () => null);`,
        { work: null }
      )
    );
    // An ID core's record takes but Workflows refuses (over 100
    // characters), so creating the run fails after its row is written.
    const taken: ReturnType<typeof crypto.randomUUID> =
      `run-${"x".repeat(100)}-${crypto.randomUUID()}`;
    const uuid = vi.spyOn(crypto, "randomUUID").mockReturnValueOnce(taken);
    let refused: unknown;
    try {
      refused = await refusal(triggered(app, "unstartable"));
    } finally {
      uuid.mockRestore();
    }
    const { status, failure } = await builder.api.workflows.status(taken);
    expect({
      refused: refused !== "ok",
      row: await rowStatus(taken),
      status,
      failure: failure && {
        step: failure.step,
        input: failure.input,
        error: failure.error,
      },
      audited: await runEvents(taken, "workflow.run.failed"),
    }).toStrictEqual({
      refused: true,
      row: "failed",
      status: "failed",
      // A report its owner sees, saying only that it didn't start.
      failure: {
        step: null,
        input: null,
        error: {
          code: "workflow.run_failed",
          message: "The workflow run couldn't be started.",
        },
      },
      audited: [
        "workflow.run.failed start_failed workflow.run_failed",
        "workflow.run.started",
      ],
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

describe("workflow side effects and failures", { timeout: 60_000 }, () => {
  afterEach(endLiveRuns);

  it("send once when a side-effect step is killed after the mail went out, and retried", async () => {
    const admin = await personApi("admin");
    const mail = await mailConnection();
    const app = await appWith(
      admin,
      mailer(
        `timeout: "1 second", retries: { limit: 1, delay: 10 }`,
        `      if ((await env.APP.call("hit", "send")) === 1) {
        // Hangs until the engine gives up on this attempt.
        await new Promise(() => {});
      }`
      )
    );
    await grantMail(admin, app, mail.id);
    const run = await admin.api.workflows.start(app, "mailer");
    await finished(run.id);

    expect({
      run: await admin.api.workflows.status(run.id),
      attempts: await hitsOf(app, admin.userId, "send"),
      server: await mail.did(),
    }).toMatchObject({
      // The retry got the first call's answer, not a second mail.
      run: { status: "completed", output: { messageId: "message-1" } },
      attempts: 2,
      server: { calls: 1, sent: [invoiceMail] },
    });
  });

  it("retry a call the connection's server took nothing of, with the step's key, until it goes through", async () => {
    const admin = await personApi("admin");
    // As a native connector's 429 comes back from connect: nothing done
    // (connect's own tests run that end to end).
    const mail = await mailConnection(["unavailable", "unavailable"]);
    const app = await appWith(
      admin,
      mailer(`retries: { limit: 3, delay: 10, backoff: "constant" }`)
    );
    await grantMail(admin, app, mail.id);
    const run = await admin.api.workflows.start(app, "mailer");
    await finished(run.id);
    // Each attempt is audited with the version whose code made it.
    const auditedVersions = await vi.waitFor(async () => {
      const events = await allEvents();
      const calls = events.filter(
        ({ action, target }) =>
          action === "connection.call" && target?.id === mail.id
      );
      expect(calls.map(({ detail }) => detail.outcome)).toContain("ok");
      return new Set(calls.map(({ detail }) => detail.appVersion));
    });

    expect({
      run: await admin.api.workflows.status(run.id),
      server: await mail.did(),
      auditedVersions,
    }).toMatchObject({
      run: { status: "completed", output: { messageId: "message-1" } },
      server: { calls: 1, sent: [invoiceMail] },
      auditedVersions: new Set([1]),
    });
  });

  it("take a connection call only inside a step, and with the step's own key", async () => {
    const admin = await personApi("admin");
    const mail = await mailConnection();
    const app = await appWith(
      admin,
      workflowFiles(
        "keys",
        `  const codeOf = async (key) => {
    try {
      await env.MAIL.call("mail.send", ${JSON.stringify(invoiceMail)}, { idempotencyKey: key });
      return "sent";
    } catch (error) {
      return error.code;
    }
  };
  const outside = await codeOf("keys-outside");
  const inside = await step.do(
    "send",
    { description: "Send the invoice", sideEffect: true, input: null },
    async ({ idempotencyKey }) => ({
      // A key of each attempt's own would send once per attempt.
      perAttempt: await codeOf(idempotencyKey + ":attempt-2"),
      // A constant key would answer every run with the first run's mail.
      constant: await codeOf("invoice-INV-7"),
    })
  );
  // A step whose last attempt hangs: once it has settled, calls between
  // steps are refused again.
  try {
    await step.do("hang", { description: "Hang", timeout: "1 second", retries: { limit: 0 } }, async () => {
      await new Promise(() => {});
    });
  } catch {}
  const afterHang = await codeOf("keys-after-hang");
  return { outside, ...inside, afterHang };`,
        { send: {}, hang: null }
      )
    );
    await grantMail(admin, app, mail.id);
    const run = await admin.api.workflows.start(app, "keys");
    await finished(run.id);

    expect({
      run: await admin.api.workflows.status(run.id),
      server: await mail.did(),
    }).toMatchObject({
      run: {
        status: "completed",
        output: {
          outside: "workflow.outside_step",
          perAttempt: "workflow.idempotency_key_invalid",
          constant: "workflow.idempotency_key_invalid",
          afterHang: "workflow.outside_step",
        },
      },
      server: { calls: 0, sent: [] },
    });
  });

  it("have their App's methods mail with the step's key only, once across a retry", async () => {
    const admin = await personApi("admin");
    const mail = await mailConnection();
    const app = await appWith(
      admin,
      workflowFiles(
        "app-mailer",
        `  return await step.do(
    "send",
    { description: "Send the invoice", sideEffect: true, input: null, retries: { limit: 1, delay: 10 } },
    async () => {
      // A key of the method's own would send once per attempt.
      const ownKey = await env.APP.call("mail", true);
      const sent = await env.APP.call("mail", false);
      if ((await env.APP.call("hit", "app-send")) === 1) {
        // The mail went out, yet the attempt fails as if nothing was done,
        // with a failure the engine retries: the retry mustn't mail again.
        throw Object.assign(new Error("busy"), { code: "connect.server_unavailable" });
      }
      return { ownKey, sent };
    }
  );`,
        { send: {} }
      )
    );
    // A method that times out fails the run for good, so the App's first
    // call mustn't have to build its code.
    await serverBuilt(app, 1);
    await grantMail(admin, app, mail.id);
    const run = await admin.api.workflows.start(app, "app-mailer");
    await finished(run.id);

    expect({
      run: await admin.api.workflows.status(run.id),
      attempts: await hitsOf(app, admin.userId, "app-send"),
      server: await mail.did(),
    }).toMatchObject({
      run: {
        status: "completed",
        output: {
          ownKey: { refused: "workflow.idempotency_key_invalid" },
          sent: { messageId: "message-1" },
        },
      },
      attempts: 2,
      server: { calls: 1, sent: [invoiceMail] },
    });
  });

  it("stop at a refused call without retrying it, with a report for the run's owner", async () => {
    const admin = await personApi("admin");
    const owner = await personApi("builder");
    const starter = await personApi("builder");
    const mail = await mailConnection(["invalid", "invalid"]);
    const app = await appWith(
      owner,
      mailer(`retries: { limit: 3, delay: 10, backoff: "constant" }`)
    );
    await grantMail(owner, app, mail.id);
    // One run a person started, which acts for them; one a trigger
    // started, which acts for the App's owner.
    const started = await starter.api.workflows.start(app, "mailer");
    const byTrigger = await triggered(app, "mailer");
    await Promise.all([finished(started.id), finished(byTrigger.id)]);
    const failures = async (person: Person) => {
      const runs = await person.api.workflows.list(app);
      const failureOf = (id: string) =>
        runs.find((run) => run.id === id)?.failure?.run ?? null;
      const { failure } = await person.api.workflows.status(started.id);
      return {
        status: failure?.run,
        listed: [failureOf(started.id), failureOf(byTrigger.id)],
      };
    };
    const unknownApp = await refusal(
      starter.api.workflows.list(crypto.randomUUID())
    );
    const events = await vi.waitFor(async () => {
      const all = await allEvents();
      const failed = all.filter(
        ({ action, target }) =>
          action === "workflow.run.failed" && target?.id === started.id
      );
      expect(failed).toHaveLength(1);
      return failed;
    });

    const seen = {
      starter: await failures(starter),
      owner: await failures(owner),
      admin: await failures(admin),
    };
    // A new owner doesn't get to see what the run read for the old one.
    await env.DB.prepare("UPDATE apps SET owner_id = ? WHERE id = ?")
      .bind(starter.userId, app)
      .run();
    const { listed: starterLists } = await failures(starter);
    const { listed: ownerLists } = await failures(owner);
    const afterOwnerChange = { starter: starterLists, owner: ownerLists };

    expect({
      server: await mail.did(),
      report: await admin.api.workflows.status(started.id),
      seen,
      afterOwnerChange,
      audited: events.map(({ detail }) => detail.error),
      unknownApp: appErrors.codeOf(unknownApp),
    }).toMatchObject({
      // One call each, never retried: the tool may have acted.
      server: { calls: 2, sent: [] },
      report: {
        status: "failed",
        failure: {
          run: started.id,
          app,
          workflow: "mailer",
          version: 1,
          step: "send",
          // What the step works on, without the values.
          input: { to: "string", subject: "string" },
          error: {
            code: "connect.action_failed",
            message: "The action reported an error.",
          },
        },
      },
      seen: {
        starter: { status: started.id, listed: [started.id, null] },
        owner: { status: undefined, listed: [null, byTrigger.id] },
        admin: { status: started.id, listed: [started.id, byTrigger.id] },
      },
      afterOwnerChange: {
        starter: [started.id, null],
        owner: [null, byTrigger.id],
      },
      audited: ["connect.action_failed"],
      unknownApp: "app.not_found",
    });
  });

  it("stop at an error of the workflow's own without retrying it, reporting its input's shape but none of its data", async () => {
    const admin = await personApi("admin");
    const app = await appWith(
      admin,
      workflowFiles(
        "careless",
        `  await step.do(
    "check",
    {
      description: "Check the customer",
      input: { customer: "c-1", "anna@example.com": true, "INV-2026-0007": 1, lines: [1, 2], note: null },
      retries: { limit: 3, delay: 10 },
    },
    async () => {
      await env.APP.call("hit", "check");
      throw new Error("Customer c-1 is blocked");
    }
  );`,
        { check: null }
      )
    );
    const run = await admin.api.workflows.start(app, "careless");
    await finished(run.id);

    const { failure } = await admin.api.workflows.status(run.id);
    expect({
      failure,
      attempts: await hitsOf(app, admin.userId, "check"),
    }).toMatchObject({
      failure: {
        step: "check",
        // No values; no field whose name could be data (an address, an ID).
        input: {
          customer: "string",
          lines: "array",
          note: "null",
          "…": "2 more",
        },
        error: {
          code: "workflow.run_failed",
          message: "Customer c-1 is blocked",
        },
      },
      attempts: 1,
    });
  });

  it("fail, recorded and reported, once a run has taken as many steps as it may", async () => {
    const admin = await personApi("admin");
    // More steps than the engine takes in one execution (vite.config.ts).
    const app = await appWith(
      admin,
      workflowFiles(
        "endless",
        `  for (let i = 0; i < 100; i++) {
    await step.do("step-" + i, { description: "One more" }, async () => i);
  }`
      )
    );
    const run = await admin.api.workflows.start(app, "endless");
    await finished(run.id);

    const { status, failure } = await admin.api.workflows.status(run.id);
    expect({
      status,
      row: await rowStatus(run.id),
      failure: failure?.error.code,
    }).toStrictEqual({
      status: "failed",
      row: "failed",
      failure: "workflow.too_many_steps",
    });
  });
});
