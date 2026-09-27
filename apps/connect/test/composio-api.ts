/**
 * A stand-in for Composio's REST API, the outside system connect calls for
 * the catalog: it answers connect's outbound requests to Composio's API
 * host as Composio documents them, so connect runs unchanged. Tests choose
 * the toolkits and tools it has and whether it is up, and read back what
 * connect asked of it.
 */
import { afterEach, beforeEach, vi } from "vite-plus/test";

import { forgetComposioCatalog } from "../src/catalog.ts";
import { composioApiBase } from "../src/composio.ts";
import { testComposioKey } from "./provider-config.ts";

export interface FakeComposioTool {
  slug: string;
  description?: string;
}

export interface FakeToolkit {
  slug: string;
  name: string;
  /** Whether Composio holds an app for it (managed auth); by default yes. */
  managed?: boolean;
  categories?: string[];
  tools: FakeComposioTool[];
}

/** One request connect sent to the API. */
export interface ComposioApiRequest {
  method: string;
  /** Its path under the API's base, with its query. */
  path: string;
  /** Whether it carried connect's key, in `x-api-key`. */
  keyed: boolean;
  /** Whether it would follow a redirect. */
  followsRedirects: boolean;
}

/**
 * How the API answers: `up`; `down` (a 503 to everything); `redirect` (a
 * 302 to another host); `garbled` (a 200 that isn't JSON); `huge` (a 200
 * streaming a valid page of 6 MiB, `hugeAnswerBytes`); `refusing` (a 400,
 * as to a toolkit it doesn't know).
 */
export type ComposioHealth =
  | "up"
  | "down"
  | "redirect"
  | "garbled"
  | "huge"
  | "refusing";

/** What the API answers to everything while it isn't up. */
const failures: Partial<Record<ComposioHealth, () => Response>> = {
  down: () => new Response("Service Unavailable", { status: 503 }),
  redirect: () =>
    new Response(null, {
      status: 302,
      headers: { location: "https://elsewhere.example/api" },
    }),
  garbled: () => new Response("<html>", { status: 200 }),
  refusing: () =>
    Response.json({ error: { message: "Toolkit not found" } }, { status: 400 }),
};

const hugeHead = new TextEncoder().encode(
  '{"items":[],"next_cursor":null,"pad":"'
);
const hugeTail = new TextEncoder().encode('"}');
// Of `a` (0x61).
const hugeChunk = new Uint8Array(64 * 1024).fill(0x61);
const hugeChunks = 96;

/**
 * Bytes in the `huge` answer: an empty page of the list, valid JSON, that
 * pads it past connect's 4 MiB cap to 6 MiB.
 */
export const hugeAnswerBytes =
  hugeHead.byteLength + hugeChunks * hugeChunk.byteLength + hugeTail.byteLength;

/**
 * The `huge` answer, in chunks and without a `content-length`, sent only
 * as fast as it is read: `sent` counts the bytes read so far.
 */
const hugeAnswer = (sent: { bytes: number }): Response => {
  let next = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull: (controller) => {
        let chunk: Uint8Array | undefined = hugeChunk;
        if (next === 0) {
          chunk = hugeHead;
        } else if (next === hugeChunks + 1) {
          chunk = hugeTail;
        } else if (next > hugeChunks + 1) {
          chunk = undefined;
        }
        next += 1;
        if (chunk === undefined) {
          controller.close();
          return;
        }
        sent.bytes += chunk.byteLength;
        controller.enqueue(chunk);
      },
    })
  );
};

/** Items per page: few, so a short list takes more than one. */
const fakePageSize = 2;

const toolkitItem = ({
  slug,
  name,
  managed,
  categories,
  tools,
}: FakeToolkit) => ({
  slug,
  name,
  type: "native",
  auth_schemes: ["OAUTH2"],
  composio_managed_auth_schemes: managed === false ? [] : ["OAUTH2"],
  no_auth: false,
  meta: {
    description: `${name} toolkit`,
    logo: `https://logos.composio.dev/api/${slug}`,
    categories: (categories ?? []).map((category) => ({
      id: category.toLowerCase(),
      name: category,
    })),
    tools_count: tools.length,
    triggers_count: 0,
  },
});

/** One page of `items`, from the cursor on, as Composio pages its lists. */
const page = (items: readonly unknown[], cursor: string | null): Response => {
  const start = cursor === null ? 0 : Number(cursor);
  const next = start + fakePageSize;
  return Response.json({
    items: items.slice(start, next),
    next_cursor: next < items.length ? String(next) : null,
    total_items: items.length,
  });
};

/**
 * Composio's API with `toolkits`, for each test in the file. `extra` are
 * items listed with the toolkits as they are, such as ones connect can't
 * read.
 */
export const fakeComposioApi = (
  toolkits: readonly FakeToolkit[],
  { extra = [] }: { extra?: readonly unknown[] } = {}
) => {
  const state: {
    /** Every request connect sent to it, in order. */
    requests: ComposioApiRequest[];
    health: ComposioHealth;
    /** Bytes of the `huge` answer read so far. */
    hugeSent: { bytes: number };
  } = { requests: [], health: "up", hugeSent: { bytes: 0 } };

  const answer = (request: Request): Response => {
    const url = new URL(request.url);
    const path = `${url.pathname.slice(new URL(composioApiBase).pathname.length)}${url.search}`;
    state.requests.push({
      method: request.method,
      path,
      keyed: request.headers.get("x-api-key") === testComposioKey,
      followsRedirects: request.redirect === "follow",
    });
    if (request.headers.get("x-api-key") !== testComposioKey) {
      return Response.json(
        { error: { message: "Invalid API key" } },
        { status: 401 }
      );
    }
    if (state.health === "huge") {
      return hugeAnswer(state.hugeSent);
    }
    const failure = failures[state.health]?.();
    if (failure !== undefined) {
      return failure;
    }
    const cursor = url.searchParams.get("cursor");
    if (request.method === "GET" && url.pathname.endsWith("/toolkits")) {
      return page([...toolkits.map(toolkitItem), ...extra], cursor);
    }
    if (request.method === "GET" && url.pathname.endsWith("/tools")) {
      const toolkit = toolkits.find(
        ({ slug }) => slug === url.searchParams.get("toolkit_slug")
      );
      return page(
        (toolkit?.tools ?? []).map(({ slug, description }) => ({
          slug,
          name: slug,
          description,
          toolkit: { slug: toolkit?.slug, name: toolkit?.name },
          input_parameters: { type: "object", properties: {} },
          tags: [],
        })),
        cursor
      );
    }
    return Response.json({ error: { message: "Not found" } }, { status: 404 });
  };

  beforeEach(() => {
    // Each test asks Composio afresh, as a new isolate would.
    forgetComposioCatalog();
    state.requests = [];
    state.health = "up";
    state.hugeSent = { bytes: 0 };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      if (!request.url.startsWith(`${composioApiBase}/`)) {
        throw new Error(`Unexpected outbound request to ${request.url}`);
      }
      return await Promise.resolve(answer(request));
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  return state;
};
