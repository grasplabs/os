/**
 * Publishes a built release (build-release.ts) to R2 through its S3 API.
 *
 * The release is verified against its manifest first, and the bytes that
 * were hashed are the bytes sent: nothing is read from disk twice. Blobs
 * are content-addressed and uploaded with their SHA-256
 * (`x-amz-checksum-sha256`), which R2 checks on write. A blob R2 already
 * holds, from an earlier release or another writer since the HEAD (the PUT
 * is conditional), is skipped only once its stored SHA-256 matches: the
 * checksum R2 reports, or, for an object stored without one, the hash of
 * its bytes. One that doesn't match fails the upload, before the manifest.
 *
 * The manifest goes up last, to `releases/<id>/manifest.json`: the console
 * imports only releases whose manifest exists, so an upload that stops
 * halfway never leaves a manifest pointing at missing blobs. It's
 * written only if absent, so a published release never changes, not even
 * when its CI run is re-run.
 *
 * With --dry-run it verifies the release and says what it would upload,
 * without credentials or network.
 *
 * Env: R2_ENDPOINT (https://<account id>.eu.r2.cloudflarestorage.com),
 *      R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
 * Usage: vp run release:upload --release <dir> [--dry-run]
 */
import { createHash } from "node:crypto";
import path from "node:path";
import { parseArgs } from "node:util";

import { AwsClient } from "aws4fetch";

import { manifestKey, verifyRelease } from "./manifest-lib.ts";

const UPLOAD_CONCURRENCY = 8;
const HTTP_NOT_FOUND = 404;
const HTTP_PRECONDITION_FAILED = 412;

const { values: args } = parseArgs({
  options: {
    release: { type: "string" },
    "dry-run": { type: "boolean", default: false },
  },
});
if (args.release === undefined) {
  throw new Error("--release <dir> is required");
}
const releaseDir = path.resolve(args.release);

const { manifest, manifestBytes, blobs } = verifyRelease(releaseDir);
const published = manifestKey(manifest.releaseId);

/** SHA-256, base64: the form of R2's `x-amz-checksum-sha256`. */
const sha256Base64 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("base64");

const assertStored = (key: string, stored: string, expected: string): void => {
  if (stored !== expected) {
    throw new Error(
      `${key} in R2 isn't the release's bytes (SHA-256 ${stored}, expected ${expected}); nothing published`
    );
  }
};

const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is required`);
  }
  return value;
};

const upload = async (): Promise<void> => {
  const endpoint = requireEnv("R2_ENDPOINT").replace(/\/$/u, "");
  const bucket = requireEnv("R2_BUCKET");
  const client = new AwsClient({
    accessKeyId: requireEnv("R2_ACCESS_KEY_ID"),
    secretAccessKey: requireEnv("R2_SECRET_ACCESS_KEY"),
    service: "s3",
    region: "auto",
  });
  const url = (key: string): string => `${endpoint}/${bucket}/${key}`;

  const checksumMode = { "x-amz-checksum-mode": "ENABLED" };

  // The SHA-256 of what R2 holds at `key`, or undefined when it holds nothing.
  const storedSha256 = async (key: string): Promise<string | undefined> => {
    const head = await client.fetch(url(key), {
      method: "HEAD",
      headers: checksumMode,
    });
    if (head.status === HTTP_NOT_FOUND) {
      return undefined;
    }
    if (!head.ok) {
      throw new Error(`HEAD ${key}: ${head.status}`);
    }
    const checksum = head.headers.get("x-amz-checksum-sha256");
    if (checksum !== null) {
      return checksum;
    }
    // Stored without a checksum: hash the bytes themselves.
    const get = await client.fetch(url(key));
    if (!get.ok) {
      throw new Error(`GET ${key}: ${get.status}`);
    }
    return sha256Base64(new Uint8Array(await get.arrayBuffer()));
  };

  const uploadBlob = async (
    key: string,
    bytes: Buffer
  ): Promise<"uploaded" | "skipped"> => {
    const expected = sha256Base64(bytes);
    const existing = await storedSha256(key);
    if (existing !== undefined) {
      assertStored(key, existing, expected);
      return "skipped";
    }
    const put = await client.fetch(url(key), {
      method: "PUT",
      body: bytes,
      headers: { "If-None-Match": "*", "x-amz-checksum-sha256": expected },
    });
    if (put.status === HTTP_PRECONDITION_FAILED) {
      // Another writer stored it since the HEAD: skipped only if it matches.
      assertStored(key, (await storedSha256(key)) ?? "none", expected);
      return "skipped";
    }
    if (!put.ok) {
      throw new Error(`PUT ${key}: ${put.status} ${await put.text()}`);
    }
    return "uploaded";
  };

  // A fixed number of workers, each taking the next blob off the queue.
  const queue = [...blobs];
  const results: ("uploaded" | "skipped")[] = [];
  const work = async (): Promise<void> => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      // oxlint-disable-next-line no-await-in-loop -- each worker uploads one blob at a time
      results.push(await uploadBlob(...next));
    }
  };
  await Promise.all(Array.from({ length: UPLOAD_CONCURRENCY }, work));
  const uploaded = results.filter((result) => result === "uploaded").length;
  console.info(
    `Blobs: ${uploaded} uploaded, ${results.length - uploaded} already there`
  );

  const put = await client.fetch(url(published), {
    method: "PUT",
    body: manifestBytes,
    headers: {
      "Content-Type": "application/json",
      "If-None-Match": "*",
      "x-amz-checksum-sha256": sha256Base64(manifestBytes),
    },
  });
  if (put.status === HTTP_PRECONDITION_FAILED) {
    // A re-run of the same CI run: same id, a new build time. The release
    // published first stands, and its blobs are in place.
    console.warn(`::warning::${published} is already published; left as it is`);
    return;
  }
  if (!put.ok) {
    throw new Error(`PUT ${published}: ${put.status} ${await put.text()}`);
  }
  console.info(`Published ${published}`);
};

if (args["dry-run"]) {
  console.info(
    `Dry run: release ${manifest.releaseId} verified; would upload whichever of its ${blobs.size} blobs R2 lacks, then ${published}`
  );
} else {
  await upload();
}
