/**
 * The release manifest, generated from the real wrangler.jsonc of core and
 * connect with fixture bundles, assets and migrations in place of a build.
 * Changing either config fails the golden test until the golden file is
 * regenerated (`vp test -u scripts/release`): a deliberate decision about
 * how the change reaches client accounts.
 */
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { parseJsonc } from "../wrangler-config-rules.ts";
import {
  collectAssets,
  collectModules,
  collectSqlFiles,
  stableStringify,
} from "./hash-lib.ts";
import {
  assetKey,
  generateManifest,
  moduleKey,
  parseWranglerConfig,
  verifyRelease,
  writeRelease,
} from "./manifest-lib.ts";
import type { ReleaseInfo, WorkerBuild } from "./manifest-lib.ts";

const ROOT = path.join(import.meta.dirname, "../..");
const TESTDATA = path.join(import.meta.dirname, "testdata");

const rawConfig = (app: string): Record<string, unknown> =>
  z
    .record(z.string(), z.unknown())
    .parse(
      parseJsonc(
        readFileSync(path.join(ROOT, "apps", app, "wrangler.jsonc"), "utf-8")
      )
    );

const fixtureBuild = (app: string): WorkerBuild => {
  const config = parseWranglerConfig(app, rawConfig(app));
  return {
    key: app,
    config,
    ...collectModules(path.join(TESTDATA, "bundles", app)),
    d1Migrations: Object.fromEntries(
      config.d1_databases.map((database) => [
        database.binding,
        collectSqlFiles(path.join(TESTDATA, "migrations")),
      ])
    ),
    ...(config.assets
      ? { assets: collectAssets(path.join(TESTDATA, "assets")) }
      : {}),
  };
};

const info: ReleaseInfo = {
  releaseId: "r000001-0000000",
  commit: "0".repeat(40),
  createdAt: "2026-01-01T00:00:00.000Z",
  notes: "feat(core): a fixture",
  wranglerVersion: "0.0.0-fixture",
  packages: { zod: "0.0.0-fixture" },
};

const builds = (): WorkerBuild[] => ["connect", "core"].map(fixtureBuild);

/** Every string anywhere in `value`. */
const stringsIn = (value: unknown): string[] => {
  if (typeof value === "string") {
    return [value];
  }
  if (typeof value === "object" && value !== null) {
    return Object.values(value).flatMap(stringsIn);
  }
  return [];
};

describe("the release manifest", () => {
  it("matches the golden manifest for the real wrangler configs", async () => {
    await expect(
      stableStringify(generateManifest(info, builds()))
    ).toMatchFileSnapshot("testdata/golden-manifest.json");
  });

  it("leaves only placeholders the console knows", () => {
    const { workers } = generateManifest(info, builds());
    const tokens = Object.values(workers)
      .flatMap((worker) => stringsIn(worker.bindings))
      .filter((value) => value.includes("$"));
    expect(tokens).toStrictEqual([
      "$D1_DB_ID",
      "$D1_DB_ID",
      "$D1_KNOWLEDGE_ID",
    ]);
  });

  it("fails the build on a wrangler.jsonc key it doesn't handle", () => {
    const core = rawConfig("core");
    expect(() =>
      parseWranglerConfig("core", { ...core, vars: { A: "b" } })
    ).toThrow(/vars/u);
    expect(() =>
      parseWranglerConfig("core", {
        ...core,
        durable_objects: {
          bindings: [{ name: "X", class_name: "X", script_name: "elsewhere" }],
        },
      })
    ).toThrow(/script_name/u);
    expect(() =>
      parseWranglerConfig("core", {
        ...core,
        observability: { enabled: true, destinations: ["an-account-sink"] },
      })
    ).toThrow(/destinations/u);
  });

  it("refuses an R2 bucket outside the EU", () => {
    expect(() =>
      parseWranglerConfig("core", {
        ...rawConfig("core"),
        r2_buckets: [{ binding: "FILES", bucket_name: "grasp-os-files" }],
      })
    ).toThrow(/jurisdiction/u);
  });

  it("refuses a service binding to a Worker outside the release", () => {
    expect(() => generateManifest(info, [fixtureBuild("core")])).toThrow(
      /grasp-os-connect/u
    );
  });

  it("refuses Workers on different compatibility dates", () => {
    const [connect, core] = builds();
    if (connect === undefined || core === undefined) {
      throw new Error("expected two builds");
    }
    const older = {
      ...connect,
      config: { ...connect.config, compatibility_date: "2026-01-01" },
    };
    expect(() => generateManifest(info, [older, core])).toThrow(
      /compatibility date/u
    );
  });

  it("refuses a release id that isn't a plain R2 prefix", () => {
    expect(() =>
      generateManifest({ ...info, releaseId: "../r000001-0000000" }, builds())
    ).toThrow(/releaseId/u);
  });

  it("refuses a build without its D1 migrations or static assets", () => {
    const [connect, core] = builds();
    if (connect === undefined || core === undefined) {
      throw new Error("expected two builds");
    }
    expect(() =>
      generateManifest(info, [connect, { ...core, d1Migrations: {} }])
    ).toThrow(/no migrations collected for DB/u);
    const { assets: _assets, ...coreWithoutAssets } = core;
    expect(() => generateManifest(info, [connect, coreWithoutAssets])).toThrow(
      /assets/u
    );
  });
});

describe("a written release", () => {
  let out = "";
  const manifest = generateManifest(info, builds());
  const [coreModule] = manifest.workers.core?.modules ?? [];
  const [assetHash] = Object.keys(manifest.assets);
  if (coreModule === undefined || assetHash === undefined) {
    throw new Error("expected a core module and an asset");
  }

  beforeEach(() => {
    out = mkdtempSync(path.join(tmpdir(), "grasp-os-release-test-"));
    writeRelease(out, manifest, builds());
  });

  afterEach(() => {
    rmSync(out, { force: true, recursive: true });
  });

  it("verifies against its manifest", () => {
    expect(verifyRelease(out)).toStrictEqual(manifest);
  });

  it("fails verification when a module changed", () => {
    writeFileSync(path.join(out, moduleKey(coreModule.sha256)), "tampered");
    expect(() => verifyRelease(out)).toThrow(/doesn't match its hash/u);
  });

  it("fails verification when an asset changed or is missing", () => {
    const asset = path.join(out, assetKey(assetHash));
    writeFileSync(asset, "tampered");
    expect(() => verifyRelease(out)).toThrow(/doesn't match its hash/u);
    unlinkSync(asset);
    expect(() => verifyRelease(out)).toThrow(/missing/u);
  });

  it("fails verification when the manifest points a blob elsewhere", () => {
    const moved = readFileSync(
      path.join(out, "manifest.json"),
      "utf-8"
    ).replace(
      `"r2Key": "${moduleKey(coreModule.sha256)}"`,
      `"r2Key": "${assetKey(assetHash)}"`
    );
    writeFileSync(path.join(out, "manifest.json"), moved);
    expect(() => verifyRelease(out)).toThrow(/content address/u);
  });
});
