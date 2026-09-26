import { expect } from "@playwright/test";

import { callGate } from "./call-gate.ts";
import { test } from "./csp.ts";
import { signedIn, signInTo } from "./people.ts";

test("loads the frontend from core and reaches core over RPC", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Grasp" })).toBeVisible();
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
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
  const { admin, one, two } = await signedIn({
    admin: "admin",
    one: "user",
    two: "user",
  });
  await signInTo(context, admin);
  await page.goto("/members");

  for (const person of [one, two]) {
    const who = `Person (${person.userId}@acme.test)`;
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
    name: `Role of Person (${one.userId}@acme.test)`,
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

test("shows the members page only to someone signed in", async ({ page }) => {
  await page.goto("/members");
  await expect(page.getByRole("heading", { name: "Members" })).toBeVisible();
  await expect(
    page.getByText("Sign in to see your organization's members.")
  ).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("table")).toHaveCount(0);
});

test("an admin changes a member's role, and the controls wait for the list to show it", async ({
  context,
  page,
}) => {
  const { admin, one } = await signedIn({ admin: "admin", one: "user" });
  await signInTo(context, admin);
  const gate = await callGate(page, '["members","list"]');
  await page.goto("/members");
  const who = `Person (${one.userId}@acme.test)`;
  const role = page.getByRole("combobox", { name: `Role of ${who}` });
  await expect(role).toContainText("user");

  gate.hold();
  await role.click();
  await page.getByRole("option", { name: "builder" }).click();
  // The change went through; the list that shows it hasn't come back yet.
  await expect.poll(gate.stalled).toBe(1);
  await expect(role).toBeDisabled();
  await expect(
    page.getByRole("button", { name: `Remove ${who}`, exact: true })
  ).toBeDisabled();

  gate.release();
  await expect(role).toBeEnabled();
  await expect(role).toContainText("builder");
});

test("says core can't be reached when the members list never comes", async ({
  context,
  page,
}) => {
  const { admin } = await signedIn({ admin: "admin" });
  await signInTo(context, admin);
  const gate = await callGate(page, '["members","list"]');
  gate.hold();
  await page.goto("/members");
  await expect(
    page.getByText("Grasp can't be reached right now. Try again in a moment.")
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("table")).toHaveCount(0);
});
