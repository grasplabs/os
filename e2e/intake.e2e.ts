import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import { test } from "./csp.ts";
import { apiOf, pageOf, peopleIn } from "./people.ts";
import type { Person } from "./people.ts";
import { revokeOtherCopies } from "./playbook.ts";

// The intake, the built-in App, end to end: an admin creates an App from
// it, approves the Playbook permission it asks for, takes an interview as
// a draft with its statements and tags, keeps it, reviews it again from
// the list, retags a statement, and saves it: the source and its
// statements are then in the Playbook, and the draft is gone. And sends
// notes to be read by a model, following the reading on the screen.

const intake = "builtin-intake";

/**
 * How long the release's install may take to list the built-in: it runs
 * on the first request, in the background.
 */
const installedMs = 30_000;

/** An App `admin` created from the intake, its Playbook approved. */
const intakeFor = async (admin: Person): Promise<string> => {
  const { core, api } = apiOf(admin);
  try {
    await expect
      .poll(
        async () => {
          const listed = await api.apps.blueprints.list();
          return listed.some((blueprint) => blueprint.app === intake);
        },
        { timeout: installedMs }
      )
      .toBeTruthy();
    const listed = await api.apps.blueprints.list();
    const version =
      listed.find((blueprint) => blueprint.app === intake)?.version ?? 1;
    const created = await api.apps.blueprints.create(intake, version, {
      name: `Intake ${crypto.randomUUID().slice(0, 8)}`,
    });
    await revokeOtherCopies(api, intake, created.app.id);
    for (const { id } of created.permissions) {
      // Reviewed before a version of the copy is current.
      // oxlint-disable-next-line no-await-in-loop -- one grant at a time
      await api.permissions.grant(id, { version: null });
    }
    await api.apps.versions.setCurrent(created.app.id, 1);
    return created.app.id;
  } finally {
    core[Symbol.dispose]();
  }
};

/** The intake's screen in `page`, once it shows. */
const openIntake = async (page: Page, app: string) => {
  await page.goto(`/apps/${app}/screens/intake`);
  const screen = page.frameLocator('iframe[title="intake screen"]');
  // The first open builds the screen, which takes a while on a loaded machine.
  await expect(screen.getByRole("heading", { name: "Intake" })).toBeVisible({
    timeout: 20_000,
  });
  return screen;
};

/** The Playbook's documents whose paths start with `prefix`, by path. */
const playbookPaths = async (
  person: Person,
  prefix: string
): Promise<string[]> => {
  const { core, api } = apiOf(person);
  try {
    const { documents } = await api.knowledge.listDocuments("playbook", {
      after: prefix.slice(0, -1),
    });
    return documents
      .map(({ path }) => path)
      .filter((path) => path.startsWith(prefix));
  } finally {
    core[Symbol.dispose]();
  }
};

