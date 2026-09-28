import { readFile } from "node:fs/promises";

import { expect } from "@playwright/test";

import { test } from "./csp.ts";
import { apiOf, pageOf, peopleIn } from "./people.ts";

// The Activity page: an admin approves one App's permission request and
// rejects another, finds the approval in the audit log with its details,
// and exports what the log's filters match. Search, export and the grant
// themselves are core's tests.

/** The built-in workflow map's App: its requests are decided on copies. */
const workflowMap = "builtin-workflow-map";

/**
 * How long the release's install may take to list the built-in: it runs
 * on the first request, in the background.
 */
const installedMs = 30_000;

test("an admin approves a permission request, finds it in the audit log, and exports it", async ({
  browser,
}) => {
  const { admin, builder } = peopleIn("activity");
  const appName = `Board pack ${crypto.randomUUID()}`;
  const { core, api } = apiOf(builder);
  let approved: string;
  try {
    const { id: appId } = await api.apps.create({
      name: appName,
      description: "Reads the Playbook",
    });
    ({ id: approved } = await api.permissions.request({
      subject: { type: "app", appId },
      object: { type: "collection", collectionId: "playbook" },
      actions: ["read"],
      binding: "PLAYBOOK",
    }));
    await api.permissions.request({
      subject: { type: "app", appId },
      object: { type: "collection", collectionId: "playbook" },
      actions: ["write"],
      binding: "PLAYBOOK_WRITE",
    });
  } finally {
    core[Symbol.dispose]();
  }
  // A built-in blueprint's own request, installed with the release on the
  // first request, waits too; the page leaves it out.
  const asAdmin = apiOf(admin);
  try {
    await expect
      .poll(
        async () => {
          const held = await asAdmin.api.permissions.list({
            type: "app",
            appId: workflowMap,
          });
          return held.some(({ status }) => status === "requested");
        },
        { timeout: installedMs }
      )
      .toBeTruthy();
  } finally {
    asAdmin.core[Symbol.dispose]();
  }

  const page = await pageOf(browser, admin);
  await page.goto("/activity");
  await page.getByRole("tab", { name: "Pending approvals" }).click();
  // Other tests' requests wait here too: only this App's rows count.
  const rows = page.getByRole("row").filter({ hasText: appName });
  await expect(rows).toHaveCount(2);
  await expect(
    page.getByRole("cell", { name: "Workflow map", exact: true })
  ).toHaveCount(0);
  const reading = rows.filter({
    has: page.getByRole("cell", { name: "read", exact: true }),
  });
  await expect(reading).toContainText("Collection playbook");
  await expect(reading).toContainText("None current");
  await reading.getByRole("button", { name: /^Approve /u }).click();
  await expect(page.getByRole("status")).toContainText(
    `Approved: ${appName}: read on Collection playbook.`
  );
  await expect(rows).toHaveCount(1);

  await rows.getByRole("button", { name: /^Reject /u }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Reject", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText(`Rejected: ${appName}`);
  await expect(rows).toHaveCount(0);

  // The approval is in the log, found by what it granted.
  await page.goto(`/activity?target=${approved}`);
  await expect(page.getByRole("textbox", { name: "Target ID" })).toHaveValue(
    approved
  );
  const granted = page
    .getByRole("row")
    .filter({ has: page.getByRole("cell", { name: "permission.granted" }) });
  await expect(granted).toHaveCount(1);
  await expect(granted).toContainText("Permission");
  await expect(granted).toContainText(`permission ${approved}`);
  await expect(
    page.getByRole("row").filter({
      has: page.getByRole("cell", { name: "permission.requested" }),
    })
  ).toHaveCount(1);
  await granted.getByRole("button", { name: /^Details of event /u }).click();
  await expect(
    page.getByText(`"requestedBy": "${builder.userId}"`)
  ).toBeVisible();

  // Narrowed to grants, the request drops out.
  await page.getByRole("combobox", { name: "Type" }).click();
  await page.getByRole("option", { name: "Permission" }).click();
  await page
    .getByRole("textbox", { name: "Action" })
    .fill("permission.granted");
  await page.getByRole("button", { name: "Filter" }).click();
  await expect(page).toHaveURL(/action=permission\.granted/u);
  await expect(
    page.getByRole("row").filter({
      has: page.getByRole("cell", { name: "permission.requested" }),
    })
  ).toHaveCount(0);
  await expect(granted).toHaveCount(1);

  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export CSV" }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/^audit-log-.+\.csv$/u);
  const csv = await readFile(await download.path(), "utf-8");
  const lines = csv.trimEnd().split("\r\n");
  expect(lines).toHaveLength(2);
  expect(lines[0]).toMatch(/^seq,received_at,at,type,action,/u);
  expect(lines[1]).toContain(",permission,permission.granted,");
  expect(lines[1]).toContain(approved);
});
