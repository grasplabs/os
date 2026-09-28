/**
 * The release manifest: the contract between CI, which builds core and
 * connect once per commit (scripts/release), and the console, which imports
 * each release and deploys those exact bytes into client accounts.
 *
 * Blobs are content-addressed, in two schemes on purpose:
 * - Worker modules and D1 migrations by their full SHA-256 (hex): our own
 *   scheme, for deduplication in R2 and for checking that what the console
 *   deploys is what CI built.
 * - Static assets by the content key of Cloudflare's assets-upload API:
 *   SHA-256 of base64(contents) plus the file's extension, hex, cut to 32
 *   characters. The API treats it as an opaque key per file (Wrangler
 *   computes the same shape with BLAKE3), so CI and the console only have to
 *   agree with each other, byte for byte.
 *
 * Account-specific values in a Worker's bindings are placeholders the
 * console fills in for the Worker it deploys:
 *
 *   $D1_<BINDING>_ID   the id of the D1 database that binding names
 *
 * The placeholder list is closed: the console refuses a `$` token it doesn't
 * know, so the generator and the console change together, behind
 * MANIFEST_VERSION.
 *
 * Nothing but Web APIs, so CI (Node) and the console (workerd) verify a
 * release with the same code.
 */
import { z } from "zod";

import { toHex } from "./encoding.ts";

/** The manifest shape the console must understand (see the header comment). */
export const MANIFEST_VERSION = 1;

/** A binding's name, as wrangler.jsonc and the Workers API take it. */
export const bindingNameSchema = z.string().regex(/^[A-Z][A-Z0-9_]*$/u);

/** Worker observability settings that mean the same in every account. */
export const observabilitySchema = z.strictObject({
  enabled: z.boolean().optional(),
  redact_query_string: z.boolean().optional(),
  logs: z.strictObject({ invocation_logs: z.boolean().optional() }).optional(),
  traces: z.strictObject({ enabled: z.boolean().optional() }).optional(),
});

const sha256 = z.string().regex(/^[0-9a-f]{64}$/u);
const assetHash = z.string().regex(/^[0-9a-f]{32}$/u);
const size = z.int().nonnegative();

const fileRef = z.strictObject({
  name: z.string(),
  sha256,
  size,
  r2Key: z.string(),
});

// `r<run>-<sha7>` from CI, `dev-<time>` locally. It becomes an R2 prefix, so
// nothing else is allowed in it.
const RELEASE_ID = /^(?:r\d{6,}-[0-9a-f]{7}|dev-[0-9a-z]+)$/u;

/** A release's id: `r<run6>-<sha7>` from CI, `dev-<time>` locally. */
export const releaseIdSchema = z.string().regex(RELEASE_ID);

const workerEntrySchema = z.strictObject({
  /** The Worker's name in every client account. */
  name: z.string(),
  /** The entry module, one of `modules`. */
  mainModule: z.string(),
  modules: z.array(
    fileRef.extend({ type: z.enum(["esm", "text", "wasm", "data"]) })
  ),
  compatibilityFlags: z.array(z.string()),
  /** Script-upload API bindings, account-specific values as placeholders. */
  bindings: z.array(
    z.looseObject({ type: z.string(), name: bindingNameSchema })
  ),
  /** Each D1 database: created by name, migrated in order before deploying. */
  d1Databases: z.array(
    z.strictObject({
      binding: bindingNameSchema,
      databaseName: z.string(),
      migrations: z.array(fileRef),
    })
  ),
  /** The whole ordered Durable Object migration history. */
  durableObjectMigrations: z.array(z.looseObject({ tag: z.string() })),
  crons: z.array(z.string()),
  /** Secrets that must be set before this Worker can be deployed. */
  requiredSecrets: z.array(bindingNameSchema),
  /** Keep the vars the console set on the previous version. */
  keepVars: z.boolean(),
  workersDev: z.boolean(),
  previewUrls: z.boolean(),
  observability: observabilitySchema,
  /** Static assets: the API's `assets.config` and upload manifest. */
  assets: z
    .strictObject({
      config: z.strictObject({
        not_found_handling: z.string().optional(),
        run_worker_first: z
          .union([z.boolean(), z.array(z.string())])
          .optional(),
      }),
      manifest: z.record(z.string(), z.strictObject({ hash: assetHash, size })),
    })
    .optional(),
});

