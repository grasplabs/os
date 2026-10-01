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

  await page.getByRole("combobox", { name: "Sprache" }).click();
  await page.getByRole("option", { name: "Nederlands" }).click();
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
  await expect(page.getByText("Connectez-vous pour continuer.")).toBeVisible();
  await context.close();
});
