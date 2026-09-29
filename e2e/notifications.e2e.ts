import { expect } from "@playwright/test";

import { test } from "./csp.ts";
import { apiOf, pageOf, peopleIn, release } from "./people.ts";

// A failed run, end to end: the person it acted for finds it counted in
// the nav, reads it on the Notifications page, and asks the agent to fix
// it, which opens a new chat with the question asked. The local stack
// reaches no model, so the answer is the gateway's failure; what the agent
// is handed, and who may ask, are core's tests
// (apps/core/test/run-fixes.test.ts).

/** Fails in its one step, with the workflow's own words. */
const careless = `import { workflow, z } from "@grasp-os/sdk/workflow";

export default workflow("careless", { input: z.unknown(), params: {} }, async (step) => {
  await step.do("check", { description: "Check the customer" }, async () => {
    throw new Error("Customer c-1 is blocked");
  });
});
`;

const carelessTests = `import { workflowTests } from "@grasp-os/sdk/testing";

import careless from "./careless.ts";

export default workflowTests(careless, [
  { name: "checks", mocks: { check: null }, expect: {} },
]);
`;

/** How long a page may take to show what core said. */
const pageRead = { timeout: 20_000 };

test("the person a run acted for is told it failed, and asks the agent to fix it", async ({
  browser,
}) => {
  const { builder } = peopleIn("notifications");
  const name = `Customers ${crypto.randomUUID()}`;
  const { core, api } = apiOf(builder);
  try {
    const { id } = await api.apps.create({ name });
    await release(
      api,
      id,
      {
        "workflows/careless.ts": careless,
        "workflows/careless.workflow-tests.ts": carelessTests,
      },
      "Customer checks"
    );
    const run = await api.workflows.start(id, "careless");
    await expect(async () => {
      const { status } = await api.workflows.status(run.id);
      expect(status).toBe("failed");
    }).toPass({ timeout: 30_000 });
  } finally {
    core[Symbol.dispose]();
  }

  const page = await pageOf(browser, builder);
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Main" });
  await nav.getByRole("link", { name: "Notifications 1 unread" }).click();
  const item = page
    .getByRole("list", { name: "Notifications" })
    .getByRole("listitem")
    .filter({ hasText: name });
  await expect(item).toContainText(`careless in ${name} failed`, pageRead);
  // Read now: the nav counts none.
  await expect(nav.getByRole("link", { name: "Notifications" })).toHaveText(
    "Notifications"
  );

  await item.getByRole("button", { name: "Ask the agent to fix" }).click();
  await expect(page).toHaveURL(/[?&]chat=/u, pageRead);
  await expect(
    page.getByRole("heading", { level: 1, name: "Fix careless" })
  ).toBeVisible(pageRead);
  const messages = page.getByRole("list", { name: "Messages" });
  await expect(messages.getByRole("listitem").first()).toContainText(
    "Its failure report is attached to this chat"
  );
  // Nothing of what the workflow wrote is in the question.
  await expect(messages.getByRole("listitem").first()).not.toContainText(
    "Customer c-1 is blocked"
  );
});
