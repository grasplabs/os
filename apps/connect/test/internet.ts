/**
 * The internet, as connect's tests see it: every request that leaves
 * connect lands in `answer`, and tests read back what was sent. OAuth
 * requests go on to the fake providers (test/oauth-provider.ts), whose spy
 * on fetch must be registered first.
 */
import { afterEach, beforeEach, vi } from "vite-plus/test";

/** One request that left connect. */
export interface SentRequest {
  method: string;
  host: string;
  /** The path and query, as sent. */
  path: string;
  headers: Record<string, string>;
  body: string;
}

const oauthHosts = new Set([
  "login.microsoftonline.com",
  "oauth2.googleapis.com",
]);

/** Answers every request with `answer`, for each test in the file. */
export const fakeInternet = (
  answer: (request: Request, url: URL) => Response | Promise<Response>
) => {
  const sent: SentRequest[] = [];
  beforeEach(() => {
    sent.length = 0;
    // A second spy on fetch replaces the first one's implementation: keep
    // the OAuth providers' (registered first) to hand their requests to.
    const passThrough =
      vi.mocked(globalThis.fetch).getMockImplementation() ?? globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (oauthHosts.has(url.hostname)) {
        return await passThrough(input, init);
      }
      sent.push({
        method: request.method,
        host: url.hostname,
        path: `${url.pathname}${url.search}`,
        headers: Object.fromEntries(request.headers),
        body: await request.clone().text(),
      });
      return await answer(request, url);
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  return { sent };
};

/** What a route's answer is made from: its path's named parts, and the request. */
export type Asked<Part extends string> = Record<Part, string> & {
  query: URLSearchParams;
  request: Request;
};

/** One of a provider's routes, and how the provider answers it. */
export interface ProviderRoute<Part extends string> {
  host: string;
  method: string;
  path: RegExp;
  answer: (asked: Asked<Part>) => Response | Promise<Response>;
}

export const json = (body: unknown, status = 200): Response =>
  Response.json(body, { status });

/** A route whose `path` pattern matches a request's whole path. */
export const route = <Part extends string>(
  host: string,
  method: string,
  path: string,
  answer: ProviderRoute<Part>["answer"]
): ProviderRoute<Part> => ({
  host,
  method,
  path: new RegExp(`${path}$`, "u"),
  answer,
});

/** How the provider fails the next request, or the next write only. */
export interface Failure {
  status: number;
  body: unknown;
  headers?: HeadersInit;
  writesOnly?: boolean;
}

/**
 * A provider on `hosts`, answering by its `routes` (`unmatched` for any
 * other request), and the rest of the internet: `elsewhere`, or a host
 * that takes whatever it is sent, as an attacker's would. `fail` makes the
 * provider fail its next request, or its next write.
 */
export const fakeProvider = <Part extends string>({
  hosts,
  parts,
  routes,
  unmatched,
  elsewhere = () => new Response("Taken"),
}: {
  hosts: readonly string[];
  /** The named parts a route's path may have, `""` where it has none. */
  parts: readonly Part[];
  routes: readonly ProviderRoute<Part>[];
  unmatched: () => Response;
  elsewhere?: (url: URL) => Response;
}) => {
  let failure: Failure | undefined;
  let writesDone = 0;
  beforeEach(() => {
    failure = undefined;
    writesDone = 0;
  });
  const hasParts = (
    named: Record<string, string>
  ): named is Record<Part, string> => parts.every((part) => part in named);
  const answer = async (request: Request, url: URL): Promise<Response> => {
    for (const { host, method, path, answer: answerOf } of routes) {
      const found =
        host === url.hostname && method === request.method
          ? path.exec(url.pathname)
          : null;
      const named = Object.fromEntries(
        parts.map((part) => [
          part,
          decodeURIComponent(found?.groups?.[part] ?? ""),
        ])
      );
      if (found !== null && hasParts(named)) {
        // oxlint-disable-next-line no-await-in-loop -- the one route that matched
        return await answerOf({ ...named, query: url.searchParams, request });
      }
    }
    return unmatched();
  };
  const { sent } = fakeInternet(async (request, url) => {
    if (!hosts.includes(url.hostname)) {
      return elsewhere(url);
    }
    const isWrite = request.method !== "GET";
    if (failure !== undefined && (isWrite || failure.writesOnly !== true)) {
      const { status, body, headers } = failure;
      failure = undefined;
      return Response.json(body, { status, headers });
    }
    if (isWrite) {
      writesDone += 1;
    }
    return await answer(request, url);
  });
  return {
    sent,
    /** The writes the provider carried out. */
    writesDone: () => writesDone,
    /** Makes the provider fail its next request, or its next write. */
    fail: (next: Failure) => {
      failure = next;
    },
  };
};
