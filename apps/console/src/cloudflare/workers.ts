/**
 * Deploying a release's Workers to a client account: uploading a version
 * (with its static assets), pointing a deployment at it, and what goes
 * with it (secrets, cron schedules, workflows, D1 migrations).
 *
 * A deploy uploads a version, then sends all traffic to it in one
 * deployment; rolling back is a deployment back to the previous version,
 * its secrets included. A Worker's first upload, and a release that adds a
 * Durable Object migration, go as a script upload instead, which deploys at
 * once.
 */
import { sha256Hex } from "@grasp-os/shared/encoding";
import { z } from "zod";

import { CloudflareApiError, isNotFound } from "./api.ts";
import type { CloudflareApi } from "./api.ts";

/** One module of a Worker, as its bundle holds it. */
export interface WorkerModule {
  /** Its path in the bundle, such as `index.js`. */
  name: string;
  content: string | Uint8Array<ArrayBuffer>;
  /** Such as `application/javascript+module`, `text/plain` or `application/wasm`. */
  type: string;
}

/**
 * The upload's `metadata` part as the API takes it (`main_module`,
 * `compatibility_date`, `bindings`, `migrations`, `assets.config`, ...),
 * built from the release's wrangler config.
 */
export type WorkerMetadata = Record<string, unknown> & {
  main_module: string;
  assets?: Record<string, unknown>;
};

/** A static file the Worker serves through its assets binding. */
export interface AssetFile {
  /** Its URL path, such as `/index.html`. */
  path: string;
  content: Uint8Array<ArrayBuffer>;
  /** Its content type, such as `text/html`. */
  type: string;
}

/** What one Worker of a release is uploaded as. */
export interface WorkerUpload {
  /** The release it comes from: the version's `workers/tag`. */
  releaseId: string;
  metadata: WorkerMetadata;
  modules: readonly WorkerModule[];
  /** Its static files, if it serves any. */
  assets?: readonly AssetFile[];
}

const scriptPath = (accountId: string, scriptName: string) =>
  `/accounts/${accountId}/workers/scripts/${scriptName}`;

/** Bytes as base64, a chunk at a time: an asset can be megabytes. */
const toBase64 = (bytes: Uint8Array): string => {
  const chunk = 0x80_00;
  let binary = "";
  for (let start = 0; start < bytes.length; start += chunk) {
    binary += String.fromCodePoint(...bytes.subarray(start, start + chunk));
  }
  return btoa(binary);
};

/** An asset's hash, as Cloudflare's direct upload takes it: 32 hex characters. */
const assetHash = async (base64: string, path: string): Promise<string> => {
  const extension = /\.(?<extension>[^./]+)$/u.exec(path)?.groups?.extension;
  const hash = await sha256Hex(`${base64}${extension ?? ""}`);
  return hash.slice(0, 32);
};

const uploadSessionSchema = z.object({
  jwt: z.string(),
  /** The hashes it lacks, in groups to upload together. */
  buckets: z.array(z.array(z.string())).nullish(),
});
const uploadedSchema = z.object({ jwt: z.string().nullish() }).nullish();

/** Most asset buckets uploaded at once. */
const assetUploadConcurrency = 3;

/** Runs `task` on each of `items`, at most `limit` at a time, in order of results. */
const inBatches = async <T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>
): Promise<R[]> => {
  if (items.length === 0) {
    return [];
  }
  const batch = await Promise.all(items.slice(0, limit).map(task));
  return [...batch, ...(await inBatches(items.slice(limit), limit, task))];
};

/**
 * Uploads the files `scriptName`'s next version serves that the account
 * doesn't hold yet, and returns the token that version's metadata names
 * them by (`assets.jwt`).
 */
