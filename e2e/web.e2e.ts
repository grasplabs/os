import { expect } from "@playwright/test";
import type { WebSocketRoute } from "@playwright/test";

import { callGate } from "./call-gate.ts";
import { test } from "./csp.ts";
import { endSession, peopleIn, signInTo } from "./people.ts";

/**
 * How long the page may take to show what came of a connection that had to
 * be made again: the read's own 5 s for one that never comes, and the
 * pauses between attempts (1 s, 2 s, then 3 s each) for one that does.
 */
const reconnectMs = 10_000;

test("loads the frontend from core, reaches core over RPC, and asks whoever isn't signed in to sign in", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Grasp" })).toBeVisible();
  // Only once core answered: without an answer, the page says so instead.
  await expect(page.getByText("Sign in to go on.")).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get("returnTo")).toBe("/");
});

test("shows only its own words for a refused sign-in, never the link's", async ({
  page,
}) => {
  const planted = "Your account is locked. Call +1 555 0100";
  await page.goto(`/?error=${encodeURIComponent(planted)}`);
  await expect(page.getByRole("alert")).toHaveText(
    "Sign-in didn't work. Try again, or ask an admin."
  );
  await expect(page.getByText(planted)).toHaveCount(0);
});

test("names each member's actions for them, and asks before making someone an admin", async ({
  context,
  page,
}) => {
  // Everyone signed in here has the same name.
  const { admin, one, two } = peopleIn("memberActions");
  await signInTo(context, admin);
  await page.goto("/members");

  for (const person of [one, two]) {
    const who = `Person (${person.email})`;
    for (const name of [`End sessions for ${who}`, `Remove ${who}`]) {
      // oxlint-disable-next-line no-await-in-loop -- one control at a time
      await expect(page.getByRole("button", { name, exact: true })).toHaveCount(
        1
      );
    }
  }
  const labels = await page
    .getByRole("button", { name: /^(?:End sessions for|Remove) /u })
    .evaluateAll((buttons) =>
      buttons.map((button) => button.getAttribute("aria-label"))
    );
  expect(new Set(labels).size).toBe(labels.length);

  const role = page.getByRole("combobox", {
    name: `Role of Person (${one.email})`,
  });
  await role.click();
  await page.getByRole("option", { name: "admin" }).click();
  await expect(
    page.getByRole("dialog", { name: "Make Person an admin?" })
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(role).toContainText("user");
});

test("shows the members page only to someone signed in, and never signs them out for core failing", async ({
  context,
  page,
}) => {
  await page.goto("/members");
  await expect(page.getByText("Sign in to go on.")).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/sign-in");
  expect(new URL(page.url()).searchParams.get("returnTo")).toBe("/members");
  await expect(page.getByRole("heading", { name: "Members" })).toHaveCount(0);
  await expect(page.getByRole("table")).toHaveCount(0);

  // Core fails the next connections outright, as a busy database failing
  // the upgrade does: the browser sees only a closed socket.
  let failing = 0;
  await page.routeWebSocket("**/rpc", async (socket) => {
    if (failing > 0) {
      failing -= 1;
      await socket.close();
      return;
    }
    socket.connectToServer();
  });
  const { admin } = peopleIn("membersRecover");
  await signInTo(context, admin);

  // A couple of failures pass: the page's connection tries again, with a
  // growing pause, and lets them in.
  failing = 2;
  await page.goto("/members");
  await expect(page.getByRole("heading", { name: "Members" })).toBeVisible({
    timeout: reconnectMs,
  });
  expect(new URL(page.url()).pathname).toBe("/members");
  expect(failing).toBe(0);

  // Failing for good says so, rather than asking them to sign in again:
  // once the page has waited its few seconds for a connection.
  failing = Number.POSITIVE_INFINITY;
  await page.goto("/members");
  await expect(
    page.getByText("Grasp can't be reached right now. Try again in a moment.")
  ).toBeVisible({ timeout: reconnectMs });
  expect(new URL(page.url()).pathname).toBe("/members");
  await expect(page.getByText("Sign in to go on.")).toHaveCount(0);

  // Trying again shows it's trying, then says so again while core fails.
  const unreachable = page.getByRole("alert");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(
    page.getByRole("button", { name: "Trying again…" })
  ).toBeDisabled();
  await expect(unreachable).toHaveText(
    "Grasp can't be reached right now. Try again in a moment.",
    { timeout: reconnectMs }
  );
  expect(new URL(page.url()).pathname).toBe("/members");

  // Once core answers again, trying again lets them in.
  failing = 0;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("heading", { name: "Members" })).toBeVisible({
    timeout: reconnectMs,
  });
});

