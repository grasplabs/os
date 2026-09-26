/**
 * The sample connector's provider (test/fixtures/sample-connector.ts), and
 * every other host on the internet: whatever connect's egress handler lets
 * out lands here, where tests read it back. The provider answers what the
 * sample connector asks, and the probes' special cases (a redirect, a flood
 * of bytes); any other host takes whatever it is sent, as an attacker's
 * would. Tests can have it rate limit its next writes (`rateLimited`), and
 * fail its next reads (`failingReads`).
 */
import { beforeEach } from "vite-plus/test";

import { sampleHost, storageHost } from "./fixtures/sample-connector.ts";
import { fakeInternet } from "./internet.ts";

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

const downloadsPath = /^\/v1\/downloads\/(?<name>[^/]+)$/u;

/** Downloads redirect to the provider's storage, as Graph's do. */
const download = (url: URL): Response | undefined => {
  const name = downloadsPath.exec(url.pathname)?.groups?.name;
  if (name === undefined) {
    return undefined;
  }
  const to = {
    elsewhere: "https://evil.test/file",
    // One of the storage's hosts, but not the deployment's own.
    others: "https://others.storage.test/file",
  }[name];
  return Response.redirect(to ?? `https://${storageHost}/${name}`, 302);
};

/** The storage: a file, a flood of bytes, or a redirect of its own. */
const storage = (url: URL): Response => {
  switch (url.pathname) {
    case "/flood": {
      return new Response(flood());
    }
    case "/again": {
      return Response.redirect(`https://${storageHost}/file`, 302);
    }
    default: {
      return new Response("file");
    }
  }
};

const answer = (method: string, url: URL): Response => {
  const redirected = download(url);
  if (redirected !== undefined) {
    return redirected;
  }
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
  const counters = {
    /** How many of the next item writes it answers 429, doing nothing. */
    rateLimited: 0,
    /** The item writes it carried out. */
    written: 0,
    /** How many of the next item reads it answers 503. */
    failingReads: 0,
  };
  beforeEach(() => {
    counters.rateLimited = 0;
    counters.written = 0;
    counters.failingReads = 0;
  });
  const answerItems = (method: string, url: URL): Response => {
    const isItems = itemsPath.test(url.pathname);
    const isWrite = method === "POST" && isItems;
    if (isWrite && counters.rateLimited > 0) {
      counters.rateLimited -= 1;
      return new Response("Too Many Requests", { status: 429 });
    }
    if (method === "GET" && isItems && counters.failingReads > 0) {
      counters.failingReads -= 1;
      return new Response("Service Unavailable", { status: 503 });
    }
    if (isWrite) {
      counters.written += 1;
    }
    return answer(method, url);
  };
  const { sent } = fakeInternet((request, url) => {
    if (url.hostname === sampleHost) {
      return answerItems(request.method, url);
    }
    return url.hostname.endsWith(".storage.test")
      ? storage(url)
      : new Response("Taken");
  });
  return Object.assign(counters, { sent });
};
