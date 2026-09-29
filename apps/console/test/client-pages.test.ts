import { introspectWorkflowInstance } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { act, consoleDatabase } from "../src/db/act.ts";
import { clients } from "../src/db/schema.ts";
import { startProvisioning } from "../src/provision/control.ts";
import { importReleases } from "../src/releases/import.ts";
import { accessJwt, mockAccess } from "./access.ts";
import { publishRelease } from "./releases.ts";

mockAccess();

const origin = "https://console.grasp.test";
const db = consoleDatabase(env.DB);
const staff = { email: "staff@grasp.test", sub: "sub-staff" };

const scripts = /<script\b[^>]*>[\s\S]*?<\/script>/gu;

/**
 * The page at `path`, as a staff member sees it: its markup without its
 * scripts, so the data sent along for hydration doesn't count as shown.
 */
const page = async (path: string) => {
  const response = await exports.default.fetch(`${origin}${path}`, {
    headers: {
      "cf-access-jwt-assertion": await accessJwt(staff.email),
    },
  });
  const html = await response.text();
  return { status: response.status, html: html.replaceAll(scripts, "") };
};

/** A client recorded as provisioning, waiting for Workers Paid, on a new account id. */
const recordClient = async () => {
  const id = `client-${crypto.randomUUID().slice(0, 8)}`;
  const accountId = crypto.randomUUID().replaceAll("-", "");
  const now = new Date();
  await act(
    db,
    staff,
    [
      db.insert(clients).values({
        id,
        name: `Acme ${id}`,
        accountId,
        ring: 3,
        createdBy: staff.email,
        createdAt: now,
        updatedAt: now,
      }),
    ],
    { action: "client.create", clientId: id }
  );
  return { id, accountId };
};

describe("the client pages", () => {
  it("list every client, with a way to add one", async () => {
    const client = await recordClient();

    const { status, html } = await page("/");

    expect({
      status,
      listed:
        html.includes(`Acme ${client.id}`) && html.includes(client.accountId),
      add: html.includes('href="/clients/new"'),
    }).toStrictEqual({ status: 200, listed: true, add: true });
  });

  it("offer the imported releases on the new-client form, newest first by default", async () => {
    const release = await publishRelease({ notes: "feat(core): newest" });
    await importReleases(env.RELEASES, db);

    const { status, html } = await page("/clients/new");

    expect({
      status,
      form:
        html.includes('name="clientId"') && html.includes('name="accountId"'),
      newest: html.includes(`value="${release.id}"`),
    }).toStrictEqual({ status: 200, form: true, newest: true });
  });

  it("show a client waiting for Workers Paid the checklist, with its account's dashboard", async () => {
    const client = await recordClient();

    const { status, html } = await page(`/clients/${client.id}`);

    expect({
      status,
      checklist: html.includes("upgrade it to Workers Paid"),
      dashboard: html.includes(
        `https://dash.cloudflare.com/${client.accountId}`
      ),
      confirm: html.includes("Workers Paid is on"),
      hostname: html.includes(`${client.id}.grasp.test`),
    }).toStrictEqual({
      status: 200,
      checklist: true,
      dashboard: true,
      confirm: true,
      hostname: true,
    });
  });

  it("show why a run stopped, with a way to resume it", async () => {
    const release = await publishRelease({ notes: "feat(core): stops" });
    await importReleases(env.RELEASES, db);
    const clientId = `client-${crypto.randomUUID().slice(0, 8)}`;
    await using run = await introspectWorkflowInstance(
      env.PROVISION_CLIENT,
      clientId
    );
    await run.modify(async (modifier) => {
      await modifier.disableRetryDelays();
    });
    // The test's store holds no deployer token: the run's first step fails.
    await startProvisioning(env, staff, {
      clientId,
      name: "Acme",
      releaseId: release.id,
      ring: 1,
    });
    await run.waitForStatus("errored");

    const { status, html } = await page(`/clients/${clientId}`);

    expect({
      status,
      reason: html.includes("DEPLOYER_API_TOKEN is missing from Secrets Store"),
      resume: html.includes("Resume"),
    }).toStrictEqual({ status: 200, reason: true, resume: true });
  });

  it("answer 404 for a client that doesn't exist, or can't be one", async () => {
    const statuses = await Promise.all(
      ["/clients/nobody-here", "/clients/Not_A_Client"].map(async (path) => {
        const { status } = await page(path);
        return status;
      })
    );

    expect(statuses).toStrictEqual([404, 404]);
  });
});