export const uploadAssets = async (
  api: CloudflareApi,
  accountId: string,
  scriptName: string,
  files: readonly AssetFile[]
): Promise<string> => {
  const encoded = await Promise.all(
    files.map(async (file) => {
      const base64 = toBase64(file.content);
      return { ...file, base64, hash: await assetHash(base64, file.path) };
    })
  );
  const session = await api.call(
    {
      method: "POST",
      path: `${scriptPath(accountId, scriptName)}/assets-upload-session`,
      json: {
        manifest: Object.fromEntries(
          encoded.map(({ path, hash, content }) => [
            path,
            { hash, size: content.byteLength },
          ])
        ),
      },
    },
    uploadSessionSchema
  );
  const buckets = session.buckets ?? [];
  if (buckets.length === 0) {
    // The account holds every file: the session's token completes it.
    return session.jwt;
  }
  const byHash = new Map(encoded.map((file) => [file.hash, file]));
  const uploads = await inBatches(
    buckets,
    assetUploadConcurrency,
    async (bucket) => {
      const form = new FormData();
      for (const hash of bucket) {
        // A hash it asks for that isn't ours goes unanswered, and the
        // upload then ends without a completion token.
        const file = byHash.get(hash);
        if (file !== undefined) {
          form.set(hash, new File([file.base64], hash, { type: file.type }));
        }
      }
      return await api.call(
        {
          method: "POST",
          path: `/accounts/${accountId}/workers/assets/upload`,
          query: { base64: "true" },
          body: form,
          bearer: session.jwt,
          // Files are named by their content's hash: sending a bucket again
          // stores the same files.
          idempotent: true,
        },
        uploadedSchema
      );
    }
  );
  // The upload that completes the set answers with the completion token.
  const completion = uploads.find(
    (uploaded) => typeof uploaded?.jwt === "string"
  );
  if (typeof completion?.jwt !== "string") {
    throw new TypeError(
      "The assets upload finished without a completion token"
    );
  }
  return completion.jwt;
};

/** A secret a version is uploaded with. */
export interface Secret {
  name: string;
  value: string;
}

/**
 * Bindings a new version keeps from the one before it, as Wrangler asks:
 * the secrets. Without this every version would start with none.
 */
const keptBindings = ["secret_text", "secret_key"];

/**
 * The upload's form: the metadata, then each module under its name. The
 * version keeps the previous one's secrets; `secrets` adds or replaces
 * some. Their values go only into this body.
 */
const uploadForm = async (
  api: CloudflareApi,
  accountId: string,
  scriptName: string,
  { releaseId, metadata, modules, assets }: WorkerUpload,
  secrets: readonly Secret[] = []
): Promise<FormData> => {
  const assetsJwt =
    assets === undefined
      ? undefined
      : await uploadAssets(api, accountId, scriptName, assets);
  const bindings: unknown[] = Array.isArray(metadata.bindings)
    ? metadata.bindings
    : [];
  const form = new FormData();
  form.set(
    "metadata",
    new Blob(
      [
        JSON.stringify({
          ...metadata,
          bindings: [
            ...bindings,
            ...secrets.map(({ name, value }) => ({
              type: "secret_text",
              name,
              text: value,
            })),
          ],
          keep_bindings: keptBindings,
          ...(assetsJwt === undefined
            ? {}
            : { assets: { ...metadata.assets, jwt: assetsJwt } }),
          annotations: {
            "workers/tag": releaseId,
            "workers/message": `Release ${releaseId}`,
          },
        }),
      ],
      { type: "application/json" }
    )
  );
  for (const { name, content, type } of modules) {
    form.set(name, new File([content], name, { type }));
  }
  return form;
};

const versionSchema = z.object({ id: z.string(), number: z.number() });
export type WorkerVersion = z.infer<typeof versionSchema>;

/**
 * Uploads a version of `scriptName` with `secrets` set, on top of the ones
 * it keeps, without deploying it: how a rollout changes secrets, so they go
 * live with the version's deployment and roll back with it.
 */
export const uploadVersionWithSecrets = async (
  api: CloudflareApi,
  accountId: string,
  scriptName: string,
  upload: WorkerUpload,
  secrets: readonly Secret[]
): Promise<WorkerVersion> =>
  await api.call(
    {
      method: "POST",
      path: `${scriptPath(accountId, scriptName)}/versions`,
      body: await uploadForm(api, accountId, scriptName, upload, secrets),
    },
    versionSchema
  );

/**
 * Uploads a version of `scriptName` without deploying it. It keeps the
 * secrets of the version before it.
 */
export const uploadVersion = async (
  api: CloudflareApi,
  accountId: string,
  scriptName: string,
  upload: WorkerUpload
): Promise<WorkerVersion> =>
  await uploadVersionWithSecrets(api, accountId, scriptName, upload, []);

