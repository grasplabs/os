import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { ensureD1Database } from "../src/cloudflare/accounts.ts";
import { cloudflareApi } from "../src/cloudflare/api.ts";
import {
  applyD1Migrations,
  deleteSecret,
  deployVersion,
  isSecretsConflict,
  latestIsDeployed,
  listDeployments,
  listSecretNames,
  putSchedules,
  putSecret,
  putWorkflow,
  RolledBackError,
  setScriptSubdomain,
  queryD1,
  uploadScript,
  uploadVersion,
  uploadVersionWithSecrets,
} from "../src/cloudflare/workers.ts";
import type { AssetFile, WorkerUpload } from "../src/cloudflare/workers.ts";
import type { AccountState } from "./cloudflare-api-kit.ts";
import { mockCloudflareApi } from "./cloudflare-api.ts";

const token = "test-deployer-token-0123456789";
const cloudflare = mockCloudflareApi(token);
const api = cloudflareApi({ token, retryDelayMs: 0 });

const encoder = new TextEncoder();

/** A release's core Worker: one module, one binding, tagged `releaseId`. */
const release = (
  releaseId: string,
  assets?: readonly AssetFile[]
): WorkerUpload => ({
  releaseId,
  metadata: {
    main_module: "index.js",
    compatibility_date: "2026-09-15",
    bindings: [
      { type: "plain_text", name: "PLATFORM_CHANGE", text: releaseId },
    ],
    ...(assets === undefined
      ? {}
      : { assets: { config: { run_worker_first: true } } }),
  },
  modules: [
    {
      name: "index.js",
      type: "application/javascript+module",
      content: `export default { fetch: () => new Response("${releaseId}") };`,
    },
    { name: "skills/SKILL.md", type: "text/plain", content: "# Skill" },
  ],
  ...(assets === undefined ? {} : { assets }),
});

const file = (path: string, content: string): AssetFile => ({
  path,
  content: encoder.encode(content),
  type: "text/plain",
});

/**
 * A version's assets metadata: its config, and whether its token came from
 * a completed upload (`complete-`) or straight from the session (`assets-`).
 */
const assetsOf = (metadata: Record<string, unknown>) => {
  const { config, jwt } = z
    .object({ config: z.unknown(), jwt: z.string() })
    .parse(metadata.assets);
  return { config, completed: jwt.startsWith("complete-") };
};

/** What `promise` fails with, or undefined if it doesn't. */
const errorOf = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return undefined;
};

/** The secrets `script`'s latest version runs with. */
const latestSecrets = (account: AccountState, script: string) =>
  account.scripts.get(script)?.versions.at(-1)?.secrets ?? new Map();

/** The version each of `script`'s deployments sends its traffic to, current first. */
const deployedVersions = async (accountId: string, script: string) => {
  const deployments = await listDeployments(api, accountId, script);
  return deployments.map(({ versions }) => versions);
};

