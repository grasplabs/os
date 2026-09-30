import { appIdSchema } from "@grasp-os/shared/ids";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { appHost } from "../src/durable-objects.ts";
import { requestGranted, serverBuilt } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { runQuarterHourCron } from "./cron.ts";
import { mockIdp } from "./idp.ts";
import { mailConnection, mailWithSearch } from "./mail-connection.ts";
import { endLiveRuns, finished, liveStatus } from "./runs.ts";
import { openRpc, outcome as codeOf, signedInWithRole } from "./sign-in.ts";
import {
  appWith,
  grantMail,
  invoiceMail,
  mailer,
  runEvents,
  workflowFiles,
} from "./workflow-apps.ts";

// A run's side effects held for the person it acts for (threat model R7,
// R12): once its App read restricted data, each waits for that person,
// and the run waits too, as for a switched-off feature, using none of its
// step's retries. The ways it can fail come first: the run fails, or
// spends its retries, while it waits; workflow code or its App hides the
// hold and the step completes without the side effect; a decline or drop
// doesn't end the step; the side effect runs for a run that has ended; a
// step forges a hold. (Apart from workflows.test.ts: one file holds only
// so many runs' worth of workers.)

const idp = mockIdp();

/** A signed-in person's API, on a connection of their own. */
const personApi = async (role: Role) => {
  const person = await signedInWithRole(idp, role);
  const { core } = await openRpc(person.session);
  return { ...person, api: core.authenticate() };
};

