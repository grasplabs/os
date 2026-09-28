/**
 * upload-release.ts run as CI runs it, against a stand-in for R2's S3 API
 * (the outside system) that stores objects in memory and, as R2 does,
 * honours `If-None-Match: *`, checks `x-amz-checksum-sha256` on a PUT and
 * reports it on a HEAD with checksum mode on.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { buffer, text } from "node:stream/consumers";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { builds, info } from "./fixture-release.ts";
import { generateManifest, moduleKey, writeRelease } from "./manifest-lib.ts";

/** Runs a script in Node, resolving with its stdout; failing with its stderr. */
const run = async (args: string[], env: NodeJS.ProcessEnv): Promise<string> => {
  const child = spawn("node", args, { env });
  const closed = once(child, "close");
  const [stdout, stderr] = await Promise.all([
    text(child.stdout),
    text(child.stderr),
  ]);
  await closed;
  if (child.exitCode !== 0) {
    throw new Error(stderr);
  }
  return stdout;
};
const SCRIPT = path.join(import.meta.dirname, "upload-release.ts");
const BUCKET = "grasp-os-releases";
const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;
const HTTP_PRECONDITION_FAILED = 412;

const manifest = generateManifest(info, builds());
const published = `releases/${manifest.releaseId}/manifest.json`;

const HTTP_BAD_REQUEST = 400;

const sha256Base64 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("base64");

/**
 * Objects by key, the SHA-256 each was stored with (if any), every PUT that
 * stored one, in order, and objects another writer stores (without a
 * checksum) right after answering a HEAD for their key with "not found".
 */
interface Bucket {
  objects: Map<string, Buffer>;
  checksums: Map<string, string>;
  puts: string[];
  writtenAfterHead: Map<string, Buffer>;
}

const emptyBucket = (): Bucket => ({
  objects: new Map(),
  checksums: new Map(),
  puts: [],
  writtenAfterHead: new Map(),
});

