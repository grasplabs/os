/**
 * The fake Cloudflare API's Worker routes (test/cloudflare-api.ts):
 * scripts, versions, deployments, assets, secrets, schedules, Workflows and
 * D1 queries.
 */
import { env } from "cloudflare:workers";
import { z } from "zod";

import { envelope, notFound, refusal, text } from "./cloudflare-api-kit.ts";
import type {
  AccountState,
  DeploymentState,
  Json,
  Route,
  ScriptState,
  UploadState,
  VersionState,
} from "./cloudflare-api-kit.ts";
import { sqlStatements } from "./sql-statements.ts";

/** Why an upload is refused, or what it uploaded. */
const readUpload = async (
  account: AccountState,
  form: unknown
): Promise<UploadState | Response> => {
  if (!(form instanceof FormData)) {
    return refusal(400, 10_000, "Expected multipart form data");
  }
  const metadataPart = form.get("metadata");
  if (!(metadataPart instanceof Blob)) {
    return refusal(400, 10_000, "Missing metadata part");
  }
  const metadata = z
    .record(z.string(), z.unknown())
    .parse(JSON.parse(await metadataPart.text()));
  const modules = await Promise.all(
    [...form.entries()]
      .filter(([name]) => name !== "metadata")
      .map(async ([name, part]) => ({
        name,
        type: part instanceof Blob ? part.type : "",
        content: part instanceof Blob ? await part.text() : part,
      }))
  );
  if (!modules.some(({ name }) => name === metadata.main_module)) {
    return refusal(400, 10_021, "No such module: the main module");
  }
  const assets = z
    .object({ jwt: z.string().optional() })
    .optional()
    .parse(metadata.assets);
  if (assets?.jwt !== undefined && !account.completions.has(assets.jwt)) {
    return refusal(400, 10_000, "Invalid assets completion token");
  }
  return { metadata, modules };
};

const bindingsSchema = z
  .array(z.object({ type: z.string(), name: z.string() }).loose())
  .default([]);

/**
 * The secrets an upload's version runs with: the latest version's, only if
 * it keeps them (`keep_bindings`), then the ones its bindings set.
 */
const secretsOf = (script: ScriptState, { metadata }: UploadState) => {
  const kept = z.array(z.string()).default([]).parse(metadata.keep_bindings);
  const secrets = new Map(
    kept.includes("secret_text") ? script.versions.at(-1)?.secrets : []
  );
  for (const binding of bindingsSchema.parse(metadata.bindings)) {
    if (binding.type === "secret_text") {
      secrets.set(
        binding.name,
        typeof binding.text === "string" ? binding.text : ""
      );
    }
  }
  return secrets;
};

const newVersion = (
  script: ScriptState,
  upload: UploadState,
  secrets: Map<string, string>
): VersionState => {
  const version = {
    ...upload,
    id: crypto.randomUUID(),
    number: script.versions.length + 1,
    secrets,
  };
  script.versions.push(version);
  return version;
};

const deploy = (
  script: ScriptState,
  versions: DeploymentState["versions"],
  annotations: Json
): DeploymentState => {
  const deployment = {
    id: crypto.randomUUID(),
    created_on: new Date().toISOString(),
    versions,
    annotations,
  };
  script.deployments.unshift(deployment);
  return deployment;
};

/** The version all of `script`'s traffic goes to, if one does. */
const deployedVersion = (script: ScriptState): VersionState | undefined => {
  const [only] = script.deployments[0]?.versions ?? [];
  return script.versions.find(({ id }) => id === only?.version_id);
};

const sameSecrets = (a: Map<string, string>, b: Map<string, string>) =>
  a.size === b.size && [...a].every(([name, value]) => b.get(name) === value);

/**
 * Changes `script`'s secrets as the API does: on a new version made from
 * the latest one and deployed at once, refused while the latest isn't the
 * one deployed (an uploaded version waiting for its deployment).
 */
const changeSecrets = (
  script: ScriptState,
  change: (secrets: Map<string, string>) => void
): Response | undefined => {
  const latest = script.versions.at(-1);
  if (latest === undefined || deployedVersion(script) !== latest) {
    return refusal(
      400,
      10_215,
      "Secret edit failed. You attempted to modify a secret, but the latest version of your Worker isn't currently deployed."
    );
  }
  const secrets = new Map(latest.secrets);
  change(secrets);
  const version = newVersion(script, latest, secrets);
  deploy(script, [{ version_id: version.id, percentage: 100 }], {});
  return undefined;
};

