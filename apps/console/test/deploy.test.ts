import { deriveClientSecret } from "@grasp-os/shared/client-secrets";
import { deriveRouterSecret } from "@grasp-os/shared/router";
import { env } from "cloudflare:workers";
import { and, asc, eq, sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { cloudflareApi } from "../src/cloudflare/api.ts";
import { queryD1 } from "../src/cloudflare/workers.ts";
import { act, consoleDatabase } from "../src/db/act.ts";
import {
  auditEvents,
  clientDeploys,
  clients,
  clientWorkers,
} from "../src/db/schema.ts";
import { runDeploy, startDeploy } from "../src/deploy/deploy.ts";
import type { DeploySecrets } from "../src/deploy/secrets.ts";
import { importReleases } from "../src/releases/import.ts";
import type { AccountState } from "./cloudflare-api-kit.ts";
import { mockCloudflareApi } from "./cloudflare-api.ts";
import { publishRelease } from "./releases.ts";
import type { ReleaseSpec } from "./releases.ts";

const token = "test-deployer-token-0123456789";
const cloudflare = mockCloudflareApi(token);
const api = cloudflareApi({ token, retryDelayMs: 0 });
const db = consoleDatabase(env.DB);
const secrets: DeploySecrets = {
  routerKey: "test-router-key",
  clientKey: "test-client-key",
  shared: {
    connect: { COMPOSIO_API_KEY: "composio" },
  },
};
const context = { api, db, store: env.RELEASES, secrets };
const staff = { email: "staff@grasp.test", sub: "sub-staff" };

/** A client on a new account in the fake, and a release imported to deploy to it. */
const setUp = async (spec?: ReleaseSpec) => {
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
  const release = await publishRelease(
    spec ?? { notes: "feat(core): deploy me" }
  );
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
    // Events of one millisecond in the order they were written.
    .orderBy(asc(auditEvents.at), sql`rowid`);
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
      step: "traffic",
      error: null,
    });
    const events = await deployEvents(clientId);
    expect(events.map(({ action }) => action)).toStrictEqual([
      "deploy.start",
      "deploy.resources",
      "deploy.migrations",
      "deploy.version",
      "deploy.version",
      "deploy.versions",
      "deploy.worker_live",
      "deploy.worker_live",
      "deploy.traffic",
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
      "deploy.version",
      "deploy.version",
      "deploy.versions",
      "deploy.worker_live",
      "deploy.worker_live",
      "deploy.traffic",
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
      error: "d1_migration_failed",
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
      error: "database_outside_eu",
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
    expect(event?.detail).toBe(
      JSON.stringify({
        deploy: deployId,
        step: "migrations",
        error: "release_blob_mismatch",
      })
    );
  });
});

/** The version all of `script`'s traffic goes to in `account`. */
const liveVersionOf = (account: AccountState, script: string) => {
  const state = account.scripts.get(script);
  const [only] = state?.deployments[0]?.versions ?? [];
  return state?.versions.find(({ id }) => id === only?.version_id);
};

/** A version's bindings, by name. */
const bindingsOf = (version: ReturnType<typeof liveVersionOf>) =>
  new Map(
    z
      .array(z.looseObject({ name: z.string() }))
      .parse(version?.metadata.bindings ?? [])
      .map((binding) => [binding.name, binding])
  );

