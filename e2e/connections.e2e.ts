import { composioConsentText } from "@grasp-os/shared/connect";
import { expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

import { seededConnections, seededTools } from "./connections-seed.ts";
import type { SeededConnection } from "./connections-seed.ts";
import { test } from "./csp.ts";
import { apiOf, pageOf, peopleIn } from "./people.ts";

// The Connections page: a person finds the account they connected, with
// what it reaches, and disconnects one; an admin sees which Apps hold a
// permission for a shared connection and revokes it there, and reads a
// Composio connection's consent. The connections are what finished flows
// leave behind (e2e/connections-seed.ts): the flows through Entra and
// Composio are core's tests.

/** A section of the page, by its heading. */
const sectionOf = (page: Page, name: string): Locator =>
  page.getByRole("region", { name, exact: true });

/** The card for `connection` in `section`, by its name and account. */
const cardOf = (
  section: Locator,
  name: string,
  { account }: SeededConnection
): Locator =>
  section.getByRole("listitem").filter({
    has: section.page().getByRole("heading", {
      level: 3,
      name: `${name} (${account})`,
    }),
  });

test("a person comes back from connecting Microsoft 365, sees it with its scope, and disconnects one that needs connecting again", async ({
  browser,
}) => {
  const { user } = peopleIn("connections");
  const { mine, expired } = seededConnections();
  const page = await pageOf(browser, user);
  // A link can name any ID: only a connection the page lists is news.
  await page.goto(`/connections?connection=${crypto.randomUUID()}`);
  await expect(
    sectionOf(page, "My connections").getByRole("listitem").first()
  ).toBeVisible();
  await expect(page.getByRole("status")).toHaveCount(0);
  // Where core's callback sends the browser once a flow finished.
  await page.goto(`/connections?connection=${mine.id}`);
  await expect(page.getByRole("status")).toHaveText("Connected.");

  const own = sectionOf(page, "My connections");
  const mineCard = cardOf(own, "Microsoft 365", mine);
  await expect(mineCard.getByText("Native")).toBeVisible();
  await expect(mineCard.getByRole("definition")).toHaveText([
    "Active",
    "Personal: only you can use it",
    mine.account,
    "You",
    /\S/u,
  ]);

  // Still holding its account, it offers Disconnect, and says why.
  const expiredCard = cardOf(own, "Microsoft 365", expired);
  await expect(expiredCard.getByText("Needs connecting again")).toBeVisible();
  await expect(
    expiredCard.getByText("Disconnect it, then connect it again.")
  ).toBeVisible();
  await expiredCard
    .getByRole("button", {
      name: `Disconnect Microsoft 365 (${expired.account})`,
    })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Disconnect" })
    .click();
  await expect(expiredCard).toHaveCount(0);
  await expect(mineCard).toBeVisible();
  // The notice was about the flow that came back, not about the page now.
  await expect(page.getByRole("status")).toHaveCount(0);
  expect(new URL(page.url()).search).toBe("");

  // Connecting it again before disconnecting comes back refused, and says
  // what to do; a code nobody knows says only the page's own words.
  await page.goto("/connections?connectionError=connection.already_connected");
  await expect(page.getByRole("alert")).toHaveText(
    "That account is already connected here. Disconnect it first to connect it again."
  );
  await page.goto("/connections?connectionError=%3Cb%3Eclick%20here%3C%2Fb%3E");
  await expect(page.getByRole("alert")).toHaveText(
    "Connecting didn't work. Try again, or ask an admin."
  );

  // The test stack has no Microsoft tenant set up: core refuses the start,
  // and the page says so where the person clicked.
  const catalogEntry = sectionOf(page, "Connect")
    .getByRole("listitem")
    .filter({ has: page.getByRole("heading", { name: "Microsoft 365" }) });
  await page.getByLabel("Search").fill("microsoft");
  await catalogEntry
    .getByRole("button", { name: "Connect Microsoft 365" })
    .click();
  await expect(catalogEntry.getByRole("alert")).toHaveText(
    "Connecting this provider isn't set up for this deployment."
  );
  await expect(page).toHaveURL(/\/connections/u);
});

test("an admin sees which Apps can use a shared connection, revokes a permission there, and reads a Composio connection's consent", async ({
  browser,
}) => {
  const { admin } = peopleIn("connections");
  const { mailbox, toolkit } = seededConnections();
  const appName = `Mail triage ${crypto.randomUUID()}`;
  const { core, api } = apiOf(admin);
  try {
    const { id: appId } = await api.apps.create({
      name: appName,
      description: "Sorts the shared mailbox",
    });
    const { id } = await api.permissions.request({
      subject: { type: "app", appId },
      object: { type: "connection", connectionId: mailbox.id },
      actions: ["mail.read"],
      binding: "MAILBOX",
    });
    // Reviewed with no version of the App current yet.
    await api.permissions.grant(id, { version: null });
    // Only asked for, it allows nothing yet: not a holder.
    await api.permissions.request({
      subject: { type: "app", appId },
      object: { type: "connection", connectionId: mailbox.id },
      actions: ["mail.send"],
      binding: "MAILBOX_SEND",
    });
  } finally {
    core[Symbol.dispose]();
  }

  const page = await pageOf(browser, admin);
  await page.goto("/connections");
  const shared = sectionOf(page, "Shared connections");
  const mailboxCard = cardOf(shared, "Microsoft 365", mailbox);
  await expect(mailboxCard.getByRole("definition").nth(1)).toHaveText(
    "Shared: your organization uses it through permissions"
  );
  const holder = mailboxCard.getByRole("listitem").filter({ hasText: appName });
  await expect(holder).toContainText(
    `App ${appName}: mail.read on the whole connection`
  );
  await expect(holder).toHaveCount(1);
  await holder
    .getByRole("button", { name: `Revoke App ${appName}'s permission` })
    .click();
  await expect(holder).toHaveCount(0);
  await expect(mailboxCard.getByText("None.")).toBeVisible();

  // Composio holds this one's tokens: who consented, to what, for which tools.
  const toolkitCard = cardOf(shared, "hubspot", toolkit);
  await expect(toolkitCard.getByText("Via Composio")).toBeVisible();
  await expect(toolkitCard.getByText(composioConsentText)).toBeVisible();
  await expect(toolkitCard).toContainText(
    `Tools allowed: ${seededTools.join(", ")}`
  );
});
