import { hkdfHmacKey } from "@grasp-os/shared/client-secrets";
import { toHex } from "@grasp-os/shared/encoding";
import { canonicalJson } from "@grasp-os/shared/json";
/**
 * One of a release's Workers as the Workers API takes it: its metadata
 * with the account's resources filled in, and its modules and static
 * files read from R2 and checked against the manifest. Its secrets are in
 * src/deploy/secrets.ts.
 */
import {
  assetContentKey,
  assetKey,
  d1IdPlaceholder,
} from "@grasp-os/shared/release";
import type { ReleaseManifest, WorkerEntry } from "@grasp-os/shared/release";
import { z } from "zod";

import type {
  AssetFile,
  Secret,
  WorkerMetadata,
  WorkerModule,
  WorkerUpload,
} from "../cloudflare/workers.ts";
import type { ReleaseStore } from "../releases/import.ts";
import { DeployError } from "./errors.ts";
import { readBlob, readChecked } from "./release.ts";

const unknownPlaceholder = (worker: WorkerEntry, binding: string) =>
  new DeployError(
    "unknown_placeholder",
    `${worker.name}'s binding ${binding} names a placeholder the console doesn't fill`
  );

/**
 * `worker`'s bindings with each D1 binding's id filled in: a D1 binding's
 * `id` must be exactly its own placeholder (`d1IdPlaceholder`), for a
 * database the Worker lists, and is replaced by that database's id in the
 * account. The placeholder list is closed: any other `$` value is refused
 * (`unknown_placeholder`), so the manifest and this change together.
 */
export const renderBindings = (
  worker: WorkerEntry,
  databases: ReadonlyMap<string, string>
): Record<string, unknown>[] =>
  worker.bindings.map((binding) => {
    const rendered: Record<string, unknown> = { ...binding };
    if (binding.type === "d1") {
      const database = worker.d1Databases.find(
        (entry) => entry.binding === binding.name
      );
      const id =
        database === undefined
          ? undefined
          : databases.get(database.databaseName);
      if (binding.id !== d1IdPlaceholder(binding.name) || id === undefined) {
        throw unknownPlaceholder(worker, binding.name);
      }
      rendered.id = id;
    }
    for (const value of Object.values(rendered)) {
      if (typeof value === "string" && value.startsWith("$")) {
        throw unknownPlaceholder(worker, binding.name);
      }
    }
    return rendered;
  });

/** The API's content type for each module type in the manifest. */
const moduleTypes = {
  esm: "application/javascript+module",
  text: "text/plain",
  wasm: "application/wasm",
  data: "application/octet-stream",
} as const;

/** Content types by extension, for the static files a release serves. */
const assetTypes: Record<string, string> = {
  css: "text/css",
  html: "text/html",
  ico: "image/x-icon",
  js: "text/javascript",
  json: "application/json",
  map: "application/json",
  png: "image/png",
  svg: "image/svg+xml",
  txt: "text/plain",
  webmanifest: "application/manifest+json",
  woff: "font/woff",
  woff2: "font/woff2",
};

const assetType = (path: string): string =>
  assetTypes[/\.(?<extension>[^./]+)$/u.exec(path)?.groups?.extension ?? ""] ??
  "application/octet-stream";

/**
 * `worker`'s static files, read from R2, each checked against the key the
 * manifest gives it before it's uploaded.
 */
const readAssets = async (
  store: ReleaseStore,
  worker: WorkerEntry
): Promise<AssetFile[]> =>
  await Promise.all(
    Object.entries(worker.assets?.manifest ?? {}).map(
      async ([path, { hash, size }]) => ({
        path,
        content: await readChecked(
          store,
          { name: path, size, r2Key: assetKey(hash) },
          async (bytes) => (await assetContentKey(bytes, path)) === hash
        ),
        type: assetType(path),
      })
    )
  );

/**
 * What `worker` of `manifest` is uploaded as: its metadata on the
 * release's compatibility date and flags, its bindings filled in and
 * `vars` added as JSON bindings, and its modules and static files, all
 * read from `store` and checked against the manifest.
 */
