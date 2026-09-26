/**
 * The sample connector's provider (test/fixtures/sample-connector.ts), and
 * every other host on the internet: whatever connect's egress handler lets
 * out lands here, where tests read it back. The provider answers what the
 * sample connector asks, and the probes' special cases (a redirect, a flood
 * of bytes); any other host takes whatever it is sent, as an attacker's
 * would. Tests can have it rate limit its next writes (`rateLimited`), and
 * fail its next reads (`failingReads`). OAuth requests go on to the fake
 * providers (test/oauth-provider.ts).
 */
import { afterEach, beforeEach, vi } from "vite-plus/test";

import { sampleHost } from "./fixtures/sample-connector.ts";

/** One request that left connect. */
export interface SentRequest {
  method: string;
  host: string;
  path: string;
  headers: Record<string, string>;
}

const oauthHosts = new Set([
  "login.microsoftonline.com",
  "oauth2.googleapis.com",
]);

/** More than the egress handler lets a connector read. */
const floodBytes = 12 * 1024 * 1024;
const floodChunk = new Uint8Array(64 * 1024);

const flood = (): ReadableStream<Uint8Array> => {
  let sent = 0;
  return new ReadableStream({
    pull: (controller) => {
      if (sent >= floodBytes) {
        controller.close();
        return;
      }
      sent += floodChunk.byteLength;
      controller.enqueue(floodChunk);
    },
  });
};

const itemsPath = /^\/v1\/mailboxes\/(?<mailbox>[^/]+)\/items$/u;

const answer = (method: string, url: URL): Response => {
  const mailbox = itemsPath.exec(url.pathname)?.groups?.mailbox;
  if (mailbox !== undefined) {
    return method === "POST"
      ? Response.json({ id: `${mailbox}-sent` })
      : Response.json({
          items: [
            { id: `${decodeURIComponent(mailbox)}/item-1`, subject: "Invoice" },
          ],
        });
  }
  switch (url.pathname) {
    case "/v1/probe/ok": {
      return new Response("ok");
    }
    case "/v1/probe/redirect": {
      return Response.redirect("https://evil.test/steal", 302);
    }
    case "/v1/probe/redirect-here": {
      return Response.redirect(`https://${sampleHost}/v1/probe/ok`, 307);
    }
    case "/v1/probe/flood": {
      return new Response(flood());
    }
    case "/v1/probe/empty": {
      return new Response(null, {
        status: 204,
        headers: { "content-length": String(floodBytes) },
      });
    }
    case "/v1/probe/flood-declared": {
      return new Response(new Uint8Array(floodBytes), {
        headers: { "content-length": String(floodBytes) },
      });
    }
    default: {
      return new Response("Not found", { status: 404 });
    }
  }
};

/** The sample provider and the rest of the internet, for each test in the file. */
export const fakeSampleApi = () => {
  const sent: SentRequest[] = [];
  const state = {
    sent,
    /** How many of the next item writes it answers 429, doing nothing. */
    rateLimited: 0,
    /** The item writes it carried out. */
    written: 0,
    /** How many of the next item reads it answers 503. */
    failingReads: 0,
  };
  const answerWrite = (method: string, url: URL): Response => {
    const isItems = itemsPath.test(url.pathname);
    const isWrite = method === "POST" && isItems;
    if (isWrite && state.rateLimited > 0) {
      state.rateLimited -= 1;
      return new Response("Too Many Requests", { status: 429 });
    }
    if (method === "GET" && isItems && state.failingReads > 0) {
      state.failingReads -= 1;
      return new Response("Service Unavailable", { status: 503 });
    }
    if (isWrite) {
      state.written += 1;
    }
    return answer(method, url);
  };
  beforeEach(() => {
    sent.length = 0;
    state.rateLimited = 0;
    state.written = 0;
    state.failingReads = 0;
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
      });
      await request.body?.cancel();
      return url.hostname === sampleHost
        ? answerWrite(request.method, url)
        : new Response("Taken");
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  return state;
};
