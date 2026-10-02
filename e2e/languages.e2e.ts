import { expect } from "@playwright/test";

import { test } from "./csp.ts";
import { peopleIn, signInTo } from "./people.ts";

// The product speaks the browser's language until the person picks one,
// and keeps their pick in this browser. Every catalog having every message
// is a unit test (apps/web/src/locales/locales.test.ts).

test("follows the browser's language, then the one the person picks", async ({
  browser,
}) => {
  const { member } = peopleIn("languages");
  const context = await browser.newContext({ locale: "de-DE" });
  await signInTo(context, member);
  const page = await context.newPage();

  await page.goto("/knowledge");
  const nav = page.getByRole("navigation", { name: "Hauptmenü" });
  await expect(nav.getByRole("link", { name: "Wissen" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "de");

  // The language is in the person menu, at the sidebar's foot.
  await page.getByRole("button", { name: /Nutzer$/u }).click();
  await page.getByRole("menuitem", { name: /^Sprache/u }).click();
  await page.getByRole("menuitemradio", { name: "Nederlands" }).click();
  await expect(
    page.getByRole("navigation", { name: "Hoofdmenu" }).getByRole("link", {
      name: "Kennis",
    })
  ).toBeVisible();

  // Kept for this browser, over its own language.
  await page.reload();
  await expect(page.getByRole("heading", { name: "Kennis" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "nl");
  await context.close();
});

test("signing in speaks the browser's language", async ({ browser }) => {
  const context = await browser.newContext({ locale: "fr-FR" });
  const page = await context.newPage();
  await page.goto("/sign-in");
  await expect(
    page.getByText("Utilisez le compte de votre organisation pour continuer.")
  ).toBeVisible();
  await context.close();
});
