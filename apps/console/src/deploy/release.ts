/**
 * A release as a deploy reads it: the manifest the console imported and
 * verified (src/releases/import.ts), and its blobs from R2, each checked
 * against the manifest again as it's read, so a deploy runs exactly the
 * bytes CI built even if the bucket changed since the import.
 */
import { releaseManifestSchema, sha256OfBytes } from "@grasp-os/shared/release";
import type { Bytes, ReleaseManifest } from "@grasp-os/shared/release";
import { eq } from "drizzle-orm";

import type { ConsoleDatabase } from "../db/act.ts";
import { releases } from "../db/schema.ts";
import type { ReleaseStore } from "../releases/import.ts";
import { DeployError } from "./errors.ts";

/** Release `id`'s manifest, as imported; null when it isn't imported. */
export const importedManifest = async (
  db: ConsoleDatabase,
  id: string
): Promise<ReleaseManifest | null> => {
  const [row] = await db
    .select({ manifest: releases.manifest })
    .from(releases)
    .where(eq(releases.id, id));
  return row === undefined
    ? null
    : releaseManifestSchema.parse(JSON.parse(row.manifest));
};

/** A blob the manifest names by its SHA-256: a module or a migration. */
export interface BlobRef {
  name: string;
  sha256: string;
  size: number;
  r2Key: string;
}

/**
 * The bytes of `file`, read from `store` and checked against the
 * manifest: its size before its body is read, then its SHA-256.
 */
export const readBlob = async (
  store: ReleaseStore,
  file: BlobRef
): Promise<Bytes> => {
  const object = await store.get(file.r2Key);
  if (object === null) {
    throw new DeployError(
      "release_blob_mismatch",
      `${file.r2Key} (${file.name}) is missing from the release`
    );
  }
  if (object.size !== file.size) {
    await object.body.cancel();
    throw new DeployError(
      "release_blob_mismatch",
      `${file.r2Key} (${file.name}) doesn't match its size`
    );
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  if ((await sha256OfBytes(bytes)) !== file.sha256) {
    throw new DeployError(
      "release_blob_mismatch",
      `${file.r2Key} (${file.name}) doesn't match its hash`
    );
  }
  return bytes;
};
