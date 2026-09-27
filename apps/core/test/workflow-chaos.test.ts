import { appIdSchema } from "@grasp-os/shared/ids";
import type { Role } from "@grasp-os/shared/roles";
import { introspectWorkflowInstance } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { callApp } from "../src/app.ts";
import { runEngine } from "../src/workflows/engine.ts";
import { serverBuilt } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { mailConnection } from "./mail-connection.ts";
import {
  endLiveRuns,
  finished,
  liveStatus,
  resumed,
  stepDone,
  stopped,
} from "./runs.ts";
import { signedInApi } from "./sign-in.ts";
import {
  appWith,
  grantMail,
  invoiceMail,
  mailer,
  runEvents,
  workflowFiles,
} from "./workflow-apps.ts";

// Workflow runs under failure: crashes mid-step, restarts, long sleeps,
// events and starts delivered twice, and failures that pass or last. Runs
// are real, on the Workflows engine (Miniflare's). Their side effects go
// through the real connect to a fake mail server (test/mail-server.ts)
// that counts every call that reached it, so a mail sent twice shows
// there; the App's counters (`hitsOf`) show how often a step really ran.
//
// How each failure is brought about, only from outside core:
// - a crash or a deploy stops a run's execution: the engine's own pause,
//   then resume, which runs the workflow again from its start, loaded
//   anew, finished steps replayed (`stopped`, test/runs.ts);
// - an isolate killed mid-step: an attempt that hangs until the engine
//   gives up on it at the step's timeout and tries again;
// - the engine losing a finished step's record: the engine's restart from
//   that step, which runs it again from scratch;
// - a long sleep: a day's sleep, whose day passes while the run is
//   stopped (the engine's test introspection);
// - an event or a start delivered twice: the engine's own `sendEvent`, and
//   a second create of the run's instance under its ID (triggers aren't in
//   yet; a trigger's duplicate events are for its own tests);
// - a failure trying again may fix: the mail server turning calls away.
// Failures trying again can't fix (a refused call, the workflow's own
// error) stop a run at once: workflows.test.ts has them, with the report
// the run's owner sees.
//
// The tests wait on conditions (a step done, a status reached), never for
// a set time. A step's timeout is the engine's to keep: the attempt it
// cuts off hangs for good, so nothing races it.

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

/**
 * The audit log's events of `action` on `target`. Read once a run has
 * ended: its events are in the outbox by then, and `allEvents` drains it.
 */
const eventsOf = async (action: string, target: string) => {
  const events = await allEvents();
  return events.filter(
    (event) => event.action === action && event.target?.id === target
  );
};

/** A step that hangs on its first attempt until the engine gives up on it. */
const hangOnFirst = (
  counter: string
) => `if ((await env.APP.call("hit", "${counter}")) === 1) {
        await new Promise(() => {});
      }`;

/** A side-effect step `name` that mails `subject`, with `body` around the call. */
const mailStep = (
  name: string,
  subject: string,
  { before = "", after = "" }: { before?: string; after?: string }
) => `  const ${name} = await step.do(
    "${name}",
    { description: "Send", sideEffect: true, input: { to: "ben@acme.test", subject: "${subject}" }, timeout: "1 second", retries: { limit: 1, delay: 10 } },
    async ({ idempotencyKey, input: mail }) => {
      ${before}
      const sent = JSON.parse((await env.MAIL.call("mail.send", mail, { idempotencyKey })).output);
      ${after}
      return sent;
    }
  );`;

