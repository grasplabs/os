import { expect, test } from "@playwright/test";

test("loads the frontend from core and reaches core over RPC", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Grasp" })).toBeVisible();
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
});
