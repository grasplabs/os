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
