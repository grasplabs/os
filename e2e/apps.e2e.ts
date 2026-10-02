import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import { callGate } from "./call-gate.ts";
import { test } from "./csp.ts";
import { apiOf, pageOf, peopleIn, release } from "./people.ts";
import type { Person } from "./people.ts";
import { origin } from "./stack.ts";

// Reaching Apps from the product: sign in, find an App in the Apps list,
// open it, and use its screen with live data from its server; its
// workflows and who opens it are a tab away. Only the people core opens
// Apps to see them.

const server = `import { DurableObject } from "cloudflare:workers";

type Watcher = ((count: number) => Promise<void>) & { dup(): Watcher };

export class App extends DurableObject {
  #watchers = new Set<Watcher>();

  #count(): number {
    return Number(this.ctx.storage.kv.get("count") ?? 0);
  }

  watchCount(_caller: unknown, onChange: Watcher): void {
    const watcher = onChange.dup();
    this.#watchers.add(watcher);
    void watcher(this.#count());
  }

  addOne(): void {
    const count = this.#count() + 1;
    this.ctx.storage.kv.put("count", count);
    for (const watcher of this.#watchers) {
      void watcher(count).catch(() => this.#watchers.delete(watcher));
    }
  }
}
`;

const screen = `import { callServer, useLive } from "@grasp-os/sdk/screen";
import { Button } from "@grasp-os/ui/components/button";

export default function Counter() {
  const count = useLive<number>("watchCount", 0);
  return (
    <main className="flex flex-col gap-4 p-4">
      <h2 className="text-lg font-medium">Counter</h2>
      <output aria-label="Count">{count}</output>
      <Button onClick={() => void callServer("addOne")}>Add one</Button>
    </main>
  );
}
`;

const tally = `import { workflow, z } from "@grasp-os/sdk/workflow";

export default workflow(
  "tally",
  { input: z.unknown(), params: {} },
  async (step) => await step.do("count", { description: "Count" }, async () => 1)
);
`;

const tallyTests = `import { workflowTests } from "@grasp-os/sdk/testing";

import tally from "./tally.ts";

export default workflowTests(tally, [{ name: "counts", mocks: { count: 1 }, expect: { output: 1 } }]);
`;

/** The counter App's files: a screen and a workflow. */
const counterFiles = {
  "app/server.ts": server,
  "screens/counter.tsx": screen,
  "workflows/tally.ts": tally,
  "workflows/tally.workflow-tests.ts": tallyTests,
};

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
 * A new App named `appName`, released with `files` unless there are none.
 * Returns its ID.
 */
const newApp = async (
  person: Person,
  appName: string,
  files: Record<string, string> = counterFiles
): Promise<string> =>
  await withApi(person, async (api) => {
    const { id } = await api.apps.create({
      name: appName,
      description: "Counts clicks",
    });
    if (Object.keys(files).length > 0) {
      await release(api, id, files, "First version");
    }
    return id;
  });

/** A counter screen on the page, once it has built. */
const counterScreen = async (page: Page, title = "counter screen") => {
  const frame = page.frameLocator(`iframe[title="${title}"]`);
  // The first open builds the screen, which on a loaded machine takes a
  // while (screens.e2e.ts).
  await expect(frame.getByRole("heading", { name: "Counter" })).toBeVisible({
    timeout: 20_000,
  });
  return frame;
};

let builder: Person;
let user: Person;
let admin: Person;
let name: string;
let app: string;

test.beforeAll(async () => {
  ({ builder, user, admin } = peopleIn("apps"));
  // Builders see every App, other tests' too: this one's name is its own.
  name = `Counter ${crypto.randomUUID()}`;
  app = await newApp(builder, name);
});