test("an admin takes an interview as a draft, reviews it again, and saves its tagged statements to the Playbook", async ({
  browser,
}) => {
  const { admin } = peopleIn("intake");
  const tag = crypto.randomUUID().slice(0, 8);
  const title = `Interview ${tag}`;
  const app = await intakeFor(admin);
  const page = await pageOf(browser, admin);
  const screen = await openIntake(page, app);

  await screen.getByRole("button", { name: "New source" }).click();
  await screen.getByLabel("Source title").fill(title);
  await screen.getByLabel("Date").fill("2026-09-21");
  await screen.getByLabel("From").fill("Anna, controller");
  await screen.getByRole("button", { name: "Add a statement" }).click();
  await screen
    .getByLabel("Statement 1", { exact: true })
    .fill("Closing takes three days.");
  // Not kept until every statement has a tag.
  await expect(screen.getByText("Tag statement 1.")).toBeVisible();
  await screen
    .getByRole("checkbox", { name: "Time sink, statement 1" })
    .click();
  await screen.getByRole("button", { name: "Add a statement" }).click();
  await screen
    .getByLabel("Statement 2", { exact: true })
    .fill("Close should take a day.");
  await screen.getByRole("checkbox", { name: "Goal, statement 2" }).click();
  await screen.getByRole("button", { name: "Keep as a draft" }).click();
  await expect(screen.getByRole("heading", { name: "Review" })).toBeVisible();

  // Back to the list, and reviewed again from it.
  await screen.getByRole("button", { name: "Back" }).click();
  const drafts = screen.getByRole("table", { name: "Drafts" });
  const row = drafts.getByRole("row").filter({ hasText: title });
  await expect(row.getByRole("cell")).toHaveText([
    title,
    "Typed in",
    "2026-09-21",
    "2",
    "Review",
  ]);
  await row.getByRole("button", { name: `Review ${title}` }).click();
  await expect(screen.getByLabel("Statement 2", { exact: true })).toHaveValue(
    "Close should take a day."
  );
  await screen.getByRole("checkbox", { name: "Handover, statement 1" }).click();
  await screen.getByRole("button", { name: "Save to the Playbook" }).click();
  await expect(screen.getByRole("status")).toHaveText(
    "Saved to the Playbook: 2 statements and their source."
  );
  await expect(drafts.getByRole("row").filter({ hasText: title })).toHaveCount(
    0
  );

  const stem = `2026-09-21-interview-${tag}-`;
  await expect
    .poll(async () => await playbookPaths(admin, `sources/${stem}`))
    .toHaveLength(1);
  const [source] = await playbookPaths(admin, `sources/${stem}`);
  const statementsStem = (source ?? "")
    .replace(/^sources\//u, "statements/")
    .replace(/\.md$/u, "-");
  expect(await playbookPaths(admin, statementsStem)).toStrictEqual([
    `${statementsStem}1.md`,
    `${statementsStem}2.md`,
  ]);
});

test("an admin sends notes to be read, and follows the reading to its end", async ({
  browser,
}) => {
  const { admin } = peopleIn("intake");
  const title = `Notes ${crypto.randomUUID().slice(0, 8)}`;
  const app = await intakeFor(admin);
  const page = await pageOf(browser, admin);
  const screen = await openIntake(page, app);

  await screen.getByRole("button", { name: "Read notes" }).click();
  const start = screen.getByRole("button", { name: "Take out statements" });
  await expect(start).toBeDisabled();
  await screen.getByLabel("Source title").fill(title);
  await screen
    .getByLabel("Notes", { exact: true })
    .fill("Closing the month takes three days.");
  await start.click();

  // Followed live. The local stack reaches no model, and doesn't allow
  // the workflow's model, so the reading fails, saying so, and keeps no
  // draft; core's tests read notes with a scripted model
  // (apps/core/test/intake.test.ts).
  const reading = screen.getByRole("region", { name: "Notes being read" });
  const item = reading.getByRole("listitem").filter({ hasText: title });
  await expect(item).toContainText("Failed:", { timeout: 30_000 });
  await item.getByRole("button", { name: "Dismiss" }).click();
  await expect(reading).toHaveCount(0);
  await expect(screen.getByText(title)).toHaveCount(0);
});

test("an admin invites a stakeholder, who opens the link without an account, writes, and finishes the chat", async ({
  browser,
}) => {
  const { admin } = peopleIn("intake");
  const name = `Ben ${crypto.randomUUID().slice(0, 8)}`;
  const app = await intakeFor(admin);
  const page = await pageOf(browser, admin);
  const screen = await openIntake(page, app);

  const chats = screen;
  await chats.getByLabel("Name").fill(name);
  await chats.getByRole("button", { name: "Invite" }).click();
  const linkField = chats.getByLabel(`Link for ${name}`);
  await expect(linkField).toBeVisible();
  const link = await linkField.inputValue();
  expect(new URL(link).pathname).toBe("/guest");

  // The guest: a browser with nobody signed in.
  const context = await browser.newContext();
  const guestPage = await context.newPage();
  await guestPage.goto(link);
  await expect(
    guestPage.getByRole("heading", { name: `Hi ${name}` })
  ).toBeVisible();
  await guestPage.getByLabel("Your message").fill("I approve invoices.");
  await guestPage.getByRole("button", { name: "Send" }).click();
  // The local stack reaches no model: the message isn't taken, and says
  // so, and what was typed stays to send again.
  await expect(guestPage.getByRole("alert")).toHaveText(
    "The chat can't answer right now. Try sending it again in a while."
  );
  await expect(guestPage.getByLabel("Your message")).toHaveValue(
    "I approve invoices."
  );
  await guestPage.getByRole("button", { name: "Finish" }).click();
  await expect(guestPage.getByRole("status")).toHaveText(
    "You finished this chat. Thank you for your time."
  );
  await expect(guestPage.getByRole("button", { name: "Send" })).toHaveCount(0);

  // Another link pasted over this one opens that one, never this chat
  // with its secret: a made-up one opens nothing.
  await guestPage.evaluate((made) => {
    window.location.hash = made;
  }, "A".repeat(43));
  await expect(
    guestPage.getByRole("heading", { name: `Hi ${name}` })
  ).toHaveCount(0);
  await expect(guestPage.getByRole("alert")).toHaveText(
    "This link doesn't work. Ask whoever sent it for a new one."
  );
  await context.close();

  // Back on the intake: the chat has ended.
  await page.reload();
  const again = await openIntake(page, app);
  const row = again
    .getByRole("table", { name: "Stakeholder chats" })
    .getByRole("row")
    .filter({ hasText: name });
  await expect(row.getByRole("cell").nth(1)).toHaveText("finished");
});
