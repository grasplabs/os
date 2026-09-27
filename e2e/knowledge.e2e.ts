import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import { test } from "./csp.ts";
import { apiOf, pageOf, peopleIn } from "./people.ts";

// The Knowledge page: a person finds a document by searching, reads it
// rendered (nothing in it runs), edits it into a new version, meets
// someone else's edit instead of overwriting it, and restores an earlier
// version. Search and versions themselves are core's tests.

/** The history table's row for `version`. */
const versionRow = (page: Page, version: number) =>
  page
    .getByRole("region", { name: "History" })
    .getByRole("row")
    .filter({
      has: page.getByRole("cell", { name: String(version), exact: true }),
    });

test("a person searches, edits a document, meets a newer version instead of overwriting it, and restores an earlier one", async ({
  browser,
}) => {
  const { one, two } = peopleIn("knowledge");
  const word = `zebrafish${crypto.randomUUID().replaceAll("-", "")}`;
  const original = [
    "# Leave",
    "",
    "## Parental leave",
    "",
    `Everyone gets sixteen weeks of ${word} leave.`,
    "",
    "[Run this](javascript:alert(1)) and [the law](https://example.com/law).",
    "",
    '<img src="https://example.com/pixel.png" onerror="alert(1)">',
    "",
  ].join("\n");
  const mine = apiOf(one);
  const theirs = apiOf(two);
  let collectionId: string;
  let collectionName: string;
  let hiddenName: string;
  try {
    const collection = await mine.api.knowledge.createCollection({
      name: `Handbook ${crypto.randomUUID()}`,
      access: "me",
    });
    ({ id: collectionId, name: collectionName } = collection);
    // Someone else's own collection: nobody else sees it.
    const hidden = await theirs.api.knowledge.createCollection({
      name: `Private ${crypto.randomUUID()}`,
      access: "me",
    });
    hiddenName = hidden.name;
    await mine.api.knowledge.saveDocument({
      collectionId,
      path: "handbook/leave.md",
      text: original,
      ifVersion: 0,
    });
  } finally {
    theirs.core[Symbol.dispose]();
  }

  try {
    const page = await pageOf(browser, one);
    await page.goto("/knowledge");
    const collections = page.getByRole("region", { name: "Collections" });
    const listed = collections
      .getByRole("listitem")
      .filter({ has: page.getByRole("link", { name: collectionName }) });
    await expect(listed.getByText("Only the owner")).toBeVisible();
    await expect(collections.getByText(hiddenName)).toHaveCount(0);
    await expect(
      page.getByRole("region", { name: "Memory" }).getByRole("alert")
    ).toHaveCount(0);

    await page.getByRole("searchbox", { name: "Search Knowledge" }).fill(word);
    await page.getByRole("button", { name: "Search" }).click();
    const results = page.getByRole("region", { name: "Results" });
    const hit = results.getByRole("listitem").filter({ hasText: word });
    await expect(
      hit.getByText(`${collectionName} › Leave › Parental leave`)
    ).toBeVisible();
    await hit.getByRole("link", { name: "Leave" }).click();

    const article = page.getByRole("article");
    await expect(
      article.getByRole("heading", { name: "Parental leave" })
    ).toBeVisible();
    // Nothing in the text runs or loads: the unsafe link is text, the safe
    // one opens apart from this page, and raw HTML is dropped.
    await expect(article.getByText("Run this")).toBeVisible();
    await expect(article.getByRole("link", { name: "Run this" })).toHaveCount(
      0
    );
    await expect(
      article.getByRole("link", { name: "the law" })
    ).toHaveAttribute("rel", "noopener noreferrer");
    await expect(article.locator("img")).toHaveCount(0);

    // An edit is a new version, with what changed.
    await page.getByRole("button", { name: "Edit" }).click();
    await page
      .getByRole("textbox", { name: "Text" })
      .fill(original.replace("sixteen", "twenty"));
    await page
      .getByRole("textbox", { name: "What changed" })
      .fill("Longer leave");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(article.getByText(/twenty weeks/u)).toBeVisible();
    await expect(versionRow(page, 2)).toContainText("Longer leave");

    // Someone saves while the editor is open: saving shows their version,
    // keeps this text, and saving again builds on theirs.
    await page.getByRole("button", { name: "Edit" }).click();
    await mine.api.knowledge.saveDocument({
      collectionId,
      path: "handbook/leave.md",
      text: `${original}\nAdded elsewhere.\n`,
      ifVersion: 2,
      message: "From another tab",
    });
    const mineText = original.replace("sixteen", "twenty-six");
    await page.getByRole("textbox", { name: "Text" }).fill(mineText);
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("alert")).toContainText(
      "This document changed since you opened it. Version 3 is below"
    );
    await expect(page.getByText("Added elsewhere.")).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Text" })).toHaveValue(
      mineText
    );
    await page.getByRole("button", { name: "Save" }).click();
    await expect(article.getByText(/twenty-six weeks/u)).toBeVisible();
    await expect(versionRow(page, 4)).toBeVisible();
    await expect(versionRow(page, 3)).toContainText("From another tab");

    // Restoring an earlier version saves its text as the next one.
    await page.getByRole("button", { name: "Restore version 1" }).click();
    await expect(versionRow(page, 5)).toContainText("Restored version 1");
    await expect(article.getByText(/sixteen weeks/u)).toBeVisible();
  } finally {
    mine.core[Symbol.dispose]();
  }
});