describe("deploying a release", () => {
  it("uploads the first release as a script, then later ones as versions", async () => {
    const account = cloudflare.addAccount();
    await uploadScript(
      api,
      account.id,
      "grasp-os-core",
      release("r000001-aaaaaaa")
    );
    const version = await uploadVersion(
      api,
      account.id,
      "grasp-os-core",
      release("r000002-bbbbbbb")
    );

    const uploaded = account.scripts.get("grasp-os-core")?.versions.at(-1);
    expect(uploaded).toMatchObject({
      id: version.id,
      metadata: {
        main_module: "index.js",
        annotations: { "workers/tag": "r000002-bbbbbbb" },
      },
      modules: [
        { name: "index.js", type: "application/javascript+module" },
        { name: "skills/SKILL.md", type: "text/plain", content: "# Skill" },
      ],
    });
    // Uploaded, not deployed: traffic still goes to the first release.
    const [current] = await deployedVersions(account.id, "grasp-os-core");
    expect(current).toStrictEqual([
      {
        version_id: account.scripts.get("grasp-os-core")?.versions[0]?.id,
        percentage: 100,
      },
    ]);
  });

  it("sends all traffic to a version, and back to the one before it", async () => {
    const account = cloudflare.addAccount();
    await uploadScript(
      api,
      account.id,
      "grasp-os-core",
      release("r000001-aaaaaaa")
    );
    const [first] = account.scripts.get("grasp-os-core")?.versions ?? [];
    const second = await uploadVersion(
      api,
      account.id,
      "grasp-os-core",
      release("r000002-bbbbbbb")
    );

    await deployVersion(api, account.id, "grasp-os-core", second.id, {
      message: "Rollout",
    });
    await deployVersion(api, account.id, "grasp-os-core", first?.id ?? "", {
      message: "Rollback",
    });

    await expect(
      deployedVersions(account.id, "grasp-os-core")
    ).resolves.toStrictEqual([
      [{ version_id: first?.id, percentage: 100 }],
      [{ version_id: second.id, percentage: 100 }],
      [{ version_id: first?.id, percentage: 100 }],
    ]);
    expect(
      account.scripts.get("grasp-os-core")?.deployments[0]?.annotations
    ).toStrictEqual({ "workers/message": "Rollback" });
  });

  it("can't upload a version of a Worker that doesn't exist yet", async () => {
    const account = cloudflare.addAccount();
    await expect(
      uploadVersion(
        api,
        account.id,
        "grasp-os-core",
        release("r000001-aaaaaaa")
      )
    ).rejects.toMatchObject({ status: 404, codes: [10_007] });
  });
});

describe("static assets", () => {
  it("uploads only the files the account lacks, and names them in the version", async () => {
    const account = cloudflare.addAccount();
    const files = [
      file("/index.html", "<!doctype html>"),
      file("/app.js", "console.log(1)"),
      file("/app.css", "body{}"),
    ];
    await uploadScript(
      api,
      account.id,
      "grasp-os-core",
      release("r000001-aaaaaaa", files)
    );
    const firstUploads = cloudflare.calls.filter(({ path }) =>
      path.endsWith("/workers/assets/upload")
    );
    await uploadVersion(
      api,
      account.id,
      "grasp-os-core",
      release("r000002-bbbbbbb", [...files, file("/new.js", "1")])
    );
    const allUploads = cloudflare.calls.filter(({ path }) =>
      path.endsWith("/workers/assets/upload")
    );

    // Three files in buckets of two, then only the new one.
    expect(firstUploads).toHaveLength(2);
    expect(allUploads).toHaveLength(3);
    expect(account.assets.size).toBe(4);
    for (const { headers } of allUploads) {
      expect(headers.get("authorization")).not.toBe(`Bearer ${token}`);
    }
    const versions = account.scripts.get("grasp-os-core")?.versions ?? [];
    expect(versions.map(({ metadata }) => assetsOf(metadata))).toStrictEqual(
      versions.map(() => ({
        config: { run_worker_first: true },
        completed: true,
      }))
    );
  });

  it("names each file by the key Wrangler uploads it under, dot-files included", async () => {
    const account = cloudflare.addAccount();
    await uploadScript(
      api,
      account.id,
      "grasp-os-core",
      release("r000001-aaaaaaa", [
        file("/index.html", "<html></html>"),
        file("/.hidden", "x"),
        file("/.well-known/security.txt", "x"),
        file("/a.tar.gz", "x"),
      ])
    );

    const session = cloudflare.calls.find(({ path }) =>
      path.endsWith("/assets-upload-session")
    );
    // Wrangler's key with SHA-256 in place of BLAKE3: base64 of the
    // contents, then the extension as Node's path.extname finds it (none
    // for a dot-file, the last for a.tar.gz). Worked out with Node.
    expect(session?.body).toStrictEqual({
      manifest: {
        "/index.html": { hash: "d4c01ae8630098078a961cef6cb9e3b3", size: 13 },
        "/.hidden": { hash: "5e21d86b709b6aa2d5fff6d7cfed56ab", size: 1 },
        "/.well-known/security.txt": {
          hash: "18bc01c2f3ff74fee5bf89429d922436",
          size: 1,
        },
        "/a.tar.gz": { hash: "c1a6faede032be6f91315fcad5b29e55", size: 1 },
      },
    });
    expect(account.assets.size).toBe(4);
  });

  it("names files the account already holds by the session's token", async () => {
    const account = cloudflare.addAccount();
    const files = [file("/index.html", "<!doctype html>")];
    await uploadScript(
      api,
      account.id,
      "grasp-os-core",
      release("r000001-aaaaaaa", files)
    );
    await uploadVersion(
      api,
      account.id,
      "grasp-os-core",
      release("r000002-bbbbbbb", files)
    );
    const uploads = cloudflare.calls.filter(({ path }) =>
      path.endsWith("/workers/assets/upload")
    );
    expect(uploads).toHaveLength(1);
    const [, second] = account.scripts.get("grasp-os-core")?.versions ?? [];
    expect(assetsOf(second?.metadata ?? {})).toMatchObject({
      completed: false,
    });
  });
});

