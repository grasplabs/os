/**
 * The release manifest: the contract between CI, which builds core and
 * connect once per commit, and the console, which deploys those exact bytes
 * into each client's account through the Workers API.
 *
 * It's generated from each Worker's wrangler.jsonc. Names (Workers, D1
 * databases, R2 buckets, the workflow) are the same in every client account;
 * what differs per account is a placeholder the console fills in for the
 * Worker it deploys:
 *
 *   $D1_<BINDING>_ID   the id of the D1 database that binding names
 *
 * The placeholder list is closed: the console refuses a `$` token it doesn't
 * know, so this file and the console change together, behind
 * MANIFEST_VERSION.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

import { cfAssetHash, sha256Hex, stableStringify } from "./hash-lib.ts";
import type {
  CollectedAssets,
  CollectedFile,
  CollectedModule,
} from "./hash-lib.ts";

/** The manifest shape the console must understand (see the header comment). */
export const MANIFEST_VERSION = 1;

const bindingName = z.string().regex(/^[A-Z][A-Z0-9_]*$/u);
const named = z.strictObject({ binding: bindingName });

// Every wrangler.jsonc key a released Worker may use, and the shape of each.
// Strict at every level: a key this generator doesn't handle fails the build,
// since a new config key needs a decision about how client accounts get it.
const wranglerConfigSchema = z.strictObject({
  $schema: z.string().optional(),
  name: z.string(),
  main: z.string(),
  compatibility_date: z.iso.date(),
  compatibility_flags: z.array(z.string()).default([]),
  workers_dev: z.boolean(),
  preview_urls: z.boolean(),
  // Bundling only: the modules it produces are in the dry-run output.
  rules: z.array(z.unknown()).optional(),
  // Passed to the Workers API as it is.
  observability: z.record(z.string(), z.unknown()).default({}),
  assets: z
    .strictObject({
      directory: z.string(),
      binding: bindingName.optional(),
      not_found_handling: z
        .enum(["none", "404-page", "single-page-application"])
        .optional(),
      run_worker_first: z.union([z.boolean(), z.array(z.string())]).optional(),
    })
    .optional(),
  keep_vars: z.boolean().default(false),
  secrets: z.strictObject({ required: z.array(bindingName) }).optional(),
  durable_objects: z
    .strictObject({
      bindings: z.array(
        z.strictObject({ name: bindingName, class_name: z.string() })
      ),
    })
    .optional(),
  // Replayed in order, never interpreted: carried through as written.
  migrations: z.array(z.looseObject({ tag: z.string() })).default([]),
  workflows: z
    .array(
      z.strictObject({
        name: z.string(),
        binding: bindingName,
        class_name: z.string(),
      })
    )
    .default([]),
  worker_loaders: z.array(named).default([]),
  d1_databases: z
    .array(
      z.strictObject({
        binding: bindingName,
        database_name: z.string(),
        migrations_dir: z.string().default("migrations"),
        // Local dev only.
        preview_database_id: z.string().optional(),
      })
    )
    .default([]),
  // EU only: a bucket's jurisdiction is set when it's created.
  r2_buckets: z
    .array(
      z.strictObject({
        binding: bindingName,
        bucket_name: z.string(),
        jurisdiction: z.literal("eu"),
      })
    )
    .default([]),
  triggers: z.strictObject({ crons: z.array(z.string()) }).optional(),
  // `remote` only changes local dev.
  ai: z
    .strictObject({ binding: bindingName, remote: z.boolean().optional() })
    .optional(),
  send_email: z.array(z.strictObject({ name: bindingName })).default([]),
  services: z
    .array(
      z.strictObject({
        binding: bindingName,
        service: z.string(),
        entrypoint: z.string().optional(),
      })
    )
    .default([]),
});

/** The part of a wrangler.jsonc a release reads. */
export type WranglerConfig = z.infer<typeof wranglerConfigSchema>;

