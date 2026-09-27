/**
 * Deploying a release's Workers to a client account: uploading a version
 * (with its static assets), pointing a deployment at it, and what goes
 * with it (secrets, cron schedules, workflows, D1 migrations).
 *
 * A deploy uploads a version, then sends all traffic to it in one
 * deployment; rolling back is a deployment back to the previous version.
 * A Worker's first upload, and a release that adds a Durable Object
 * migration, go as a script upload instead, which deploys at once.
 */
import { sha256Hex } from "@grasp-os/shared/encoding";
import { z } from "zod";

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
  const uploads = await Promise.all(
    buckets.map(async (bucket) => {
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
        },
        uploadedSchema
      );
    })
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

/** The upload's form: the metadata, then each module under its name. */
const uploadForm = async (
  api: CloudflareApi,
  accountId: string,
  scriptName: string,
  { releaseId, metadata, modules, assets }: WorkerUpload
): Promise<FormData> => {
  const assetsJwt =
    assets === undefined
      ? undefined
      : await uploadAssets(api, accountId, scriptName, assets);
  const form = new FormData();
  form.set(
    "metadata",
    new Blob(
      [
        JSON.stringify({
          ...metadata,
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

/** Uploads a version of `scriptName` without deploying it. */
export const uploadVersion = async (
  api: CloudflareApi,
  accountId: string,
  scriptName: string,
  upload: WorkerUpload
): Promise<WorkerVersion> =>
  await api.call(
    {
      method: "POST",
      path: `${scriptPath(accountId, scriptName)}/versions`,
      body: await uploadForm(api, accountId, scriptName, upload),
    },
    versionSchema
  );

/**
 * Uploads `scriptName` and deploys it at once: a Worker's first upload, or
 * a release with a Durable Object migration, which a version can't carry.
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

/** Sends all of `scriptName`'s traffic to `versionId`, noting why. */
export const deployVersion = async (
  api: CloudflareApi,
  accountId: string,
  scriptName: string,
  versionId: string,
  message: string
): Promise<WorkerDeployment> =>
  await api.call(
    {
      method: "POST",
      path: `${scriptPath(accountId, scriptName)}/deployments`,
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
 * Sets the secret `name` on `scriptName`, which deploys it at once. The
 * value goes only into the request body: never into a path or an error.
 */
export const putSecret = async (
  api: CloudflareApi,
  accountId: string,
  scriptName: string,
  secret: { name: string; value: string }
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

/** Removes the secret `name` from `scriptName`. */
export const deleteSecret = async (
  api: CloudflareApi,
  accountId: string,
  scriptName: string,
  name: string
): Promise<void> => {
  await api.call(
    {
      method: "DELETE",
      path: `${scriptPath(accountId, scriptName)}/secrets/${encodeURIComponent(name)}`,
    },
    z.unknown()
  );
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
 * one batch; returns each statement's rows.
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
 * Applies `pending` in order, each with its record in one query (one
 * transaction), stopping at the first that fails.
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
 * `d1_migrations` table, each migration and its record in one query), so
 * the console and `wrangler d1 migrations` agree on what was applied.
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