export const workerUpload = async (
  store: ReleaseStore,
  manifest: ReleaseManifest,
  worker: WorkerEntry,
  databases: ReadonlyMap<string, string>,
  vars: Readonly<Record<string, unknown>>
): Promise<WorkerUpload> => {
  const modules = await Promise.all(
    worker.modules.map(async (file): Promise<WorkerModule> => ({
      name: file.name,
      content: await readBlob(store, file),
      type: moduleTypes[file.type],
    }))
  );
  const metadata: WorkerMetadata = {
    main_module: worker.mainModule,
    compatibility_date: manifest.compatibilityDate,
    compatibility_flags: worker.compatibilityFlags,
    bindings: [
      ...renderBindings(worker, databases),
      ...Object.entries(vars).map(([name, json]) => ({
        type: "json",
        name,
        json,
      })),
    ],
    observability: worker.observability,
    ...(worker.assets === undefined
      ? {}
      : { assets: { config: worker.assets.config } }),
  };
  return {
    releaseId: manifest.releaseId,
    metadata,
    modules,
    ...(worker.assets === undefined
      ? {}
      : { assets: await readAssets(store, worker) }),
  };
};

/**
 * Throws `binding_name_taken` unless every binding, var and secret of
 * `worker` has a name of its own: a setting named like a binding or a
 * secret, or a shared secret named like a binding, would replace it.
 */
export const checkBindingNames = (
  worker: WorkerEntry,
  vars: Readonly<Record<string, unknown>>,
  secrets: readonly Secret[]
): void => {
  const bindings = new Set(worker.bindings.map(({ name }) => name));
  const secretNames = new Set(secrets.map(({ name }) => name));
  const taken =
    Object.keys(vars).find(
      (name) => bindings.has(name) || secretNames.has(name)
    ) ?? [...secretNames].find((name) => bindings.has(name));
  if (taken !== undefined) {
    throw new DeployError(
      "binding_name_taken",
      `${worker.name} has more than one binding named ${taken}`
    );
  }
};

const encoder = new TextEncoder();

/** What goes into one Worker's upload, as `uploadFingerprint` takes it. */
export interface UploadInputs {
  manifest: ReleaseManifest;
  worker: WorkerEntry;
  databases: ReadonlyMap<string, string>;
  vars: Readonly<Record<string, unknown>>;
  secrets: readonly Secret[];
}

/** HMAC-SHA256 of `inputs`, as canonical JSON, under `key`: hex. */
const keyedHash = async (key: CryptoKey, inputs: unknown): Promise<string> => {
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(canonicalJson(z.json().parse(inputs)))
  );
  return toHex(new Uint8Array(mac));
};

/** `key` as an HMAC-SHA256 key, as it is. */
const rawHmacKey = async (key: string): Promise<CryptoKey> =>
  await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

/** What the key secrets fingerprints are made with is derived for. */
const secretsFingerprintPurpose = "grasp-os console secrets fingerprint";

/** Secrets as `[name, value]` pairs, by name. */
const sortedSecrets = (secrets: readonly Secret[]): [string, string][] =>
  secrets
    .map(({ name, value }): [string, string] => [name, value])
    .toSorted(([a], [b]) => (a < b ? -1 : 1));

/**
 * A fingerprint of everything that goes into a Worker's upload: its
 * secrets' names and values (the previous keys included, when given), its
 * vars, its bindings as filled in for the account, its code, static files,
 * settings and pins. HMAC-SHA256 under `key` (`CLIENT_KEY`), so the
 * fingerprint stored with a recorded version tells nothing about the
 * secret values that went into it. A resumed deploy reuses a version only
 * while this is the same.
 */
export const uploadFingerprint = async (
  key: string,
  { manifest, worker, databases, vars, secrets }: UploadInputs
): Promise<string> =>
  await keyedHash(await rawHmacKey(key), {
    compatibilityDate: manifest.compatibilityDate,
    compatibilityFlags: worker.compatibilityFlags,
    mainModule: worker.mainModule,
    modules: worker.modules.map(({ name, type, sha256 }) => [
      name,
      type,
      sha256,
    ]),
    assets: worker.assets ?? null,
    observability: worker.observability,
    durableObjectMigrations: worker.durableObjectMigrations,
    bindings: renderBindings(worker, databases),
    vars,
    secrets: sortedSecrets(secrets),
  });

/**
 * A fingerprint of `secrets` alone, names and values: HMAC-SHA256 under a
 * key HKDF derives from `key` (`CLIENT_KEY`) for this purpose alone, so it
 * tells nothing about the values and never passes for another MAC. Of a
 * Worker's secrets: two versions with the same one may share traffic
 * (src/rollout/workflow.ts). Of its shared secrets: whether a version
 * runs the ones in Secrets Store now (src/rollout/shared-secrets.ts).
 */
export const secretsFingerprint = async (
  key: string,
  secrets: readonly Secret[]
): Promise<string> =>
  await keyedHash(await hkdfHmacKey(key, secretsFingerprintPurpose, ["sign"]), {
    secrets: sortedSecrets(secrets),
  });