describe("uploads that fail part way", () => {
  it("uploads asset buckets three at a time, retrying one after a server error", async () => {
    const account = cloudflare.addAccount();
    const files = Array.from({ length: 15 }, (_, index) =>
      file(`/file-${index}.js`, `export default ${index};`)
    );
    // The versions lookup, the session, then the first bucket's upload
    // fails once.
    cloudflare.failCall(3, 500);
    await uploadScript(
      api,
      account.id,
      "grasp-os-core",
      release("r000001-aaaaaaa", files)
    );
    const uploads = cloudflare.calls.filter(({ path }) =>
      path.endsWith("/workers/assets/upload")
    );
    // Eight buckets of two, one sent twice.
    expect(uploads).toHaveLength(9);
    expect(account.assets.size).toBe(15);
    expect(cloudflare.peakConcurrency()).toBe(3);
  });

  it("retries a script upload after a server error, unless it migrates Durable Objects", async () => {
    const account = cloudflare.addAccount();
    // The versions lookup (none yet), then the upload, which fails once.
    cloudflare.failCall(2, 500);
    await uploadScript(
      api,
      account.id,
      "grasp-os-core",
      release("r000001-aaaaaaa")
    );
    expect(cloudflare.calls.map(({ method }) => method)).toStrictEqual([
      "GET",
      "PUT",
      "PUT",
    ]);

    const migrating = release("r000002-bbbbbbb");
    // The versions and deployments lookups, then the upload.
    cloudflare.failCall(3, 500);
    await expect(
      uploadScript(api, account.id, "grasp-os-core", {
        ...migrating,
        metadata: {
          ...migrating.metadata,
          migrations: { new_tag: "v2", new_sqlite_classes: ["Uploads"] },
        },
      })
    ).rejects.toMatchObject({ status: 500 });
    expect(cloudflare.calls).toHaveLength(6);
  });
});

