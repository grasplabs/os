import { env } from "cloudflare:workers";
import { and, asc, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vite-plus/test";

import { cloudflareApi } from "../src/cloudflare/api.ts";
import { queryD1 } from "../src/cloudflare/workers.ts";
import { act, consoleDatabase } from "../src/db/act.ts";
import { auditEvents, clientDeploys, clients } from "../src/db/schema.ts";
import { runDeploy, startDeploy } from "../src/deploy/deploy.ts";
import { importReleases } from "../src/releases/import.ts";
import type { AccountState } from "./cloudflare-api-kit.ts";
import { mockCloudflareApi } from "./cloudflare-api.ts";
import { publishRelease } from "./releases.ts";

const token = "test-deployer-token-0123456789";
const cloudflare = mockCloudflareApi(token);
const api = cloudflareApi({ token, retryDelayMs: 0 });
const db = consoleDatabase(env.DB);
const context = { api, db, store: env.RELEASES };
const staff = { email: "staff@grasp.test", sub: "sub-staff" };

/** A client on a new account in the fake, and a release imported to deploy to it. */
const setUp = async () => {
  const account = cloudflare.addAccount();
  const clientId = `client-${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date();
  await act(
    db,
    staff,
    [
      db.insert(clients).values({
        id: clientId,
        name: clientId,
        accountId: account.id,
        createdAt: now,
        updatedAt: now,
      }),
    ],
    { action: "client.create", clientId }
  );
  const release = await publishRelease({ notes: "feat(core): deploy me" });
  await importReleases(env.RELEASES, db);
  const deployId = await startDeploy(db, staff, clientId, release.id);
  return { account, clientId, release, deployId };
};

const deployRow = async (id: string) => {
  const [row] = await db
    .select()
    .from(clientDeploys)
    .where(eq(clientDeploys.id, id));
  return row;
};

/** The deploy's audit events, oldest first: each action and its detail. */
const deployEvents = async (clientId: string) => {
  const events = await db
    .select({ action: auditEvents.action, detail: auditEvents.detail })
    .from(auditEvents)
    .where(eq(auditEvents.clientId, clientId))
    .orderBy(asc(auditEvents.at));
  return events.filter(({ action }) => action.startsWith("deploy."));
};

/** The migrations each database in `account` recorded, by database name. */
const appliedMigrations = async (
  account: AccountState
): Promise<Record<string, unknown[]>> => {
  const entries = await Promise.all(
    account.d1.map(async ({ uuid, name }): Promise<[string, unknown[]]> => {
      // A database no migration reached has no d1_migrations table yet.
      const [tables = []] = await queryD1(
        api,
        account.id,
        uuid,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'd1_migrations'"
      );
      if (tables.length === 0) {
        return [name, []];
      }
      const [rows = []] = await queryD1(
        api,
        account.id,
        uuid,
        "SELECT name FROM d1_migrations ORDER BY id"
      );
      return [name, rows.map((row) => row.name)];
    })
  );
  return Object.fromEntries(entries);
};

/** Runs a deploy expected to fail, with its logged failure kept out of the output. */
const failingDeploy = async (id: string) => {
  const logged: unknown[] = [];
  const errors = vi.spyOn(console, "error").mockImplementation((line) => {
    logged.push(line);
  });
  try {
    await expect(runDeploy(context, id)).rejects.toBeInstanceOf(Error);
  } finally {
    errors.mockRestore();
  }
  return logged;
};

describe("deploying a release to a client's account", () => {
  it("creates its databases and buckets in the EU and applies its migrations, audited step by step", async () => {
    const { account, clientId, deployId } = await setUp();

    await runDeploy(context, deployId);

    const made = [...account.d1, ...account.buckets].map(
      ({ name, jurisdiction }) => `${name} in ${jurisdiction}`
    );
    expect(made.toSorted((a, b) => a.localeCompare(b))).toStrictEqual([
      "grasp-os-audit-archive in eu",
      "grasp-os-connect in eu",
      "grasp-os-core in eu",
      "grasp-os-files in eu",
      "grasp-os-knowledge in eu",
    ]);
    await expect(appliedMigrations(account)).resolves.toStrictEqual({
      "grasp-os-connect": ["0000_connect.sql"],
      "grasp-os-core": ["0000_init.sql"],
      "grasp-os-knowledge": ["0000_knowledge.sql"],
    });
    await expect(deployRow(deployId)).resolves.toMatchObject({
      status: "done",
      step: "migrations",
      error: null,
    });
    const events = await deployEvents(clientId);
    expect(events.map(({ action }) => action)).toStrictEqual([
      "deploy.start",
      "deploy.resources",
      "deploy.migrations",
      "deploy.done",
    ]);
  });

  it("resumes after a resource was made but its answer lost, creating nothing twice", async () => {
    const { account, clientId, deployId } = await setUp();
    // The second database's create: listed (1), created (2), listed (3),
    // then this one goes through, and its answer never arrives.
    cloudflare.failCall(4, "lost");

    await failingDeploy(deployId);

    expect(cloudflare.calls[3]).toMatchObject({
      method: "POST",
      path: `/accounts/${account.id}/d1/database`,
    });
    await expect(deployRow(deployId)).resolves.toMatchObject({
      status: "failed",
      step: null,
      error: "cloudflare_0",
    });

    await runDeploy(context, deployId);

    expect([account.d1.length, account.buckets.length]).toStrictEqual([3, 2]);
    const events = await deployEvents(clientId);
    expect(events.map(({ action }) => action)).toStrictEqual([
      "deploy.start",
      "deploy.fail",
      "deploy.resources",
      "deploy.migrations",
      "deploy.done",
    ]);
  });

  it("keeps the API token out of its logs, its row and its audit events", async () => {
    const { clientId, deployId } = await setUp();
    // The first database's create fails, and isn't retried.
    cloudflare.failCall(2, 500);
    const logged = await failingDeploy(deployId);
    await runDeploy(context, deployId);

    const rows = await db
      .select()
      .from(clientDeploys)
      .where(eq(clientDeploys.id, deployId));
    const events = await deployEvents(clientId);
    expect(logged).not.toHaveLength(0);
    expect(JSON.stringify([logged, rows, events])).not.toContain(token);
  });

  it("resumes after a migration failed, applying only what's left", async () => {
    const { account, deployId } = await setUp();
    // Ten calls make the three databases and two buckets; then connect's
    // database is read (11) and its migration applied (12), which fails.
    cloudflare.failCall(12, "statement-failed");

    await failingDeploy(deployId);

    expect(cloudflare.calls[11]?.path).toMatch(/\/query$/u);
    await expect(deployRow(deployId)).resolves.toMatchObject({
      status: "failed",
      step: "resources",
      error: "Error",
    });
    await expect(appliedMigrations(account)).resolves.toMatchObject({
      "grasp-os-connect": [],
    });

    await runDeploy(context, deployId);

    await expect(appliedMigrations(account)).resolves.toStrictEqual({
      "grasp-os-connect": ["0000_connect.sql"],
      "grasp-os-core": ["0000_init.sql"],
      "grasp-os-knowledge": ["0000_knowledge.sql"],
    });
  });

  it("stops at a database that exists outside the EU, and makes nothing after it", async () => {
    const { account, deployId } = await setUp();
    account.d1.push({ uuid: crypto.randomUUID(), name: "grasp-os-core" });

    await failingDeploy(deployId);

    await expect(deployRow(deployId)).resolves.toMatchObject({
      status: "failed",
      error: "OutsideEuError",
    });
    expect(account.buckets).toStrictEqual([]);
  });

  it("leaves a deploy that's done as it is", async () => {
    const { deployId } = await setUp();
    await runDeploy(context, deployId);
    const calls = cloudflare.calls.length;

    await runDeploy(context, deployId);

    expect(cloudflare.calls).toHaveLength(calls);
  });

  it("refuses a migration whose blob changed since the release was imported", async () => {
    const { account, release, deployId } = await setUp();
    const connectMigration =
      release.manifest.workers.connect?.d1Databases[0]?.migrations[0];
    if (connectMigration === undefined) {
      throw new Error("expected connect's migration");
    }
    const original = release.blobs.get(connectMigration.r2Key);
    // The same size, other bytes. Every test release shares this blob, so
    // it's put back.
    await env.RELEASES.put(connectMigration.r2Key, "CREATE TABLE x (id TEXT);");
    try {
      await failingDeploy(deployId);
    } finally {
      await env.RELEASES.put(connectMigration.r2Key, original ?? "");
    }

    await expect(appliedMigrations(account)).resolves.toMatchObject({
      "grasp-os-connect": [],
    });
    const [event] = await db
      .select({ detail: auditEvents.detail })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.action, "deploy.fail"),
          eq(auditEvents.target, release.id)
        )
      );
    expect(event?.detail).toContain('"step":"migrations"');
  });
});