/** Parses a released Worker's wrangler.jsonc, failing on anything unhandled. */
export const parseWranglerConfig = (
  file: string,
  config: unknown
): WranglerConfig => {
  const result = wranglerConfigSchema.safeParse(config);
  if (!result.success) {
    throw new Error(
      `${file} has config the release generator doesn't handle; decide how client accounts get it:\n${z.prettifyError(result.error)}`
    );
  }
  return result.data;
};

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
  bindings: z.array(z.looseObject({ type: z.string(), name: bindingName })),
  /** Each D1 database: created by name, migrated in order before deploying. */
  d1Databases: z.array(
    z.strictObject({
      binding: bindingName,
      databaseName: z.string(),
      migrations: z.array(fileRef),
    })
  ),
  /** The whole ordered Durable Object migration history. */
  durableObjectMigrations: z.array(z.looseObject({ tag: z.string() })),
  crons: z.array(z.string()),
  /** Secrets that must be set before this Worker can be deployed. */
  requiredSecrets: z.array(bindingName),
  /** Keep the vars the console set on the previous version. */
  keepVars: z.boolean(),
  workersDev: z.boolean(),
  previewUrls: z.boolean(),
  observability: z.record(z.string(), z.unknown()),
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
  releaseId: z.string().regex(RELEASE_ID),
  /** The full commit SHA it was built from. */
  commit: z.string().regex(/^[0-9a-f]{40}$/u),
  createdAt: z.iso.datetime(),
  /** The squash commit's subject: the merged pull request's title. */
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

/** One Worker's build output, as {@link generateManifest} takes it. */
export interface WorkerBuild {
  /** The app, e.g. `core`. */
  key: string;
  config: WranglerConfig;
  mainModule: string;
  modules: CollectedModule[];
  /** Each D1 binding's migrations. */
  d1Migrations: Record<string, CollectedFile[]>;
  /** The assets directory's contents, for a Worker that serves assets. */
  assets?: CollectedAssets;
}

type Binding = WorkerEntry["bindings"][number];

const bindingsOf = (
  config: WranglerConfig,
  releaseNames: Set<string>
): Binding[] => [
  ...(config.durable_objects?.bindings ?? []).map((object) => ({
    type: "durable_object_namespace",
    name: object.name,
    class_name: object.class_name,
  })),
  ...config.workflows.map((workflow) => ({
    type: "workflow",
    name: workflow.binding,
    workflow_name: workflow.name,
    class_name: workflow.class_name,
  })),
  ...config.worker_loaders.map((loader) => ({
    type: "worker_loader",
    name: loader.binding,
  })),
  ...config.d1_databases.map((database) => ({
    type: "d1",
    name: database.binding,
    id: `$D1_${database.binding}_ID`,
  })),
  ...config.r2_buckets.map((bucket) => ({
    type: "r2_bucket",
    name: bucket.binding,
    bucket_name: bucket.bucket_name,
    jurisdiction: bucket.jurisdiction,
  })),
  ...(config.ai ? [{ type: "ai", name: config.ai.binding }] : []),
  ...config.send_email.map((email) => ({
    type: "send_email",
    name: email.name,
  })),
  ...config.services.map((service) => {
    if (!releaseNames.has(service.service)) {
      throw new Error(
        `${config.name} binds ${service.service}, which isn't in the release`
      );
    }
    return {
      type: "service",
      name: service.binding,
      service: service.service,
      ...(service.entrypoint === undefined
        ? {}
        : { entrypoint: service.entrypoint }),
    };
  }),
  ...(config.assets
    ? [{ type: "assets", name: config.assets.binding ?? "ASSETS" }]
    : []),
];

const fileRefs = (
  files: CollectedFile[],
  key: (hash: string) => string
): z.infer<typeof fileRef>[] =>
  files.map((file) => ({
    name: file.name,
    sha256: file.sha256,
    size: file.size,
    r2Key: key(file.sha256),
  }));

const workerEntry = (
  { config, mainModule, modules, d1Migrations, assets }: WorkerBuild,
  releaseNames: Set<string>
): WorkerEntry => {
  if (Boolean(config.assets) !== Boolean(assets)) {
    throw new Error(
      `${config.name}: assets must be collected exactly when its config serves them`
    );
  }
  return {
    name: config.name,
    mainModule,
    modules: modules.map((module) => ({
      name: module.name,
      type: module.type,
      sha256: module.sha256,
      size: module.size,
      r2Key: moduleKey(module.sha256),
    })),
    compatibilityFlags: config.compatibility_flags,
    bindings: bindingsOf(config, releaseNames),
    d1Databases: config.d1_databases.map((database) => {
      const migrations = d1Migrations[database.binding];
      if (migrations === undefined) {
        throw new Error(
          `${config.name}: no migrations collected for ${database.binding}`
        );
      }
      return {
        binding: database.binding,
        databaseName: database.database_name,
        migrations: fileRefs(migrations, migrationKey),
      };
    }),
    durableObjectMigrations: config.migrations,
    crons: config.triggers?.crons ?? [],
    requiredSecrets: config.secrets?.required ?? [],
    keepVars: config.keep_vars,
    workersDev: config.workers_dev,
    previewUrls: config.preview_urls,
    observability: config.observability,
    ...(config.assets && assets
      ? {
          assets: {
            config: {
              not_found_handling: config.assets.not_found_handling,
              run_worker_first: config.assets.run_worker_first,
            },
            manifest: assets.manifest,
          },
        }
      : {}),
  };
};