describe("workflow runs under failure", { timeout: 60_000 }, () => {
  afterEach(endLiveRuns);

  it("send each mail once when a side-effect step is killed before or after its call, and retried", async () => {
    const admin = await personApi("admin");
    const mail = await mailConnection();
    const app = await appWith(
      admin,
      workflowFiles(
        "killed",
        `${mailStep("early", "Early", { before: hangOnFirst("early") })}
${mailStep("late", "Late", { after: hangOnFirst("late") })}
  return { early, late };`,
        { early: {}, late: {} }
      )
    );
    await grantMail(idp, admin, app, mail.id);
    const run = await admin.api.workflows.start(app, "killed");
    await finished(run.id);

    expect({
      run: await admin.api.workflows.status(run.id),
      attempts: {
        early: await hitsOf(app, admin.userId, "early"),
        late: await hitsOf(app, admin.userId, "late"),
      },
      server: await mail.did(),
    }).toMatchObject({
      // Killed before its call, the step sent on its retry; killed after,
      // its retry got the first call's answer, not a second mail.
      run: {
        status: "completed",
        output: {
          early: { messageId: "message-1" },
          late: { messageId: "message-2" },
        },
      },
      attempts: { early: 2, late: 2 },
      server: {
        calls: 2,
        sent: [
          { to: "ben@acme.test", subject: "Early" },
          { to: "ben@acme.test", subject: "Late" },
        ],
      },
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
    await grantMail(idp, admin, app, mail.id);
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

  it("never send again when the engine loses a finished side-effect step and runs it anew", async () => {
    const admin = await personApi("admin");
    const mail = await mailConnection();
    const app = await appWith(
      admin,
      workflowFiles(
        "forgetful",
        `  const sent = await step.do(
    "send",
    { description: "Send the invoice", sideEffect: true, input: ${JSON.stringify(invoiceMail)} },
    async ({ idempotencyKey, input: mail }) => {
      await env.APP.call("hit", "send");
      return JSON.parse((await env.MAIL.call("mail.send", mail, { idempotencyKey })).output);
    }
  );
  await step.waitFor("go", { description: "Wait", type: "go", timeout: "1 day" });
  return sent;`,
        { send: { messageId: "mocked" } }
      )
    );
    await grantMail(idp, admin, app, mail.id);
    const run = await admin.api.workflows.start(app, "forgetful");
    await stepDone(run.id, "send");
    // Runs the step again from scratch, as if its result had never been
    // stored: only its idempotency key stands between it and a second mail.
    const instance = await env.WORKFLOWS.get(run.id);
    await instance.restart({ from: { name: "send" } });
    await vi.waitFor(
      async () => {
        await expect(
          hitsOf(app, admin.userId, "send")
        ).resolves.toBeGreaterThan(1);
      },
      { timeout: 10_000, interval: 100 }
    );
    await finished(run.id, { type: "go", payload: null });

    expect({
      run: await admin.api.workflows.status(run.id),
      attempts: await hitsOf(app, admin.userId, "send"),
      server: await mail.did(),
    }).toMatchObject({
      run: { status: "completed", output: { messageId: "message-1" } },
      attempts: 2,
      server: { calls: 1, sent: [invoiceMail] },
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

    expect({
      status: await builder.api.workflows.status(run.id),
      before: await hitsOf(app, builder.userId, "before"),
      work: await hitsOf(app, builder.userId, `work:${run.id}:work`),
      after: await hitsOf(app, builder.userId, "after"),
    }).toMatchObject({
      status: { status: "completed", output: 2 },
      before: 1,
      work: 2,
      after: 1,
    });
  });

  it("sleep durably across a crash, without running finished steps again", async () => {
    const builder = await personApi("builder");
    const app = await appWith(
      builder,
      workflowFiles(
        "sleeper",
        `  await step.do("before", { description: "Before" }, async () => await env.APP.call("hit", "before"));
  await step.sleep("nap", { description: "Wait a day", duration: "1 day" });
  return await step.do("after", { description: "After" }, async () => await env.APP.call("hit", "after"));`,
        { before: 1, after: 1 }
      )
    );
    const run = await builder.api.workflows.start(app, "sleeper");
    await stepDone(run.id, "before");
    // Stopped past its first step, with nothing between it and the day's
    // sleep: a stop that lands before the sleep begins ends the sleep's
    // first moment. `asleep` shows the sleep hadn't ended.
    await stopped(run.id);
    const asleep = await hitsOf(app, builder.userId, "after");
    // The day passes while the run is stopped: the resumed execution
    // replays the sleep it began, which then ends at once. Not disposed:
    // disposing deletes the run's instance.
    const instance = await introspectWorkflowInstance(env.WORKFLOWS, run.id);
    await instance.modify(async (modifier) => {
      await modifier.disableSleeps();
    });
    await resumed(run.id);
    await finished(run.id);

    expect({
      asleep,
      status: await builder.api.workflows.status(run.id),
      before: await hitsOf(app, builder.userId, "before"),
      after: await hitsOf(app, builder.userId, "after"),
    }).toMatchObject({
      asleep: 0,
      status: { status: "completed", output: 1 },
      before: 1,
      after: 1,
    });
  });

  it("record a step paused mid-way once, as completed, not as failed", async () => {
    const builder = await personApi("builder");
    const app = await appWith(
      builder,
      workflowFiles(
        "blocking",
        `  return await step.do("block", { description: "Block" }, async () => {
    await env.APP.call("hit", "entered");
    while ((await env.APP.call("hits", "gate")) === 0) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return "done";
  });`,
        { block: "done" }
      )
    );
    const run = await builder.api.workflows.start(app, "blocking");
    await vi.waitFor(
      async () => {
        await expect(
          hitsOf(app, builder.userId, "entered")
        ).resolves.toBeGreaterThan(0);
      },
      { timeout: 10_000, interval: 100 }
    );
    // Paused while the step runs: the engine lets it end, then stops the
    // execution, which throws out of the step's call.
    const instance = await env.WORKFLOWS.get(run.id);
    await instance.pause();
    await callApp(
      env,
      appIdSchema.parse(app),
      { userId: builder.userId, mode: "interactive" },
      "hit",
      ["gate"]
    );
    await vi.waitFor(
      async () => {
        await expect(liveStatus(run.id)).resolves.toBe("paused");
      },
      { timeout: 10_000, interval: 100 }
    );
    await resumed(run.id);
    await finished(run.id);
    const { status, output } = await builder.api.workflows.status(run.id);

    expect({
      status,
      output,
      audited: await runEvents(run.id, "workflow.run.completed"),
    }).toStrictEqual({
      status: "completed",
      output: "done",
      audited: [
        "workflow.run.completed",
        "workflow.run.started",
        "workflow.step.completed $params",
        "workflow.step.completed block",
      ],
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

  it("take an event delivered twice once, and send once", async () => {
    const admin = await personApi("admin");
    const mail = await mailConnection();
    const app = await appWith(
      admin,
      workflowFiles(
        "approved",
        `  const approval = await step.waitFor("approval", { description: "Wait for approval", type: "approved", timeout: "1 day" });
  const sent = await step.do(
    "send",
    { description: "Send the invoice", sideEffect: true, input: ${JSON.stringify(invoiceMail)} },
    async ({ idempotencyKey, input: mail }) => {
      await env.APP.call("hit", "send");
      return JSON.parse((await env.MAIL.call("mail.send", mail, { idempotencyKey })).output);
    }
  );
  return { approval: approval.received && approval.payload, sent };`,
        { send: { messageId: "mocked" } }
      )
    );
    await grantMail(idp, admin, app, mail.id);
    const run = await admin.api.workflows.start(app, "approved");
    // Delivered twice at once, as an event source that retries may.
    const instance = await env.WORKFLOWS.get(run.id);
    const event = { type: "approved", payload: { by: "anna" } };
    await Promise.all([instance.sendEvent(event), instance.sendEvent(event)]);
    await finished(run.id);

    expect({
      run: await admin.api.workflows.status(run.id),
      attempts: await hitsOf(app, admin.userId, "send"),
      server: await mail.did(),
    }).toMatchObject({
      run: {
        status: "completed",
        output: { approval: { by: "anna" }, sent: { messageId: "message-1" } },
      },
      attempts: 1,
      server: { calls: 1, sent: [invoiceMail] },
    });
  });

  it("take a start delivered again under the run's ID as the run it is, sending once", async () => {
    const admin = await personApi("admin");
    const mail = await mailConnection();
    const app = await appWith(
      admin,
      workflowFiles(
        "started",
        `  const sent = await step.do(
    "send",
    { description: "Send the invoice", sideEffect: true, input: ${JSON.stringify(invoiceMail)} },
    async ({ idempotencyKey, input: mail }) => {
      await env.APP.call("hit", "send");
      return JSON.parse((await env.MAIL.call("mail.send", mail, { idempotencyKey })).output);
    }
  );
  await step.waitFor("go", { description: "Wait", type: "go", timeout: "1 day" });
  return sent;`,
        { send: { messageId: "mocked" } }
      )
    );
    await grantMail(idp, admin, app, mail.id);
    const run = await admin.api.workflows.start(app, "started");
    await stepDone(run.id, "send");
    // The same start again, under the run's ID: Cloudflare refuses an ID
    // it has, the local engine takes it as the run it already has. Either
    // way, no second run and no second mail.
    await runEngine(env)
      .create({
        id: run.id,
        pinned: { app: run.app, workflow: run.workflow, version: run.version },
        input: null,
      })
      .catch(() => null);
    await finished(run.id, { type: "go", payload: null });
    const completed = await eventsOf("workflow.run.completed", run.id);

    expect({
      run: await admin.api.workflows.status(run.id),
      attempts: await hitsOf(app, admin.userId, "send"),
      completed: completed.length,
      server: await mail.did(),
    }).toMatchObject({
      run: { status: "completed", output: { messageId: "message-1" } },
      attempts: 1,
      completed: 1,
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
    await grantMail(idp, admin, app, mail.id);
    const run = await admin.api.workflows.start(app, "mailer");
    await finished(run.id);
    // Each attempt is audited with the version whose code made it.
    const calls = await eventsOf("connection.call", mail.id);

    expect({
      run: await admin.api.workflows.status(run.id),
      server: await mail.did(),
      outcomes: calls.map(({ detail }) => detail.outcome),
      auditedVersions: new Set(calls.map(({ detail }) => detail.appVersion)),
    }).toMatchObject({
      run: { status: "completed", output: { messageId: "message-1" } },
      server: { calls: 1, sent: [invoiceMail] },
      // Two attempts the server took nothing of, then the one that went through.
      outcomes: ["failed", "failed", "ok"],
      auditedVersions: new Set([1]),
    });
  });

  it("fail, reported at the step, when the server stays away past the step's retries, having sent nothing", async () => {
    const admin = await personApi("admin");
    const mail = await mailConnection([
      "unavailable",
      "unavailable",
      "unavailable",
    ]);
    const app = await appWith(
      admin,
      mailer(`retries: { limit: 2, delay: 10, backoff: "constant" }`)
    );
    await grantMail(idp, admin, app, mail.id);
    const run = await admin.api.workflows.start(app, "mailer");
    await finished(run.id);
    const calls = await eventsOf("connection.call", mail.id);

    expect({
      run: await admin.api.workflows.status(run.id),
      outcomes: calls.map(({ detail }) => detail.outcome),
      server: await mail.did(),
    }).toMatchObject({
      run: {
        status: "failed",
        failure: {
          step: "send",
          error: { code: "connect.server_unavailable" },
        },
      },
      outcomes: ["failed", "failed", "failed"],
      server: { calls: 0, sent: [] },
    });
  });
});
