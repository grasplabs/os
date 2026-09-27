import { expect } from "@playwright/test";
import type { FrameLocator, Page } from "@playwright/test";

import { test } from "./csp.ts";
import { invoiceAppFiles } from "./invoice-app.ts";
import { apiOf, pageOf, peopleIn, release } from "./people.ts";
import type { Person } from "./people.ts";

// Screens and workflows in one App, end to end, with the sample invoice
// App: a screen starts the intake workflow and sees its run change live;
// its reviewer answers on the same screen, open elsewhere, and
// everyone with it open sees "waiting" go; and what the workflow's steps
// write to the App's data reaches every open screen without a refresh.

/**
 * How long a screen may take to show what changed: a push through core
 * and the page, then a read of the runs back the same way. A first build
 * of the screen comes before it, with its own wait (`openIntake`).
 */
const live = { timeout: 30_000 };

/**
 * A new App running the sample, released by `builder`, whose intake asks
 * `reviewer` alone: every admin would be too many in a local database
 * that keeps the people of every earlier run.
 */
const releaseApp = async (
  builder: Person,
  reviewer: Person
): Promise<string> => {
  const { core, api } = apiOf(builder);
  try {
    const { id } = await api.apps.create({ name: "Invoices" });
    await release(api, id, invoiceAppFiles, "Invoice intake");
    await api.workflows.params.set(
      id,
      "invoice-intake",
      "reviewer",
      `person:${reviewer.userId}`
    );
    return id;
  } finally {
    core[Symbol.dispose]();
  }
};

/**
 * Opens the intake screen, once it shows. The first open of an App's
 * screen builds it, which on a loaded machine takes longer than the
 * default 5 seconds.
 */
const openIntake = async (page: Page, app: string): Promise<FrameLocator> => {
  await page.goto(`/apps/${app}/screens/intake`);
  const screen = page.frameLocator('iframe[title="intake screen"]');
  await expect(screen.getByRole("heading", { name: "Invoices" })).toBeVisible({
    timeout: 20_000,
  });
  return screen;
};

const runsOn = (screen: FrameLocator) =>
  screen.getByRole("list", { name: "Runs" }).getByRole("listitem");

const invoicesOn = (screen: FrameLocator) =>
  screen.getByRole("list", { name: "Invoices" }).getByRole("listitem");

test("a screen starts a run and follows it live, and an answer on another screen continues it for everyone", async ({
  browser,
}) => {
  const { builder, admin } = peopleIn("screenWorkflows");
  const app = await releaseApp(builder, admin);
  const [first, second] = await Promise.all([
    pageOf(browser, builder),
    pageOf(browser, admin),
  ]);
  const [starter, reviewer] = await Promise.all([
    openIntake(first, app),
    openIntake(second, app),
  ]);

  await starter.getByRole("button", { name: "Start intake" }).click();

  // Both see the run wait for its review, and the invoice its first step
  // marked received, without a refresh.
  await Promise.all(
    [starter, reviewer].flatMap((screen) => [
      expect(runsOn(screen)).toHaveText(["waitingApprove review"], live),
      expect(invoicesOn(screen)).toHaveText(["INV-7: received"], live),
    ])
  );

  await reviewer.getByRole("button", { name: "Approve review" }).click();

  // The run goes on: nobody sees it waiting any more, it completes, and
  // its last step books the invoice, on every screen.
  await Promise.all(
    [starter, reviewer].flatMap((screen) => [
      expect(runsOn(screen)).toHaveText(["completed"], live),
      expect(invoicesOn(screen)).toHaveText(["INV-7: booked"], live),
    ])
  );
});
