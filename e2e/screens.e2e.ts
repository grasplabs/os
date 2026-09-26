import { once } from "node:events";
import { createServer } from "node:http";
import type { Server } from "node:http";

import { expect, test as base } from "@playwright/test";
import type { Page } from "@playwright/test";

import { test } from "./csp.ts";
import { apiOf, pageOf, release, signedIn } from "./people.ts";
import type { Person } from "./people.ts";
import { screenAppFiles } from "./screen-app.ts";

// An App's screen in its sandboxed frame, end to end: the page, the frame,
// core and the App's server, in a real browser. The screen reads and writes
// through its server, sees another person's changes live, and reports its
// errors; and, as code nobody reviewed line by line, it gets nowhere else.

declare global {
  interface Window {
    /** The App names the page's chrome showed, sampled by a test below. */
    chromeNames: { path: string; name: string }[];
  }
}

/**
 * Longer than the page waits between attempts to reconnect after one
 * failed (2 s), twice over: a second round of attempts, running beside the
 * first, shows by then.
 */
const reconnectsSettledMs = 5000;

/** Counts every request that reaches it: none should. */
const serveAttacker = async (): Promise<{
  url: string;
  hits: string[];
  server: Server;
}> => {
  const hits: string[] = [];
  const server = createServer((request, response) => {
    hits.push(request.url ?? "");
    response.end("stolen");
  });
  await once(server.listen(0, "127.0.0.1"), "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("The attacker's server has no port");
  }
  return { url: `http://127.0.0.1:${address.port}`, hits, server };
};

/** A new App named `name` running the sample, released by `builder`. */
const releaseApp = async (
  builder: Person,
  attacker: string,
  name = "Notes"
): Promise<string> => {
  const { core, api } = apiOf(builder);
  try {
    const { id } = await api.apps.create({ name });
    await release(api, id, screenAppFiles(attacker), name);
    return id;
  } finally {
    core[Symbol.dispose]();
  }
};

const openScreen = async (page: Page, app: string) => {
  await page.goto(`/apps/${app}/screens/notes`);
  const screen = page.frameLocator('iframe[title="notes screen"]');
  await expect(screen.getByRole("heading", { name: "Notes" })).toBeVisible();
  return screen;
};

let attacker: Awaited<ReturnType<typeof serveAttacker>>;
let one: Person;
let two: Person;
let app: string;

test.beforeAll(async () => {
  attacker = await serveAttacker();
  ({ one, two } = await signedIn({ one: "builder", two: "builder" }));
  app = await releaseApp(one, attacker.url);
});

test.afterAll(() => {
  attacker.server.close();
});

test("two people see each other's notes live, in their theme, and a failing screen lands in the App's error log", async ({
  browser,
}) => {
  const [first, second] = await Promise.all([
    pageOf(browser, one),
    pageOf(browser, two),
  ]);
  await first.emulateMedia({ colorScheme: "light" });
  const [firstScreen, secondScreen] = await Promise.all([
    openScreen(first, app),
    openScreen(second, app),
  ]);

  // The page marks what the App draws as the App's, around the frame.
  await expect(first.getByText("App screen", { exact: true })).toBeVisible();
  await expect(first.getByRole("heading", { name: "Notes" })).toBeVisible();

  // The screen follows its page's theme.
  const frame = first.frame({ url: /\/screen-frame\?load=/u });
  const dark = async () =>
    await frame?.evaluate(() =>
      document.documentElement.classList.contains("dark")
    );
  expect(await dark()).toBeFalsy();
  await first.emulateMedia({ colorScheme: "dark" });
  await expect.poll(dark).toBeTruthy();

  await firstScreen.getByRole("button", { name: "Add a note" }).click();
  const note = `Call Acme by ${one.userId}`;
  await expect(
    secondScreen.getByRole("list", { name: "Notes" }).getByText(note)
  ).toBeVisible();
  await expect(
    firstScreen.getByRole("list", { name: "Notes" }).getByText(note)
  ).toBeVisible();

  await secondScreen.getByRole("button", { name: "Fail" }).click();
  const { core, api } = apiOf(one);
  try {
    await expect
      .poll(async () => {
        const log = await api.screens.errors(app);
        return log.map(({ message }) => message);
      })
      .toContain("Invoice 7 has no total");
  } finally {
    core[Symbol.dispose]();
  }
});

