import { expect } from "@playwright/test";

import { test } from "./csp.ts";
import { apiOf, pageOf, peopleIn } from "./people.ts";

// The board page, the built-in App, end to end: an admin creates an App
// from it, approves the Playbook permission it asks for, takes a snapshot
// of a Playbook full of workflows, writes its narrative and decision, and
// prints it: the page alone, on one sheet of A4.

const boardPage = "builtin-board-page";

/**
 * How long the release's install may take to list the built-in: it runs
 * on the first request, in the background.
 */
const installedMs = 30_000;

/** Workflows seeded: more than each list on the page shows. */
const seeded = 8;

/** A decision long enough to be cut short in print. */
const decision =
  `Automate answering tenders next quarter? ${"It takes most of our hours, and the design saves nine of every ten. ".repeat(6)}`.trim();

/** A sheet of A4 in CSS pixels, as a PDF of it has no margins. */
const a4 = { width: 794, height: 1123 };

/** The pages in a PDF: its page objects, not the page tree (`/Pages`). */
const pageObject = /\/Type\s*\/Page(?![a-z])/gu;

test("an admin takes a snapshot on the board page, writes its narrative and prints it on one page", async ({
  browser,
}) => {
  const { admin } = peopleIn("boardPage");
  const run = crypto.randomUUID().slice(0, 8);
  const { core, api } = apiOf(admin);
  let app: string;
  try {
    await expect
      .poll(
        async () => {
          const listed = await api.apps.blueprints.list();
          return listed.some((blueprint) => blueprint.app === boardPage);
        },
        { timeout: installedMs }
      )
      .toBeTruthy();
    const listed = await api.apps.blueprints.list();
    const version =
      listed.find((blueprint) => blueprint.app === boardPage)?.version ?? 1;
    const created = await api.apps.blueprints.create(boardPage, version, {
      name: `Board page ${run}`,
    });
    for (const { id } of created.permissions) {
      // oxlint-disable-next-line no-await-in-loop -- one grant at a time
      await api.permissions.grant(id);
    }
    await api.apps.versions.setCurrent(created.app.id, 1);
    app = created.app.id;
    // A first snapshot sets the Playbook up, if no test has yet.
    await api.screens.call(app, "take", [{ maturity: 0 }]);
    // The Playbook is the deployment's: other runs' workflows are in it
    // too, and the page shows the top ones of all of them.
    for (let index = 1; index <= seeded; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one save at a time
      await api.knowledge.saveDocument({
        collectionId: "playbook",
        path: `workflows/board-${run}-${index}.md`,
        ifVersion: 0,
        text: [
          "---",
          "type: workflow",
          `title: A workflow with a long name to wrap, number ${index} of run ${run}`,
          "state: drawn",
          "steps:",
          "  - name: Do it",
          "    numbers:",
          `      frequency: { value: ${index * 10}, basis: estimated }`,
          "      minutes: { value: 30, basis: estimated }",
          "---",
          "",
        ].join("\n"),
      });
    }
  } finally {
    core[Symbol.dispose]();
  }

  const page = await pageOf(browser, admin);
  await page.goto(`/apps/${app}/screens/board`);
  const screen = page.frameLocator('iframe[title="board screen"]');
  // The first open builds the screen, which takes a while on a loaded machine.
  await expect(screen.getByRole("heading", { name: "Board page" })).toBeVisible(
    { timeout: 20_000 }
  );

  await screen.getByRole("combobox", { name: "Maturity" }).click();
  await screen.getByRole("option", { name: "Maturity 2 of 5" }).click();
  await screen.getByRole("button", { name: "Take a snapshot" }).click();
  const board = screen.getByRole("article", { name: "Board page" });
  await expect(board.getByText("Maturity 2 of 5")).toBeVisible();
  await expect(
    board.getByRole("table", { name: "Where the hours go" }).getByRole("row")
  ).toHaveCount(6);

  await screen.getByLabel("Edit the decision needed").fill(decision);
  await screen
    .getByLabel("Edit the narrative")
    .fill(
      Array.from(
        { length: 30 },
        (_, line) =>
          `Line ${line + 1}: where we stand, what changed and what comes next.`
      ).join("\n")
    );
  await screen.getByRole("button", { name: "Save" }).click();
  await expect(board.getByText(decision)).toBeVisible();

  // Printed on A4 (at 96 pixels an inch, without margins): the page alone,
  // without the controls or the App's chrome. The screen's frame fills the
  // sheet and clips what doesn't fit, so the page must fit in the frame,
  // and the sheet be the only one.
  await page.setViewportSize(a4);
  await page.emulateMedia({ media: "print" });
  await expect(board).toBeVisible();
  await expect(
    screen.getByRole("button", { name: "Take a snapshot" })
  ).toBeHidden();
  await expect(screen.getByLabel("Edit the narrative")).toBeHidden();
  await expect(page.getByText("App screen")).toBeHidden();
  const frame = page
    .frames()
    .find((each) => each.url().includes("/screen-frame"));
  const fit = await frame?.evaluate(() => ({
    height: document.documentElement.scrollHeight,
    room: window.innerHeight,
  }));
  expect(fit?.room).toBe(a4.height);
  expect(fit?.height).toBeLessThanOrEqual(a4.height);
  const pdf = await page.pdf({ format: "A4", printBackground: true });
  expect(pdf.toString("latin1").match(pageObject)).toHaveLength(1);

  // Paper is light: printed from the dark theme, the screen's colours are
  // the light theme's.
  const colours = async () =>
    await frame?.evaluate(() => ({
      dark: document.documentElement.classList.contains("dark"),
      background: getComputedStyle(document.body).backgroundColor,
      text: getComputedStyle(document.body).color,
    }));
  const light = await colours();
  await page.emulateMedia({ media: "print", colorScheme: "dark" });
  await expect
    .poll(async () => {
      const now = await colours();
      return now?.dark;
    })
    .toBeTruthy();
  expect(await colours()).toStrictEqual({ ...light, dark: true });
});
