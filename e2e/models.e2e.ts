import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import { test } from "./csp.ts";
import { pageOf, peopleIn } from "./people.ts";

// The Models page: an admin reads the models the deployment allows, its
// EU routing and data rules, and its budgets with this month's spend, as
// the stack's gateway config sets them (playwright.config.ts). The spend
// itself, which only model calls add to, is core's test.

/** A section of the page, by its heading. */
const sectionOf = (page: Page, name: string) =>
  page.getByRole("region", { name, exact: true });

test("an admin reads the allowed models, the rules and the budgets, and nobody else does", async ({
  browser,
}) => {
  const { admin, builder } = peopleIn("models");
  const page = await pageOf(browser, admin);
  await page.goto("/models");

  await expect(page.getByText("To change them, contact Grasp.")).toBeVisible();
  const allowed = sectionOf(page, "Allowed models").getByRole("row", {
    name: /gpt-oss-120b/u,
  });
  await expect(allowed).toContainText("Hosted in the EU");
  await expect(allowed).not.toContainText("Takes sensitive data");
  await expect(sectionOf(page, "EU routing")).toContainText(
    "Every call stays in the EU: yes."
  );
  await expect(sectionOf(page, "Data rules")).toContainText(
    "There is no data rule"
  );
  const budgets = sectionOf(page, "Budgets");
  await expect(budgets.getByRole("heading", { level: 3 })).toHaveText([
    "All calls together",
    "Each person",
  ]);
  await expect(budgets).toContainText(
    "$250.00 a month, admins alerted at 80%."
  );
  await expect(budgets).toContainText("$20.00 a month, admins alerted at 80%.");
  await expect(page.getByRole("button")).toHaveCount(1);

  const refused = await pageOf(browser, builder);
  await refused.goto("/models");
  await expect(refused.getByRole("alert")).toHaveText(
    "Your role doesn't allow that."
  );
});
