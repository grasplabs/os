import { expect } from "@playwright/test";

import { test } from "./csp.ts";
import { apiOf, pageOf, peopleIn, release } from "./people.ts";
import type { Person } from "./people.ts";

// The Workflows page, end to end: a builder finds their App's workflows
// with a waiting run, finds that run at the top of Runs and follows it to
// where it is decided; then opens a workflow, reads its steps, changes a
// parameter and tests it with the new value. Someone the App is shared
// with as a user reads its steps without their code, with no parameters,
// Test or decision to offer them; where their App's workflows can't be
// read, the Runs tab's Workflow filter says so.

/** Waits for one decision, asked of the reviewer the parameter names. */
const approval = `import { person, workflow, z } from "@grasp-os/sdk/workflow";

export default workflow(
  "approval",
  { input: z.unknown(), params: { reviewer: person({ label: "Reviewer", default: "role:admin" }) } },
  async (step, { params }) =>
    await step.decision("review", {
      description: "Approve invoice INV-7",
      from: params.reviewer,
      ask: async () => {},
      timeout: "7 days",
    })
);
`;

const approvalTests = `import { workflowTests } from "@grasp-os/sdk/testing";

import approval from "./approval.ts";

export default workflowTests(approval, [
  { name: "ends with the answer", decisions: { review: { approved: true, by: "anna" } }, expect: {} },
]);
`;

/**
 * Reads an invoice's total with a model, asks a reviewer above a limit,
 * and books it.
 */
const approve = `import { model, money, person, workflow, z } from "@grasp-os/sdk/workflow";

export default workflow(
  "approve",
  {
    input: z.object({ text: z.string() }),
    params: {
      limit: money({ label: "Review invoices above", currency: "EUR", default: 500_000, sensitive: true }),
      reviewer: person({ label: "Reviewer", default: "role:admin" }),
      reader: model({ label: "Reading model", default: "mistral-large" }),
    },
  },
  async (step, { input, params }) => {
    const extracted = await step.llm("extract", {
      description: "Read the invoice's total",
      model: params.reader,
      instructions: "Read the total in cents.",
      input: input.text,
      schema: z.object({ total: z.int() }),
    });
    if (extracted.total > params.limit) {
      await step.decision("review", {
        description: "Ask the reviewer to approve it",
        from: params.reviewer,
        ask: async () => {},
        timeout: "7 days",
      });
    }
    return await step.do(
      "book",
      { description: "Book the invoice", sideEffect: true, input: { total: extracted.total } },
      async () => "booked"
    );
  }
);
`;

const approveTests = `import { workflowTests } from "@grasp-os/sdk/testing";

import approve from "./approve.ts";

export default workflowTests(approve, [
  {
    name: "books a large invoice once approved",
    input: { text: "Total €8,000" },
    mocks: { extract: { total: 800_000 } },
    decisions: { review: { approved: true, by: "anna" } },
    expect: {},
  },
]);
`;

/**
 * How long a page may take to show what core said: it reads core within
 * a few seconds a read (apps/web/src/core.ts), and a Test builds and runs
 * the workflow's tests first.
 */
const pageRead = { timeout: 20_000 };

/** Runs `run` with `person`'s API over `/rpc`, closed after. */
const withApi = async <T>(
  person: Person,
  run: (api: ReturnType<typeof apiOf>["api"]) => Promise<T>
): Promise<T> => {
  const { core, api } = apiOf(person);
  try {
    return await run(api);
  } finally {
    core[Symbol.dispose]();
  }
};

/**
 * A new App of `builder`'s, shared with `user`, with a run of `approval`
 * waiting for its decision, asked of `builder` alone: every admin would
 * be too many in a local database that keeps earlier runs' people.
 */
const appWithWaitingRun = async (
  builder: Person,
  user: Person,
  name: string
): Promise<string> =>
  await withApi(builder, async (api) => {
    const { id } = await api.apps.create({ name });
    await release(
      api,
      id,
      {
        "workflows/approval.ts": approval,
        "workflows/approval.workflow-tests.ts": approvalTests,
        "workflows/approve.ts": approve,
        "workflows/approve.workflow-tests.ts": approveTests,
      },
      "Invoice approvals"
    );
    await api.apps.members.add(id, {
      type: "person",
      id: user.userId,
      role: "user",
    });
    await api.workflows.params.set(
      id,
      "approval",
      "reviewer",
      `person:${builder.userId}`
    );
    const run = await api.workflows.start(id, "approval");
    await expect(async () => {
      const waiting = await api.workflows.runs({ app: id, status: "waiting" });
      expect(waiting.runs.map(({ id: runId }) => runId)).toStrictEqual([
        run.id,
      ]);
    }).toPass({ timeout: 30_000 });
    return id;
  });