const handle = async (
  bucket: Bucket,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> => {
  const prefix = `/${BUCKET}/`;
  const url = request.url ?? "";
  const key = url.startsWith(prefix) ? url.slice(prefix.length) : undefined;
  if (key === undefined || request.headers.authorization === undefined) {
    response.writeHead(HTTP_NOT_FOUND).end();
    return;
  }
  const stored = bucket.objects.get(key);
  if (request.method === "HEAD") {
    const checksum = bucket.checksums.get(key);
    const reportChecksum =
      checksum !== undefined &&
      request.headers["x-amz-checksum-mode"] === "ENABLED";
    response
      .writeHead(
        stored === undefined ? HTTP_NOT_FOUND : HTTP_OK,
        reportChecksum ? { "x-amz-checksum-sha256": checksum } : {}
      )
      .end();
    const other = bucket.writtenAfterHead.get(key);
    if (other !== undefined && stored === undefined) {
      bucket.objects.set(key, other);
    }
    return;
  }
  if (request.method === "GET") {
    response.writeHead(stored === undefined ? HTTP_NOT_FOUND : HTTP_OK);
    response.end(stored);
    return;
  }
  const body = await buffer(request);
  if (request.headers["if-none-match"] === "*" && stored !== undefined) {
    response.writeHead(HTTP_PRECONDITION_FAILED).end();
    return;
  }
  const checksum = request.headers["x-amz-checksum-sha256"];
  if (typeof checksum === "string" && checksum !== sha256Base64(body)) {
    response.writeHead(HTTP_BAD_REQUEST).end();
    return;
  }
  bucket.objects.set(key, body);
  if (typeof checksum === "string") {
    bucket.checksums.set(key, checksum);
  }
  bucket.puts.push(key);
  response.writeHead(HTTP_OK).end();
};

describe("publishing a release", () => {
  let dir = "";
  let server: Server | undefined;
  let bucket = emptyBucket();
  let endpoint = "";

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "grasp-os-upload-test-"));
    writeRelease(dir, manifest, builds());
    bucket = emptyBucket();
    const current = bucket;
    server = createServer((request, response) => {
      void handle(current, request, response);
    }).listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("no port for the stand-in");
    }
    endpoint = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    server?.close();
    if (server) {
      await once(server, "close");
    }
    rmSync(dir, { force: true, recursive: true });
  });

  const upload = async (...flags: string[]): Promise<string> =>
    await run([SCRIPT, "--release", dir, ...flags], {
      PATH: process.env.PATH,
      R2_ENDPOINT: endpoint,
      R2_BUCKET: BUCKET,
      R2_ACCESS_KEY_ID: "test-key-id",
      R2_SECRET_ACCESS_KEY: "test-secret",
    });

  it("uploads every blob, then the manifest last", async () => {
    await upload();
    const referenced = [
      ...Object.values(manifest.workers).flatMap((worker) => [
        ...worker.modules.map((module) => module.r2Key),
        ...worker.d1Databases.flatMap((database) =>
          database.migrations.map((migration) => migration.r2Key)
        ),
      ]),
      ...Object.values(manifest.assets).map((asset) => asset.r2Key),
    ];
    expect(bucket.puts.at(-1)).toBe(published);
    expect(bucket.puts.slice(0, -1).toSorted()).toStrictEqual(
      [...new Set(referenced)].toSorted()
    );
  });

  it("skips blobs R2 has, and never replaces a published manifest", async () => {
    await upload();
    const first = bucket.objects.get(published);
    bucket.puts.length = 0;
    writeFileSync(
      path.join(dir, "manifest.json"),
      `${JSON.stringify({ ...manifest, createdAt: "2026-02-02T00:00:00.000Z" })}\n`
    );
    const stdout = await upload();
    expect(bucket.puts).toStrictEqual([]);
    expect(bucket.objects.get(published)).toStrictEqual(first);
    expect(stdout).toContain("0 uploaded");
  });

  const coreModule = (): { key: string; bytes: Buffer } => {
    const module = manifest.workers.core?.modules[0];
    if (module === undefined) {
      throw new Error("expected a core module");
    }
    return {
      key: module.r2Key,
      bytes: readFileSync(path.join(dir, module.r2Key)),
    };
  };

  it("keeps a matching blob another writer stores between its HEAD and its PUT", async () => {
    const { key, bytes } = coreModule();
    bucket.writtenAfterHead.set(key, bytes);
    const stdout = await upload();
    expect(bucket.puts).not.toContain(key);
    expect(bucket.puts.at(-1)).toBe(published);
    expect(stdout).toContain(`Published ${published}`);
  });

  it("publishes nothing when another writer stores other bytes between its HEAD and its PUT", async () => {
    const { key } = coreModule();
    bucket.writtenAfterHead.set(key, Buffer.from("other bytes"));
    await expect(upload()).rejects.toThrow(/isn't the release's bytes/u);
    expect(bucket.objects.has(published)).toBeFalsy();
  });

  it("publishes nothing when R2 already holds other bytes at a blob's key", async () => {
    const { key } = coreModule();
    const other = Buffer.from("other bytes");
    bucket.objects.set(key, other);
    bucket.checksums.set(key, sha256Base64(other));
    await expect(upload()).rejects.toThrow(/isn't the release's bytes/u);
    expect(bucket.objects.has(published)).toBeFalsy();
  });

  it("uploads only the blobs the manifest references", async () => {
    const stray = "blobs/modules/stray";
    mkdirSync(path.dirname(path.join(dir, stray)), { recursive: true });
    writeFileSync(path.join(dir, stray), "not in the manifest");
    await upload();
    expect(bucket.puts).not.toContain(stray);
  });

  it("uploads nothing on a dry run", async () => {
    const stdout = await upload("--dry-run");
    expect(bucket.puts).toStrictEqual([]);
    expect(stdout).toContain(published);
  });

  it("uploads nothing from a release that doesn't verify", async () => {
    const module = manifest.workers.core?.modules[0];
    if (module === undefined) {
      throw new Error("expected a core module");
    }
    writeFileSync(path.join(dir, moduleKey(module.sha256)), "tampered");
    await expect(upload()).rejects.toThrow(/doesn't match its hash/u);
    expect(bucket.puts).toStrictEqual([]);
  });
});