base(
  "the screen reaches nothing but its own App's server",
  async ({ browser }) => {
    const page = await pageOf(browser, one);
    const popups: string[] = [];
    page.on("popup", (popup) => {
      popups.push(popup.url());
    });
    const screen = await openScreen(page, app);

    await expect(
      screen.getByRole("status", { name: "Probes" })
    ).not.toBeEmpty();
    const probes: unknown = JSON.parse(
      (await screen.getByRole("status", { name: "Probes" }).textContent()) ?? ""
    );
    expect(probes).toStrictEqual({
      fetch: "blocked",
      fetchCore: "blocked",
      socket: "blocked",
      image: "blocked",
      popup: "blocked",
      top: "blocked",
      parentDocument: "blocked",
      cookie: "blocked",
      storage: "blocked",
      tailwindRule: "applied",
      styleRule: "applied",
    });

    // The bridge, reached past the SDK, offers only the App's own server.
    const frame = page.frame({ url: /\/screen-frame\?load=/u });
    await expect
      .poll(
        async () => await frame?.evaluate(() => document.body.dataset.bridge)
      )
      .toBeDefined();
    const bridge: unknown = JSON.parse(
      (await frame?.evaluate(() => document.body.dataset.bridge)) ?? "{}"
    );
    expect(bridge).toStrictEqual({
      nameObject: "screen.invalid",
      session: "refused",
      apps: "refused",
      screens: "refused",
      prototype: "refused",
    });

    // An answer shaped like the platform's error is only an answer: the page
    // doesn't end the session over it.
    await screen.getByRole("button", { name: "Ask" }).click();
    await expect(screen.getByRole("status", { name: "Answer" })).toHaveText(
      "an answer"
    );
    await expect(page.getByText("Your session has ended")).toHaveCount(0);

    // Nothing got out, and the page stayed where it was.
    expect({
      hits: attacker.hits,
      popups,
      url: new URL(page.url()).pathname,
    }).toStrictEqual({
      hits: [],
      popups: [],
      url: `/apps/${app}/screens/notes`,
    });
  }
);

test("a screen subscribes again after its connection drops, trying one connection at a time", async ({
  browser,
}) => {
  const page = await pageOf(browser, one);
  let drop: (() => Promise<void>) | undefined;
  let dropped = false;
  let afterDrop = 0;
  // After the drop, core is out of reach for the next attempt.
  let refuse = 0;
  await page.routeWebSocket("**/rpc", async (socket) => {
    if (dropped) {
      afterDrop += 1;
    }
    if (refuse > 0) {
      refuse -= 1;
      await socket.close();
      return;
    }
    socket.connectToServer();
    drop = async () => {
      dropped = true;
      refuse = 1;
      await socket.close();
    };
  });
  const screen = await openScreen(page, app);
  await drop?.();

  // Only a new subscription, on the page's new connection, can bring it.
  const { core, api } = apiOf(two);
  try {
    await api.screens.call(app, "addNote", ["After the drop"]);
  } finally {
    core[Symbol.dispose]();
  }
  await expect(
    screen
      .getByRole("list", { name: "Notes" })
      .getByText(`After the drop by ${two.userId}`)
  ).toBeVisible({ timeout: 20_000 });
  // One refused attempt, then one that holds, and none beside or after it:
  // a failed attempt doesn't start another round of attempts of its own.
  await page.waitForTimeout(reconnectsSettledMs);
  expect(afterDrop).toBe(2);
});

test("moving to another App's screen never shows the App it left in the chrome", async ({
  browser,
}) => {
  const other = await releaseApp(one, attacker.url, "Tasks");
  const page = await pageOf(browser, one);
  await openScreen(page, app);
  await expect(page.getByRole("heading", { name: "Notes" })).toBeVisible();

  // Every frame, the App name the chrome shows at the page's address.
  await page.evaluate(() => {
    const names: Window["chromeNames"] = [];
    window.chromeNames = names;
    const sample = () => {
      names.push({
        path: location.pathname,
        name: document.querySelector("header h1")?.textContent ?? "",
      });
      requestAnimationFrame(sample);
    };
    sample();
  });
  // Within the page, as a link would: a new document would start afresh.
  const otherPath = `/apps/${other}/screens/notes`;
  await page.evaluate((path) => {
    history.pushState(null, "", path);
    dispatchEvent(new PopStateEvent("popstate"));
  }, otherPath);
  await expect(page.getByRole("heading", { name: "Tasks" })).toBeVisible();

  const shown = await page.evaluate(() => window.chromeNames);
  const atOther = new Set(
    shown.filter(({ path }) => path === otherPath).map(({ name }) => name)
  );
  expect(atOther.has("Notes")).toBeFalsy();
  expect(atOther.has("Tasks")).toBeTruthy();
});

test("a new current version is offered while the screen is open", async ({
  browser,
}) => {
  const page = await pageOf(browser, one);
  await page.clock.install();
  await openScreen(page, app);
  const { core, api } = apiOf(one);
  try {
    await release(
      api,
      app,
      {
        "screens/notes.tsx": `${screenAppFiles(attacker.url)["screens/notes.tsx"]}// v2\n`,
      },
      "v2"
    );
  } finally {
    core[Symbol.dispose]();
  }

  await page.clock.fastForward(30_000);
  await expect(
    page.getByText("A new version of this App is available.")
  ).toBeVisible();
});
