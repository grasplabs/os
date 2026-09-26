/**
 * The approval workflow the decision tests run, and how they drive it:
 * start it, read whom it asked, and wait on its decisions.
 */
import { appIdSchema } from "@grasp-os/shared/ids";
import { env } from "cloudflare:workers";
import { expect, vi } from "vite-plus/test";
import { z } from "zod";

import { callApp } from "../src/app.ts";
import { release, serverBuilt } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { finished } from "./runs.ts";
import type { signedInApi } from "./sign-in.ts";

/** Someone signed in, with their API. */
export type Person = Awaited<ReturnType<typeof signedInApi>>;

/**
 * The App's server: it keeps whom each ask went to, with their links, as
 * a workflow that mails them would.
 */
export const server = `import { DurableObject } from "cloudflare:workers";

export class App extends DurableObject {
  #table() {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS asks (n INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL)");
  }

  remember(_caller, recipients, reminder) {
    this.#table();
    this.ctx.storage.sql.exec("INSERT INTO asks (body) VALUES (?)", JSON.stringify({ recipients, reminder }));
  }

  asks(_caller) {
    this.#table();
    return this.ctx.storage.sql.exec("SELECT body FROM asks ORDER BY n").toArray().map((row) => JSON.parse(row.body));
  }
}
`;

/** A workflow that waits for one decision and returns how it ended. */
export const approval = `import { workflow, z } from "@grasp-os/sdk/workflow";

export default workflow(
  "approval",
  {
    params: {},
    input: z.object({ from: z.string(), timeout: z.number(), remindAfter: z.number().optional() }),
  },
  async (step, { input, env }) =>
    await step.decision("review", {
      description: "Approve the invoice",
      from: input.from,
      ask: async ({ recipients, reminder }) => {
        await env.APP.call("remember", recipients, reminder);
      },
      timeout: input.timeout,
      ...(input.remindAfter === undefined ? {} : { remindAfter: input.remindAfter }),
    })
);
`;

export const approvalTests = `import { workflowTests } from "@grasp-os/sdk/testing";

import approval from "./approval.ts";

export default workflowTests(approval, [
  {
    name: "ends with the answer",
    input: { from: "role:admin", timeout: 1000 },
    decisions: { review: { approved: true, by: "anna" } },
    expect: { output: { timedOut: false, approved: true, by: "anna", payload: null } },
  },
]);
`;

export const week = 7 * 86_400_000;

/**
 * A decision a test acts on while it waits for the reminder: the reminder
 * is due five seconds after the ask, which leaves a slow runner room for
 * what a test does first (change a team, switch a feature off, stop the
 * run). The deadline, ten seconds after the decision opened, leaves room
 * to switch back on before it, where a test does that.
 */
export const reminding = { timeout: 10_000, remindAfter: 5000 };

/**
 * A new App with the approval workflow, released by `builder`, its server
 * built ahead (`serverBuilt`): the first ask calls it once the decision
 * is open, and a build there would take from the time left before the
 * reminder is due and the deadline.
 */
export const approvalApp = async (builder: Person): Promise<string> => {
  const { id } = await builder.api.apps.create({ name: "Approvals" });
  const version = await release(builder, id, {
    "app/server.ts": server,
    "workflows/approval.ts": approval,
    "workflows/approval.workflow-tests.ts": approvalTests,
  });
  await serverBuilt(id, version);
  return id;
};

export const askSchema = z.array(
  z.object({
    recipients: z.array(
      z.object({
        userId: z.string(),
        name: z.string(),
        email: z.string(),
        link: z.url(),
      })
    ),
    reminder: z.boolean(),
  })
);
export type Ask = z.infer<typeof askSchema>[number];

/** The asks the App's server kept, once there are `count` of them. */
export const asksOf = async (app: string, count = 1): Promise<Ask[]> =>
  await vi.waitFor(
    async () => {
      const asks = askSchema.parse(
        await callApp(
          env,
          appIdSchema.parse(app),
          { userId: "test", mode: "interactive" },
          "asks",
          []
        )
      );
      if (asks.length < count) {
        throw new Error(`${asks.length} of ${count} asks so far`);
      }
      return asks;
    },
    { timeout: 20_000, interval: 100 }
  );

/** The link the ask sent to `userId`, and the decision it leads to. */
export const linkOf = (ask: Ask | undefined, userId: string) => {
  const recipient = ask?.recipients.find((person) => person.userId === userId);
  if (!recipient) {
    throw new Error(`The ask went to ${JSON.stringify(ask?.recipients)}`);
  }
  const url = new URL(recipient.link);
  const decision = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
  return { link: url, decision };
};

/** Starts the approval workflow and waits until it has asked. */
export const asking = async (
  builder: Person,
  input: { from: string; timeout: number; remindAfter?: number }
) => {
  const app = await approvalApp(builder);
  const run = await builder.api.workflows.start(app, "approval", input);
  const [ask] = await asksOf(app);
  if (!ask) {
    throw new Error("No ask");
  }
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
  return { app, run, ask, decision };
};

/** What the run returned, once it has ended. */
export const outputOf = async (
  builder: Person,
  run: string
): Promise<unknown> => {
  await finished(run);
  const { output } = await builder.api.workflows.status(run);
  return output;
};

/** Whether `decision`'s deadline has passed, by the database's clock. */
export const deadlinePassed = async (decision: string): Promise<boolean> => {
  const row = await env.DB.prepare(
    "SELECT (julianday('now') - 2440587.5) * 86400000 > expires_at AS past FROM workflow_decisions WHERE id = ?"
  )
    .bind(decision)
    .first<{ past: number }>();
  return row?.past === 1;
};

/** Once run `run` waits because `feature` is switched off, as audited. */
export const waitingFor = async (
  run: string,
  feature: string
): Promise<void> => {
  await vi.waitFor(
    async () => {
      const events = await allEvents();
      expect(
        events.some(
          ({ action, target, detail }) =>
            action === "workflow.run.waiting" &&
            target?.id === run &&
            detail.feature === feature
        )
      ).toBeTruthy();
    },
    { timeout: 10_000, interval: 100 }
  );
};
