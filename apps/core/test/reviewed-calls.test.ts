import {
  appIdSchema,
  permissionIdSchema,
  runIdSchema,
  workflowIdSchema,
} from "@grasp-os/shared/ids";
import { authoritySchema } from "@grasp-os/shared/permissions";
import type { Role } from "@grasp-os/shared/roles";
import type { WorkflowCalls } from "@grasp-os/shared/workflows";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { callApp } from "../src/app.ts";
import type { Settled } from "../src/workflows/code.ts";
import { RunHost } from "../src/workflows/host.ts";
import type { HostHooks, RunStep } from "../src/workflows/host.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { mailConnection } from "./mail-connection.ts";
import { endLiveRuns, finished } from "./runs.ts";
import { signedInApi } from "./sign-in.ts";
import {
  server,
  appWith,
  grantMail,
  invoiceMail,
  mailer,
  workflowFiles,
} from "./workflow-apps.ts";

// A run's calls of its App's bindings are held to what the review of its
// version shows its workflow calling (`app_versions.workflow_calls`): each
// step to its own, or, when its steps can't be read, every step to all
// the workflow's code calls. A call the review doesn't show is refused,
// audited once per attempt, and fails its step; a version whose calls
// can't be read at all isn't committed. Real runs on the Workflows engine,
// and, for what code in a run's isolate would have to get past the SDK to
// try, the host a run's isolate calls, with an engine of the test's own
// that runs each step once, as the platform's does.

const idp = mockIdp();

const personApi = async (role: Role) => await signedInApi(idp, role);

/** How often the App counted `name` (its server's `hit`). */
const hitsOf = async (app: string, userId: string, name: string) =>
  await callApp(
    env,
    appIdSchema.parse(app),
    { userId, mode: "interactive" },
    "hits",
    [name]
  );

/** What version 1 of `app` keeps of what its workflows call. */
const storedCalls = async (app: string): Promise<unknown> => {
  const row = await env.DB.prepare(
    "SELECT workflow_calls FROM app_versions WHERE app_id = ? AND version = 1"
  )
    .bind(app)
    .first<{ workflow_calls: string }>();
  return row === null ? null : JSON.parse(row.workflow_calls);
};

/** Keeps `calls` as what version 1 of `app`'s review showed. */
const describedAs = async (
  app: string,
  calls: Record<string, WorkflowCalls>
): Promise<void> => {
  await env.DB.prepare(
    "UPDATE app_versions SET workflow_calls = ? WHERE app_id = ? AND version = 1"
  )
    .bind(JSON.stringify(calls), app)
    .run();
};

/** A run's refusals of calls, as the audit log has them. */
const refusals = async (run: string) => {
  const events = await allEvents();
  return events
    .filter(
      ({ action, target }) =>
        action === "workflow.call.refused" && target?.id === run
    )
    .map(({ detail }) => ({
      step: detail.step,
      call: detail.call,
      errorCode: detail.errorCode,
    }));
};

/**
 * A run's status and output, the step and error code its failure report
 * names, and whether that error's message says `says`.
 */
const outcomeOf = async (
  person: Awaited<ReturnType<typeof personApi>>,
  run: string,
  says = ""
) => {
  const { status, failure, output } = await person.api.workflows.status(run);
  return {
    status,
    output,
    step: failure?.step,
    code: failure?.error.code,
    says: failure?.error.message.includes(says) ?? false,
  };
};

/** The engine's `step`, running each step's function once. */
const step: RunStep = {
  do: async (_name, _config, fn) => await fn(),
  sleep: async () => {
    await Promise.resolve();
  },
  waitForEvent: async () => await Promise.reject(new Error("No waits here")),
};

/**
 * A host for a run of a new App held to `calls`, whose App method calls
 * are counted in `appCalls`, with a permission on another App's exports
 * as `CRM`.
 */
const hostHeldTo = async (calls: WorkflowCalls) => {
  const { userId } = await personApi("builder");
  const app = appIdSchema.parse(crypto.randomUUID());
  const runId = runIdSchema.parse(crypto.randomUUID());
  const appCalls: string[] = [];
  const hooks: HostHooks = {
    stepFailed: () => {},
    engineStopped: () => false,
    waiting: async () => {
      await Promise.resolve();
    },
    callApp: async (_caller, method) => {
      appCalls.push(method);
      return await Promise.resolve({ ok: true, value: null });
    },
  };
  const host = new RunHost(
    env,
    step,
    {
      app,
      workflow: workflowIdSchema.parse("tidy"),
      version: 1,
      runId,
      authority: authoritySchema.parse({
        subject: { type: "app", appId: app },
        onBehalfOf: userId,
        mode: "workflow",
        appVersion: 1,
      }),
      collections: {},
      connections: {},
      apps: {
        CRM: {
          permissionId: permissionIdSchema.parse(crypto.randomUUID()),
          app: appIdSchema.parse(crypto.randomUUID()),
        },
      },
      calls,
    },
    hooks
  );
  return { host, runId, appCalls };
};

/** A settled call's error code, or `ok`. */
const codeOf = (settled: Settled<unknown>): string =>
  settled.ok ? "ok" : (settled.error.code ?? settled.error.message);

