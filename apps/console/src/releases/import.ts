/**
 * Imports the releases CI publishes to R2 (scripts/release/upload-release.ts)
 * into the console's database, on the console's cron.
 *
 * CI writes a release's blobs first and its manifest,
 * `releases/<id>/manifest.json`, last, so a release is listed only once its
 * manifest exists. Each new one has every blob checked against its manifest
 * (`verifyReleaseBlobs`, the check CI ran before publishing) and is then
 * recorded with its audit event. A release that doesn't verify is not
 * imported, and is checked again on the next run.
 *
 * Idempotent: an imported release is skipped, and one imported by a run
 * that overlapped this one is recorded, and audited, once.
 */
import { errorFields, log } from "@grasp-os/shared/log";
import {
  manifestKey,
  releaseIdSchema,
  releaseManifestSchema,
  sha256OfBytes,
  verifyReleaseBlobs,
} from "@grasp-os/shared/release";

import { actIfChanged } from "../db/act.ts";
import type { ConsoleDatabase } from "../db/act.ts";
import { releases } from "../db/schema.ts";

/**
 * The releases bucket, as the console may use it: reading only. CI is the
 * only writer; a release never changes once published.
 */
export type ReleaseStore = Pick<R2Bucket, "get" | "list">;

const RELEASES_PREFIX = "releases/";

/**
 * Most releases one run imports. Every merge is a release, so a run
 * normally finds one or none; this bounds the first run, or one after an
 * outage, and the rest follow on the next runs.
 */
export const MAX_IMPORTS_PER_RUN = 10;

/** What one run did, by release id. */
export interface ImportResult {
  imported: string[];
  /** Published, but didn't verify: checked again next run. */
  failed: string[];
}

/** The id of every release with a manifest in `store`. */
const publishedIds = async (store: ReleaseStore): Promise<string[]> => {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    // oxlint-disable-next-line no-await-in-loop -- each page names the next
    const page = await store.list({
      prefix: RELEASES_PREFIX,
      delimiter: "/",
      ...(cursor === undefined ? {} : { cursor }),
    });
    for (const prefix of page.delimitedPrefixes) {
      const id = prefix.slice(RELEASES_PREFIX.length, -1);
      if (releaseIdSchema.safeParse(id).success) {
        ids.push(id);
      }
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  return ids;
};

const ciRun = /^r(?<run>\d+)-/u;

/** A CI release's run number; -1 for a local build (`dev-`). */
const runOf = (id: string): number => Number(ciRun.exec(id)?.groups?.run ?? -1);

/** CI releases by run number, newest first, then local builds. */
const newestFirst = (a: string, b: string): number =>
  runOf(b) - runOf(a) || b.localeCompare(a);

const bytesAt = async (
  store: ReleaseStore,
  key: string
): Promise<Uint8Array | undefined> => {
  const object = await store.get(key);
  return object === null
    ? undefined
    : new Uint8Array(await object.arrayBuffer());
};

/**
 * Verifies release `id` and records it. Returns false when it has no
 * manifest (yet); throws when it doesn't verify.
 */
const importRelease = async (
  store: ReleaseStore,
  db: ConsoleDatabase,
  id: string
): Promise<boolean> => {
  const manifestBytes = await bytesAt(store, manifestKey(id));
  if (manifestBytes === undefined) {
    return false;
  }
  const manifestText = new TextDecoder().decode(manifestBytes);
  const manifest = releaseManifestSchema.parse(JSON.parse(manifestText));
  if (manifest.releaseId !== id) {
    throw new Error(
      `The manifest at ${manifestKey(id)} names release ${manifest.releaseId}`
    );
  }
  await verifyReleaseBlobs(manifest, async (key) => await bytesAt(store, key));
  const manifestSha256 = await sha256OfBytes(manifestBytes);
  await actIfChanged(
    db,
    "system",
    db
      .insert(releases)
      .values({
        id,
        commitSha: manifest.commit,
        manifest: manifestText,
        manifestSha256,
        builtAt: new Date(manifest.createdAt),
        importedAt: new Date(),
      })
      .onConflictDoNothing(),
    {
      action: "release.import",
      target: id,
      detail: { commit: manifest.commit, manifestSha256 },
    }
  );
  return true;
};

/**
 * Imports every release published to `store` that `db` doesn't hold yet,
 * newest first, at most {@link MAX_IMPORTS_PER_RUN}.
 */
export const importReleases = async (
  store: ReleaseStore,
  db: ConsoleDatabase
): Promise<ImportResult> => {
  const imported = await db.select({ id: releases.id }).from(releases);
  const known = new Set(imported.map((row) => row.id));
  const published = await publishedIds(store);
  const pending = published
    .filter((id) => !known.has(id))
    .toSorted(newestFirst)
    .slice(0, MAX_IMPORTS_PER_RUN);

  const result: ImportResult = { imported: [], failed: [] };
  // One at a time, to bound the blobs read at once.
  for (const id of pending) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- one release at a time
      if (await importRelease(store, db, id)) {
        result.imported.push(id);
      }
    } catch (error) {
      result.failed.push(id);
      log.error("release.import_failed", {
        releaseId: id,
        ...errorFields(error),
      });
    }
  }
  return result;
};