/**
 * Uploads `scriptName` and deploys it at once: a Worker's first upload, or
 * a release with a Durable Object migration, which a version can't carry.
 *
 * Such a release isn't retried after a server error or no answer: if the
 * upload went through, its migration ran, and sending it again would be
 * refused on the migration's tag, or worse, apply it twice. The caller
 * reads the deployments to find out.
 */
export const uploadScript = async (
  api: CloudflareApi,
  accountId: string,
  scriptName: string,
  upload: WorkerUpload
): Promise<void> => {
  await api.call(
    {
      method: "PUT",
      path: scriptPath(accountId, scriptName),
      body: await uploadForm(api, accountId, scriptName, upload),
      idempotent: upload.metadata.migrations === undefined,
    },
    z.unknown()
  );
};

/**
 * Makes `scriptName` reachable on the account's workers.dev subdomain, or
 * not; its preview URLs stay off (each would serve an older version).
 */
export const setScriptSubdomain = async (
  api: CloudflareApi,
  accountId: string,
  scriptName: string,
  { enabled, previewsEnabled }: { enabled: boolean; previewsEnabled: false }
): Promise<void> => {
  await api.call(
    {
      method: "POST",
      path: `${scriptPath(accountId, scriptName)}/subdomain`,
      json: { enabled, previews_enabled: previewsEnabled },
    },
    z.unknown()
  );
};

const deploymentSchema = z.object({
  id: z.string(),
  created_on: z.string(),
  versions: z.array(
    z.object({ version_id: z.string(), percentage: z.number() })
  ),
});
export type WorkerDeployment = z.infer<typeof deploymentSchema>;

/**
 * Cloudflare's refusal of a deployment that would change the Worker's
 * secrets, such as a rollback to a version from before a secret changed.
 */
export const secretsWouldChangeCode = 10_220;

/** Whether `error` is Cloudflare refusing a deployment that would change secrets. */
export const isSecretsConflict = (error: unknown): boolean =>
  error instanceof CloudflareApiError &&
  error.codes.includes(secretsWouldChangeCode);

/**
 * Sends all of `scriptName`'s traffic to `versionId`, noting why. Secrets
 * belong to versions, so this deploys that version's secrets too: a
 * rollback reverts any secret changed since. Cloudflare refuses that
 * (`isSecretsConflict`) unless `force` says it's meant.
 */
export const deployVersion = async (
  api: CloudflareApi,
  accountId: string,
  scriptName: string,
  versionId: string,
  { message, force = false }: { message: string; force?: boolean }
): Promise<WorkerDeployment> =>
  await api.call(
    {
      method: "POST",
      path: `${scriptPath(accountId, scriptName)}/deployments`,
      ...(force ? { query: { force: "true" } } : {}),
      json: {
        strategy: "percentage",
        versions: [{ version_id: versionId, percentage: 100 }],
        annotations: { "workers/message": message },
      },
    },
    deploymentSchema
  );

/** `scriptName`'s deployments, the current one first. */
export const listDeployments = async (
  api: CloudflareApi,
  accountId: string,
  scriptName: string
): Promise<WorkerDeployment[]> => {
  const { deployments } = await api.call(
    {
      method: "GET",
      path: `${scriptPath(accountId, scriptName)}/deployments`,
    },
    z.object({ deployments: z.array(deploymentSchema) })
  );
  return deployments;
};

/**
 * Sets the secret `name` on `scriptName`, for first-time setup only. It
 * makes a new version from the latest one and deploys it at once, so
 * Cloudflare refuses it (10215) whenever the latest version isn't the one
 * deployed: while an uploaded version waits for its deployment, and after
 * any rollback. A rollout sets secrets with `uploadVersionWithSecrets`
 * instead. The value goes only into the request body: never into a path
 * or an error.
 */
export const putSecret = async (
  api: CloudflareApi,
  accountId: string,
  scriptName: string,
  secret: Secret
): Promise<void> => {
  await api.call(
    {
      method: "PUT",
      path: `${scriptPath(accountId, scriptName)}/secrets`,
      json: { name: secret.name, text: secret.value, type: "secret_text" },
    },
    z.unknown()
  );
};

