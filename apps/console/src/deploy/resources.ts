/**
 * The resources a release needs in a client's account, named as its
 * manifest names them (the same in every account) and all in the EU.
 * Each `ensure*` finds a resource before it creates one, so running this
 * again, after a failure part way, creates nothing twice.
 */
import type { ReleaseManifest } from "@grasp-os/shared/release";

import { ensureD1Database, ensureR2Bucket } from "../cloudflare/accounts.ts";
import type { CloudflareApi } from "../cloudflare/api.ts";

/** What a release's Workers bind to in one account. */
export interface AccountResources {
  /** Each D1 database's id, by its name. */
  databases: Map<string, string>;
  /** The R2 buckets, by name. */
  buckets: string[];
}

/** Every D1 database the release's Workers bind, by name, once each. */
const databaseNames = (manifest: ReleaseManifest): string[] => [
  ...new Set(
    Object.values(manifest.workers).flatMap((worker) =>
      worker.d1Databases.map((database) => database.databaseName)
    )
  ),
];

/**
 * Every R2 bucket the release's Workers bind, by name, once each. The
 * manifest only lets EU buckets through, and this checks it again: a
 * bucket's jurisdiction is set when it's created.
 */
const bucketNames = (manifest: ReleaseManifest): string[] => {
  const names = new Set<string>();
  for (const worker of Object.values(manifest.workers)) {
    for (const binding of worker.bindings) {
      if (binding.type !== "r2_bucket") {
        continue;
      }
      const { bucket_name: name, jurisdiction } = binding;
      if (typeof name !== "string" || jurisdiction !== "eu") {
        throw new Error(
          `${worker.name} binds ${binding.name} to a bucket outside the EU`
        );
      }
      names.add(name);
    }
  }
  return [...names];
};

/**
 * Ensures every D1 database and R2 bucket the release binds exists in the
 * account, in the EU, one at a time. Throws `OutsideEuError` for one that
 * exists elsewhere.
 */
export const ensureResources = async (
  api: CloudflareApi,
  accountId: string,
  manifest: ReleaseManifest
): Promise<AccountResources> => {
  const databases = new Map<string, string>();
  for (const name of databaseNames(manifest)) {
    // oxlint-disable-next-line no-await-in-loop -- one at a time, in order
    const database = await ensureD1Database(api, accountId, name);
    databases.set(name, database.uuid);
  }
  const buckets = bucketNames(manifest);
  for (const name of buckets) {
    // oxlint-disable-next-line no-await-in-loop -- one at a time, in order
    await ensureR2Bucket(api, accountId, name);
  }
  return { databases, buckets };
};
