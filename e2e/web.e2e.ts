import { expect, test } from "@playwright/test";

test("loads the Grasp OS frontend", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Grasp" })).toBeVisible();
});