/** Release metadata that isn't read from the Workers' builds. */
export interface ReleaseInfo {
  releaseId: string;
  commit: string;
  createdAt: string;
  notes: string;
  wranglerVersion: string;
  packages: Record<string, string>;
}

/** Assembles the manifest from each Worker's build. */
export const generateManifest = (
  info: ReleaseInfo,
  workers: WorkerBuild[]
): ReleaseManifest => {
  const dates = new Set(workers.map((w) => w.config.compatibility_date));
  const [compatibilityDate] = dates;
  if (compatibilityDate === undefined || dates.size > 1) {
    throw new Error(
      `Released Workers must share one compatibility date, found: ${[...dates].join(", ") || "none"}`
    );
  }
  const releaseNames = new Set(workers.map((w) => w.config.name));
  const assets: ReleaseManifest["assets"] = {};
  for (const [hash, bytes] of workers.flatMap((w) => [
    ...(w.assets?.blobs ?? []),
  ])) {
    assets[hash] = { size: bytes.length, r2Key: assetKey(hash) };
  }
  return releaseManifestSchema.parse({
    manifestVersion: MANIFEST_VERSION,
    ...info,
    compatibilityDate,
    workers: Object.fromEntries(
      workers.map((w) => [w.key, workerEntry(w, releaseNames)])
    ),
    assets,
  });
};

const writeBlob = (outDir: string, key: string, bytes: Buffer): void => {
  const file = path.join(outDir, key);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, bytes);
};

/**
 * Writes a release directory laid out as it's stored in R2: every blob at
 * its key, then `manifest.json`, last.
 */
export const writeRelease = (
  outDir: string,
  manifest: ReleaseManifest,
  workers: WorkerBuild[]
): void => {
  for (const worker of workers) {
    for (const module of worker.modules) {
      writeBlob(outDir, moduleKey(module.sha256), module.bytes);
    }
    for (const migration of Object.values(worker.d1Migrations).flat()) {
      writeBlob(outDir, migrationKey(migration.sha256), migration.bytes);
    }
    for (const [hash, bytes] of worker.assets?.blobs ?? []) {
      writeBlob(outDir, assetKey(hash), bytes);
    }
  }
  writeFileSync(path.join(outDir, "manifest.json"), stableStringify(manifest));
};

const readBlob = (outDir: string, key: string, expectedKey: string): Buffer => {
  if (key !== expectedKey) {
    throw new Error(`${key} isn't stored at its content address`);
  }
  try {
    return readFileSync(path.join(outDir, key));
  } catch (error) {
    throw new Error(`${key} is missing from the release`, { cause: error });
  }
};

const verifyFile = (
  outDir: string,
  file: z.infer<typeof fileRef>,
  key: (hash: string) => string
): void => {
  const bytes = readBlob(outDir, file.r2Key, key(file.sha256));
  if (sha256Hex(bytes) !== file.sha256 || bytes.length !== file.size) {
    throw new Error(`${file.r2Key} (${file.name}) doesn't match its hash`);
  }
};

/**
 * Checks a release directory against its manifest: every module, migration
 * and asset is present at its content address, and its bytes hash to it.
 * Returns the parsed manifest.
 */
export const verifyRelease = (outDir: string): ReleaseManifest => {
  const manifest = releaseManifestSchema.parse(
    JSON.parse(readFileSync(path.join(outDir, "manifest.json"), "utf-8"))
  );
  for (const worker of Object.values(manifest.workers)) {
    for (const module of worker.modules) {
      verifyFile(outDir, module, moduleKey);
    }
    for (const migration of worker.d1Databases.flatMap((d) => d.migrations)) {
      verifyFile(outDir, migration, migrationKey);
    }
    for (const [assetPath, entry] of Object.entries(
      worker.assets?.manifest ?? {}
    )) {
      const blob = manifest.assets[entry.hash];
      if (blob === undefined) {
        throw new Error(`${assetPath} isn't in the release's asset index`);
      }
      const bytes = readBlob(outDir, blob.r2Key, assetKey(entry.hash));
      if (
        cfAssetHash(bytes, assetPath) !== entry.hash ||
        bytes.length !== entry.size
      ) {
        throw new Error(`${assetPath} doesn't match its hash`);
      }
    }
  }
  return manifest;
};
