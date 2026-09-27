/**
 * A stand-in for the Cloudflare REST API: it answers at the real URLs, in
 * the API's envelope, and keeps what each account holds, so the console's
 * client runs unchanged against it. Only the token it was made with gets
 * in, and only to the accounts it holds. A test can plan failures (the
 * Nth call answers 429 or 500) and read every call it got.
 *
 * It replaces `fetch` in the tests' isolate, which is also where the
 * console's Workflow steps run. D1 queries run on a real D1 database, one
 * for every account's databases (`CLIENT_D1`, vite.test.config.ts).
 */
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, vi } from "vite-plus/test";
import { z } from "zod";

const base = "https://api.cloudflare.com/client/v4";

type Json = Record<string, unknown>;

interface AccountState {
  id: string;
  name: string;
  subdomain?: string;
  d1: { uuid: string; name: string; jurisdiction?: string }[];
  /** Buckets by jurisdiction: a name is unique only within one. */
  buckets: { name: string; jurisdiction: string }[];
  gateways: Json[];
  scripts: Map<string, ScriptState>;
  workflows: Map<string, { class_name: string; script_name: string }>;
  /** The hashes of the static files the account holds. */
  assets: Set<string>;
  /** Assets upload sessions: each token, and the hashes still to upload. */
  sessions: Map<string, Set<string>>;
  /** Assets completion tokens it issued. */
  completions: Set<string>;
}

/** A call the fake got. */
export interface ApiCall {
  method: string;
  /** Below the API base, without the query. */
  path: string;
  query: URLSearchParams;
  headers: Headers;
  body: unknown;
}

const envelope = (result: unknown, resultInfo?: Json): Response =>
  Response.json({
    success: true,
    errors: [],
    messages: [],
    result,
    ...(resultInfo === undefined ? {} : { result_info: resultInfo }),
  });

const refusal = (status: number, code: number, message: string): Response =>
  Response.json(
    { success: false, errors: [{ code, message }], messages: [], result: null },
    { status }
  );

const notFound = (): Response => refusal(404, 10_007, "Not found");

/** One page of `items`, as the API pages its lists. */
const paged = (items: readonly unknown[], query: URLSearchParams): Response => {
  const page = Number(query.get("page") ?? "1");
  const perPage = Number(query.get("per_page") ?? "20");
  const slice = items.slice((page - 1) * perPage, page * perPage);
  return envelope(slice, {
    page,
    per_page: perPage,
    count: slice.length,
    total_count: items.length,
  });
};

const text = (body: Json, key: string): string => {
  const value = body[key];
  return typeof value === "string" ? value : "";
};

/** A Worker script's modules and metadata, as one upload sent them. */
interface UploadState {
  metadata: Json;
  modules: { name: string; type: string; content: string }[];
}

interface VersionState extends UploadState {
  id: string;
  number: number;
}

interface DeploymentState {
  id: string;
  created_on: string;
  versions: { version_id: string; percentage: number }[];
  annotations: Json;
}

interface ScriptState {
  versions: VersionState[];
  /** The current deployment first. */
  deployments: DeploymentState[];
  /** Values by name: a test can check a secret arrived, the API never shows it. */
  secrets: Map<string, string>;
  schedules: string[];
}

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

