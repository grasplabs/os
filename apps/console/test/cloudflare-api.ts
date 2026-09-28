/**
 * A stand-in for the Cloudflare REST API: it answers at the real URLs, in
 * the API's envelope, and keeps what each account holds, so the console's
 * client runs unchanged against it. Only the token it was made with gets
 * in, and only to the accounts it holds. A test can plan failures (the
 * Nth call answers 429 or 500) and read every call it got.
 *
 * It replaces `fetch` in the tests' isolate, which is also where the
 * console's Workflow steps run. D1 queries run on real D1 databases, one
 * for each database the fake holds at once (`CLIENT_D1_<n>`,
 * vite.test.config.ts).
 */
import { afterEach, beforeEach, vi } from "vite-plus/test";

import {
  base,
  envelope,
  notFound,
  paged,
  refusal,
  text,
} from "./cloudflare-api-kit.ts";
import type {
  AccountState,
  ApiCall,
  Json,
  Route,
} from "./cloudflare-api-kit.ts";
import { forgetDatabases, workerRoutes } from "./cloudflare-api-workers.ts";

/** The R2 jurisdiction a call names, as the API reads its header. */
const jurisdictionOf = (call: ApiCall): string =>
  call.headers.get("cf-r2-jurisdiction") ?? "default";

const subdomainOf = (account: AccountState): Response =>
  account.subdomain === undefined
    ? notFound()
    : envelope({ subdomain: account.subdomain });

/**
 * The workers.dev subdomains taken across Cloudflare: a subdomain is one
 * account's only.
 */
const takenSubdomains = new Set<string>();

/** What each account holds, at the paths the API serves it. */
const accountRoutes: Route[] = [
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
      const wanted = text(json, "subdomain");
      if (takenSubdomains.has(wanted) && account.subdomain !== wanted) {
        return refusal(400, 10_031, "Subdomain is unavailable");
      }
      takenSubdomains.add(wanted);
      account.subdomain = wanted;
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
      const jurisdiction = account.d1Reports ?? text(json, "jurisdiction");
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
      return bucket === undefined
        ? notFound()
        : envelope({
            name: bucket.name,
            jurisdiction: account.r2Reports ?? bucket.jurisdiction,
          });
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
      return envelope({
        ...bucket,
        jurisdiction: account.r2Reports ?? bucket.jurisdiction,
      });
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
];

const routes = [...accountRoutes, ...workerRoutes];

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
 * How a planned call fails: rate-limited (429, optionally with a
 * `Retry-After`), a server error in the envelope (500, 503), the edge's
 * HTML error page (502), no answer before it ran (`network`), or no answer
 * after it ran (`lost`: the change is made, its response never arrives),
 * or, for a D1 query, an answer that succeeds with a statement that didn't
 * (`statement-failed`).
 */
export type Failure =
  | 429
  | 500
  | 502
  | 503
  | "network"
  | "lost"
  | "statement-failed"
  | { retryAfter: string };

const lostConnection = (): never => {
  throw new TypeError("Network connection lost.");
};

const failed = (failure: Exclude<Failure, "lost">): Response => {
  if (failure === "network") {
    return lostConnection();
  }
  if (failure === "statement-failed") {
    return envelope([
      { results: [], success: true, meta: {} },
      { results: [], success: false, meta: {} },
    ]);
  }
  if (typeof failure === "object") {
    const response = refusal(
      429,
      971,
      "Please wait and consider throttling your request speed"
    );
    response.headers.set("retry-after", failure.retryAfter);
    return response;
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
  /** Failures planned for the next call a test picks out, each once. */
  const matched: { matches: (call: ApiCall) => boolean; failure: Failure }[] =
    [];

  /** Calls being answered now, and the most at once. */
  const load = { now: 0, peak: 0 };

  /** Answers `call` as the API would. */
  const respond = async (
    request: Request,
    call: ApiCall
  ): Promise<Response> => {
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
    const match = matched.findIndex(({ matches }) => matches(call));
    const [picked] = match === -1 ? [] : matched.splice(match, 1);
    const failure = planned.get(calls.length) ?? picked?.failure;
    if (failure === "lost") {
      await respond(request, call);
      return lostConnection();
    }
    if (failure !== undefined) {
      return failed(failure);
    }
    return await respond(request, call);
  };

  /**
   * What a Worker on an account's workers.dev subdomain answers: its live
   * version's `/health`, as core answers it, to a request carrying the
   * router secret that version has. Undefined for any other host.
   */
  const workersDev = (request: Request): Response | undefined => {
    const url = new URL(request.url);
    const host = /^(?<script>[^.]+)\.(?<subdomain>[^.]+)\.workers\.dev$/u.exec(
      url.hostname
    )?.groups;
    if (host === undefined) {
      return undefined;
    }
    const account = [...accounts.values()].find(
      ({ subdomain }) => subdomain === host.subdomain
    );
    const script = account?.scripts.get(host.script ?? "");
    const [only] = script?.deployments[0]?.versions ?? [];
    const live = script?.versions.find(({ id }) => id === only?.version_id);
    if (
      account === undefined ||
      live === undefined ||
      script?.subdomain?.enabled !== true
    ) {
      return new Response("There is nothing here yet", { status: 404 });
    }
    if (account.unhealthy !== undefined && account.unhealthy > 0) {
      account.unhealthy -= 1;
      return new Response("Starting", { status: 503 });
    }
    const secret = live.secrets.get("ROUTER_SECRET");
    if (
      secret === undefined ||
      request.headers.get("x-grasp-router-secret") !== secret
    ) {
      return new Response("Forbidden", { status: 403 });
    }
    return url.pathname === "/health"
      ? Response.json({
          ok: true,
          version: account.answeringVersion ?? live.id,
        })
      : new Response("Not found", { status: 404 });
  };

  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const served = workersDev(request);
      if (served !== undefined) {
        return served;
      }
      if (!request.url.startsWith(`${base}/`)) {
        throw new Error(`Unexpected outbound request to ${request.url}`);
      }
      load.now += 1;
      load.peak = Math.max(load.peak, load.now);
      try {
        return await answer(request);
      } finally {
        load.now -= 1;
      }
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    accounts.clear();
    forgetDatabases();
    calls.length = 0;
    planned.clear();
    takenSubdomains.clear();
    matched.length = 0;
    load.peak = 0;
  });

  return {
    /** Every call the fake got in this test, in order. */
    calls,
    /** The most calls it was answering at once in this test. */
    peakConcurrency: () => load.peak,
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
        scriptUploads: [],
      };
      accounts.set(account.id, account);
      return account;
    },
    /** Fails the `n`th call from now as `failure` says, whatever it asks. */
    failCall: (n: number, failure: Failure) => {
      planned.set(calls.length + n, failure);
    },
    /** Takes `subdomain` for an account outside the test, as another customer's. */
    takeSubdomain: (subdomain: string) => {
      takenSubdomains.add(subdomain);
    },
    /** Fails the next call `matches` picks out as `failure` says, once. */
    failNext: (matches: (call: ApiCall) => boolean, failure: Failure) => {
      matched.push({ matches, failure });
    },
  };
};
