import { expect, test } from "@playwright/test";

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
