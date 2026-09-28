/**
 * A release built from the real wrangler.jsonc of core and connect, with
 * fixture bundles, assets and migrations in place of a build. Shared by the
 * release tests.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

import { parseJsonc } from "../wrangler-config-rules.ts";
import { collectAssets, collectModules, collectSqlFiles } from "./hash-lib.ts";
import { parseWranglerConfig } from "./manifest-lib.ts";
import type { ReleaseInfo, WorkerBuild } from "./manifest-lib.ts";

const ROOT = path.join(import.meta.dirname, "../..");
const TESTDATA = path.join(import.meta.dirname, "testdata");

export const rawConfig = (app: string): Record<string, unknown> =>
  z
    .record(z.string(), z.unknown())
    .parse(
      parseJsonc(
        readFileSync(path.join(ROOT, "apps", app, "wrangler.jsonc"), "utf-8")
      )
    );

export const fixtureBuild = async (app: string): Promise<WorkerBuild> => {
  const config = parseWranglerConfig(app, rawConfig(app));
  const migrations = await collectSqlFiles(path.join(TESTDATA, "migrations"));
  return {
    key: app,
    config,
    ...(await collectModules(path.join(TESTDATA, "bundles", app))),
    d1Migrations: Object.fromEntries(
      config.d1_databases.map((database) => [database.binding, migrations])
    ),
    ...(config.assets
      ? { assets: await collectAssets(path.join(TESTDATA, "assets")) }
      : {}),
  };
};

export const info: ReleaseInfo = {
  releaseId: "r000001-0000000",
  commit: "0".repeat(40),
  createdAt: "2026-01-01T00:00:00.000Z",
  notes: "feat(core): a fixture",
  wranglerVersion: "0.0.0-fixture",
  packages: { zod: "0.0.0-fixture" },
};

export const builds = async (): Promise<WorkerBuild[]> =>
  await Promise.all(["connect", "core"].map(fixtureBuild));