test("an admin changes a member's role, and the controls wait for the list to show it", async ({
  context,
  page,
}) => {
  const { admin, one } = peopleIn("roleChange");
  await signInTo(context, admin);
  const gate = await callGate(page, '["members","list"]');
  await page.goto("/members");
  const who = `Person (${one.email})`;
  const role = page.getByRole("combobox", { name: `Role of ${who}` });
  await expect(role).toContainText("user");

  gate.hold();
  await role.click();
  await page.getByRole("option", { name: "builder" }).click();
  // The change went through; the list that shows it hasn't come back yet.
  // The controls went off before the change was sent, so they're read
  // right away, then the list is let through, well before the page would
  // give up on it.
  await expect.poll(gate.stalled).toBe(1);
  const whileRefreshing = {
    role: await role.isDisabled(),
    remove: await page
      .getByRole("button", { name: `Remove ${who}`, exact: true })
      .isDisabled(),
  };
  gate.release();
  expect(whileRefreshing).toStrictEqual({ role: true, remove: true });
  await expect(role).toBeEnabled();
  await expect(role).toContainText("builder");
});

test("says core can't be reached when the members list never comes", async ({
  context,
  page,
}) => {
  const { admin } = peopleIn("membersUnreachable");
  await signInTo(context, admin);
  const gate = await callGate(page, '["members","list"]');
  gate.hold();
  await page.goto("/members");
  await expect(
    page.getByText("Grasp can't be reached right now. Try again in a moment.")
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("table")).toHaveCount(0);
});

test("sends someone whose session ended elsewhere to sign in, and back to the page they asked for", async ({
  context,
  page,
}) => {
  const { member } = peopleIn("sessionEnded");
  await signInTo(context, member);
  await page.goto("/knowledge");
  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav.getByRole("link", { name: "Apps" })).toBeVisible();

  // Signed out in another tab, or revoked: the page's connection, opened
  // while they were signed in, is refused at the next page they open.
  await endSession(member);
  await nav.getByRole("link", { name: "Apps" }).click();
  await expect(page.getByText("Sign in to go on.")).toBeVisible({
    timeout: reconnectMs,
  });
  expect(new URL(page.url()).pathname).toBe("/sign-in");
  expect(new URL(page.url()).searchParams.get("returnTo")).toBe("/apps");
  await expect(nav).toHaveCount(0);
});

test("never sends what it gave up on while core was out of reach, once core is back", async ({
  context,
  page,
}) => {
  const { member } = peopleIn("readsGivenUp");
  await signInTo(context, member);
  let refusing = false;
  let open: WebSocketRoute | undefined;
  // What the page sends core from when core went out of reach.
  let recording = false;
  const sent: string[] = [];
  await page.routeWebSocket("**/rpc", async (socket) => {
    if (refusing) {
      await socket.close();
      return;
    }
    const server = socket.connectToServer();
    open = socket;
    socket.onMessage((message) => {
      if (recording) {
        sent.push(String(message));
      }
      server.send(message);
    });
  });
  await page.goto("/members");
  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav.getByRole("link", { name: "Knowledge" })).toBeVisible();

  // Core goes out of reach: the page's connection drops, and none gets in.
  refusing = true;
  recording = true;
  await open?.close();
  await nav.getByRole("link", { name: "Knowledge" }).click();
  await expect(
    page.getByText("Grasp can't be reached right now. Try again in a moment.")
  ).toBeVisible({ timeout: reconnectMs });

  // Core is back. Trying again asks who is signed in once more: that is the
  // only status read sent, not the one the page gave up on as well.
  refusing = false;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("heading", { name: "Knowledge" })).toBeVisible({
    timeout: reconnectMs,
  });
  const pings = sent.filter((message) => message.includes('["ping"]'));
  expect(pings).toHaveLength(1);
});
