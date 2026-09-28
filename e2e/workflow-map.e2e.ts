import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import { test } from "./csp.ts";
import { apiOf, pageOf, peopleIn } from "./people.ts";
import type { Person } from "./people.ts";

// The workflow map, the built-in App, end to end: an admin creates an App
// from it, approves the Playbook permission it asks for, draws a workflow
// with numbers and sees its totals, then designs it and sees the gain;
// someone it's shared with who can't change the Playbook reads it only.
// And the editor keeps what is typed: numbers that would pass the
// Playbook's limits say so instead of failing the save, nothing can be
// typed while a save is on its way (the saved version replaces the editor
// once it is open), and linking or going back never drops unsaved edits
// unseen. An answer to an earlier open, arriving late, never replaces the
// workflow opened since.

const workflowMap = "builtin-workflow-map";

/**
 * How long the release's install may take to list the built-in: it runs
 * on the first request, in the background.
 */
const installedMs = 30_000;

/** An App `admin` created from the workflow map, its Playbook approved. */
const mapFor = async (admin: Person): Promise<string> => {
  const { core, api } = apiOf(admin);
  try {
    await expect
      .poll(
        async () => {
          const listed = await api.apps.blueprints.list();
          return listed.some((blueprint) => blueprint.app === workflowMap);
        },
        { timeout: installedMs }
      )
      .toBeTruthy();
    const listed = await api.apps.blueprints.list();
    const version =
      listed.find((blueprint) => blueprint.app === workflowMap)?.version ?? 1;
    const created = await api.apps.blueprints.create(workflowMap, version, {
      name: `Workflow map ${crypto.randomUUID().slice(0, 8)}`,
    });
    expect(
      created.permissions.map(({ object, actions, binding }) => ({
        object,
        actions,
        binding,
      }))
    ).toStrictEqual([
      {
        object: { type: "collection", collectionId: "playbook" },
        actions: ["read", "write"],
        binding: "PLAYBOOK",
      },
    ]);
    for (const { id } of created.permissions) {
      // oxlint-disable-next-line no-await-in-loop -- one grant at a time
      await api.permissions.grant(id);
    }
    await api.apps.versions.setCurrent(created.app.id, 1);
    return created.app.id;
  } finally {
    core[Symbol.dispose]();
  }
};

/** The map's screen in `page`, once it shows. */
const openMap = async (page: Page, app: string) => {
  await page.goto(`/apps/${app}/screens/map`);
  const screen = page.frameLocator('iframe[title="map screen"]');
  // The first open builds the screen, which takes a while on a loaded machine.
  await expect(
    screen.getByRole("heading", { name: "Workflow map" })
  ).toBeVisible({ timeout: 20_000 });
  return screen;
};