describe("secrets, schedules and workflows", () => {
  it("sets, lists and removes secrets, never reading a value back", async () => {
    const account = cloudflare.addAccount();
    await uploadScript(
      api,
      account.id,
      "grasp-os-core",
      release("r000001-aaaaaaa")
    );
    await putSecret(api, account.id, "grasp-os-core", {
      name: "ROUTER_SECRET",
      value: "router-secret-value",
    });
    await putSecret(api, account.id, "grasp-os-core", {
      name: "BETTER_AUTH_SECRET",
      value: "auth-secret-value",
    });
    await deleteSecret(api, account.id, "grasp-os-core", "BETTER_AUTH_SECRET");

    await expect(
      listSecretNames(api, account.id, "grasp-os-core")
    ).resolves.toStrictEqual(["ROUTER_SECRET"]);
    expect(latestSecrets(account, "grasp-os-core")).toStrictEqual(
      new Map([["ROUTER_SECRET", "router-secret-value"]])
    );
    // Removing one that's already gone succeeds, so a retried step does.
    await expect(
      deleteSecret(api, account.id, "grasp-os-core", "BETTER_AUTH_SECRET")
    ).resolves.toBeUndefined();
  });

  it("carries secrets to every new version, and gives a rollout's version exactly its own", async () => {
    const account = cloudflare.addAccount();
    await uploadScript(
      api,
      account.id,
      "grasp-os-core",
      release("r000001-aaaaaaa")
    );
    await putSecret(api, account.id, "grasp-os-core", {
      name: "ROUTER_SECRET",
      value: "first",
    });
    const kept = await uploadVersion(
      api,
      account.id,
      "grasp-os-core",
      release("r000002-bbbbbbb")
    );
    const rotated = await uploadVersionWithSecrets(
      api,
      account.id,
      "grasp-os-core",
      release("r000003-ccccccc"),
      [
        { name: "ROUTER_SECRET", value: "second" },
        { name: "ROUTER_SECRET_PREVIOUS", value: "first" },
      ]
    );

    const secretsOf = (id: string) =>
      account.scripts
        .get("grasp-os-core")
        ?.versions.find((version) => version.id === id)?.secrets;
    expect(secretsOf(kept.id)).toStrictEqual(
      new Map([["ROUTER_SECRET", "first"]])
    );
    expect(secretsOf(rotated.id)).toStrictEqual(
      new Map([
        ["ROUTER_SECRET", "second"],
        ["ROUTER_SECRET_PREVIOUS", "first"],
      ])
    );
  });

  it("can't set a secret while an uploaded version waits for its deployment", async () => {
    const account = cloudflare.addAccount();
    await uploadScript(
      api,
      account.id,
      "grasp-os-core",
      release("r000001-aaaaaaa")
    );
    const waiting = await uploadVersion(
      api,
      account.id,
      "grasp-os-core",
      release("r000002-bbbbbbb")
    );
    const secret = { name: "ROUTER_SECRET", value: "router-secret-value" };

    await expect(
      putSecret(api, account.id, "grasp-os-core", secret)
    ).rejects.toMatchObject({ status: 400, codes: [10_215] });

    await deployVersion(api, account.id, "grasp-os-core", waiting.id, {
      message: "Rollout",
    });
    await putSecret(api, account.id, "grasp-os-core", secret);
    expect(latestSecrets(account, "grasp-os-core").get("ROUTER_SECRET")).toBe(
      "router-secret-value"
    );
  });

  it("rolls back past a secret change only when forced", async () => {
    const account = cloudflare.addAccount();
    await uploadScript(
      api,
      account.id,
      "grasp-os-core",
      release("r000001-aaaaaaa")
    );
    const [first] = account.scripts.get("grasp-os-core")?.versions ?? [];
    const second = await uploadVersionWithSecrets(
      api,
      account.id,
      "grasp-os-core",
      release("r000002-bbbbbbb"),
      [{ name: "ROUTER_SECRET", value: "new" }]
    );
    await deployVersion(api, account.id, "grasp-os-core", second.id, {
      message: "Rollout",
    });

    const refused = await errorOf(
      deployVersion(api, account.id, "grasp-os-core", first?.id ?? "", {
        message: "Rollback",
      })
    );
    expect(isSecretsConflict(refused)).toBeTruthy();
    expect(isSecretsConflict(new Error("other"))).toBeFalsy();

    await deployVersion(api, account.id, "grasp-os-core", first?.id ?? "", {
      message: "Rollback",
      force: true,
    });
    const [current] = await deployedVersions(account.id, "grasp-os-core");
    expect(current).toStrictEqual([{ version_id: first?.id, percentage: 100 }]);

    // After a rollback the latest version isn't the deployed one, so a
    // secret can't be set on its own.
    await expect(
      putSecret(api, account.id, "grasp-os-core", {
        name: "ROUTER_SECRET",
        value: "newer",
      })
    ).rejects.toMatchObject({ status: 400, codes: [10_215] });
  });

  it("never brings back a rolled-back secret in the next version", async () => {
    const account = cloudflare.addAccount();
    await uploadScript(
      api,
      account.id,
      "grasp-os-core",
      release("r000001-aaaaaaa")
    );
    await putSecret(api, account.id, "grasp-os-core", {
      name: "ROUTER_SECRET",
      value: "v1",
    });
    const [, first] = account.scripts.get("grasp-os-core")?.versions ?? [];
    // v2 adds a credential; the rollback to v1 takes it out of service.
    const second = await uploadVersionWithSecrets(
      api,
      account.id,
      "grasp-os-core",
      release("r000002-bbbbbbb"),
      [
        { name: "ROUTER_SECRET", value: "v2" },
        { name: "LEAKED_KEY", value: "revoked" },
      ]
    );
    await deployVersion(api, account.id, "grasp-os-core", second.id, {
      message: "Rollout",
    });
    await deployVersion(api, account.id, "grasp-os-core", first?.id ?? "", {
      message: "Rollback",
      force: true,
    });

    // Keeping secrets now would keep v2's, the latest: refused.
    await expect(
      latestIsDeployed(api, account.id, "grasp-os-core")
    ).resolves.toBeFalsy();
    await expect(
      uploadVersion(
        api,
        account.id,
        "grasp-os-core",
        release("r000003-ccccccc")
      )
    ).rejects.toBeInstanceOf(RolledBackError);
    await expect(
      uploadScript(api, account.id, "grasp-os-core", release("r000003-ccccccc"))
    ).rejects.toBeInstanceOf(RolledBackError);

    // With every secret given, the new version has exactly those.
    const third = await uploadVersionWithSecrets(
      api,
      account.id,
      "grasp-os-core",
      release("r000003-ccccccc"),
      [{ name: "ROUTER_SECRET", value: "v1" }]
    );
    const uploaded = account.scripts
      .get("grasp-os-core")
      ?.versions.find(({ id }) => id === third.id);
    expect(uploaded?.secrets).toStrictEqual(new Map([["ROUTER_SECRET", "v1"]]));
  });

  it("deploys a Durable Object migration after a rollback with exactly the secrets given", async () => {
    const account = cloudflare.addAccount();
    await uploadScript(
      api,
      account.id,
      "grasp-os-core",
      release("r000001-aaaaaaa")
    );
    const [first] = account.scripts.get("grasp-os-core")?.versions ?? [];
    const second = await uploadVersionWithSecrets(
      api,
      account.id,
      "grasp-os-core",
      release("r000002-bbbbbbb"),
      [{ name: "LEAKED_KEY", value: "revoked" }]
    );
    await deployVersion(api, account.id, "grasp-os-core", second.id, {
      message: "Rollout",
    });
    await deployVersion(api, account.id, "grasp-os-core", first?.id ?? "", {
      message: "Rollback",
      force: true,
    });

    // A release with a migration can only go as a script upload.
    const migrating = release("r000003-ccccccc");
    await uploadScript(
      api,
      account.id,
      "grasp-os-core",
      {
        ...migrating,
        metadata: {
          ...migrating.metadata,
          migrations: { new_tag: "v2", new_sqlite_classes: ["Uploads"] },
        },
      },
      [{ name: "ROUTER_SECRET", value: "current" }]
    );

    const [current] = await deployedVersions(account.id, "grasp-os-core");
    const live = account.scripts
      .get("grasp-os-core")
      ?.versions.find(({ id }) => id === current?.[0]?.version_id);
    expect(live?.metadata.migrations).toStrictEqual({
      new_tag: "v2",
      new_sqlite_classes: ["Uploads"],
    });
    expect(live?.secrets).toStrictEqual(
      new Map([["ROUTER_SECRET", "current"]])
    );
  });

  it("keeps a secret's value out of the error when it's refused", async () => {
    const account = cloudflare.addAccount();
    const refused = putSecret(api, account.id, "grasp-os-missing", {
      name: "ROUTER_SECRET",
      value: "router-secret-value",
    });
    await expect(refused).rejects.toThrow(
      `Cloudflare API PUT /accounts/${account.id}/workers/scripts/grasp-os-missing/secrets failed (404)`
    );
    await expect(refused).rejects.not.toThrow("router-secret-value");
  });

  it("serves a Worker on workers.dev without preview URLs", async () => {
    const account = cloudflare.addAccount();
    await uploadScript(
      api,
      account.id,
      "grasp-os-core",
      release("r000001-aaaaaaa")
    );
    await setScriptSubdomain(api, account.id, "grasp-os-core", {
      enabled: true,
      previewsEnabled: false,
    });
    expect(account.scripts.get("grasp-os-core")?.subdomain).toStrictEqual({
      enabled: true,
      previews_enabled: false,
    });
  });

  it("sets cron schedules and the workflow a Worker runs", async () => {
    const account = cloudflare.addAccount();
    await uploadScript(
      api,
      account.id,
      "grasp-os-core",
      release("r000001-aaaaaaa")
    );
    await putSchedules(api, account.id, "grasp-os-core", [
      "* * * * *",
      "*/15 * * * *",
    ]);
    await putWorkflow(api, account.id, "grasp-os-workflows", {
      className: "WorkflowDispatcher",
      scriptName: "grasp-os-core",
    });
    expect(account.scripts.get("grasp-os-core")?.schedules).toStrictEqual([
      "* * * * *",
      "*/15 * * * *",
    ]);
    expect(account.workflows.get("grasp-os-workflows")).toStrictEqual({
      class_name: "WorkflowDispatcher",
      script_name: "grasp-os-core",
    });
  });
});

