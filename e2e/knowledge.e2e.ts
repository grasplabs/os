import { fileURLToPath } from "node:url";

import { pageMaxLimit } from "@grasp-os/shared/knowledge";
import { uploadErrors, uploadMaxBytes } from "@grasp-os/shared/uploads";
import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import { test } from "./csp.ts";
import { apiOf, pageOf, peopleIn } from "./people.ts";

// The Knowledge page: a person finds a document by searching, reads it
// rendered (nothing in it runs, its `[[links]]` open here) with what links
// to it, edits it into a new version, meets an edit saved since in another
// tab instead of overwriting it, and restores an earlier version; and
// uploads files, following each until it is ready or failed. Search,
// versions and extraction themselves are core's tests.

/** A file from core's upload fixtures. */
const fixture = (name: string): string =>
  fileURLToPath(
    new URL(
      `../apps/core/test/fixtures/assets/uploads/${name}`,
      import.meta.url
    )
  );

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
    // Frontmatter as core reads it: after a byte order mark, with spaces
    // after the opening fence.
    "\uFEFF---  ",
    "description: Who gets how much leave",
    "---",
    "# Leave",
    "",
    "## Parental leave",
    "",
    `Everyone gets sixteen weeks of ${word} leave.`,
    "",
    "[Run this](javascript:alert(1)) and [the law](https://example.com/law).",
    "",
    "Paid as in [[handbook/pay|the pay policy]]; [back to the top](#leave).",
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
    await mine.api.knowledge.saveDocument({
      collectionId,
      path: "handbook/pay.md",
      text: "# Pay\n\nLeave is paid; see [[handbook/leave]].\n",
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
    // A first visit creates the person's Personal collection, listed at once.
    await expect(
      collections.getByRole("link", { name: "Personal", exact: true })
    ).toBeVisible();
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
    // ones (a `#heading` too) open apart from this page, and raw HTML is
    // dropped.
    await expect(article.getByText("Run this")).toBeVisible();
    await expect(article.getByRole("link", { name: "Run this" })).toHaveCount(
      0
    );
    for (const name of ["the law", "back to the top"]) {
      const link = article.getByRole("link", { name });
      // oxlint-disable-next-line no-await-in-loop -- one link at a time
      await expect(link).toHaveAttribute("rel", "noopener noreferrer");
      // oxlint-disable-next-line no-await-in-loop -- one link at a time
      await expect(link).toHaveAttribute("target", "_blank");
    }
    await expect(article.locator("img")).toHaveCount(0);
    // The frontmatter is a detail, not text.
    await expect(article.getByText("description:")).toHaveCount(0);
    await expect(
      page.getByRole("definition").getByText("Who gets how much leave")
    ).toBeVisible();

    // A `[[link]]` opens the document it names here, and each lists the
    // other as using it.
    await article.getByRole("link", { name: "the pay policy" }).click();
    await expect(
      page.getByRole("heading", { level: 2, name: "Pay" })
    ).toBeVisible();
    await page
      .getByRole("definition")
      .getByRole("link", { name: "Leave", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { level: 2, name: "Leave", exact: true })
    ).toBeVisible();
    await expect(
      page.getByRole("definition").getByRole("link", { name: "Pay" })
    ).toBeVisible();

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

    // A save from another tab while the editor is open: saving shows that
    // version and keeps this text, and only an explicit step replaces it.
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
    await expect(page.getByRole("button", { name: "Save" })).toHaveCount(0);
    await page
      .getByRole("button", { name: "Replace version 3 with mine" })
      .click();
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

test("a person uploads a file and follows it through core failing for a moment until it is ready, while one too large is refused, one core refuses to report on says why, one past the listed files opens from its row, and one without text fails, each with the reason", async ({
  browser,
}) => {
  const { one } = peopleIn("knowledgeUploads");
  const { core, api } = apiOf(one);
  let collectionId: string;
  try {
    ({ id: collectionId } = await api.knowledge.createCollection({
      name: `Policies ${crypto.randomUUID()}`,
      access: "me",
    }));
    // A full first page of files between "expense-policy.pdf" and
    // "offices.xlsx", so the one lands on it and the other past it.
    await Promise.all(
      Array.from({ length: pageMaxLimit }, async (_, index) => {
        await api.knowledge.saveDocument({
          collectionId,
          path: `m-${String(index).padStart(3, "0")}.md`,
          text: `# Note ${index}`,
          ifVersion: 0,
        });
      })
    );
  } finally {
    core[Symbol.dispose]();
  }
  const page = await pageOf(browser, one);
  // The page's asks for an upload's status (`uploads.get`): the next
  // `dropping` fail as core out of reach does (a closed socket), and while
  // `refusing`, each asks for an upload core doesn't have, which it refuses.
  let dropping = 0;
  let refusing = false;
  const statusCall = '["uploads","get"]';
  const uploadId = /[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}/gu;
  await page.routeWebSocket("**/rpc", (socket) => {
    const toCore = socket.connectToServer();
    socket.onMessage(async (message) => {
      const text = String(message);
      if (text.includes(statusCall) && dropping > 0) {
        dropping -= 1;
        await socket.close();
        return;
      }
      toCore.send(
        text.includes(statusCall) && refusing
          ? text.replaceAll(uploadId, crypto.randomUUID())
          : text
      );
    });
  });
  await page.goto(`/knowledge/${collectionId}`);
  const uploads = page.getByRole("region", { name: "Upload" });
  const input = uploads.getByLabel("Upload a PDF, Word or Excel file");

  // A file over the limit is refused with core's reason, before it's sent.
  await input.setInputFiles({
    name: "too-large.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.alloc(uploadMaxBytes + 1),
  });
  await expect(uploads.getByRole("alert")).toHaveText(
    uploadErrors.create("upload.too_large").message
  );
  await expect(uploads.getByRole("listitem")).toHaveCount(0);

  // Core out of reach for its first two asks only costs those turns.
  dropping = 2;
  await input.setInputFiles(fixture("expense-policy.pdf"));
  const ready = uploads
    .getByRole("listitem")
    .filter({ hasText: "expense-policy.pdf" });
  // Extraction runs on the engine, in its own isolate.
  await expect(ready.getByRole("status")).toHaveText("Ready", {
    timeout: 30_000,
  });
  expect(dropping).toBe(0);
  await expect(ready.getByRole("alert")).toHaveCount(0);
  await expect(ready.getByText(/past the first/u)).toHaveCount(0);
  // The file list shows the new document.
  await expect(
    page
      .getByRole("region", { name: "Files" })
      .getByRole("link", { name: "expense-policy.pdf" })
  ).toBeVisible();
  // The original comes back as an attachment, never shown in the page.
  const href = await ready
    .getByRole("link", { name: "Download expense-policy.pdf" })
    .getAttribute("href");
  expect(href).toMatch(/^\/api\/knowledge\/uploads\/[\w-]+\/original$/u);
  const original = await page.request.get(href ?? "");
  expect(original.headers()["content-disposition"]).toMatch(/^attachment/u);
  await ready.getByRole("link", { name: "Open expense-policy.pdf" }).click();
  await expect(
    page.getByRole("heading", { level: 2, name: "expense-policy" })
  ).toBeVisible();

  // A refusal ends the following, with core's reason.
  refusing = true;
  await input.setInputFiles(fixture("travel-policy.docx"));
  await expect(
    uploads
      .getByRole("listitem")
      .filter({ hasText: "travel-policy.docx" })
      .getByRole("alert")
  ).toHaveText("There's no such upload, or you can't see it.");
  refusing = false;

  // A name that sorts past the listed files opens from its row, and says so.
  await input.setInputFiles(fixture("offices.xlsx"));
  const past = uploads
    .getByRole("listitem")
    .filter({ hasText: "offices.xlsx" });
  await expect(past.getByRole("status")).toHaveText("Ready", {
    timeout: 30_000,
  });
  await expect(past).toContainText(
    `It's past the first ${pageMaxLimit} files listed: open it from here.`
  );
  await expect(
    page
      .getByRole("region", { name: "Files" })
      .getByRole("link", { name: "offices.xlsx" })
  ).toHaveCount(0);
  await past.getByRole("link", { name: "Open offices.xlsx" }).click();
  await expect(
    page.getByRole("heading", { level: 2, name: "offices", exact: true })
  ).toBeVisible();

  await input.setInputFiles(fixture("scan.pdf"));
  await expect(
    uploads
      .getByRole("listitem")
      .filter({ hasText: "scan.pdf" })
      .getByRole("status")
  ).toHaveText(
    "Failed: The file has no text to read: a scan without a text layer has none.",
    { timeout: 30_000 }
  );
});

test("someone who may only read a collection is offered no upload, edit or restore", async ({
  browser,
}) => {
  const { admin, reader } = peopleIn("knowledgeReader");
  const { core, api } = apiOf(admin);
  let collectionId: string;
  let documentId: string;
  try {
    ({ id: collectionId } = await api.knowledge.createCollection({
      name: `Handbook ${crypto.randomUUID()}`,
      access: "everyone",
    }));
    const first = await api.knowledge.saveDocument({
      collectionId,
      path: "leave.md",
      text: "# Leave\n\nSixteen weeks.\n",
      ifVersion: 0,
    });
    documentId = first.id;
    await api.knowledge.saveDocument({
      collectionId,
      path: "leave.md",
      text: "# Leave\n\nTwenty weeks.\n",
      ifVersion: 1,
    });
  } finally {
    core[Symbol.dispose]();
  }

  // Its owner, an admin, may change it.
  const owner = await pageOf(browser, admin);
  await owner.goto(`/knowledge/${collectionId}?doc=${documentId}`);
  await expect(owner.getByRole("button", { name: "Edit" })).toBeVisible();
  await expect(
    owner.getByRole("button", { name: "Restore version 1" })
  ).toBeVisible();
  await expect(owner.getByRole("region", { name: "Upload" })).toBeVisible();

  // Anyone else reads it, and is offered nothing core would refuse.
  const page = await pageOf(browser, reader);
  await page.goto(`/knowledge/${collectionId}?doc=${documentId}`);
  await expect(page.getByText("Twenty weeks.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Restore/u })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Upload" })).toHaveCount(0);
});
