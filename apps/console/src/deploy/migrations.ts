/**
 * A release's D1 migrations, applied to a client's databases before its
 * Workers are deployed: expand only (AGENTS.md), so the running version
 * keeps working against the new schema. Each database skips what it has
 * already applied, so running this again after a failure applies only
 * what's left.
 */
import type { ReleaseManifest } from "@grasp-os/shared/release";

import type { CloudflareApi } from "../cloudflare/api.ts";
import { applyD1Migrations } from "../cloudflare/workers.ts";
import type { ReleaseStore } from "../releases/import.ts";
import { readBlob } from "./release.ts";

const decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * Applies each database's pending migrations from the release, one
 * database at a time, reading each migration from `store` and checking it
 * against the manifest first. Returns how many each database applied, by
 * name. `databases` gives each database's id by name.
 */
export const migrateDatabases = async (
  api: CloudflareApi,
  accountId: string,
  databases: ReadonlyMap<string, string>,
  manifest: ReleaseManifest,
  store: ReleaseStore
): Promise<Map<string, number>> => {
  const applied = new Map<string, number>();
  for (const worker of Object.values(manifest.workers)) {
    for (const database of worker.d1Databases) {
      const id = databases.get(database.databaseName);
      if (id === undefined) {
        throw new Error(`No database ${database.databaseName} to migrate`);
      }
      // oxlint-disable-next-line no-await-in-loop -- one database at a time
      const migrations = await Promise.all(
        database.migrations.map(async (file) => ({
          name: file.name,
          sql: decoder.decode(await readBlob(store, file)),
        }))
      );
      // oxlint-disable-next-line no-await-in-loop -- one database at a time
      const names = await applyD1Migrations(api, accountId, id, migrations);
      applied.set(
        database.databaseName,
        (applied.get(database.databaseName) ?? 0) + names.length
      );
    }
  }
  return applied;
};
