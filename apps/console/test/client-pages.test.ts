import { introspectWorkflow } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";

import { setFeature, setSignIn } from "../src/clients/settings.ts";
import { act, audit, consoleDatabase } from "../src/db/act.ts";
import { clientDeploys, clientRuns, clients } from "../src/db/schema.ts";
import { startProvisioning } from "../src/provision/control.ts";
import { importReleases } from "../src/releases/import.ts";
import { mockAccess } from "./access.ts";
import { page } from "./pages.ts";
import { publishRelease } from "./releases.ts";

mockAccess();

const db = consoleDatabase(env.DB);
const staff = { email: "staff@grasp.test", sub: "sub-staff" };

/**
 * A client whose real run waits for Workers Paid, its account step as it
 * ends for a new account (the page's tests have no Cloudflare API to
 * settle one against). The caller disposes of `runs`.
 */
const waitingClient = async () => {
  const release = await publishRelease({ notes: "feat(core): waits" });
  await importReleases(env.RELEASES, db);
  const clientId = `client-${crypto.randomUUID().slice(0, 8)}`;
  const accountId = crypto.randomUUID().replaceAll("-", "");
  const runs = await introspectWorkflow(env.PROVISION_CLIENT);
  await runs.modifyAll(async (modifier) => {
    await modifier.mockStepResult(
      { name: "account" },
      { accountId, abandonedAccountId: null }
    );
  });
  await startProvisioning(env, staff, {
    clientId,
    name: "Acme",
    releaseId: release.id,
    ring: 1,
    signIn: {
      domains: ["acme.test"],
      admins: ["ada@acme.test"],
      googleHostedDomain: "acme.test",
    },
  });
  const [run] = await runs.get();
  if (run === undefined) {
    throw new Error("No run was created");
  }
  await run.waitForStepResult({ name: "client" });
  return { clientId, accountId, releaseId: release.id, runs };
};

/** A client recorded as `status`, without a run, on a new account id. */
const recordClient = async (
  status: "provisioning" | "active" = "provisioning"
) => {
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
        status,
        createdBy: staff.email,
        createdAt: now,
        updatedAt: now,
      }),
    ],
    { action: "client.create", clientId: id }
  );
  return { id, accountId };
};

/** What the not-found page says of client `id`, as React escapes it. */
const noSuchClient = (id: string) => `There&#x27;s no client ${id}.`;

