import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import { test } from "./csp.ts";

const bodyBackground = async (page: Page): Promise<string> =>
  await page
    .locator("body")
    .evaluate((body) => getComputedStyle(body).backgroundColor);

const expectKitRendered = async (page: Page): Promise<void> => {
  await page.goto("/kit");
  await expect(page.getByRole("heading", { name: "UI kit" })).toBeVisible();
  await expect(page.getByLabel("Name")).toBeVisible();

  const model = page.getByRole("combobox", { name: "Model" });
  await expect(model).toContainText("Small");
  await model.click();
  await page.getByRole("option", { name: "Large" }).click();
  await expect(model).toContainText("Large");

  const summary = page.getByRole("checkbox", { name: "Email me a summary" });
  await expect(summary).toBeChecked();
  await summary.click();
  await expect(summary).not.toBeChecked();

  const notifications = page.getByRole("switch", { name: "Notifications" });
  await expect(notifications).not.toBeChecked();
  await notifications.click();
  await expect(notifications).toBeChecked();

  await expect(page.getByRole("cell", { name: "Weekly report" })).toBeVisible();

  await page.getByRole("tab", { name: "Actions" }).click();
  await page.getByRole("button", { name: "Open dialog" }).click();
  await expect(page.getByRole("dialog", { name: "Dialog" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();

  await page.getByRole("button", { name: "Open menu" }).click();
  await expect(page.getByRole("menuitem", { name: "Rename" })).toBeVisible();
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Show toast" }).click();
  await expect(page.getByText("Your changes are saved.")).toBeVisible();

  await expect(page.getByRole("button", { name: "Chat" })).toBeVisible();
  await expect(page.getByText("A title is needed.")).toBeVisible();

  await page.getByRole("button", { name: "Open sheet" }).click();
  const sheet = page.getByRole("dialog", { name: "Sheet" });
  await expect(sheet).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();

  await page.getByRole("button", { name: "Open popover" }).click();
  await expect(page.getByText("Anchored to its button.")).toBeVisible();
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Show details" }).click();
  await expect(page.getByText("The details.")).toBeVisible();
};

test("renders the UI kit in light mode", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await expectKitRendered(page);
});

test("renders the UI kit in dark mode", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/kit");
  const light = await bodyBackground(page);

  // The page follows a change of the system scheme without a reload.
  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(async () => await bodyBackground(page)).not.toBe(light);

  // And starts dark when the system already is.
  await expectKitRendered(page);
  expect(await bodyBackground(page)).not.toBe(light);
});

test("serves the Grasp favicon the page names", async ({ page }) => {
  await page.goto("/kit");
  const href = await page.locator('link[rel="icon"]').getAttribute("href");
  expect(href).toBe("/favicon.svg");
  const icon = await page.request.get("/favicon.svg");
  expect(icon.ok()).toBe(true);
  expect(icon.headers()["content-type"]).toContain("image/svg+xml");
});