describe("D1 migrations", () => {
  const table = `t_${crypto.randomUUID().replaceAll("-", "")}`;
  const migrations = [
    {
      name: `${table}_0000.sql`,
      sql: `CREATE TABLE ${table} (id TEXT PRIMARY KEY);`,
    },
    {
      name: `${table}_0001.sql`,
      sql: `-- A comment; with a semicolon.\nALTER TABLE ${table} ADD "note" TEXT;\n--> statement-breakpoint\n/* A block; comment. */\nINSERT INTO ${table} (id, "note") VALUES ('a', 'it''s; here');`,
    },
  ];

  it("applies each migration once, in order, as Wrangler records them", async () => {
    const account = cloudflare.addAccount();
    const { uuid } = await ensureD1Database(api, account.id, "grasp-os-core");

    await expect(
      applyD1Migrations(api, account.id, uuid, migrations.slice(0, 1))
    ).resolves.toStrictEqual([migrations[0]?.name]);
    await expect(
      applyD1Migrations(api, account.id, uuid, migrations)
    ).resolves.toStrictEqual([migrations[1]?.name]);
    await expect(
      applyD1Migrations(api, account.id, uuid, migrations)
    ).resolves.toStrictEqual([]);

    const [rows, recorded] = await queryD1(
      api,
      account.id,
      uuid,
      `SELECT id, note FROM ${table}; SELECT name FROM d1_migrations WHERE name LIKE '${table}%' ORDER BY id;`
    );
    expect(rows).toStrictEqual([{ id: "a", note: "it's; here" }]);
    expect(recorded).toStrictEqual(migrations.map(({ name }) => ({ name })));
  });

  it("applies core's real migrations: FTS5 tables, triggers and comments", async () => {
    const account = cloudflare.addAccount();
    const { uuid } = await ensureD1Database(
      api,
      account.id,
      "grasp-os-knowledge"
    );
    const files = z
      .array(z.object({ name: z.string(), sql: z.string() }))
      .parse(Reflect.get(env, "KNOWLEDGE_MIGRATION_FILES"));
    expect(files.length).toBeGreaterThan(0);

    await expect(
      applyD1Migrations(api, account.id, uuid, files)
    ).resolves.toStrictEqual(files.map(({ name }) => name));

    const [triggers] = await queryD1(
      api,
      account.id,
      uuid,
      "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'sections_search_%' ORDER BY name;"
    );
    expect(triggers?.length).toBeGreaterThan(0);
  });

  it("keeps each database's tables to itself", async () => {
    const account = cloudflare.addAccount();
    const core = await ensureD1Database(api, account.id, "grasp-os-core");
    const knowledge = await ensureD1Database(
      api,
      account.id,
      "grasp-os-knowledge"
    );
    await applyD1Migrations(api, account.id, core.uuid, [
      { name: "0000_only_core.sql", sql: "CREATE TABLE only_core (id TEXT);" },
    ]);
    const tablesOf = async (uuid: string) => {
      const [rows] = await queryD1(
        api,
        account.id,
        uuid,
        "SELECT name FROM sqlite_master WHERE name IN ('only_core', 'd1_migrations') ORDER BY name;"
      );
      return rows;
    };
    await expect(tablesOf(core.uuid)).resolves.toStrictEqual([
      { name: "d1_migrations" },
      { name: "only_core" },
    ]);
    await expect(tablesOf(knowledge.uuid)).resolves.toStrictEqual([]);
  });

  it("keeps each account's databases apart too", async () => {
    const acme = cloudflare.addAccount("Acme");
    const globex = cloudflare.addAccount("Globex");
    const first = await ensureD1Database(api, acme.id, "grasp-os-core");
    const second = await ensureD1Database(api, globex.id, "grasp-os-core");
    await applyD1Migrations(api, acme.id, first.uuid, [
      { name: "0000_acme.sql", sql: "CREATE TABLE acme_only (id TEXT);" },
    ]);
    await applyD1Migrations(api, globex.id, second.uuid, [
      { name: "0000_globex.sql", sql: "CREATE TABLE globex_only (id TEXT);" },
    ]);
    const tables = async (accountId: string, uuid: string) => {
      const [rows] = await queryD1(
        api,
        accountId,
        uuid,
        "SELECT name FROM sqlite_master WHERE name LIKE '%_only' ORDER BY name;"
      );
      return rows;
    };
    await expect(tables(acme.id, first.uuid)).resolves.toStrictEqual([
      { name: "acme_only" },
    ]);
    await expect(tables(globex.id, second.uuid)).resolves.toStrictEqual([
      { name: "globex_only" },
    ]);
  });

  it("fails a query when a statement in it failed, though the answer succeeded", async () => {
    const account = cloudflare.addAccount();
    const { uuid } = await ensureD1Database(api, account.id, "grasp-os-core");
    cloudflare.failCall(1, "statement-failed");
    await expect(
      queryD1(api, account.id, uuid, "SELECT 1; SELECT 2;")
    ).rejects.toThrow(`D1 query on ${uuid} failed at statement 2 of 2`);
  });

  it("stops at a migration that fails, recording none after it", async () => {
    const account = cloudflare.addAccount();
    const { uuid } = await ensureD1Database(api, account.id, "grasp-os-core");
    const broken = `t_${crypto.randomUUID().replaceAll("-", "")}`;

    await expect(
      applyD1Migrations(api, account.id, uuid, [
        { name: `${broken}_0000.sql`, sql: "CREATE TABLE oops (" },
        {
          name: `${broken}_0001.sql`,
          sql: `CREATE TABLE ${broken} (id TEXT);`,
        },
      ])
    ).rejects.toMatchObject({ status: 400, codes: [7500] });

    const [recorded] = await queryD1(
      api,
      account.id,
      uuid,
      `SELECT name FROM d1_migrations WHERE name LIKE '${broken}%';`
    );
    expect(recorded).toStrictEqual([]);
  });
});