test("an admin copies the workflow map, approves its Playbook, draws a workflow and sees its totals, then its expected gain", async ({
  browser,
}) => {
  const { admin, reader } = peopleIn("workflowMap");
  // The Playbook is the deployment's: other runs' workflows are in it too.
  const title = `Pay supplier invoices ${crypto.randomUUID().slice(0, 8)}`;
  const app = await mapFor(admin);
  const page = await pageOf(browser, admin);
  const screen = await openMap(page, app);

  await screen.getByRole("button", { name: "Draw a workflow" }).click();
  await screen.getByLabel("Title", { exact: true }).fill(title);
  await screen.getByRole("button", { name: "Add a step" }).click();
  await screen.getByLabel("Name, step 1").fill("Match the invoice");
  await screen.getByLabel("Who, step 1").fill("Controller");
  await screen.getByRole("checkbox", { name: "Handover, step 1" }).click();
  // 30 times a week, 10 minutes, 2 people: 10 hours a week.
  await screen.getByLabel("Times a week, step 1").fill("30");
  await screen.getByLabel("Minutes, step 1").fill("10");
  await screen.getByLabel("People, step 1").fill("2");
  const totals = screen.getByRole("definition");
  await expect(totals).toHaveText(["10 h", "1", "1", "estimated"]);

  await screen.getByRole("button", { name: "Save" }).click();
  await expect(screen.getByText("Version 1")).toBeVisible();

  // Listed with its totals.
  await screen.getByRole("button", { name: "All workflows" }).click();
  const row = screen.getByRole("row").filter({ hasText: title });
  await expect(row.getByRole("cell")).toHaveText([
    title,
    "drawn",
    "10 h",
    "1",
    "1",
    "",
  ]);

  // Designed beside the drawn version, it shows the hours it saves.
  await row.getByRole("button", { name: title }).click();
  await screen.getByRole("button", { name: "Design it" }).click();
  await expect(screen.getByText("Version 2")).toBeVisible();
  await expect(screen.getByText("Drawn (version 1)")).toBeVisible();
  await screen.getByLabel("Minutes, step 1").fill("1");
  await expect(screen.getByLabel("Expected gain")).toHaveText(
    "Expected gain: 9 h a week"
  );
  await screen.getByRole("button", { name: "Save" }).click();
  await expect(screen.getByText("Version 3")).toBeVisible();
  await screen.getByRole("button", { name: "All workflows" }).click();
  await expect(
    screen.getByRole("row").filter({ hasText: title }).getByRole("cell")
  ).toHaveText([title, "designed", "1 h", "1", "1", "9 h"]);

  // Shared with someone who isn't an admin: they read it, and are offered
  // no change the Playbook would refuse.
  const { core, api } = apiOf(admin);
  try {
    await api.apps.members.add(app, {
      type: "person",
      id: reader.userId,
      role: "user",
    });
  } finally {
    core[Symbol.dispose]();
  }
  const readerPage = await pageOf(browser, reader);
  const readerScreen = await openMap(readerPage, app);
  const listed = readerScreen.getByRole("row").filter({ hasText: title });
  await expect(listed.getByRole("cell")).toHaveText([
    title,
    "designed",
    "1 h",
    "1",
    "1",
    "9 h",
  ]);
  await expect(
    readerScreen.getByRole("button", { name: "Draw a workflow" })
  ).toHaveCount(0);
  await listed.getByRole("button", { name: title }).click();
  await expect(
    readerScreen.getByText(
      "You can read this workflow, but not change it here."
    )
  ).toBeVisible();
  await expect(
    readerScreen.getByLabel("Title", { exact: true })
  ).toBeDisabled();
  await expect(readerScreen.getByRole("button", { name: "Save" })).toHaveCount(
    0
  );
});

test("keeps numbers within the Playbook's limits, and never drops what is typed while saving, linking or going back", async ({
  browser,
}) => {
  const { admin } = peopleIn("workflowMap");
  const title = `Big invoices ${crypto.randomUUID().slice(0, 8)}`;
  const app = await mapFor(admin);
  const page = await pageOf(browser, admin);
  // Core's answers to the page wait while `held` is set, so a save stays
  // on its way until the test lets it land.
  let held: (() => void)[] | undefined;
  await page.routeWebSocket("**/rpc", (socket) => {
    const core = socket.connectToServer();
    core.onMessage((message) => {
      if (held === undefined) {
        socket.send(message);
      } else {
        held.push(() => {
          socket.send(message);
        });
      }
    });
  });
  const screen = await openMap(page, app);
  const save = screen.getByRole("button", { name: "Save" });
  const why = screen.getByLabel("Why it can't be saved");

  await screen.getByRole("button", { name: "Draw a workflow" }).click();
  await screen.getByLabel("Title", { exact: true }).fill(title);
  await screen.getByRole("button", { name: "Add a step" }).click();
  await screen.getByLabel("Name, step 1").fill("Match the invoice");
  await screen.getByLabel("Times a week, step 1").fill("10000");
  // A number the Playbook doesn't take says so, and isn't sent.
  await screen.getByLabel("Minutes, step 1").fill("20000");
  await expect(why).toHaveText("Each number is between 0 and 10,000.");
  await expect(save).toBeDisabled();
  // 10,000 times a week, 600 minutes, 2 people: 200,000 hours a week.
  await screen.getByLabel("Minutes, step 1").fill("600");
  await screen.getByLabel("People, step 1").fill("2");
  await expect(why).toHaveCount(0);

  // While the save is on its way, nothing can be typed: the saved version
  // replaces the editor once it is open.
  held = [];
  await save.click();
  await expect(screen.getByLabel("Title", { exact: true })).toBeDisabled();
  await expect(screen.getByLabel("Name, step 1")).toBeDisabled();
  const answers = held;
  held = undefined;
  for (const answer of answers) {
    answer();
  }
  await expect(screen.getByText("Version 1")).toBeVisible();
  await expect(screen.getByLabel("Title", { exact: true })).toBeEnabled();

  // Designed with no time left, it would save more than the Playbook
  // takes: it says so instead of failing the save.
  await screen.getByRole("button", { name: "Design it" }).click();
  await expect(screen.getByText("Version 2")).toBeVisible();
  await screen.getByLabel("Minutes, step 1").fill("0");
  await expect(why).toHaveText(
    "The expected gain is over 100,000 hours a week, more than the Playbook takes: check the numbers."
  );
  await expect(save).toBeDisabled();

  // Unsaved edits hold the link back, and going back says it drops them.
  await screen.getByLabel("Minutes, step 1").fill("599");
  await expect(why).toHaveCount(0);
  await screen.getByLabel("App ID").fill("app-1");
  await screen.getByLabel("Workflow ID").fill("pay");
  await expect(screen.getByRole("button", { name: "Link" })).toBeDisabled();
  await expect(screen.getByText("Save first, then link it.")).toBeVisible();
  await expect(
    screen.getByRole("button", { name: "Discard changes and go back" })
  ).toBeVisible();
  await save.click();
  await expect(screen.getByText("Version 3")).toBeVisible();
  await expect(screen.getByLabel("Expected gain")).toHaveText(
    "Expected gain: 333.3 h a week"
  );
  await expect(
    screen.getByRole("button", { name: "All workflows" })
  ).toBeVisible();
});