const newVersion = (script: ScriptState, upload: UploadState): VersionState => {
  const version = {
    ...upload,
    id: crypto.randomUUID(),
    number: script.versions.length + 1,
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

/** The script a route names, or the API's refusal. */
const scriptOf = (
  account: AccountState,
  params: Record<string, string>
): ScriptState | Response =>
  account.scripts.get(params.script ?? "") ??
  refusal(404, 10_007, "This Worker does not exist on your account.");

/** Splits `sql` into statements at semicolons outside string literals. */
const statementsOf = (sql: string): string[] =>
  (sql.match(/(?:[^;']|'[^']*')+/gu) ?? [])
    .map((statement) => statement.trim())
    .filter(
      (statement) => statement !== "" && !/^(?:--[^\n]*\s*)+$/u.test(statement)
    );

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

/** What a route gets: the account, the call, its path's named parts and its JSON body. */
interface RouteInput {
  account: AccountState;
  call: ApiCall;
  params: Record<string, string>;
  json: Json;
}

interface Route {
  method: string;
  /** Matched against the path below `/accounts/<id>`. */
  path: RegExp;
  /** Authorized by an assets upload session's token, not the account's. */
  session?: boolean;
  answer: (input: RouteInput) => Response | Promise<Response>;
}

/** The R2 jurisdiction a call names, as the API reads its header. */
const jurisdictionOf = (call: ApiCall): string =>
  call.headers.get("cf-r2-jurisdiction") ?? "default";

const subdomainOf = (account: AccountState): Response =>
  account.subdomain === undefined
    ? notFound()
    : envelope({ subdomain: account.subdomain });

/** What each account holds, at the paths the API serves it. */
const routes: Route[] = [
  {
    method: "GET",
    path: /^$/u,
    answer: ({ account }) => envelope({ id: account.id, name: account.name }),
  },
  {
    method: "GET",
    path: /^\/workers\/subdomain$/u,
    answer: ({ account }) => subdomainOf(account),
  },
  {
    method: "PUT",
    path: /^\/workers\/subdomain$/u,
    answer: ({ account, json }) => {
      account.subdomain = text(json, "subdomain");
      return subdomainOf(account);
    },
  },
  {
    method: "GET",
    path: /^\/d1\/database$/u,
    // The API matches `name` as a substring.
    answer: ({ account, call }) => {
      const name = call.query.get("name") ?? "";
      return paged(
        account.d1.filter((database) => database.name.includes(name)),
        call.query
      );
    },
  },
  {
    method: "POST",
    path: /^\/d1\/database$/u,
    answer: ({ account, json }) => {
      const jurisdiction = text(json, "jurisdiction");
      const database = {
        uuid: crypto.randomUUID(),
        name: text(json, "name"),
        ...(jurisdiction === "" ? {} : { jurisdiction }),
      };
      account.d1.push(database);
      return envelope(database);
    },
  },
  {
    method: "GET",
    path: /^\/r2\/buckets\/(?<name>[^/]+)$/u,
    answer: ({ account, call, params }) => {
      const bucket = account.buckets.find(
        ({ name, jurisdiction }) =>
          name === params.name && jurisdiction === jurisdictionOf(call)
      );
      return bucket === undefined ? notFound() : envelope(bucket);
    },
  },
  {
    method: "POST",
    path: /^\/r2\/buckets$/u,
    answer: ({ account, call, json }) => {
      const bucket = {
        name: text(json, "name"),
        jurisdiction: jurisdictionOf(call),
      };
      account.buckets.push(bucket);
      return envelope(bucket);
    },
  },
  {
    method: "GET",
    path: /^\/ai-gateway\/gateways\/(?<id>[^/]+)$/u,
    answer: ({ account, params }) => {
      const gateway = account.gateways.find(({ id }) => id === params.id);
      return gateway === undefined ? notFound() : envelope(gateway);
    },
  },
  {
    method: "POST",
    path: /^\/ai-gateway\/gateways$/u,
    answer: ({ account, json }) => {
      const gateway = { authentication: false, ...json };
      account.gateways.push(gateway);
      return envelope(gateway);
    },
  },
  {
    method: "PUT",
    path: /^\/ai-gateway\/gateways\/(?<id>[^/]+)$/u,
    answer: ({ account, params, json }) => {
      const index = account.gateways.findIndex(({ id }) => id === params.id);
      if (index === -1) {
        return notFound();
      }
      // An update replaces the gateway's settings, as the API does.
      const gateway = { id: params.id, authentication: false, ...json };
      account.gateways[index] = gateway;
      return envelope(gateway);
    },
  },
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
        secrets: new Map(),
        schedules: [],
      };
      account.scripts.set(name, script);
      const version = newVersion(script, upload);
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
      const { id, number } = newVersion(script, upload);
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
    answer: ({ account, params, json }) => {
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
      script.secrets.set(name, text(json, "text"));
      return envelope({ name, type: "secret_text" });
    },
  },
  {
    method: "GET",
    path: /^\/workers\/scripts\/(?<script>[^/]+)\/secrets$/u,
    answer: ({ account, params }) => {
      const script = scriptOf(account, params);
      return script instanceof Response
        ? script
        : envelope(
            [...script.secrets.keys()].map((name) => ({
              name,
              type: "secret_text",
            }))
          );
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
      return script.secrets.delete(decodeURIComponent(params.name ?? ""))
        ? envelope(null)
        : notFound();
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
          statementsOf(text(json, "sql")).map((statement) =>
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

/** The route that serves `call`, with its path's named parts. */
const routeOf = (
  call: ApiCall,
  rest: string
): { route: Route; params: Record<string, string> } | null => {
  for (const route of routes) {
    const match = route.method === call.method ? route.path.exec(rest) : null;
    if (match !== null) {
      return { route, params: { ...match.groups } };
    }
  }
  return null;
};

/**
 * How a planned call fails: rate-limited (429), a server error in the
 * envelope (500, 503), the edge's HTML error page (502), or no answer.
 */
export type Failure = 429 | 500 | 502 | 503 | "network";

const failed = (failure: Failure): Response => {
  if (failure === "network") {
    throw new TypeError("Network connection lost.");
  }
  if (failure === 502) {
    return new Response("<html>Bad gateway</html>", {
      status: 502,
      headers: { "content-type": "text/html" },
    });
  }
  return failure === 429
    ? refusal(
        429,
        971,
        "Please wait and consider throttling your request speed"
      )
    : refusal(failure, 10_000, "Internal error");
};

const accountRoute = /^\/accounts\/(?<id>[^/]+)(?<rest>\/.*)?$/u;

/** A call's body: JSON parsed, form data as such, anything else as text. */
const readBody = async (request: Request): Promise<unknown> => {
  const type = request.headers.get("content-type") ?? "";
  if (type.startsWith("application/json")) {
    return await request.json();
  }
  if (type.startsWith("multipart/form-data")) {
    return await request.formData();
  }
  return request.body === null ? undefined : await request.text();
};

/**
 * A fake Cloudflare API that lets `token` in, for each test in the file.
 * Add accounts with `addAccount`; plan failures with `failCall`.
 */
export const mockCloudflareApi = (token: string) => {
  const accounts = new Map<string, AccountState>();
  const calls: ApiCall[] = [];
  const planned = new Map<number, Failure>();

  const answer = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const call: ApiCall = {
      method: request.method,
      path: url.pathname.slice(new URL(base).pathname.length),
      query: url.searchParams,
      headers: request.headers,
      body: await readBody(request),
    };
    calls.push(call);
    const failure = planned.get(calls.length);
    if (failure !== undefined) {
      return failed(failure);
    }
    const authorized =
      request.headers.get("authorization") === `Bearer ${token}`;
    if (call.path === "/accounts" && call.method === "GET") {
      if (!authorized) {
        return refusal(403, 10_000, "Authentication error");
      }
      return paged(
        [...accounts.values()].map(({ id, name }) => ({ id, name })),
        call.query
      );
    }
    const match = accountRoute.exec(call.path)?.groups;
    const found = routeOf(call, match?.rest ?? "");
    // An upload session's token opens its upload, and nothing else; the
    // account's token doesn't open the upload.
    if (found?.route.session === true ? authorized : !authorized) {
      return refusal(403, 10_000, "Authentication error");
    }
    const account = accounts.get(match?.id ?? "");
    if (account === undefined) {
      return refusal(403, 9109, "Unauthorized to access requested resource");
    }
    if (found === null) {
      // As the API answers a path it doesn't serve.
      return refusal(400, 7003, "No route for the URI");
    }
    const json: Json =
      typeof call.body === "object" && call.body !== null
        ? { ...call.body }
        : {};
    return await found.route.answer({
      account,
      call,
      params: found.params,
      json,
    });
  };

  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      if (!request.url.startsWith(`${base}/`)) {
        throw new Error(`Unexpected outbound request to ${request.url}`);
      }
      return await answer(request);
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    accounts.clear();
    calls.length = 0;
    planned.clear();
  });

  return {
    /** Every call the fake got in this test, in order. */
    calls,
    /** Adds an account the token is a member of, and returns what it holds. */
    addAccount: (name = "Client"): AccountState => {
      const account: AccountState = {
        id: crypto.randomUUID().replaceAll("-", ""),
        name,
        d1: [],
        buckets: [],
        gateways: [],
        scripts: new Map(),
        workflows: new Map(),
        assets: new Set(),
        sessions: new Map(),
        completions: new Set(),
      };
      accounts.set(account.id, account);
      return account;
    },
    /** Fails the `n`th call from now as `failure` says, whatever it asks. */
    failCall: (n: number, failure: Failure) => {
      planned.set(calls.length + n, failure);
    },
  };
};