/** The script a route names, or the API's refusal. */
const scriptOf = (
  account: AccountState,
  params: Record<string, string>
): ScriptState | Response =>
  account.scripts.get(params.script ?? "") ??
  refusal(404, 10_007, "This Worker does not exist on your account.");

const isDatabase = (value: unknown): value is D1Database =>
  typeof value === "object" &&
  value !== null &&
  "prepare" in value &&
  "batch" in value;

/** Where the fake keeps every account's D1 data: one real D1 for all. */
const clientD1 = (): D1Database => {
  const database: unknown = Reflect.get(env, "CLIENT_D1");
  if (!isDatabase(database)) {
    throw new TypeError("Expected the fake's D1 database as CLIENT_D1");
  }
  return database;
};

export const workerRoutes: Route[] = [
  {
    method: "PUT",
    path: /^\/workers\/scripts\/(?<script>[^/]+)$/u,
    answer: async ({ account, call, params }) => {
      const upload = await readUpload(account, call.body);
      if (upload instanceof Response) {
        return upload;
      }
      const name = params.script ?? "";
      const script = account.scripts.get(name) ?? {
        versions: [],
        deployments: [],
        schedules: [],
      };
      account.scripts.set(name, script);
      const version = newVersion(script, upload, secretsOf(script, upload));
      deploy(script, [{ version_id: version.id, percentage: 100 }], {});
      return envelope({ id: name });
    },
  },
  {
    method: "POST",
    path: /^\/workers\/scripts\/(?<script>[^/]+)\/versions$/u,
    answer: async ({ account, call, params }) => {
      const script = scriptOf(account, params);
      if (script instanceof Response) {
        return script;
      }
      const upload = await readUpload(account, call.body);
      if (upload instanceof Response) {
        return upload;
      }
      const { id, number } = newVersion(
        script,
        upload,
        secretsOf(script, upload)
      );
      return envelope({ id, number });
    },
  },
  {
    method: "GET",
    path: /^\/workers\/scripts\/(?<script>[^/]+)\/deployments$/u,
    answer: ({ account, params }) => {
      const script = scriptOf(account, params);
      return script instanceof Response
        ? script
        : envelope({ deployments: script.deployments });
    },
  },
  {
    method: "POST",
    path: /^\/workers\/scripts\/(?<script>[^/]+)\/deployments$/u,
    answer: ({ account, call, params, json }) => {
      const script = scriptOf(account, params);
      if (script instanceof Response) {
        return script;
      }
      const { versions, annotations } = z
        .object({
          strategy: z.literal("percentage"),
          versions: z.array(
            z.object({ version_id: z.string(), percentage: z.number() })
          ),
          annotations: z.record(z.string(), z.unknown()).default({}),
        })
        .parse(json);
      const total = versions.reduce(
        (sum, { percentage }) => sum + percentage,
        0
      );
      const known = versions.every(({ version_id }) =>
        script.versions.some(({ id }) => id === version_id)
      );
      if (total !== 100 || !known) {
        return refusal(400, 10_000, "Invalid deployment");
      }
      // Going back to a version from before a secret changed would revert
      // it: refused unless forced.
      const current = deployedVersion(script);
      const target = script.versions.find(
        ({ id }) => id === versions[0]?.version_id
      );
      const reverts =
        current !== undefined &&
        target !== undefined &&
        target.number < current.number &&
        !sameSecrets(target.secrets, current.secrets);
      if (reverts && call.query.get("force") !== "true") {
        return refusal(
          400,
          10_220,
          "This deployment would change the Worker's secrets; deploy with force to go ahead"
        );
      }
      return envelope(deploy(script, versions, annotations));
    },
  },
  {
    method: "POST",
    path: /^\/workers\/scripts\/(?<script>[^/]+)\/assets-upload-session$/u,
    answer: ({ account, json }) => {
      const { manifest } = z
        .object({
          manifest: z.record(
            z.string(),
            z.object({ hash: z.string(), size: z.number() })
          ),
        })
        .parse(json);
      const missing = [
        ...new Set(
          Object.values(manifest)
            .map(({ hash }) => hash)
            .filter((hash) => !account.assets.has(hash))
        ),
      ];
      const jwt = `assets-${crypto.randomUUID()}`;
      if (missing.length === 0) {
        account.completions.add(jwt);
        return envelope({ jwt, buckets: [] });
      }
      account.sessions.set(jwt, new Set(missing));
      // Two files a bucket, so an upload takes several.
      const buckets = Array.from(
        { length: Math.ceil(missing.length / 2) },
        (_, index) => missing.slice(index * 2, index * 2 + 2)
      );
      return envelope({ jwt, buckets });
    },
  },
  {
    method: "POST",
    path: /^\/workers\/assets\/upload$/u,
    session: true,
    answer: ({ account, call }) => {
      const jwt = (call.headers.get("authorization") ?? "").replace(
        /^Bearer /u,
        ""
      );
      const pending = account.sessions.get(jwt);
      if (
        pending === undefined ||
        call.query.get("base64") !== "true" ||
        !(call.body instanceof FormData)
      ) {
        return refusal(400, 10_000, "Invalid upload");
      }
      for (const [hash, part] of call.body.entries()) {
        if (part instanceof Blob && pending.delete(hash)) {
          account.assets.add(hash);
        }
      }
      if (pending.size > 0) {
        return Response.json(
          { success: true, errors: [], messages: [], result: { jwt: null } },
          { status: 202 }
        );
      }
      account.sessions.delete(jwt);
      const completion = `complete-${crypto.randomUUID()}`;
      account.completions.add(completion);
      return Response.json(
        {
          success: true,
          errors: [],
          messages: [],
          result: { jwt: completion },
        },
        { status: 201 }
      );
    },
  },
  {
    method: "PUT",
    path: /^\/workers\/scripts\/(?<script>[^/]+)\/secrets$/u,
    answer: ({ account, params, json }) => {
      const script = scriptOf(account, params);
      if (script instanceof Response) {
        return script;
      }
      const name = text(json, "name");
      return (
        changeSecrets(script, (secrets) => {
          secrets.set(name, text(json, "text"));
        }) ?? envelope({ name, type: "secret_text" })
      );
    },
  },
  {
    method: "GET",
    path: /^\/workers\/scripts\/(?<script>[^/]+)\/secrets$/u,
    answer: ({ account, params }) => {
      const script = scriptOf(account, params);
      if (script instanceof Response) {
        return script;
      }
      const names = [...(script.versions.at(-1)?.secrets.keys() ?? [])];
      return envelope(names.map((name) => ({ name, type: "secret_text" })));
    },
  },
  {
    method: "DELETE",
    path: /^\/workers\/scripts\/(?<script>[^/]+)\/secrets\/(?<name>[^/]+)$/u,
    answer: ({ account, params }) => {
      const script = scriptOf(account, params);
      if (script instanceof Response) {
        return script;
      }
      const name = decodeURIComponent(params.name ?? "");
      if (script.versions.at(-1)?.secrets.has(name) !== true) {
        return notFound();
      }
      return (
        changeSecrets(script, (secrets) => {
          secrets.delete(name);
        }) ?? envelope(null)
      );
    },
  },
  {
    method: "POST",
    path: /^\/workers\/scripts\/(?<script>[^/]+)\/subdomain$/u,
    answer: ({ account, params, json }) => {
      const script = scriptOf(account, params);
      if (script instanceof Response) {
        return script;
      }
      script.subdomain = z
        .object({ enabled: z.boolean(), previews_enabled: z.boolean() })
        .parse(json);
      return envelope(script.subdomain);
    },
  },
  {
    method: "PUT",
    path: /^\/workers\/scripts\/(?<script>[^/]+)\/schedules$/u,
    answer: ({ account, params, call }) => {
      const script = scriptOf(account, params);
      if (script instanceof Response) {
        return script;
      }
      script.schedules = z
        .array(z.object({ cron: z.string() }))
        .parse(call.body)
        .map(({ cron }) => cron);
      return envelope({
        schedules: script.schedules.map((cron) => ({ cron })),
      });
    },
  },
  {
    method: "PUT",
    path: /^\/workflows\/(?<name>[^/]+)$/u,
    answer: ({ account, params, json }) => {
      const workflow = {
        class_name: text(json, "class_name"),
        script_name: text(json, "script_name"),
      };
      account.workflows.set(params.name ?? "", workflow);
      return envelope({
        id: crypto.randomUUID(),
        name: params.name,
        ...workflow,
      });
    },
  },
  {
    method: "POST",
    path: /^\/d1\/database\/(?<database>[^/]+)\/query$/u,
    answer: async ({ account, params, json }) => {
      if (!account.d1.some(({ uuid }) => uuid === params.database)) {
        return notFound();
      }
      const d1 = clientD1();
      try {
        const results = await d1.batch(
          sqlStatements(text(json, "sql")).map((statement) =>
            d1.prepare(statement)
          )
        );
        return envelope(
          results.map(({ results: rows }) => ({
            results: rows,
            success: true,
            meta: {},
          }))
        );
      } catch (error) {
        return refusal(
          400,
          7500,
          error instanceof Error ? error.message : "D1 error"
        );
      }
    },
  },
];