test("an answer to an earlier open, arriving late, never replaces the workflow opened since", async ({
  browser,
}) => {
  const { admin } = peopleIn("workflowMap");
  const app = await mapFor(admin);
  const run = crypto.randomUUID().slice(0, 8);
  const [first, second] = [`Slow ${run}`, `Quick ${run}`];
  const { core, api } = apiOf(admin);
  try {
    for (const title of [first, second]) {
      // oxlint-disable-next-line no-await-in-loop -- one after the other
      await api.screens.call(app, "save", [
        {
          ifVersion: 0,
          record: {
            type: "workflow",
            title,
            state: "drawn",
            steps: [],
            parameters: [],
          },
          body: "",
        },
      ]);
    }
  } finally {
    core[Symbol.dispose]();
  }
  const page = await pageOf(browser, admin);
  // Core's answers that name `slow` wait until the test lets them through:
  // the listing has come by then, so only the first workflow's opening.
  let slow: string | undefined;
  const held: (() => void)[] = [];
  await page.routeWebSocket("**/rpc", (socket) => {
    const toCore = socket.connectToServer();
    toCore.onMessage((message) => {
      if (slow !== undefined && String(message).includes(slow)) {
        held.push(() => {
          socket.send(message);
        });
        return;
      }
      socket.send(message);
    });
  });
  const screen = await openMap(page, app);
  await expect(
    screen.getByRole("button", { name: first, exact: true })
  ).toBeVisible();

  slow = first;
  await screen.getByRole("button", { name: first, exact: true }).click();
  await expect.poll(() => held.length).toBeGreaterThan(0);
  await screen.getByRole("button", { name: second, exact: true }).click();
  await expect(screen.getByLabel("Title", { exact: true })).toHaveValue(second);

  // The first answer lands, then one to a call after it: by then the map
  // has had the first, and still shows the second workflow.
  slow = undefined;
  for (const answer of held.splice(0)) {
    answer();
  }
  const team = `Team ${run}`;
  await screen.getByLabel("New team").fill(team);
  // A double click adds the team once.
  await screen.getByRole("button", { name: "Add team" }).dblclick();
  await expect(screen.getByRole("combobox", { name: "Team" })).toContainText(
    team
  );
  await expect(screen.getByLabel("Title", { exact: true })).toHaveValue(second);
  const check = apiOf(admin);
  try {
    const overview: unknown = await check.api.screens.call(app, "overview", []);
    expect(JSON.stringify(overview).split(`"title":"${team}"`).length - 1).toBe(
      1
    );
  } finally {
    check.core[Symbol.dispose]();
  }
});
