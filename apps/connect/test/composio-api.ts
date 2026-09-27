/**
 * A stand-in for Composio, the outside system connect calls for the
 * catalog and for Composio connections: its REST API, as Composio
 * documents it, and the MCP servers it makes, each a real MCP server
 * (test/mcp-server.ts). It answers connect's outbound requests to
 * Composio's host, so connect runs unchanged. Tests choose the toolkits and
 * tools it has, whether it is up, and how an admin fares at its auth link,
 * and read back what connect asked of it and what it holds.
 */
import { afterEach, beforeEach, vi } from "vite-plus/test";

import { forgetComposioCatalog } from "../src/catalog.ts";
import { composioApiBase } from "../src/composio.ts";
import { mcpServerWith } from "./mcp-server.ts";
import type { FakeTool } from "./mcp-server.ts";
import { testComposioKey } from "./provider-config.ts";

export interface FakeComposioTool {
  slug: string;
  description?: string;
  /** The properties its input takes. */
  inputs?: string[];
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
 * as to a toolkit it doesn't know); `stuck` (a 503 whose body fails when
 * connect cancels it).
 */
export type ComposioHealth =
  | "up"
  | "down"
  | "redirect"
  | "garbled"
  | "huge"
  | "refusing"
  | "stuck";

/** What the API answers to everything while it isn't up. */
const failures: Partial<Record<ComposioHealth, () => Response>> = {
  down: () => new Response("Service Unavailable", { status: 503 }),
  redirect: () =>
    new Response(null, {
      status: 302,
      headers: { location: "https://elsewhere.example/api" },
    }),
  garbled: () => new Response("<html>", { status: 200 }),
  stuck: () =>
    new Response(
      new ReadableStream<Uint8Array>({
        pull: (controller) => {
          controller.enqueue(new Uint8Array(16));
        },
        cancel: () => {
          throw new Error("The connection broke");
        },
      }),
      { status: 503 }
    ),
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

/** Where Composio serves the MCP servers it makes. */
const mcpBase = "https://backend.composio.dev/v3/mcp/";

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

/**
 * One page of `items`, from the cursor on, as Composio pages its lists;
 * `endless` pages never end.
 */
const page = (
  items: readonly unknown[],
  cursor: string | null,
  endless = false
): Response => {
  const start = cursor === null ? 0 : Number(cursor);
  const next = start + fakePageSize;
  return Response.json({
    items: items.slice(start, next),
    next_cursor: endless || next < items.length ? String(next) : null,
    total_items: items.length,
  });
};

const notFound = (): Response =>
  Response.json({ error: { message: "Not found" } }, { status: 404 });

/** An auth config connect made: Composio's app for one toolkit. */
export interface FakeAuthConfig {
  toolkit: string;
  managed: boolean;
  name: string | null;
}

/** A connected account connect made, and how its auth went. */
export interface FakeAccount {
  authConfigId: string;
  toolkit: string;
  userId: string;
  callbackUrl: string;
  redirectUrl: string;
  status: "INITIATED" | "ACTIVE" | "FAILED";
}

/** An MCP server connect made. */
export interface FakeMcpServerConfig {
  name: string;
  authConfigIds: string[];
  allowedTools: string[];
}

interface Holdings {
  authConfigs: Map<string, FakeAuthConfig>;
  accounts: Map<string, FakeAccount>;
  servers: Map<string, FakeMcpServerConfig>;
}

const bodyOf = async (request: Request): Promise<Record<string, unknown>> => {
  const body: unknown = await request.json();
  return typeof body === "object" && body !== null
    ? Object.fromEntries(Object.entries(body))
    : {};
};

const stringsOf = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((each): each is string => typeof each === "string")
    : [];

const nested = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null
    ? Object.entries(value).find(([name]) => name === key)?.[1]
    : undefined;

/**
 * Composio with `toolkits`, for each test in the file. `extra` are items
 * listed with the toolkits as they are, such as ones connect can't read.
 * Every MCP server it makes has the tools `mcpTools`, as Composio's would
 * have its toolkit's; the server's own allowlist isn't applied, so the
 * tests see what connect lets through.
 */
export const fakeComposioApi = (
  toolkits: readonly FakeToolkit[],
  {
    extra = [],
    mcpTools = [],
  }: { extra?: readonly unknown[]; mcpTools?: readonly FakeTool[] } = {}
) => {
  const mcp = mcpServerWith(mcpTools);
  const state: {
    /** Every request connect sent to the API, in order. */
    requests: ComposioApiRequest[];
    health: ComposioHealth;
    /** Bytes of the `huge` answer read so far. */
    hugeSent: { bytes: number };
    /** Its toolkit list never ends: every page says there is another. */
    endless: boolean;
    /** The status its tool lists answer with instead, if any. */
    toolsStatus: number | undefined;
    /**
     * Requests that answer 503: those whose method and path under the
     * API's base start with this, such as `DELETE /connected_accounts/`.
     */
    failing: string | undefined;
    /** Where it says a new server is, instead of its own MCP host. */
    serverUrlBase: string;
    /**
     * Which account the URL it generates names: the one asked for, another
     * one, or none (a URL for no one account).
     */
    accountInUrl: "own" | "other" | "none";
    /** What connect made at Composio and hasn't deleted. */
    holds: Holdings;
    /** The MCP servers' requests and tool runs, all of them together. */
    mcp: typeof mcp.state;
  } = {
    requests: [],
    health: "up",
    hugeSent: { bytes: 0 },
    endless: false,
    toolsStatus: undefined,
    failing: undefined,
    serverUrlBase: mcpBase,
    accountInUrl: "own",
    holds: { authConfigs: new Map(), accounts: new Map(), servers: new Map() },
    mcp: mcp.state,
  };

  /** What connect creates at Composio, by route, from the request's body. */
  const creations: Record<string, (body: Record<string, unknown>) => Response> =
    {
      "/auth_configs": (body) => {
        const toolkit = String(nested(body.toolkit, "slug"));
        if (!toolkits.some(({ slug }) => slug === toolkit)) {
          return notFound();
        }
        const authConfigId = `ac_${crypto.randomUUID()}`;
        state.holds.authConfigs.set(authConfigId, {
          toolkit,
          managed:
            nested(body.auth_config, "type") === "use_composio_managed_auth",
          name:
            typeof nested(body.auth_config, "name") === "string"
              ? String(nested(body.auth_config, "name"))
              : null,
        });
        return Response.json(
          { toolkit: { slug: toolkit }, auth_config: { id: authConfigId } },
          { status: 201 }
        );
      },
      "/connected_accounts/link": (body) => {
        const authConfigId = String(body.auth_config_id);
        const authConfig = state.holds.authConfigs.get(authConfigId);
        if (authConfig === undefined) {
          return notFound();
        }
        const accountId = `ca_${crypto.randomUUID()}`;
        const redirectUrl = `https://connect.composio.dev/link/${accountId}`;
        state.holds.accounts.set(accountId, {
          authConfigId,
          toolkit: authConfig.toolkit,
          userId: String(body.user_id),
          callbackUrl: String(body.callback_url),
          redirectUrl,
          status: "INITIATED",
        });
        return Response.json(
          {
            link_token: "link-token",
            redirect_url: redirectUrl,
            expires_at: new Date(Date.now() + 600_000).toISOString(),
            connected_account_id: accountId,
          },
          { status: 201 }
        );
      },
      "/mcp/servers": (body) => {
        const serverId = crypto.randomUUID();
        state.holds.servers.set(serverId, {
          name: String(body.name),
          authConfigIds: stringsOf(body.auth_config_ids),
          allowedTools: stringsOf(body.allowed_tools),
        });
        return Response.json({ id: serverId }, { status: 201 });
      },
      "/mcp/servers/generate": (body) => {
        const serverId = String(body.mcp_server_id);
        if (!state.holds.servers.has(serverId)) {
          return notFound();
        }
        const base = `${state.serverUrlBase}${serverId}`;
        return Response.json({
          mcp_url: base,
          connected_account_urls: stringsOf(body.connected_account_ids).map(
            (account) =>
              ({
                own: `${base}?connected_account_id=${account}`,
                other: `${base}?connected_account_id=ca_someone_else`,
                none: base,
              })[state.accountInUrl]
          ),
          user_ids_url: [],
        });
      },
    };

  /** A deletion of something connect made, by route. */
  const deletion = (route: string): Response => {
    const [, area, id] = route.split("/");
    const held = {
      auth_configs: state.holds.authConfigs,
      connected_accounts: state.holds.accounts,
      mcp: state.holds.servers,
    }[area ?? ""];
    return held?.delete(id ?? "") === true
      ? Response.json({ success: true })
      : notFound();
  };

  /** A connected account, as Composio shows it. */
  const accountAt = (route: string): Response => {
    const id = route.slice("/connected_accounts/".length);
    const account = state.holds.accounts.get(id);
    return account === undefined
      ? notFound()
      : Response.json({
          id,
          status: account.status,
          toolkit: { slug: account.toolkit },
          auth_config: { id: account.authConfigId },
        });
  };

  /**
   * Lists of what connect made, as Composio filters them: auth configs by
   * a search of their name, servers by their name and auth configs, and
   * connected accounts by their auth configs.
   */
  const listing = (route: string, query: URLSearchParams): Response => {
    const { holds } = state;
    const search = query.get("search") ?? query.get("name") ?? "";
    const byAuthConfig = query.get("auth_config_ids");
    const lists: Record<string, { id: string; name?: string | null }[]> = {
      "/auth_configs": [...holds.authConfigs]
        .filter(([, { name }]) => (name ?? "").includes(search))
        .map(([id, { name }]) => ({ id, name })),
      "/mcp/servers": [...holds.servers]
        .filter(([, { name }]) =>
          name.toLowerCase().includes(search.toLowerCase())
        )
        .map(([id, { name }]) => ({ id, name })),
      "/connected_accounts": [...holds.accounts]
        .filter(([, { authConfigId }]) => authConfigId === byAuthConfig)
        .map(([id]) => ({ id })),
    };
    const items = lists[route];
    return items === undefined
      ? notFound()
      : Response.json({ items, next_cursor: null });
  };

  const manage = async (
    request: Request,
    route: string,
    query: URLSearchParams
  ): Promise<Response> => {
    if (request.method === "DELETE") {
      return deletion(route);
    }
    if (
      request.method === "GET" &&
      ["/auth_configs", "/mcp/servers", "/connected_accounts"].includes(route)
    ) {
      return listing(route, query);
    }
    if (request.method === "GET" && route.startsWith("/connected_accounts/")) {
      return accountAt(route);
    }
    const create = creations[route];
    if (request.method === "POST" && create !== undefined) {
      return create(await bodyOf(request));
    }
    return notFound();
  };

  const answer = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const route = url.pathname.slice(new URL(composioApiBase).pathname.length);
    state.requests.push({
      method: request.method,
      path: `${route}${url.search}`,
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
    if (
      state.failing !== undefined &&
      `${request.method} ${route}`.startsWith(state.failing)
    ) {
      return new Response("Service Unavailable", { status: 503 });
    }
    const cursor = url.searchParams.get("cursor");
    if (request.method === "GET" && route === "/toolkits") {
      return page(
        [...toolkits.map(toolkitItem), ...extra],
        cursor,
        state.endless
      );
    }
    if (request.method === "GET" && route === "/tools") {
      if (state.toolsStatus !== undefined) {
        return Response.json(
          { error: { message: "Invalid request" } },
          { status: state.toolsStatus }
        );
      }
      const toolkit = toolkits.find(
        ({ slug }) => slug === url.searchParams.get("toolkit_slug")
      );
      return page(
        (toolkit?.tools ?? []).map(({ slug, description, inputs = [] }) => ({
          slug,
          name: slug,
          description,
          toolkit: { slug: toolkit?.slug, name: toolkit?.name },
          input_parameters: {
            type: "object",
            properties: Object.fromEntries(
              inputs.map((input) => [input, { type: "string" }])
            ),
          },
          tags: [],
        })),
        cursor
      );
    }
    return await manage(request, route, url.searchParams);
  };

  beforeEach(() => {
    // Each test asks Composio afresh, as a new isolate would.
    forgetComposioCatalog();
    state.requests = [];
    state.health = "up";
    state.hugeSent = { bytes: 0 };
    state.endless = false;
    state.toolsStatus = undefined;
    state.failing = undefined;
    state.serverUrlBase = mcpBase;
    state.accountInUrl = "own";
    state.holds = {
      authConfigs: new Map(),
      accounts: new Map(),
      servers: new Map(),
    };
    mcp.reset();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      if (request.url.startsWith(mcpBase)) {
        return await mcp.answer(request);
      }
      if (!request.url.startsWith(`${composioApiBase}/`)) {
        throw new Error(`Unexpected outbound request to ${request.url}`);
      }
      return await answer(request);
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  return {
    state,
    /**
     * The admin finishing at the auth link `url` as `status` says, as
     * Composio would: the flow's `state`, from the callback URL it sends
     * the browser back to.
     */
    authorize: (
      url: string,
      status: FakeAccount["status"] = "ACTIVE"
    ): { state: string; account: FakeAccount } => {
      const account = [...state.holds.accounts.values()].find(
        ({ redirectUrl }) => redirectUrl === url
      );
      if (account === undefined) {
        throw new Error(`No account at ${url}`);
      }
      account.status = status;
      return {
        state: new URL(account.callbackUrl).searchParams.get("state") ?? "",
        account,
      };
    },
  };
};