test("a builder follows a waiting run to its decision, then changes and tests a workflow", async ({
  browser,
}) => {
  const { builder, user } = peopleIn("workflows");
  const name = `Invoices ${crypto.randomUUID()}`;
  const app = await appWithWaitingRun(builder, user, name);

  const page = await pageOf(browser, builder);
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Workflows" })
    .click();
  const rows = page.getByRole("row").filter({ hasText: name });
  await expect(rows).toHaveCount(2, pageRead);
  await expect(rows.first().getByRole("cell")).toHaveText([
    "approval",
    name,
    "1",
    "You",
    /^Waiting for a decision, /u,
    "1",
    "0",
  ]);

  // The waiting run comes first on the Runs tab, with where to decide it.
  await page.getByRole("tab", { name: "Runs" }).click();
  const first = page.getByRole("row").nth(1);
  await expect(first).toContainText("Waiting for a decision", pageRead);
  await first.getByRole("link", { name: "Decide" }).click();
  await expect(
    page.getByRole("heading", { name: "Approve invoice INV-7" })
  ).toBeVisible(pageRead);

  // The workflow view: its steps, a parameter changed, and a Test with it.
  await page.goto(`/workflows/${app}/approve`);
  await expect(
    page.getByRole("heading", { level: 1, name: "approve" })
  ).toBeVisible(pageRead);
  const steps = page.getByRole("tabpanel");
  await expect(steps.getByText("Read the invoice's total")).toBeVisible();
  await expect(steps.getByText("AI", { exact: true })).toBeVisible();
  await expect(steps.getByText("Decision", { exact: true })).toBeVisible();
  await expect(
    steps.getByText("If extracted.total > params.limit:")
  ).toBeVisible();

  await page.getByRole("tab", { name: "Parameters" }).click();
  const limit = page.getByRole("textbox", { name: "Review invoices above" });
  await expect(limit).toHaveValue("5000");
  const saveLimit = page
    .getByRole("form", { name: "Review invoices above" })
    .getByRole("button", { name: "Save" });
  // More decimals than euros have: refused, not rounded.
  await limit.fill("1.005");
  await expect(
    page.getByText("An amount in EUR has at most 2 decimals.")
  ).toBeVisible();
  await expect(saveLimit).toBeDisabled();
  await limit.fill("10000");
  await page
    .getByRole("form", { name: "Review invoices above" })
    .getByRole("button", { name: "Save" })
    .click();
  await expect(page.getByRole("status")).toHaveText("Saved.", pageRead);
  await withApi(builder, async (api) => {
    const params = await api.workflows.params.list(app, "approve");
    expect(params.find(({ name: param }) => param === "limit")?.value).toBe(
      1_000_000
    );
  });
  // Another tab and back: the field shows what was saved, with nothing
  // left to save.
  await page.getByRole("tab", { name: "Steps" }).click();
  await page.getByRole("tab", { name: "Parameters" }).click();
  await expect(limit).toHaveValue("10000");
  await expect(
    page
      .getByRole("form", { name: "Review invoices above" })
      .getByRole("button", { name: "Save" })
  ).toBeDisabled();

  await page.getByRole("button", { name: "Test" }).click();
  const dialog = page.getByRole("dialog", { name: "Test of approve" });
  const report = dialog.getByText(/^Dry run of approve/u);
  await expect(report).toBeVisible(pageRead);
  // Above the invoice's total now: nobody is asked, and it books.
  await expect(report).toContainText('- book {"total":800000}');
  await expect(report).not.toContainText("review#ask");
});

test("someone an App is shared with reads its workflow, with nothing to change or test", async ({
  browser,
}) => {
  const { builder, user } = peopleIn("workflows");
  const name = `Invoices ${crypto.randomUUID()}`;
  const app = await appWithWaitingRun(builder, user, name);

  const page = await pageOf(browser, user);
  // Core refuses the App's contents, as for an App it doesn't have: the
  // Runs tab's Workflow filter can't offer its workflows.
  await page.routeWebSocket("**/rpc", (socket) => {
    const toCore = socket.connectToServer();
    socket.onMessage((message) => {
      const text = String(message);
      toCore.send(
        text.includes('"contents"') ? text.replaceAll(app, "missing") : text
      );
    });
  });
  await page.goto(`/workflows/${app}/approve`);
  await expect(
    page.getByRole("heading", { level: 1, name: "approve" })
  ).toBeVisible(pageRead);
  await expect(page.getByText("Read the invoice's total")).toBeVisible();
  // The steps without their code: no condition, only that there is one.
  await expect(page.getByText("Only when a condition holds:")).toBeVisible();
  await expect(page.getByText("params.limit")).toHaveCount(0);
  await expect(page.getByRole("tab")).toHaveText(["Steps", "History"]);
  await expect(page.getByRole("button", { name: "Test" })).toHaveCount(0);

  // The run waits for the builder's answer, not theirs: no link to decide.
  await page.goto(`/workflows?tab=runs&app=${app}`);
  const first = page.getByRole("row").nth(1);
  await expect(first).toContainText("Waiting for a decision", pageRead);
  await expect(first.getByRole("link", { name: "Decide" })).toHaveCount(0);
  // The App's workflows couldn't be read: the filter says so, and its runs
  // are listed all the same.
  await expect(
    page.getByText("Couldn't load this App's workflows.")
  ).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Workflow" })).toBeDisabled();
});