/** Everything the manifest says about one Worker. */
export type WorkerEntry = z.infer<typeof workerEntrySchema>;

/** The release manifest (see the header comment). */
export const releaseManifestSchema = z.strictObject({
  manifestVersion: z.literal(MANIFEST_VERSION),
  releaseId: releaseIdSchema,
  /** The full commit SHA it was built from. */
  commit: z.string().regex(/^[0-9a-f]{40}$/u),
  createdAt: z.iso.datetime(),
  /**
   * The release note: the squash commit's subject, which is the merged pull
   * request's Conventional Commit title.
   */
  notes: z.string(),
  wranglerVersion: z.string(),
  /** One compatibility date for the whole platform. */
  compatibilityDate: z.iso.date(),
  /** Installed versions of the Workers' and frontend's dependencies. */
  packages: z.record(z.string(), z.string()),
  /** By app: `core`, `connect`. */
  workers: z.record(z.string(), workerEntrySchema),
  /** Every asset blob, by content key. */
  assets: z.record(assetHash, z.strictObject({ size, r2Key: z.string() })),
});

export type ReleaseManifest = z.infer<typeof releaseManifestSchema>;

/** Where a Worker module is stored, in the release directory and in R2. */
export const moduleKey = (hash: string): string => `blobs/modules/${hash}`;
/** Where a D1 migration is stored. */
export const migrationKey = (hash: string): string =>
  `blobs/migrations/${hash}`;
/** Where a static asset is stored. */
export const assetKey = (hash: string): string => `blobs/assets/${hash}`;
/** Where a release's manifest is stored; written last. */
export const manifestKey = (releaseId: string): string =>
  `releases/${releaseId}/manifest.json`;

/** SHA-256 of `bytes`, lowercase hex. */
export const sha256OfBytes = async (bytes: Uint8Array): Promise<string> =>
  toHex(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)))
  );

/** Bytes as base64, a chunk at a time: an asset can be megabytes. */
const toBase64 = (bytes: Uint8Array): string => {
  const chunk = 0x80_00;
  let binary = "";
  for (let start = 0; start < bytes.length; start += chunk) {
    binary += String.fromCodePoint(...bytes.subarray(start, start + chunk));
  }
  return btoa(binary);
};

/** A path's extension without its dot, as Node's `path.extname` finds it. */
const extensionOf = (filePath: string): string => {
  const base = filePath.slice(filePath.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1);
};

/** The static-asset content key (see the header comment). */
export const assetContentKey = async (
  bytes: Uint8Array,
  filePath: string
): Promise<string> => {
  const input = new TextEncoder().encode(
    `${toBase64(bytes)}${extensionOf(filePath)}`
  );
  const hash = await crypto.subtle.digest("SHA-256", input);
  return toHex(new Uint8Array(hash)).slice(0, 32);
};

/** Reads the blob at an R2 key; undefined when there's none. */
export type ReadBlob = (key: string) => Promise<Uint8Array | undefined>;

/** What a blob's bytes must be, for one place the manifest names it. */
type Expectation =
  | { kind: "file"; name: string; sha256: string; size: number }
  | { kind: "asset"; size: number }
  | { kind: "served"; path: string; hash: string; size: number };

/** Blobs read at once while verifying. */
const VERIFY_CONCURRENCY = 8;

