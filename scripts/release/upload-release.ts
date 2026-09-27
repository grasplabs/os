/**
 * Publishes a built release (build-release.ts) to R2 through its S3 API.
 *
 * The release is verified against its manifest first. Blobs are
 * content-addressed, so one an earlier release uploaded is found by a HEAD
 * and skipped. The manifest goes up last, to `releases/<id>/manifest.json`:
 * the console imports only releases whose manifest exists, so an upload that
 * stops halfway never leaves a manifest pointing at missing blobs. It's
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
import { readdirSync, readFileSync } from "node:fs";
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

const manifest = verifyRelease(releaseDir);
const published = manifestKey(manifest.releaseId);
// Every blob, at the key it has in the release directory and in R2.
const blobs = readdirSync(path.join(releaseDir, "blobs"), {
  recursive: true,
  withFileTypes: true,
})
  .filter((entry) => entry.isFile())
  .map((entry) =>
    path
      .relative(releaseDir, path.join(entry.parentPath, entry.name))
      .split(path.sep)
      .join("/")
  )
  .toSorted();

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

  const uploadBlob = async (key: string): Promise<"uploaded" | "skipped"> => {
    const head = await client.fetch(url(key), { method: "HEAD" });
    if (head.ok) {
      return "skipped";
    }
    if (head.status !== HTTP_NOT_FOUND) {
      throw new Error(`HEAD ${key}: ${head.status}`);
    }
    const put = await client.fetch(url(key), {
      method: "PUT",
      body: readFileSync(path.join(releaseDir, key)),
    });
    if (!put.ok) {
      throw new Error(`PUT ${key}: ${put.status} ${await put.text()}`);
    }
    return "uploaded";
  };

  // A fixed number of workers, each taking the next blob off the queue.
  const queue = [...blobs];
  const results: ("uploaded" | "skipped")[] = [];
  const work = async (): Promise<void> => {
    for (let key = queue.shift(); key !== undefined; key = queue.shift()) {
      // oxlint-disable-next-line no-await-in-loop -- each worker uploads one blob at a time
      results.push(await uploadBlob(key));
    }
  };
  await Promise.all(Array.from({ length: UPLOAD_CONCURRENCY }, work));
  const uploaded = results.filter((result) => result === "uploaded").length;
  console.info(
    `Blobs: ${uploaded} uploaded, ${results.length - uploaded} already there`
  );

  const put = await client.fetch(url(published), {
    method: "PUT",
    body: readFileSync(path.join(releaseDir, "manifest.json")),
    headers: { "Content-Type": "application/json", "If-None-Match": "*" },
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
    `Dry run: release ${manifest.releaseId} verified; would upload whichever of its ${blobs.length} blobs R2 lacks, then ${published}`
  );
} else {
  await upload();
}
