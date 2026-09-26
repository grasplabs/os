import { expect } from "@playwright/test";

import { callGate } from "./call-gate.ts";
import { test } from "./csp.ts";
import { apiOf, pageOf, release, signedIn, signInTo } from "./people.ts";
import type { Person } from "./people.ts";

// A decision a workflow run waits for, answered from the link its ask
// sent: the person it was sent to opens it, signs in, and approves, and
// the run goes on with their answer. Anyone else who opens the same link
// only sees that it isn't for them.

/** Keeps each ask's recipients, as a workflow that mails them would. */
const server = `import { DurableObject } from "cloudflare:workers";

export class App extends DurableObject {
  remember(_caller, recipients) {
    this.ctx.storage.kv.put("recipients", recipients);
  }

  recipients(_caller) {
    return this.ctx.storage.kv.get("recipients") ?? [];
  }
}
`;

const approval = `import { workflow, z } from "@grasp-os/sdk/workflow";

export default workflow(
  "approval",
  { params: {}, input: z.object({ from: z.string() }) },
  async (step, { input, env }) =>
    await step.decision("review", {
      description: "Approve invoice INV-7",
      from: input.from,
      ask: async ({ recipients }) => {
        await env.APP.call("remember", recipients);
      },
      timeout: "7 days",
    })
);
`;

const approvalTests = `import { workflowTests } from "@grasp-os/sdk/testing";

import approval from "./approval.ts";

export default workflowTests(approval, [
  {
    name: "ends with the answer",
    input: { from: "role:admin" },
    decisions: { review: { approved: true, by: "anna" } },
    expect: { output: { timedOut: false, approved: true, by: "anna", payload: null } },
  },
]);
`;

/** The first recipient's link, from what the App's server kept. */
const linkIn = (recipients: unknown): string => {
  const first: unknown = Array.isArray(recipients) ? recipients.at(0) : null;
  return typeof first === "object" &&
    first !== null &&
    "link" in first &&
    typeof first.link === "string"
    ? first.link
    : "";
};

/** Starts a run that asks `decider`; returns it and the link they got. */
const askedFor = async (builder: Person, decider: Person) => {
  const { core, api } = apiOf(builder);
  try {
    const { id: app } = await api.apps.create({ name: "Approvals" });
    await release(
      api,
      app,
      {
        "app/server.ts": server,
        "workflows/approval.ts": approval,
        "workflows/approval.workflow-tests.ts": approvalTests,
      },
      "Approvals"
    );
    const run = await api.workflows.start(app, "approval", {
      from: `person:${decider.userId}`,
    });
    let link = "";
    await expect(async () => {
      link = linkIn(await api.screens.call(app, "recipients", []));
      expect(link).toMatch(/\/decisions\/.+\?link=/u);
    }).toPass({ timeout: 30_000 });
    const { pathname, search } = new URL(link);
    return { run: run.id, link: `${pathname}${search}` };
  } finally {
    core[Symbol.dispose]();
  }
};

test("the person a decision link was sent to approves it, and the run goes on", async ({
  browser,
}) => {
  const { builder, decider, other } = await signedIn({
    builder: "builder",
    decider: "user",
    other: "admin",
  });
  const { run, link } = await askedFor(builder, decider);

  const forwarded = await pageOf(browser, other);
  await forwarded.goto(link);
  await expect(forwarded.getByRole("alert")).toHaveText(
    "You aren't one of the people who answer this decision."
  );

  // Opened signed out, the link only asks them to sign in. The local stack
  // has no IdP, so signing in is the session it leaves, and the browser
  // comes back to the same link.
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(link);
  await expect(
    page.getByRole("heading", { name: "Sign in to answer" })
  ).toBeVisible();
  await signInTo(context, decider);
  await page.goto(link);
  await expect(
    page.getByRole("heading", { name: "Approve invoice INV-7" })
  ).toBeVisible();
  await page.getByLabel("Comment (optional)").fill("Matches the PO");
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByRole("status")).toHaveText(/^Approved by Person on /u);

  const { core, api } = apiOf(builder);
  try {
    await expect(async () => {
      // Awaited first: `expect` would probe the RPC promise's stub itself.
      const status = await api.workflows.status(run);
      expect(status).toMatchObject({
        status: "completed",
        output: {
          timedOut: false,
          approved: true,
          by: decider.userId,
          payload: { comment: "Matches the PO" },
        },
      });
    }).toPass({ timeout: 30_000 });
  } finally {
    core[Symbol.dispose]();
  }
});

test("says core can't be reached when a decision never loads", async ({
  browser,
}) => {
  const { decider } = await signedIn({ decider: "user" });
  const page = await pageOf(browser, decider);
  const gate = await callGate(page, '["decisions","get"]');
  gate.hold();
  await page.goto(`/decisions/${crypto.randomUUID()}`);
  await expect(
    page.getByText("Grasp can't be reached right now. Try again in a moment.")
  ).toBeVisible({ timeout: 15_000 });
  expect(gate.stalled()).toBe(1);
});
