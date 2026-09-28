import { assetContentKey, assetKey } from "@grasp-os/shared/release";
import type { ReleaseManifest, WorkerEntry } from "@grasp-os/shared/release";
/**
 * One of a release's Workers as the Workers API takes it: its metadata
 * with the account's resources filled in, its modules and static files
 * read from R2 and checked against the manifest, and its secrets.
 */
import { deriveRouterSecret } from "@grasp-os/shared/router";

import type {
  AssetFile,
  Secret,
  WorkerMetadata,
  WorkerModule,
  WorkerUpload,
} from "../cloudflare/workers.ts";
import type { ReleaseStore } from "../releases/import.ts";
import { readBlob } from "./release.ts";

/** The placeholder a D1 binding's id is in the manifest (scripts/release). */
const d1Placeholder = /^\$D1_(?<binding>[A-Z][A-Z0-9_]*)_ID$/u;

/**
 * `worker`'s bindings with each `$D1_<BINDING>_ID` replaced by the id of
 * the database that binding names. The placeholder list is closed: any
 * other `$` value is refused, so the manifest and this change together.
 */
export const renderBindings = (
  worker: WorkerEntry,
  databases: ReadonlyMap<string, string>
): Record<string, unknown>[] =>
  worker.bindings.map((binding) =>
    Object.fromEntries(
      Object.entries(binding).map(([field, value]) => {
        if (typeof value !== "string" || !value.startsWith("$")) {
          return [field, value];
        }
        const name = d1Placeholder.exec(value)?.groups?.binding;
        const database = worker.d1Databases.find(
          (entry) => entry.binding === name
        );
        const id =
          database === undefined
            ? undefined
            : databases.get(database.databaseName);
        if (id === undefined) {
          throw new Error(
            `${worker.name}'s binding ${binding.name} names a placeholder the console doesn't fill`
          );
        }
        return [field, id];
      })
    )
  );

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
      async ([path, { hash, size }]) => {
        const object = await store.get(assetKey(hash));
        if (object === null || object.size !== size) {
          await object?.body.cancel();
          throw new Error(`${path} is missing from the release or changed`);
        }
        const content = new Uint8Array(await object.arrayBuffer());
        if ((await assetContentKey(content, path)) !== hash) {
          throw new Error(`${path} doesn't match its hash`);
        }
        return { path, content, type: assetType(path) };
      }
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

/** The secrets a deploy gives each Worker. */
export interface DeploySecrets {
  /** `ROUTER_KEY` from Secrets Store: each client's router secret is derived from it. */
  routerKey: string;
  /**
   * Every other secret, by app (`core`, `connect`), then by name, such as
   * the ones Secrets Store holds for all clients.
   */
  byApp: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

/** A Worker's required secret that the deploy wasn't given. */
export class MissingSecretError extends Error {
  constructor(worker: string, name: string) {
    super(`No value for ${worker}'s secret ${name}`);
    this.name = "MissingSecretError";
  }
}

/** The router secret's name on core (core's src/router-secret.ts). */
const routerSecretName = "ROUTER_SECRET";

/**
 * Every secret the Worker `app` runs with: `ROUTER_SECRET`, where it needs
 * it, derived for the client and its router secret generation, and the
 * ones given for it. Throws `MissingSecretError` for a required one it
 * wasn't given, so nothing is uploaded without it.
 */
export const workerSecrets = async (
  app: string,
  worker: WorkerEntry,
  secrets: DeploySecrets,
  client: { id: string; generation: number }
): Promise<Secret[]> => {
  const given = new Map(Object.entries(secrets.byApp[app] ?? {}));
  if (worker.requiredSecrets.includes(routerSecretName)) {
    given.set(
      routerSecretName,
      await deriveRouterSecret(secrets.routerKey, client.id, client.generation)
    );
  }
  for (const name of worker.requiredSecrets) {
    if (!given.has(name)) {
      throw new MissingSecretError(worker.name, name);
    }
  }
  return [...given].map(([name, value]) => ({ name, value }));
};