/** The names of `scriptName`'s secrets: the API never returns their values. */
export const listSecretNames = async (
  api: CloudflareApi,
  accountId: string,
  scriptName: string
): Promise<string[]> => {
  const secrets = await api.call(
    { method: "GET", path: `${scriptPath(accountId, scriptName)}/secrets` },
    z.array(z.object({ name: z.string() }))
  );
  return secrets.map(({ name }) => name);
};

/**
 * Removes the secret `name` from `scriptName`, deploying a new version as
 * `putSecret` does. One that's already gone counts as removed, so a retried
 * step succeeds.
 */
export const deleteSecret = async (
  api: CloudflareApi,
  accountId: string,
  scriptName: string,
  name: string
): Promise<void> => {
  try {
    await api.call(
      {
        method: "DELETE",
        path: `${scriptPath(accountId, scriptName)}/secrets/${encodeURIComponent(name)}`,
      },
      z.unknown()
    );
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }
  }
};

/** Replaces `scriptName`'s cron triggers with `crons`. */
export const putSchedules = async (
  api: CloudflareApi,
  accountId: string,
  scriptName: string,
  crons: readonly string[]
): Promise<void> => {
  await api.call(
    {
      method: "PUT",
      path: `${scriptPath(accountId, scriptName)}/schedules`,
      json: crons.map((cron) => ({ cron })),
    },
    z.unknown()
  );
};

/** Creates or updates the Workflow `name`, run by `className` in `scriptName`. */
export const putWorkflow = async (
  api: CloudflareApi,
  accountId: string,
  name: string,
  { className, scriptName }: { className: string; scriptName: string }
): Promise<void> => {
  await api.call(
    {
      method: "PUT",
      path: `/accounts/${accountId}/workflows/${name}`,
      json: { class_name: className, script_name: scriptName },
    },
    z.unknown()
  );
};

const queryResultSchema = z.array(
  z.object({ results: z.array(z.record(z.string(), z.unknown())) })
);

/**
 * Runs `sql`, one or more statements, on the D1 database `databaseId` as
 * one request; returns each statement's rows.
 */
export const queryD1 = async (
  api: CloudflareApi,
  accountId: string,
  databaseId: string,
  sql: string
): Promise<Record<string, unknown>[][]> => {
  const statements = await api.call(
    {
      method: "POST",
      path: `/accounts/${accountId}/d1/database/${databaseId}/query`,
      json: { sql },
    },
    queryResultSchema
  );
  return statements.map(({ results }) => results);
};

/** A D1 migration: its file's name and SQL, as `readD1Migrations` reads them. */
export interface D1Migration {
  name: string;
  sql: string;
}

/** A SQL string literal of `text`. */
const sqlText = (text: string): string => `'${text.replaceAll("'", "''")}'`;

/**
 * Applies `pending` in order, each with its record in one query, stopping
 * at the first that fails.
 */
const applyInOrder = async (
  api: CloudflareApi,
  accountId: string,
  databaseId: string,
  pending: readonly D1Migration[]
): Promise<void> => {
  const [next, ...rest] = pending;
  if (next === undefined) {
    return;
  }
  await queryD1(
    api,
    accountId,
    databaseId,
    `${next.sql}\nINSERT INTO d1_migrations (name) VALUES (${sqlText(next.name)});`
  );
  await applyInOrder(api, accountId, databaseId, rest);
};

/**
 * Applies the migrations the database hasn't had, in order, and returns
 * their names. They're recorded as Wrangler records them (its
 * `d1_migrations` table), so the console and `wrangler d1 migrations`
 * agree on what was applied. Each migration and its record go in one
 * query, as Wrangler sends them; the API doesn't document such a query as
 * atomic, so a failure part way could leave a migration half applied and
 * unrecorded (threat model CO13). The first that fails stops the rest.
 */
export const applyD1Migrations = async (
  api: CloudflareApi,
  accountId: string,
  databaseId: string,
  migrations: readonly D1Migration[]
): Promise<string[]> => {
  const [, applied = []] = await queryD1(
    api,
    accountId,
    databaseId,
    "CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL); SELECT name FROM d1_migrations;"
  );
  const done = new Set(applied.map(({ name }) => name));
  const pending = migrations.filter(({ name }) => !done.has(name));
  await applyInOrder(api, accountId, databaseId, pending);
  return pending.map(({ name }) => name);
};
