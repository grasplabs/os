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
