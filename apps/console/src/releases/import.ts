/**
 * Imports the releases CI publishes to R2 (scripts/release/upload-release.ts)
 * into the console's database, on the console's cron.
 *
 * CI writes a release's blobs first and its manifest,
 * `releases/<id>/manifest.json`, last, so a release is listed only once its
 * manifest exists. Each new one has every blob checked against its manifest
 * (`verifyReleaseBlobs`, the check CI ran before publishing) and is then
 * recorded with its audit event. This protects against partial or
 * corrupted uploads, not against whoever can write to the bucket: a
 * release that's consistent with its own manifest imports.
 *
 * A release that doesn't verify is recorded as failed, audited, and tried
 * again after a wait that doubles with each attempt, so a broken release
 * costs a few reads a day and never holds up the releases after or before
 * it.
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
import type { Bytes, ReleaseManifest } from "@grasp-os/shared/release";
import { eq } from "drizzle-orm";

import { act, actIfChanged } from "../db/act.ts";
import type { ConsoleDatabase } from "../db/act.ts";
import { releaseImportFailures, releases } from "../db/schema.ts";

/**
 * The releases bucket, as the import uses it: reading only, so the import
 * can't write to it. CI is the only writer; a release never changes once
 * published.
 */
export type ReleaseStore = Pick<R2Bucket, "get" | "list">;

const RELEASES_PREFIX = "releases/";

/**
 * Most releases one run imports. Every merge is a release, so a run
 * normally finds one or none; this bounds the first run, or one after an
 * outage, and the rest follow on the next runs.
 */
export const MAX_IMPORTS_PER_RUN = 5;

/**
 * Most R2 reads a run starts a release with: each release is one read per
 * blob (about 70 today), and a run's reads count towards the Worker's
 * subrequest limit. A release that starts under it may finish over it.
 */
export const MAX_READS_PER_RUN = 500;

/**
 * Blobs read at once. A release's largest module is about 10 MB today:
 * two at a time, with their hashing, stays well inside the Worker's memory.
 */
const READ_CONCURRENCY = 2;

/** Largest manifest the import reads; today's is about 35 KB. */
export const MAX_MANIFEST_BYTES = 1_000_000;

/** The wait after a release's first failed attempt: the next run. */
const FIRST_RETRY_MS = 5 * 60 * 1000;
/** The longest wait between attempts. */
const MAX_RETRY_MS = 24 * 60 * 60 * 1000;

/** What one run did, by release id. */
export interface ImportResult {
  imported: string[];
  /** Published, but didn't verify: tried again after a wait. */
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

const ciRelease = /^r(?<run>\d+)-(?<sha>[0-9a-f]{7})$/u;

/** A CI release's run number; -1 for a local build (`dev-`). */
const runOf = (id: string): number =>
  Number(ciRelease.exec(id)?.groups?.run ?? -1);

/** CI releases by run number, newest first, then local builds. */
const newestFirst = (a: string, b: string): number =>
  runOf(b) - runOf(a) || b.localeCompare(a);

/** Reads from `store`, counting the reads. */
class Reader {
  reads = 0;
  readonly #store: ReleaseStore;

  constructor(store: ReleaseStore) {
    this.#store = store;
  }

  /**
   * The object at `key`, or undefined when there's none. Refuses one whose
   * size fails `sizeOk` before reading its body.
   */
  async read(
    key: string,
    sizeOk: (size: number) => boolean,
    expected: string
  ): Promise<Bytes | undefined> {
    this.reads += 1;
    const object = await this.#store.get(key);
    if (object === null) {
      return undefined;
    }
    if (!sizeOk(object.size)) {
      await object.body.cancel();
      throw new Error(`${key} is ${object.size} bytes; expected ${expected}`);
    }
    return new Uint8Array(await object.arrayBuffer());
  }
}

/**
 * The manifest at `id`'s key, checked to be release `id`'s, and its text:
 * strict UTF-8, a byte-order mark kept (and refused by the JSON parser).
 */
const parseManifest = (
  id: string,
  bytes: Bytes
): { manifest: ReleaseManifest; text: string } => {
  const text = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  }).decode(bytes);
  const manifest = releaseManifestSchema.parse(JSON.parse(text));
  if (manifest.releaseId !== id) {
    throw new Error(
      `The manifest at ${manifestKey(id)} names release ${manifest.releaseId}`
    );
  }
  const sha = ciRelease.exec(id)?.groups?.sha;
  if (sha !== undefined && !manifest.commit.startsWith(sha)) {
    throw new Error(
      `Release ${id} names commit ${manifest.commit}, not one starting ${sha}`
    );
  }
  return { manifest, text };
};