/** Every blob the manifest names, with what its bytes must be. */
const expectationsOf = (
  manifest: ReleaseManifest
): Map<string, Expectation[]> => {
  const expected = new Map<string, Expectation[]>();
  const expect = (key: string, expectation: Expectation): void => {
    expected.set(key, [...(expected.get(key) ?? []), expectation]);
  };

  // Only the content-addressed form, which is plain hex under blobs/: an
  // r2Key can never name anything outside the release's blobs.
  for (const [hash, blob] of Object.entries(manifest.assets)) {
    if (blob.r2Key !== assetKey(hash)) {
      throw new Error(`${blob.r2Key} isn't stored at its content address`);
    }
    expect(blob.r2Key, { kind: "asset", size: blob.size });
  }

  const served = new Set<string>();
  for (const worker of Object.values(manifest.workers)) {
    const files = [
      ...worker.modules.map((file) => ({ file, key: moduleKey })),
      ...worker.d1Databases.flatMap((database) =>
        database.migrations.map((file) => ({ file, key: migrationKey }))
      ),
    ];
    for (const { file, key } of files) {
      if (file.r2Key !== key(file.sha256)) {
        throw new Error(`${file.r2Key} isn't stored at its content address`);
      }
      expect(file.r2Key, {
        kind: "file",
        name: file.name,
        sha256: file.sha256,
        size: file.size,
      });
    }
    for (const [assetPath, entry] of Object.entries(
      worker.assets?.manifest ?? {}
    )) {
      if (!Object.hasOwn(manifest.assets, entry.hash)) {
        throw new Error(`${assetPath} isn't in the release's asset index`);
      }
      expect(assetKey(entry.hash), {
        kind: "served",
        path: assetPath,
        hash: entry.hash,
        size: entry.size,
      });
      served.add(entry.hash);
    }
  }

  const unserved = Object.keys(manifest.assets).filter(
    (hash) => !served.has(hash)
  );
  if (unserved.length > 0) {
    throw new Error(
      `The asset index lists blobs no Worker serves: ${unserved.join(", ")}`
    );
  }
  return expected;
};

/** Throws unless `bytes` is what `expectation` says the blob at `key` is. */
const check = async (
  key: string,
  bytes: Uint8Array,
  expectation: Expectation
): Promise<void> => {
  switch (expectation.kind) {
    case "file": {
      if (
        bytes.length !== expectation.size ||
        (await sha256OfBytes(bytes)) !== expectation.sha256
      ) {
        throw new Error(`${key} (${expectation.name}) doesn't match its hash`);
      }
      return;
    }
    case "asset": {
      if (bytes.length !== expectation.size) {
        throw new Error(`${key} doesn't match its hash`);
      }
      return;
    }
    case "served": {
      if (
        bytes.length !== expectation.size ||
        (await assetContentKey(bytes, expectation.path)) !== expectation.hash
      ) {
        throw new Error(`${expectation.path} doesn't match its hash`);
      }
      return;
    }
    default: {
      throw new Error("Unknown expectation");
    }
  }
};

/**
 * Checks a release's blobs against its manifest: every module, migration
 * and asset is stored at its content address, is present, and its bytes
 * hash to it; every entry in the asset index is one a Worker serves. Each
 * blob is read once, through `read`, and checked for every place the
 * manifest names it; a reader that keeps what it returns holds exactly the
 * bytes that were checked. Throws on the first mismatch.
 */
export const verifyReleaseBlobs = async (
  manifest: ReleaseManifest,
  read: ReadBlob
): Promise<void> => {
  const queue = [...expectationsOf(manifest)];
  const verifyOne = async (
    key: string,
    expectations: Expectation[]
  ): Promise<void> => {
    const bytes = await read(key);
    if (bytes === undefined) {
      throw new Error(`${key} is missing from the release`);
    }
    for (const expectation of expectations) {
      // oxlint-disable-next-line no-await-in-loop -- a blob's checks run in turn
      await check(key, bytes, expectation);
    }
  };
  const work = async (): Promise<void> => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- each worker reads one blob at a time
        await verifyOne(...next);
      } catch (error) {
        // The first failure decides: the other workers stop reading.
        queue.length = 0;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: VERIFY_CONCURRENCY }, work));
};
