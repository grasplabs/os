/**
 * What the fake Cloudflare API (test/cloudflare-api.ts) is built from: an
 * account's state, the API's envelope, and how a route answers.
 */
export const base = "https://api.cloudflare.com/client/v4";

export type Json = Record<string, unknown>;

/** A Worker script's modules and metadata, as one upload sent them. */
export interface UploadState {
  metadata: Json;
  modules: { name: string; type: string; content: string }[];
}

/** A version: its upload, and the secrets it runs with. */
export interface VersionState extends UploadState {
  id: string;
  number: number;
  /** Values by name: a test can check a secret arrived; the API never shows one. */
  secrets: Map<string, string>;
}

export interface DeploymentState {
  id: string;
  created_on: string;
  versions: { version_id: string; percentage: number }[];
  annotations: Json;
}

export interface ScriptState {
  /** Oldest first. */
  versions: VersionState[];
  /** The current deployment first. */
  deployments: DeploymentState[];
  schedules: string[];
  subdomain?: { enabled: boolean; previews_enabled: boolean };
}

export interface AccountState {
  id: string;
  name: string;
  subdomain?: string;
  d1: { uuid: string; name: string; jurisdiction?: string }[];
  /** Buckets by jurisdiction: a name is unique only within one. */
  buckets: { name: string; jurisdiction: string }[];
  /**
   * The jurisdiction R2 reports for every bucket, whatever it's in: a test
   * of an API that answers other than asked.
   */
  r2Reports?: string;
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

export const envelope = (result: unknown, resultInfo?: Json): Response =>
  Response.json({
    success: true,
    errors: [],
    messages: [],
    result,
    ...(resultInfo === undefined ? {} : { result_info: resultInfo }),
  });

export const refusal = (
  status: number,
  code: number,
  message: string
): Response =>
  Response.json(
    { success: false, errors: [{ code, message }], messages: [], result: null },
    { status }
  );

export const notFound = (): Response => refusal(404, 10_007, "Not found");

/** One page of `items`, as the API pages its lists. */
export const paged = (
  items: readonly unknown[],
  query: URLSearchParams
): Response => {
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

export const text = (body: Json, key: string): string => {
  const value = body[key];
  return typeof value === "string" ? value : "";
};

/** What a route gets: the account, the call, its path's named parts and its JSON body. */
export interface RouteInput {
  account: AccountState;
  call: ApiCall;
  params: Record<string, string>;
  json: Json;
}

export interface Route {
  method: string;
  /** Matched against the path below `/accounts/<id>`. */
  path: RegExp;
  /** Authorized by an assets upload session's token, not the account's. */
  session?: boolean;
  answer: (input: RouteInput) => Response | Promise<Response>;
}