describe("a run's binding calls", { timeout: 60_000 }, () => {
  afterEach(endLiveRuns);

  it("run a call a step's review shows, also on a version that kept none, and refuse and audit it from a step whose review doesn't", async () => {
    const admin = await personApi("admin");
    const mail = await mailConnection();
    const shown = await appWith(admin, mailer(""));
    const hidden = await appWith(admin, mailer(""));
    const unkept = await appWith(admin, mailer(""));
    for (const app of [shown, hidden, unkept]) {
      // oxlint-disable-next-line no-await-in-loop -- one grant at a time
      await grantMail(idp, admin, app, mail.id);
    }
    const kept = await storedCalls(shown);
    await describedAs(hidden, { mailer: { steps: { send: [] }, all: [] } });
    // As a version committed before its row kept what it calls.
    await describedAs(unkept, {});

    const sent = await admin.api.workflows.start(shown, "mailer");
    const refused = await admin.api.workflows.start(hidden, "mailer");
    const noneKept = await admin.api.workflows.start(unkept, "mailer");
    await Promise.all([
      finished(sent.id),
      finished(refused.id),
      finished(noneKept.id),
    ]);

    expect({
      kept,
      sent: await outcomeOf(admin, sent.id),
      refused: await outcomeOf(admin, refused.id, 'Step "send" called MAIL'),
      noneKept: await outcomeOf(admin, noneKept.id),
      filled: await storedCalls(unkept),
      audited: await refusals(refused.id),
      server: await mail.did(),
    }).toMatchObject({
      // What the reader shows the review, kept as the version is committed.
      kept: { mailer: { steps: { send: ["MAIL"] }, all: ["MAIL"] } },
      sent: { status: "completed" },
      refused: {
        status: "failed",
        step: "send",
        code: "workflow.call_not_reviewed",
        says: true,
      },
      // Read from its files as its commit would have, and kept.
      noneKept: { status: "completed" },
      filled: { mailer: { steps: { send: ["MAIL"] }, all: ["MAIL"] } },
      audited: [
        { step: "send", call: "MAIL", errorCode: "workflow.call_not_reviewed" },
      ],
      // Only the runs whose review shows the call reached the mail server.
      server: { calls: 2, sent: [invoiceMail, invoiceMail] },
    });
  });

  it("hold every step of a workflow whose steps can't be read to all its code calls, shown in its review", async () => {
    const admin = await personApi("admin");
    const mail = await mailConnection();
    // A step in a `try` can't be read as a step list.
    const files = workflowFiles(
      "guarded",
      `  try {
    return await step.do(
      "send",
      { description: "Send the invoice", sideEffect: true, input: ${JSON.stringify(invoiceMail)} },
      async ({ idempotencyKey, input: mail }) =>
        JSON.parse((await env.MAIL.call("mail.send", mail, { idempotencyKey })).output)
    );
  } catch (error) {
    throw error;
  }`,
      { send: { messageId: "mocked" } }
    );
    const { id: app } = await admin.api.apps.create({ name: "Invoices" });
    const { version } = await admin.api.apps.files.commit(
      app,
      { "app/server.ts": server, ...files },
      "Guarded"
    );
    const { workflows } = await admin.api.apps.versions.review(app, version);
    await admin.api.apps.versions.setCurrent(app, version);
    await grantMail(idp, admin, app, mail.id);
    const run = await admin.api.workflows.start(app, "guarded");
    await finished(run.id);

    expect({
      reviewed: workflows.map(({ id, steps, calls }) => ({ id, steps, calls })),
      kept: await storedCalls(app),
      run: await outcomeOf(admin, run.id),
      server: await mail.did(),
    }).toMatchObject({
      reviewed: [{ id: "guarded", steps: null, calls: ["MAIL"] }],
      kept: { guarded: { steps: null, all: ["MAIL"] } },
      run: { status: "completed", output: { messageId: "message-1" } },
      server: { calls: 1, sent: [invoiceMail] },
    });
  });

  it("hold a workflow whose calls can't be read to none, such as a stub made in one step and called in another", async () => {
    const admin = await personApi("admin");
    const files = workflowFiles(
      "tidy",
      `  let app;
  await step.do("prepare", { description: "Prepare" }, async () => {
    app = appServer(env);
  });
  return await step.do("tidy-up", { description: "Tidy" }, async () => {
    await app.hit("tidied");
    return "tidied";
  });`,
      { prepare: null, "tidy-up": null }
    );
    const source = (files["workflows/tidy.ts"] ?? "").replace(
      "import { workflow, z }",
      "import { appServer, workflow, z }"
    );
    const { id: app } = await admin.api.apps.create({ name: "Invoices" });
    const { version } = await admin.api.apps.files.commit(
      app,
      { "app/server.ts": server, ...files, "workflows/tidy.ts": source },
      "Tidy"
    );
    const { workflows } = await admin.api.apps.versions.review(app, version);
    await admin.api.apps.versions.setCurrent(app, version);
    // As a version committed before its row kept what it calls: read
    // again from its files as its first run starts.
    await describedAs(app, {});
    const run = await admin.api.workflows.start(app, "tidy");
    await finished(run.id);

    expect({
      reviewed: workflows.map(({ id, steps, calls }) => ({ id, steps, calls })),
      kept: await storedCalls(app),
      run: await outcomeOf(admin, run.id, 'Step "tidy-up" called APP'),
      audited: await refusals(run.id),
      hits: await hitsOf(app, admin.userId, "tidied"),
    }).toMatchObject({
      // The reader refuses a stub kept in a variable: the review shows the
      // workflow's steps as unreadable, calling none of the App's bindings.
      reviewed: [{ id: "tidy", steps: null, calls: [] }],
      kept: { tidy: { steps: null, all: [] } },
      run: {
        status: "failed",
        step: "tidy-up",
        code: "workflow.call_not_reviewed",
        says: true,
      },
      audited: [
        {
          step: "tidy-up",
          call: "APP",
          errorCode: "workflow.call_not_reviewed",
        },
      ],
      hits: 0,
    });
  });

  it("run the workflow its review shows, though its module tries to put another run in its place", async () => {
    const admin = await personApi("admin");
    const files = workflowFiles(
      "tidy",
      `  return await step.do("tidy", { description: "Tidy" }, async () => {
    await appServer(env).hit("tidied");
    return "tidied";
  });`,
      { tidy: null }
    );
    // The workflow's module imports itself, and once it has loaded puts a
    // run of its own on the definition: one that runs a step under a name
    // the review shows, calling what that step may, with other arguments.
    const swaps = `import me from "./tidy.ts";

queueMicrotask(() => {
  try {
    Object.assign(me, {
      run: async (engine) => {
        await engine.do("tidy:x1", {}, async () => await engine.env.APP.call("hit", "swapped"));
        return "swapped";
      },
    });
  } catch {}
});
`;
    const source = (files["workflows/tidy.ts"] ?? "").replace(
      'import { workflow, z } from "@grasp-os/sdk/workflow";\n',
      `import { appServer, workflow, z } from "@grasp-os/sdk/workflow";\n${swaps}`
    );
    const app = await appWith(admin, {
      ...files,
      "workflows/tidy.ts": source,
    });

    const run = await admin.api.workflows.start(app, "tidy");
    await finished(run.id);

    expect({
      kept: await storedCalls(app),
      run: await outcomeOf(admin, run.id),
      tidied: await hitsOf(app, admin.userId, "tidied"),
      swapped: await hitsOf(app, admin.userId, "swapped"),
    }).toMatchObject({
      kept: { tidy: { steps: { tidy: ["APP"] }, all: ["APP"] } },
      run: { status: "completed", output: "tidied" },
      tidied: 1,
      swapped: 0,
    });
  });

  it("refuse a step whose name the review doesn't show, and a call from one step's code made while another runs", async () => {
    const { host } = await hostHeldTo({
      steps: { arm: [], send: ["APP"] },
      all: ["APP"],
    });
    let armed = "";
    const unnamed = await host.do(
      "evil",
      {},
      async () => await Promise.resolve({ ok: true, value: null })
    );
    await host.do("arm", {}, async (attempt) => {
      armed = attempt;
      return await Promise.resolve({ ok: true, value: null });
    });
    let leftBehind: Settled<unknown> = { ok: true, value: null };
    const sent = await host.do("send", {}, async () => {
      // As code `arm` left behind would, calling with its attempt.
      leftBehind = await host.callApp("hit", ["armed"], armed);
      return { ok: true, value: null };
    });

    expect({
      unnamed: codeOf(unnamed),
      leftBehind: codeOf(leftBehind),
      sent: codeOf(sent),
    }).toStrictEqual({
      unnamed: "workflow.step_not_reviewed",
      leftBehind: "workflow.call_not_reviewed",
      sent: "workflow.call_not_reviewed",
    });
  });

  it("audit only an attempt's first refused call, and refuse every later one of it at once, one its review shows too", async () => {
    const { host, runId, appCalls } = await hostHeldTo({
      steps: { tidy: ["APP"] },
      all: ["APP"],
    });
    const codes: string[] = [];
    const done = await host.do("tidy", {}, async () => {
      for (let tries = 0; tries < 3; tries += 1) {
        // oxlint-disable-next-line no-await-in-loop -- one call at a time
        codes.push(codeOf(await host.callExport("CRM", "find", {})));
      }
      codes.push(codeOf(await host.callApp("hit", ["tidied"])));
      // The code carries on as if nothing was refused.
      return { ok: true, value: "tidied" };
    });

    expect({
      codes,
      done: codeOf(done),
      appCalls,
      audited: await refusals(runId),
    }).toStrictEqual({
      codes: [
        "workflow.call_not_reviewed",
        "workflow.call_not_reviewed",
        "workflow.call_not_reviewed",
        "workflow.call_not_reviewed",
      ],
      done: "workflow.call_not_reviewed",
      appCalls: [],
      audited: [
        { step: "tidy", call: "CRM", errorCode: "workflow.call_not_reviewed" },
      ],
    });
  });
});