describe("a run's held side effects", { timeout: 60_000 }, () => {
  afterEach(endLiveRuns);

  it("wait in their App's restricted mode for the person to confirm a side effect, or a Composio read the admin marked, then run it once", async () => {
    const admin = await personApi("admin");
    const mail = await mailConnection([], mailWithSearch);
    // No retries: waiting for the person uses none.
    const app = await appWith(admin, {
      ...mailer(`retries: { limit: 0 }`),
      // A read, but on a Composio connection from a restricted App its
      // input leaves for a third party: a side effect's step, with its key.
      ...workflowFiles(
        "search",
        `  return await step.do("search", { description: "Search the mail", sideEffect: true, input: { query: "INV-7" }, retries: { limit: 0 } }, async ({ idempotencyKey, input }) => JSON.parse((await env.MAIL.call("mail.search", input, { idempotencyKey })).output));`,
        { search: null }
      ),
    });
    await requestGranted(idp, admin, {
      subject: { type: "app", appId: app },
      object: { type: "connection", connectionId: mail.id },
      actions: ["mail.send", "mail.search"],
      binding: "MAIL",
    });
    await appHost(env, appIdSchema.parse(app)).restrict();
    const run = await admin.api.workflows.start(app, "mailer");
    const search = await admin.api.workflows.start(app, "search");
    // Observed waiting, then shown to the person it acts for, warned.
    await runEvents(run.id, "workflow.run.waiting");
    await runEvents(search.id, "workflow.run.waiting");
    const waiting = await admin.api.pendingActions.list();
    const held = waiting.find(({ action }) => action === "mail.send");
    const heldSearch = waiting.find(({ action }) => action === "mail.search");
    if (held === undefined || heldSearch === undefined) {
      throw new Error("Nothing held");
    }
    const before = {
      live: [await liveStatus(run.id), await liveStatus(search.id)],
      server: await mail.did(),
      searched: await mail.searched(),
    };
    await admin.api.pendingActions.confirm(held.id, held.inputHash);
    await admin.api.pendingActions.confirm(heldSearch.id, heldSearch.inputHash);
    await finished(run.id);
    await finished(search.id);
    expect({
      held: waiting.map(({ mode, restricted }) => ({ mode, restricted })),
      before,
      run: await admin.api.workflows.status(run.id),
      search: await admin.api.workflows.status(search.id),
      server: await mail.did(),
      searched: await mail.searched(),
      audited: await runEvents(run.id, "workflow.run.completed"),
    }).toMatchObject({
      held: [
        { mode: "workflow", restricted: true },
        { mode: "workflow", restricted: true },
      ],
      before: {
        live: ["running", "running"],
        server: { calls: 0, sent: [] },
        searched: [],
      },
      // Run again once confirmed, each got the answer of the call that ran.
      run: { status: "completed", output: { messageId: "message-1" } },
      search: { status: "completed", output: { messages: ["INV-7-1"] } },
      server: { calls: 1, sent: [invoiceMail] },
      searched: ["INV-7"],
      audited: [
        "workflow.run.completed",
        "workflow.run.started",
        "workflow.run.waiting held",
        "workflow.step.completed $params",
        "workflow.step.completed send",
      ],
    });
  });

  it("wait for a side effect held in their App's method, or caught by their code, and complete once confirmed", async () => {
    const admin = await personApi("admin");
    const mail = await mailConnection();
    const app = await appWith(admin, {
      ...workflowFiles(
        "via-app",
        `  return await step.do("send", { description: "Send", sideEffect: true, input: null, retries: { limit: 0 } }, async () => await env.APP.call("mail", false));`,
        { send: null }
      ),
      ...workflowFiles(
        "caught",
        `  return await step.do("send", { description: "Send", sideEffect: true, input: ${JSON.stringify(invoiceMail)}, retries: { limit: 0 } }, async ({ idempotencyKey, input }) => {
    try {
      return JSON.parse((await env.MAIL.call("mail.send", input, { idempotencyKey })).output);
    } catch (error) {
      return { caught: error.code };
    }
  });`,
        { send: null }
      ),
    });
    // The App's first call mustn't have to build its code in the call's
    // deadline.
    await serverBuilt(app, 1);
    await grantMail(idp, admin, app, mail.id);
    await appHost(env, appIdSchema.parse(app)).restrict();
    const runs = [
      await admin.api.workflows.start(app, "via-app"),
      await admin.api.workflows.start(app, "caught"),
    ];
    for (const run of runs) {
      // oxlint-disable-next-line no-await-in-loop -- one run at a time
      await runEvents(run.id, "workflow.run.waiting");
    }
    const held = await admin.api.pendingActions.list();
    const before = await mail.did();
    for (const action of held) {
      // oxlint-disable-next-line no-await-in-loop -- one at a time
      await admin.api.pendingActions.confirm(action.id, action.inputHash);
    }
    const outputs = [];
    for (const run of runs) {
      // oxlint-disable-next-line no-await-in-loop -- one run at a time
      await finished(run.id);
      // oxlint-disable-next-line no-await-in-loop -- one run at a time
      const { status, output } = await admin.api.workflows.status(run.id);
      outputs.push({ status, output });
    }
    const after = await mail.did();
    expect({
      held: held.length,
      before,
      statuses: outputs.map(({ status }) => status),
      answered: outputs.map(({ output }) =>
        JSON.stringify(output).includes("messageId")
      ),
      server: after.calls,
    }).toStrictEqual({
      held: 2,
      before: { calls: 0, sent: [] },
      // Neither the App's catch nor the workflow's ended the step: each ran
      // again once confirmed and got the mail's answer.
      statuses: ["completed", "completed"],
      answered: [true, true],
      server: 2,
    });
  });

  it("refuse a step that returns the value core keeps for a held step", async () => {
    const admin = await personApi("admin");
    const app = await appWith(
      admin,
      workflowFiles(
        "forger",
        `  return await step.do("forge", { description: "Forge", retries: { limit: 0 } }, async () => ({ "$grasp:held": true }));`,
        { forge: null }
      )
    );
    const run = await admin.api.workflows.start(app, "forger");
    await finished(run.id);
    await expect(admin.api.workflows.status(run.id)).resolves.toMatchObject({
      status: "failed",
      failure: {
        step: "forge",
        error: {
          message: 'Step "forge" returned a value core keeps for itself',
        },
      },
    });
  });

  it("wait on, and complete once confirmed, when connect can't say for a moment whether a side effect still waits", async () => {
    const admin = await personApi("admin");
    const mail = await mailConnection();
    // Through the App (asked in the attempt) and directly (asked while the
    // run waits): connect fails the first question each time.
    const app = await appWith(admin, {
      ...workflowFiles(
        "via-app",
        `  return await step.do("send", { description: "Send", sideEffect: true, input: null, retries: { limit: 0 } }, async () => await env.APP.call("mail", false));`,
        { send: null }
      ),
      ...mailer(`retries: { limit: 0 }`),
    });
    // The App's first call mustn't have to build its code in the call's
    // deadline.
    await serverBuilt(app, 1);
    await grantMail(idp, admin, app, mail.id);
    await appHost(env, appIdSchema.parse(app)).restrict();
    const { CONNECT: connect } = env;
    const statuses: string[] = [];
    try {
      for (const workflow of ["via-app", "mailer"]) {
        let failures = 1;
        env.CONNECT = new Proxy(connect, {
          get: (target, name) => {
            if (name === "anyPending" && failures > 0) {
              failures -= 1;
              return async () => {
                await Promise.resolve();
                throw new Error("Connect didn't answer");
              };
            }
            const real: unknown = Reflect.get(target, name);
            return real;
          },
        });
        // oxlint-disable-next-line no-await-in-loop -- one run at a time
        const run = await admin.api.workflows.start(app, workflow);
        // oxlint-disable-next-line no-await-in-loop -- one run at a time
        await runEvents(run.id, "workflow.run.waiting");
        // oxlint-disable-next-line no-await-in-loop -- one run at a time
        const [held] = await admin.api.pendingActions.list();
        if (held === undefined) {
          throw new Error("Nothing held");
        }
        // oxlint-disable-next-line no-await-in-loop -- one run at a time
        await admin.api.pendingActions.confirm(held.id, held.inputHash);
        // oxlint-disable-next-line no-await-in-loop -- one run at a time
        await finished(run.id);
        // oxlint-disable-next-line no-await-in-loop -- one run at a time
        const { status } = await admin.api.workflows.status(run.id);
        statuses.push(`${workflow} ${status} ${String(failures)}`);
      }
    } finally {
      env.CONNECT = connect;
    }
    const { calls: sent } = await mail.did();
    expect({ statuses, sent }).toStrictEqual({
      statuses: ["via-app completed 0", "mailer completed 0"],
      sent: 2,
    });
  });

  it("drop a held side effect whose run has ended when its person comes to confirm it", async () => {
    const admin = await personApi("admin");
    const mail = await mailConnection();
    const app = await appWith(admin, mailer(`retries: { limit: 0 }`));
    await grantMail(idp, admin, app, mail.id);
    await appHost(env, appIdSchema.parse(app)).restrict();
    const run = await admin.api.workflows.start(app, "mailer");
    await runEvents(run.id, "workflow.run.waiting");
    const [held] = await admin.api.pendingActions.list();
    if (held === undefined) {
      throw new Error("Nothing held");
    }
    await admin.api.workflows.cancel(run.id);
    const confirmed = await codeOf(
      admin.api.pendingActions.confirm(held.id, held.inputHash)
    );
    expect({
      confirmed,
      waiting: await admin.api.pendingActions.list(),
      server: await mail.did(),
    }).toStrictEqual({
      confirmed: "connect.run_ended",
      waiting: [],
      server: { calls: 0, sent: [] },
    });
  });

  it("drop a held side effect, input and all, once its run has ended for its retention, without its person coming back", async () => {
    const admin = await personApi("admin");
    const mail = await mailConnection();
    const app = await appWith(admin, mailer(`retries: { limit: 0 }`));
    await grantMail(idp, admin, app, mail.id);
    await appHost(env, appIdSchema.parse(app)).restrict();
    const run = await admin.api.workflows.start(app, "mailer");
    // Another run's, still waiting: not this retention's to drop.
    const live = await admin.api.workflows.start(app, "mailer");
    await runEvents(run.id, "workflow.run.waiting");
    await runEvents(live.id, "workflow.run.waiting");
    await admin.api.workflows.cancel(run.id);
    const day = 24 * 60 * 60 * 1000;

    await runQuarterHourCron({}, new Date(Date.now() + 29 * day));
    const within = await admin.api.pendingActions.list();
    await runQuarterHourCron({}, new Date(Date.now() + 31 * day));
    const after = await admin.api.pendingActions.list();
    const events = await allEvents();
    const dropped = events
      .filter(
        ({ action, target }) =>
          action === "connection.action.dropped" && target?.id === mail.id
      )
      .map(({ actor, detail }) => [actor.type, detail.reason]);

    expect({
      within: within.length,
      after: after.map(({ idempotencyKey }) =>
        idempotencyKey.startsWith(`${live.id}:`)
      ),
      dropped,
      server: await mail.did(),
    }).toStrictEqual({
      within: 2,
      // The live run's stays.
      after: [true],
      dropped: [["system", "run.ended"]],
      server: { calls: 0, sent: [] },
    });
  });

  it("fail the step, for good, when the person declines a side effect it waits for", async () => {
    const admin = await personApi("admin");
    const mail = await mailConnection();
    const app = await appWith(
      admin,
      mailer(`retries: { limit: 3, delay: 10, backoff: "constant" }`)
    );
    await grantMail(idp, admin, app, mail.id);
    await appHost(env, appIdSchema.parse(app)).restrict();
    const run = await admin.api.workflows.start(app, "mailer");
    await runEvents(run.id, "workflow.run.waiting");
    const [held] = await admin.api.pendingActions.list();
    if (held === undefined) {
      throw new Error("Nothing held");
    }
    await admin.api.pendingActions.decline(held.id);
    await finished(run.id);
    const audited = await runEvents(run.id, "workflow.run.failed");
    expect({
      run: await admin.api.workflows.status(run.id),
      server: await mail.did(),
      audited: audited.filter(
        (event) =>
          event.startsWith("workflow.run.waiting") ||
          event.startsWith("workflow.step.failed")
      ),
    }).toMatchObject({
      run: { status: "failed" },
      server: { calls: 0, sent: [] },
      // Failed once, not retried: a decline is final.
      audited: ["workflow.run.waiting held", "workflow.step.failed send"],
    });
  });

  it("fail at once in restricted mode while held actions are switched off", async () => {
    const admin = await personApi("admin");
    const mail = await mailConnection();
    const app = await appWith(admin, mailer(`retries: { limit: 0 }`));
    await grantMail(idp, admin, app, mail.id);
    await appHost(env, appIdSchema.parse(app)).restrict();
    const on = z.record(z.string(), z.boolean()).parse(env.FEATURES);
    const { FEATURES: features } = env;
    let run: { id: string };
    try {
      env.FEATURES = { ...on, confirmations: false };
      run = await admin.api.workflows.start(app, "mailer");
      await finished(run.id);
    } finally {
      env.FEATURES = features;
    }
    const audited = await runEvents(run.id, "workflow.run.failed");
    expect({
      run: await admin.api.workflows.status(run.id),
      waited: audited.some((event) => event.startsWith("workflow.run.waiting")),
      waiting: await admin.api.pendingActions.list(),
      server: await mail.did(),
    }).toMatchObject({
      run: { status: "failed" },
      waited: false,
      waiting: [],
      server: { calls: 0, sent: [] },
    });
  });
});
