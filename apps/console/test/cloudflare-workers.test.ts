import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { ensureD1Database } from "../src/cloudflare/accounts.ts";
import { cloudflareApi } from "../src/cloudflare/api.ts";
import {
  applyD1Migrations,
  deleteSecret,
  deployVersion,
  listDeployments,
  listSecretNames,
  putSchedules,
  putSecret,
  putWorkflow,
  queryD1,
  uploadScript,
  uploadVersion,
} from "../src/cloudflare/workers.ts";
import type { AssetFile, WorkerUpload } from "../src/cloudflare/workers.ts";
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

    await deployVersion(api, account.id, "grasp-os-core", second.id, "Rollout");
    await deployVersion(
      api,
      account.id,
      "grasp-os-core",
      first?.id ?? "",
      "Rollback"
    );

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
    expect(
      account.scripts.get("grasp-os-core")?.secrets.get("ROUTER_SECRET")
    ).toBe("router-secret-value");
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
      sql: `ALTER TABLE ${table} ADD note TEXT;\n--> statement-breakpoint\nINSERT INTO ${table} (id, note) VALUES ('a', 'it''s; here');`,
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