describe("the client pages", () => {
  it("list every client in a grid from what the console recorded, with links to its deployment, account and Activity, a way to add one, and its live columns still to read", async () => {
    const client = await recordClient();
    const live = await recordClient("active");

    // The live columns are read after the page shows (test/client-grid.test.ts).
    const { status, html } = await page("/");

    expect({
      status,
      listed: html.includes(`href="/clients/${client.id}"`),
      columns: [
        "Release",
        "Last deploy (UTC)",
        "Drift",
        "Shared secrets",
        "Health",
        "Cost this month",
      ].every((column) => html.includes(column)),
      links: [
        `href="https://${live.id}.grasp.test"`,
        `href="https://${live.id}.grasp.test/activity"`,
        `href="https://dash.cloudflare.com/${live.accountId}"`,
      ].every((link) => html.includes(link)),
      reading: html.includes("reading…"),
      add: html.includes('href="/clients/new"'),
    }).toStrictEqual({
      status: 200,
      listed: true,
      columns: true,
      links: true,
      reading: true,
      add: true,
    });
  });

  it("offer the imported releases on the new-client form, newest first by default", async () => {
    const release = await publishRelease({ notes: "feat(core): newest" });
    await importReleases(env.RELEASES, db);

    const { status, html } = await page("/clients/new");

    expect({
      status,
      form:
        html.includes('name="clientId"') && html.includes('name="accountId"'),
      signIn: [
        'name="entraTenantId"',
        'name="googleHostedDomain"',
        'name="domains"',
        'name="admins"',
      ].every((field) => html.includes(field)),
      newest: html.includes(`value="${release.id}"`),
    }).toStrictEqual({ status: 200, form: true, signIn: true, newest: true });
  });

  it("show a client waiting for Workers Paid the checklist, with its account's dashboard", async () => {
    const { clientId, accountId, runs } = await waitingClient();
    await using _runs = runs;

    const { status, html } = await page(`/clients/${clientId}`);

    expect({
      status,
      checklist: html.includes("upgrade it to Workers Paid"),
      dashboard: html.includes(`https://dash.cloudflare.com/${accountId}`),
      confirm: html.includes("Workers Paid is on"),
      hostname: html.includes(`${clientId}.grasp.test`),
    }).toStrictEqual({
      status: 200,
      checklist: true,
      dashboard: true,
      confirm: true,
      hostname: true,
    });
  });

  it("say a Workers Paid confirmation is in, in place of the button, while the run gets to it", async () => {
    const { clientId, runs } = await waitingClient();
    await using _runs = runs;
    // Once the run has checked for a confirmation and found none, it waits:
    // recorded then, as confirming does first, before the run has the event.
    const [run] = await runs.get();
    await run?.waitForStepResult({ name: "workers paid confirmed" });
    await audit(db, staff, { action: "client.workers_paid", clientId });

    const { html } = await page(`/clients/${clientId}`);

    expect({
      confirmed: html.includes("Confirmed, waiting for the run."),
      button: html.includes("Workers Paid is on"),
    }).toStrictEqual({ confirmed: true, button: false });
  });

  it("show a deploy under way with its release and the last step it finished", async () => {
    const { clientId, releaseId, runs } = await waitingClient();
    await using _runs = runs;
    const now = new Date();
    await db.insert(clientDeploys).values({
      id: crypto.randomUUID(),
      clientId,
      releaseId,
      status: "running",
      step: "migrations",
      startedBy: staff.email,
      createdAt: now,
      updatedAt: now,
    });

    const { html } = await page(`/clients/${clientId}`);

    expect({
      deploying: html.includes(`Deploying ${releaseId}: migrations done.`),
      release: html.includes(releaseId),
    }).toStrictEqual({ deploying: true, release: true });
  });

  it("show a resumed run in its first steps, not the deploy an earlier run left", async () => {
    const { clientId, releaseId, runs } = await waitingClient();
    await using _runs = runs;
    const [run] = await runs.get();
    await run?.waitForStepResult({ name: "workers paid confirmed" });
    // Staff confirmed Workers Paid, an earlier run's deploy failed, and the
    // current run was claimed after both: it won't wait, and hasn't started
    // its own deploy yet.
    await audit(db, staff, { action: "client.workers_paid", clientId });
    const earlier = new Date(Date.now() - 60 * 60 * 1000);
    await db.insert(clientDeploys).values({
      id: crypto.randomUUID(),
      clientId,
      releaseId,
      status: "failed",
      step: "workers",
      error: "hostname_taken",
      startedBy: staff.email,
      createdAt: earlier,
      updatedAt: earlier,
    });
    await db
      .update(clientRuns)
      .set({ claimedAt: new Date(Date.now() + 1000) })
      .where(eq(clientRuns.clientId, clientId));

    const { html } = await page(`/clients/${clientId}`);

    expect({
      settingUp: html.includes(
        "Setting up: the Cloudflare account, then the client record."
      ),
      deploying: html.includes("Deploying"),
    }).toStrictEqual({ settingUp: true, deploying: false });
  });

  it("show an active client where it's live", async () => {
    const client = await recordClient("active");

    const { status, html } = await page(`/clients/${client.id}`);

    expect({
      status,
      live: html.includes(
        `Live at https://${client.id}.grasp.test, and passed its smoke check.`
      ),
      resume: html.includes("Resume"),
    }).toStrictEqual({ status: 200, live: true, resume: false });
  });

  it("offer to resume a client whose run is gone", async () => {
    const client = await recordClient();

    const { status, html } = await page(`/clients/${client.id}`);

    expect({
      status,
      gone: html.includes("its run is gone"),
      resume: html.includes("Resume"),
      confirm: html.includes("Workers Paid is on"),
    }).toStrictEqual({ status: 200, gone: true, resume: true, confirm: false });
  });

  it("show why a run stopped before it recorded the client, with a way to start again", async () => {
    const release = await publishRelease({ notes: "feat(core): stops" });
    await importReleases(env.RELEASES, db);
    const clientId = `client-${crypto.randomUUID().slice(0, 8)}`;
    await using runs = await introspectWorkflow(env.PROVISION_CLIENT);
    // The test's store holds no deployer token: the run's first step stops.
    await startProvisioning(env, staff, {
      clientId,
      name: "Acme",
      releaseId: release.id,
      ring: 1,
      signIn: {
        domains: ["acme.test"],
        admins: ["ada@acme.test"],
        googleHostedDomain: "acme.test",
      },
    });
    const [run] = await runs.get();
    await run?.waitForStatus("errored");

    const { status, html } = await page(`/clients/${clientId}`);

    expect({
      status,
      reason: html.includes(
        "store_secret_missing: DEPLOYER_API_TOKEN is missing from Secrets Store"
      ),
      startAgain: html.includes('href="/clients/new"'),
      resume: html.includes("Resume"),
    }).toStrictEqual({
      status: 200,
      reason: true,
      startAgain: true,
      resume: false,
    });
  });

  it("show a client's ring, flags and sign-in to change, what waits for its next deploy, and its history", async () => {
    const client = await recordClient("active");
    await setSignIn(env, staff, {
      clientId: client.id,
      signIn: {
        domains: ["acme.test"],
        admins: ["ada@acme.test"],
        googleHostedDomain: "acme.test",
      },
    });
    await setFeature(env, staff, {
      clientId: client.id,
      feature: "knowledge_uploads",
      on: true,
    });

    const { status, html } = await page(`/clients/${client.id}`);

    expect({
      status,
      ring: html.includes('name="ring"') && html.includes('value="3"'),
      flag:
        html.includes("knowledge_uploads") &&
        html.includes('aria-label="Feature knowledge_uploads"'),
      signIn:
        html.includes('value="acme.test"') &&
        html.includes('value="ada@acme.test"'),
      pending: html.includes("changed since its last deploy: apply them now"),
      apply: html.includes("Apply settings now"),
      history: ["client.feature", "client.sign_in", "client.create"].map(
        (action) => html.includes(action)
      ),
    }).toStrictEqual({
      status: 200,
      ring: true,
      flag: true,
      signIn: true,
      pending: true,
      apply: true,
      history: [true, true, true],
    });
  });

  it("answer 404 for a client that doesn't exist, or can't be one, and link back to the list", async () => {
    const [missing, invalid] = await Promise.all(
      ["/clients/nobody-here", "/clients/Not_A_Client"].map(
        async (path) => await page(path)
      )
    );

    expect({
      statuses: [missing?.status, invalid?.status],
      missing: missing?.html.includes(noSuchClient("nobody-here")),
      invalid: invalid?.html.includes(noSuchClient("Not_A_Client")),
      back: [missing, invalid].every(
        (answer) =>
          answer?.html.includes("Back to clients") === true &&
          answer.html.includes('href="/"')
      ),
    }).toStrictEqual({
      statuses: [404, 404],
      missing: true,
      invalid: true,
      back: true,
    });
  });

  it("answer 404 for a page the console doesn't have, with a way back", async () => {
    const { status, html } = await page("/no-such-page");

    expect({
      status,
      says: html.includes("The console has no such page."),
      back: html.includes("Back to clients"),
    }).toStrictEqual({ status: 404, says: true, back: true });
  });
});