describe("deploying a release's Workers", () => {
  it("uploads connect then core with their secrets and settings, on the release's pins, and sends them all traffic", async () => {
    const { account, clientId, release, deployId } = await setUp();

    await runDeploy(context, deployId);

    const connect = liveVersionOf(account, "grasp-os-connect");
    // Core signs capabilities with what connect checks them with.
    const capability = await deriveClientSecret(
      "test-client-key",
      "capability",
      clientId,
      1
    );
    const core = liveVersionOf(account, "grasp-os-core");
    expect({
      connect: Object.fromEntries(connect?.secrets ?? []),
      core: Object.fromEntries(core?.secrets ?? []),
    }).toStrictEqual({
      // Derived for the client's first generation, and the shared one.
      connect: {
        CAPABILITY_SIGNING_KEY: capability,
        COMPOSIO_API_KEY: "composio",
        TOKEN_ENCRYPTION_KEY: await deriveClientSecret(
          "test-client-key",
          "token-encryption",
          clientId,
          1,
          "base64"
        ),
      },
      core: {
        BETTER_AUTH_SECRET: await deriveClientSecret(
          "test-client-key",
          "better-auth",
          clientId,
          1
        ),
        CAPABILITY_SIGNING_KEY: capability,
        // The first router secret generation, as a new client has.
        ROUTER_SECRET: await deriveRouterSecret("test-router-key", clientId, 1),
      },
    });
    const coreDb = account.d1.find(({ name }) => name === "grasp-os-core");
    const started = await deployRow(deployId);
    const bindings = bindingsOf(core);
    expect({
      db: bindings.get("DB"),
      change: bindings.get("PLATFORM_CHANGE"),
      compatibilityDate: core?.metadata.compatibility_date,
      tag: account.scripts.get("grasp-os-core")?.migrationTag,
    }).toStrictEqual({
      db: { type: "d1", name: "DB", id: coreDb?.uuid },
      change: {
        type: "json",
        name: "PLATFORM_CHANGE",
        json: {
          by: staff.email,
          what: "release",
          release: release.id,
          // When the deploy started.
          at: started?.createdAt.toISOString(),
        },
      },
      compatibilityDate: release.manifest.compatibilityDate,
      tag: "v1",
    });
    expect({
      schedules: account.scripts.get("grasp-os-core")?.schedules,
      subdomain: account.scripts.get("grasp-os-core")?.subdomain,
      workflow: account.workflows.get("grasp-os-workflows"),
    }).toStrictEqual({
      schedules: ["* * * * *"],
      subdomain: { enabled: true, previews_enabled: false },
      workflow: {
        class_name: "WorkflowDispatcher",
        script_name: "grasp-os-core",
      },
    });
    const workers = await db
      .select({
        worker: clientWorkers.worker,
        versionId: clientWorkers.versionId,
      })
      .from(clientWorkers)
      .where(eq(clientWorkers.clientId, clientId));
    expect(
      workers.toSorted((a, b) => a.worker.localeCompare(b.worker))
    ).toStrictEqual([
      { worker: "connect", versionId: connect?.id },
      { worker: "core", versionId: core?.id },
    ]);
  });

  it("deploys a later release as new versions, and runs only its new Durable Object migrations", async () => {
    const { account, clientId, deployId } = await setUp();
    await runDeploy(context, deployId);
    const next = await publishRelease({
      notes: "feat(core): next",
      core: "export default { core: 2 };",
      durableObjectMigrations: ["v1", "v2"],
    });
    const same = await publishRelease({
      notes: "fix(core): same objects",
      core: "export default { core: 3 };",
      durableObjectMigrations: ["v1", "v2"],
    });
    await importReleases(env.RELEASES, db);

    await runDeploy(context, await startDeploy(db, staff, clientId, next.id));
    const migrated = cloudflare.calls.filter(
      ({ method, path }) =>
        method === "PUT" && path.endsWith("/workers/scripts/grasp-os-core")
    );
    await runDeploy(context, await startDeploy(db, staff, clientId, same.id));

    // The first deploy and v2 went as script uploads; the last as a
    // version, since it runs no migration.
    const core = account.scripts.get("grasp-os-core");
    expect({
      scriptUploads: migrated.length,
      migrations: core?.versions[1]?.metadata.migrations,
      tag: core?.migrationTag,
      live: liveVersionOf(account, "grasp-os-core")?.modules[0]?.content,
      versions: core?.versions.length,
    }).toStrictEqual({
      scriptUploads: 2,
      migrations: {
        old_tag: "v1",
        new_tag: "v2",
        steps: [{ new_sqlite_classes: ["Classv2"] }],
      },
      tag: "v2",
      live: "export default { core: 3 };",
      versions: 3,
    });
  });

  it("refuses to upload without a required secret, and resumes without uploading connect again", async () => {
    const { account, deployId } = await setUp({
      notes: "feat(core): needs a shared secret",
      coreSecrets: ["ENTRA_CLIENT_SECRET"],
    });
    const withoutEntra = context;
    const withEntra = {
      ...context,
      secrets: {
        ...secrets,
        shared: { ...secrets.shared, core: { ENTRA_CLIENT_SECRET: "entra" } },
      },
    };

    await expect(runDeploy(withoutEntra, deployId)).rejects.toMatchObject({
      name: "MissingSecretError",
    });
    await expect(deployRow(deployId)).resolves.toMatchObject({
      status: "failed",
      step: "migrations",
      error: "MissingSecretError",
    });
    expect(account.scripts.has("grasp-os-core")).toBeFalsy();

    await runDeploy(withEntra, deployId);

    expect(
      [...account.scripts].map(([name, script]) => [
        name,
        script.versions.length,
      ])
    ).toStrictEqual([
      ["grasp-os-connect", 1],
      ["grasp-os-core", 1],
    ]);
  });
});