test("a builder finds an App in the list, opens it and uses its screen with live data", async ({
  browser,
}) => {
  const page = await pageOf(browser, builder);
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Main" });
  await nav.getByRole("link", { name: "Apps" }).click();

  const row = page.getByRole("row").filter({ hasText: name });
  await expect(row.getByRole("cell")).toHaveText([
    name,
    "Counts clicks",
    "1",
    "counter",
    "tally",
  ]);
  await row.getByRole("link", { name }).click();

  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
  await expect(page.getByText("Version 1")).toBeVisible();
  const counter = await counterScreen(page);
  // One page heading: the screen's chrome names the App a level below it.
  await expect(page.getByRole("heading", { level: 2, name })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  await expect(counter.getByRole("status", { name: "Count" })).toHaveText("0");
  await counter.getByRole("button", { name: "Add one" }).click();
  await expect(counter.getByRole("status", { name: "Count" })).toHaveText("1");

  await page.getByRole("tab", { name: "Workflows" }).click();
  await expect(
    page.getByRole("list", { name: "Workflows" }).getByRole("listitem")
  ).toHaveText(["tally"]);
  await expect(page.getByText("No runs yet.")).toBeVisible();

  await page.getByRole("tab", { name: "Members" }).click();
  await expect(page.getByText("Created by you.")).toBeVisible();
});

test("the sidebar shows everyone the sections, and admins their own in the person menu", async ({
  browser,
}) => {
  const adminOnly = ["Activity", "Models", "Members"];
  const everyone = ["Chat", "Knowledge", "Apps", "Workflows", "Connections"];
  const roleNames = { admin: "Admin", builder: "Builder", user: "User" };
  const sidebarOf = async (person: Person) => {
    const page = await pageOf(browser, person);
    await page.goto("/");
    const links = page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link");
    // The nav shows once the person's identity is in, and Notifications
    // once core has counted them.
    await expect(links.first()).toBeVisible();
    await expect(links.filter({ hasText: /^Notifications/u })).toBeVisible();
    const texts = await links.allTextContents();
    // The person menu, at the sidebar's foot, ends in their role.
    await page
      .getByRole("button", {
        name: new RegExp(`${roleNames[person.role]}$`, "u"),
      })
      .click();
    const items = page.getByRole("menuitem");
    await expect(items.filter({ hasText: "Sign out" })).toBeVisible();
    const menu = await items.allTextContents();
    return {
      // Without how many are unread.
      nav: texts.map((text) => text.replace(/\d+ unread$/u, "")),
      menu: menu.filter((text) => adminOnly.includes(text)),
    };
  };
  expect({
    admin: await sidebarOf(admin),
    builder: await sidebarOf(builder),
    user: await sidebarOf(user),
  }).toStrictEqual({
    admin: { nav: [...everyone, "Notifications"], menu: adminOnly },
    builder: { nav: [...everyone, "Notifications"], menu: [] },
    user: { nav: [...everyone, "Notifications"], menu: [] },
  });
});

test("someone with the user role finds no App to open", async ({ browser }) => {
  const page = await pageOf(browser, user);
  await page.goto("/apps");
  await expect(
    page.getByText("There are no Apps you can open yet.")
  ).toBeVisible();
  await expect(page.getByRole("table")).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("signing in goes back to the page asked for, and only to a page of this site", async ({
  browser,
}) => {
  const page = await pageOf(browser, builder);
  await page.goto("/sign-in?returnTo=%2Fapps");
  await expect(page.getByRole("heading", { name: "Apps" })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/apps");

  for (const elsewhere of [
    "//evil.test/apps",
    "/\\evil.test",
    "/\t/evil.test",
    "https://evil.test",
  ]) {
    // oxlint-disable-next-line no-await-in-loop -- one address at a time
    await page.goto(`/sign-in?returnTo=${encodeURIComponent(elsewhere)}`);
    // oxlint-disable-next-line no-await-in-loop -- one address at a time
    await expect(page.getByRole("heading", { name: "Chat" })).toBeVisible();
    expect(page.url()).toBe(`${origin}/`);
  }
});

test("an App whose contents can't be read, or never come, keeps its row, and the others theirs", async ({
  browser,
}) => {
  const brokenName = `Broken ${crypto.randomUUID()}`;
  const broken = await newApp(builder, brokenName, {});
  const page = await pageOf(browser, builder);
  // The page asks core for this App's contents as for an App core doesn't
  // have, which core refuses.
  await page.routeWebSocket("**/rpc", (socket) => {
    const toCore = socket.connectToServer();
    socket.onMessage((message) => {
      const text = String(message);
      toCore.send(
        text.includes('"contents"') ? text.replaceAll(broken, "missing") : text
      );
    });
  });
  await page.goto("/apps");

  await expect(
    page.getByRole("row").filter({ hasText: brokenName }).getByRole("cell")
  ).toHaveText([
    brokenName,
    "Counts clicks",
    "Contents unavailable",
    "Contents unavailable",
    "Contents unavailable",
  ]);
  await expect(
    page.getByRole("row").filter({ hasText: name }).getByRole("cell")
  ).toHaveText([name, "Counts clicks", "1", "counter", "tally"]);
  await expect(page.getByRole("alert")).toHaveCount(0);

  // A read that never comes costs only its own row too, not the page: the
  // list shows, where a page waiting on every read would say core can't
  // be reached.
  const hangingName = `Hanging ${crypto.randomUUID()}`;
  const hanging = await newApp(builder, hangingName, {});
  const waiting = await pageOf(browser, builder);
  const gate = await callGate(waiting, hanging);
  gate.hold();
  await waiting.goto("/apps");
  await expect(
    waiting.getByRole("row").filter({ hasText: hangingName }).getByRole("cell")
  ).toHaveText(
    [
      hangingName,
      "Counts clicks",
      "Contents unavailable",
      "Contents unavailable",
      "Contents unavailable",
    ],
    // The row waits out its read's limit, well under this.
    { timeout: 10_000 }
  );
  await expect(
    waiting.getByRole("row").filter({ hasText: name }).getByRole("cell").first()
  ).toHaveText(name);
  await expect(waiting.getByRole("alert")).toHaveCount(0);
  gate.release();
});

test("a runs read that never comes leaves the App usable, and says so in its tab", async ({
  browser,
}) => {
  const page = await pageOf(browser, builder);
  const gate = await callGate(page, '["workflows","list"]');
  gate.hold();
  await page.goto(`/apps/${app}`);

  const counter = await counterScreen(page);
  await expect(counter.getByRole("button", { name: "Add one" })).toBeEnabled();
  await page.getByRole("tab", { name: "Workflows" }).click();
  await expect(
    page.getByRole("list", { name: "Workflows" }).getByRole("listitem")
  ).toHaveText(["tally"]);
  await expect(
    page.getByText("Grasp can't be reached right now. Try again in a moment.")
  ).toBeVisible({ timeout: 15_000 });
  gate.release();
});

test("loading a screen again after a new version shows that version, and its first screen when the one open is gone", async ({
  browser,
}) => {
  const swapped = await newApp(builder, `Swap ${crypto.randomUUID()}`, {
    "app/server.ts": server,
    "screens/counter.tsx": screen,
  });
  const page = await pageOf(browser, builder);
  await page.clock.install();
  await page.goto(`/apps/${swapped}`);
  await counterScreen(page);

  await withApi(builder, async (api) => {
    await release(
      api,
      swapped,
      { "screens/counter.tsx": null, "screens/tally.tsx": screen },
      "Rename the screen"
    );
  });
  // The frame asks for a new version every 30 seconds.
  await page.clock.fastForward(30_000);
  await expect(
    page.getByText("A new version of this App is available.")
  ).toBeVisible();
  await page.getByRole("button", { name: "Reload" }).click();

  await expect(page.getByText("Version 2")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "tally", exact: true })
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("button", { name: "counter", exact: true })
  ).toHaveCount(0);
  await counterScreen(page, "tally screen");
});
