import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

const bodyBackground = async (page: Page): Promise<string> =>
  await page
    .locator("body")
    .evaluate((body) => getComputedStyle(body).backgroundColor);

const expectKitRendered = async (page: Page): Promise<void> => {
  await page.goto("/kit");
  await expect(page.getByRole("heading", { name: "UI kit" })).toBeVisible();
  await expect(page.getByLabel("Name")).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Model" })).toBeVisible();
  await expect(
    page.getByRole("checkbox", { name: "Email me a summary" })
  ).toBeChecked();
  await expect(
    page.getByRole("switch", { name: "Notifications" })
  ).not.toBeChecked();
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
