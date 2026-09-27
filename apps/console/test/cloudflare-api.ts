/**
 * A stand-in for the Cloudflare REST API: it answers at the real URLs, in
 * the API's envelope, and keeps what each account holds, so the console's
 * client runs unchanged against it. Only the token it was made with gets
 * in, and only to the accounts it holds. A test can plan failures (the
 * Nth call answers 429 or 500) and read every call it got.
 *
 * It replaces `fetch` in the tests' isolate, which is also where the
 * console's Workflow steps run.
 */
import { afterEach, beforeEach, vi } from "vite-plus/test";

const base = "https://api.cloudflare.com/client/v4";

type Json = Record<string, unknown>;

interface AccountState {
  id: string;
  name: string;
  subdomain?: string;
  d1: { uuid: string; name: string; jurisdiction?: string }[];
  /** Buckets by jurisdiction: a name is unique only within one. */
  buckets: { name: string; jurisdiction: string }[];
  namespaces: { id: string; title: string }[];
  gateways: Json[];
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
  answer: (input: RouteInput) => Response;
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
    path: /^\/storage\/kv\/namespaces$/u,
    answer: ({ account, call }) => paged(account.namespaces, call.query),
  },
  {
    method: "POST",
    path: /^\/storage\/kv\/namespaces$/u,
    answer: ({ account, json }) => {
      const namespace = { id: crypto.randomUUID(), title: text(json, "title") };
      account.namespaces.push(namespace);
      return envelope(namespace);
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
      account.gateways.push(json);
      return envelope(json);
    },
  },
];

/** Answers a call to one of `account`'s resources: `rest` is the path below it. */
const routeAccount = (
  account: AccountState,
  call: ApiCall,
  rest: string
): Response => {
  const json: Json =
    typeof call.body === "object" && call.body !== null ? { ...call.body } : {};
  for (const route of routes) {
    const match = route.method === call.method ? route.path.exec(rest) : null;
    if (match !== null) {
      return route.answer({ account, call, params: { ...match.groups }, json });
    }
  }
  return notFound();
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
    if (request.headers.get("authorization") !== `Bearer ${token}`) {
      return refusal(403, 10_000, "Authentication error");
    }
    if (call.path === "/accounts" && call.method === "GET") {
      return paged(
        [...accounts.values()].map(({ id, name }) => ({ id, name })),
        call.query
      );
    }
    const match = accountRoute.exec(call.path)?.groups;
    const account = accounts.get(match?.id ?? "");
    if (account === undefined) {
      return refusal(403, 9109, "Unauthorized to access requested resource");
    }
    return routeAccount(account, call, match?.rest ?? "");
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
        namespaces: [],
        gateways: [],
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