/**
 * Verifies release `id` and records it. Returns false when it has no
 * manifest (yet); throws when it doesn't verify.
 */
const importRelease = async (
  reader: Reader,
  db: ConsoleDatabase,
  id: string
): Promise<boolean> => {
  const manifestBytes = await reader.read(
    manifestKey(id),
    (size) => size <= MAX_MANIFEST_BYTES,
    `at most ${MAX_MANIFEST_BYTES}`
  );
  if (manifestBytes === undefined) {
    return false;
  }
  const { manifest, text } = parseManifest(id, manifestBytes);
  await verifyReleaseBlobs(
    manifest,
    async (key, size) =>
      await reader.read(key, (actual) => actual === size, String(size)),
    { concurrency: READ_CONCURRENCY }
  );
  const manifestSha256 = await sha256OfBytes(manifestBytes);
  await actIfChanged(
    db,
    "system",
    db
      .insert(releases)
      .values({
        id,
        commitSha: manifest.commit,
        manifest: text,
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
  // Bookkeeping only: the import itself is what's audited.
  await db
    .delete(releaseImportFailures)
    .where(eq(releaseImportFailures.releaseId, id));
  return true;
};

/** Records a failed attempt at `id`, the `attempts`th, and when to try again. */
const recordFailure = async (
  db: ConsoleDatabase,
  id: string,
  attempts: number,
  now: Date
): Promise<void> => {
  const wait = Math.min(FIRST_RETRY_MS * 2 ** (attempts - 1), MAX_RETRY_MS);
  const row = {
    releaseId: id,
    attempts,
    failedAt: now,
    nextAttemptAt: new Date(now.getTime() + wait),
  };
  await act(
    db,
    "system",
    [
      db.insert(releaseImportFailures).values(row).onConflictDoUpdate({
        target: releaseImportFailures.releaseId,
        set: row,
      }),
    ],
    { action: "release.import_failed", target: id, detail: { attempts } }
  );
};

/**
 * Imports the releases published to `store` that `db` doesn't hold yet,
 * newest first: until {@link MAX_IMPORTS_PER_RUN} are imported or
 * {@link MAX_READS_PER_RUN} reads are spent. A release that failed is
 * passed over until its next attempt is due.
 */
export const importReleases = async (
  store: ReleaseStore,
  db: ConsoleDatabase,
  { now = new Date() }: { now?: Date } = {}
): Promise<ImportResult> => {
  const imported = await db.select({ id: releases.id }).from(releases);
  const known = new Set(imported.map((row) => row.id));
  const failed = await db.select().from(releaseImportFailures);
  const failures = new Map(failed.map((row) => [row.releaseId, row]));
  const published = await publishedIds(store);
  const pending = published
    .filter((id) => !known.has(id))
    .filter(
      (id) => (failures.get(id)?.nextAttemptAt.getTime() ?? 0) <= now.getTime()
    )
    .toSorted(newestFirst);

  const reader = new Reader(store);
  const result: ImportResult = { imported: [], failed: [] };
  // One release at a time, to bound the blobs read at once.
  for (const id of pending) {
    if (
      result.imported.length >= MAX_IMPORTS_PER_RUN ||
      reader.reads >= MAX_READS_PER_RUN
    ) {
      break;
    }
    try {
      // oxlint-disable-next-line no-await-in-loop -- one release at a time
      if (await importRelease(reader, db, id)) {
        result.imported.push(id);
      }
    } catch (error) {
      result.failed.push(id);
      log.error("release.import_failed", {
        releaseId: id,
        ...errorFields(error),
      });
      // oxlint-disable-next-line no-await-in-loop -- one release at a time
      await recordFailure(db, id, (failures.get(id)?.attempts ?? 0) + 1, now);
    }
  }
  return result;
};
