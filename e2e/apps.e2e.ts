import { expect } from "@playwright/test";

import { test } from "./csp.ts";
import { apiOf, origin, pageOf, release, signedIn } from "./people.ts";
import type { Person } from "./people.ts";

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

/** A new App named `name` with a counter screen and a workflow, released. */
const releaseApp = async (builder: Person, name: string): Promise<string> => {
  const { core, api } = apiOf(builder);
  try {
    const { id } = await api.apps.create({
      name,
      description: "Counts clicks",
    });
    await release(
      api,
      id,
      {
        "app/server.ts": server,
        "screens/counter.tsx": screen,
        "workflows/tally.ts": tally,
        "workflows/tally.workflow-tests.ts": tallyTests,
      },
      "First version"
    );
    return id;
  } finally {
    core[Symbol.dispose]();
  }
};

let builder: Person;
let user: Person;
let admin: Person;
let name: string;

test.beforeAll(async () => {
  ({ builder, user, admin } = await signedIn({
    builder: "builder",
    user: "user",
    admin: "admin",
  }));
  // Builders see every App, other tests' too: this one's name is its own.
  name = `Counter ${crypto.randomUUID()}`;
  await releaseApp(builder, name);
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

  await expect(
    page.getByRole("heading", { level: 1, name }).first()
  ).toBeVisible();
  await expect(page.getByText("Version 1")).toBeVisible();
  // The first open builds the screen, which on a loaded machine takes a
  // while (screens.e2e.ts).
  const counter = page.frameLocator('iframe[title="counter screen"]');
  await expect(counter.getByRole("heading", { name: "Counter" })).toBeVisible({
    timeout: 20_000,
  });
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

test("the nav shows admins their own sections, and nobody else", async ({
  browser,
}) => {
  const adminOnly = ["Activity", "Models", "Members"];
  const everyone = ["Chat", "Knowledge", "Apps", "Workflows", "Connections"];
  const navOf = async (person: Person) => {
    const page = await pageOf(browser, person);
    await page.goto("/");
    const links = page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link");
    // The nav shows once the person's identity is in.
    await expect(links.first()).toBeVisible();
    return await links.allTextContents();
  };
  expect({
    admin: await navOf(admin),
    builder: await navOf(builder),
    user: await navOf(user),
  }).toStrictEqual({
    admin: [...everyone, ...adminOnly],
    builder: everyone,
    user: everyone,
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
    "https://evil.test",
  ]) {
    // oxlint-disable-next-line no-await-in-loop -- one address at a time
    await page.goto(`/sign-in?returnTo=${encodeURIComponent(elsewhere)}`);
    // oxlint-disable-next-line no-await-in-loop -- one address at a time
    await expect(page.getByRole("heading", { name: "Chat" })).toBeVisible();
    expect(page.url()).toBe(`${origin}/`);
  }
});
