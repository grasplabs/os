import {
  catalogRequestSchema,
  catalogToolsRequestSchema,
  composioToolkitSchema,
  connectErrors,
} from "@grasp-os/shared/connect";
import type {
  Catalog,
  CatalogEntry,
  CatalogTool,
  OAuthProvider,
} from "@grasp-os/shared/connect";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { errorFields, log } from "@grasp-os/shared/log";
import { z } from "zod";

import { ComposioError, composioKey, composioRequest } from "./composio.ts";
import { nativeConnector } from "./connectors.ts";
import { providers } from "./providers.ts";

// The catalog: what an admin can connect. The native providers come from
// this release (src/providers.ts and their connectors' manifests); Composio's
// toolkits from Composio's API, with connect's key, while the `composio`
// flag is on (core says so with each request). Each entry is marked with
// who carries out its actions, and so who holds its tokens: connect
// (`native`) or Composio's cloud (`composio`). What Composio lists is kept
// for ten minutes (`cachedIn`), and only asked for while the flag is on and
// connect has its key.

/** How native providers are shown in the catalog. */
const nativeShown: Record<
  OAuthProvider,
  Pick<CatalogEntry, "name" | "categories">
> = {
  microsoft: { name: "Microsoft 365", categories: ["Productivity"] },
  google: { name: "Google Workspace", categories: ["Productivity"] },
};

/** The native providers whose connector is in this release. */
const nativeEntries = (): CatalogEntry[] =>
  Object.values(providers).flatMap((provider) => {
    const connector = nativeConnector(provider.server);
    if (connector === undefined) {
      return [];
    }
    return [
      {
        source: "native",
        id: provider.id,
        ...nativeShown[provider.id],
        toolCount: Object.keys(connector.manifest.actions).length,
      },
    ];
  });

/**
 * How much of one of Composio's lists is read for one answer: pages of
 * `pageSize` items, at most `maxPages` of them. Toolkits come in Composio's
 * largest pages; tools, which carry their input schemas, in smaller ones.
 */
interface Paging {
  pageSize: number;
  maxPages: number;
}

const toolkitPaging: Paging = { pageSize: 1000, maxPages: 5 };
const toolPaging: Paging = { pageSize: 200, maxPages: 25 };

/**
 * How long what Composio listed is kept: its catalog changes rarely, and
 * the Connections page shouldn't ask Composio every time it opens.
 */
const cacheTtlMs = 10 * 60 * 1000;

/** Most answers kept in each cache: about one per toolkit people look at. */
const maxCached = 100;

interface Cached<Value> {
  expiresAt: number;
  value: Value;
}

// Per isolate, keyed by the SHA-256 of connect's Composio key (a rotated
// key starts afresh) and what was listed. Only answers are kept: a failure
// is asked again next time. Loads under way are shared: people opening the
// Connections page at once ask Composio once (`loading`).
interface Cache<Value> {
  values: Map<string, Cached<Value>>;
  loading: Map<string, Promise<Value>>;
}

const toolkitCache: Cache<CatalogEntry[]> = {
  values: new Map(),
  loading: new Map(),
};
const toolCache: Cache<CatalogTool[]> = {
  values: new Map(),
  loading: new Map(),
};

/** Forgets everything cached, so the next answer comes from Composio. */
export const forgetComposioCatalog = (): void => {
  for (const cache of [toolkitCache, toolCache]) {
    cache.values.clear();
    cache.loading.clear();
  }
};

/** Stores `value` under `id`, dropping expired entries, then the oldest. */
const store = <Value>(
  cache: Map<string, Cached<Value>>,
  id: string,
  value: Value
): void => {
  const now = Date.now();
  for (const [each, { expiresAt }] of cache) {
    if (expiresAt <= now) {
      cache.delete(each);
    }
  }
  cache.delete(id);
  const [oldest] = cache.keys();
  if (cache.size >= maxCached && oldest !== undefined) {
    cache.delete(oldest);
  }
  cache.set(id, { expiresAt: now + cacheTtlMs, value });
};

/**
 * The value `load` gives for `name` under `key`, from `cache` while it is
 * fresh. A load already under way for the same `name` and `key` is
 * awaited, not repeated; it is forgotten once it settles, and a failed one
 * is never kept.
 */
const cachedIn = async <Value>(
  { values, loading }: Cache<Value>,
  key: string,
  name: string,
  load: () => Promise<Value>
): Promise<Value> => {
  const id = `${await sha256Hex(key)}:${name}`;
  const hit = values.get(id);
  if (hit !== undefined && hit.expiresAt > Date.now()) {
    return hit.value;
  }
  const underWay = loading.get(id);
  if (underWay !== undefined) {
    return await underWay;
  }
  const loaded = (async () => {
    try {
      const value = await load();
      store(values, id, value);
      return value;
    } finally {
      loading.delete(id);
    }
  })();
  loading.set(id, loaded);
  return await loaded;
};

/**
 * A page of one of Composio's lists. Items are checked one at a time, so
 * one Composio can't read leaves the others listed.
 */
const pageSchema = z.object({
  items: z.array(z.unknown()),
  next_cursor: z.string().min(1).nullish(),
});

const toolkitSchema = z.object({
  slug: composioToolkitSchema,
  name: z.string().min(1).max(256),
  /** The auth schemes Composio holds an app for: connectable without one of ours. */
  composio_managed_auth_schemes: z.array(z.string()).default([]),
  meta: z
    .object({
      categories: z.array(z.unknown()).default([]),
      tools_count: z.number().int().nonnegative().default(0),
    })
    .default({ categories: [], tools_count: 0 }),
});

const categorySchema = z.object({ name: z.string().min(1).max(128) });

const toolSchema = z.object({
  slug: z.string().min(1).max(256),
  description: z.string().max(4096).nullish(),
});

/**
 * Every item of one of Composio's lists at `path`, page after page, as
 * far as `paging` goes, each item as `schema` reads it; items it can't read
 * are left out. A list longer than `paging` allows is a failure: half a
 * catalog would look like all of it.
 */
const composioList = async <Item>(
  key: string,
  path: string,
  schema: z.ZodType<Item>,
  { pageSize, maxPages }: Paging
): Promise<Item[]> => {
  const items: Item[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const query = new URLSearchParams({ limit: String(pageSize) });
    if (cursor !== undefined) {
      query.set("cursor", cursor);
    }
    const separator = path.includes("?") ? "&" : "?";
    // oxlint-disable-next-line no-await-in-loop -- pages come one after another
    const { items: listed, next_cursor: next } = await composioRequest(key, {
      path: `${path}${separator}${query.toString()}`,
      schema: pageSchema,
    });
    for (const item of listed) {
      const parsed = schema.safeParse(item);
      if (parsed.success) {
        items.push(parsed.data);
      }
    }
    cursor = next ?? undefined;
    if (cursor === undefined) {
      return items;
    }
  }
  throw new ComposioError(`${path} is longer than connect reads`);
};

/**
 * Whether a toolkit is in the catalog: Composio holds an app for it
 * (managed auth), so an admin needs nothing but their consent, and it has
 * tools, so connecting it could do something.
 */
const isListed = ({
  composio_managed_auth_schemes: managed,
  meta,
}: z.infer<typeof toolkitSchema>): boolean =>
  managed.length > 0 && meta.tools_count > 0;

/** Composio's toolkits in the catalog (`isListed`). */
const composioEntries = async (key: string): Promise<CatalogEntry[]> => {
  const toolkits = await composioList(
    key,
    "/toolkits?sort_by=alphabetically",
    toolkitSchema,
    toolkitPaging
  );
  return toolkits.filter(isListed).map(({ slug, name, meta }) => ({
    source: "composio",
    id: slug,
    name,
    categories: meta.categories.flatMap((category) => {
      const parsed = categorySchema.safeParse(category);
      return parsed.success ? [parsed.data.name] : [];
    }),
    toolCount: meta.tools_count,
  }));
};

/** Composio's toolkits in the catalog, as cached. */
const listedToolkits = async (key: string): Promise<CatalogEntry[]> =>
  await cachedIn(
    toolkitCache,
    key,
    "toolkits",
    async () => await composioEntries(key)
  );

/** The catalog, as `ConnectApi.catalog` describes it. */
export const catalog = async (env: Env, request: unknown): Promise<Catalog> => {
  const parsed = catalogRequestSchema.safeParse(request);
  if (!parsed.success) {
    throw connectErrors.create("connect.invalid");
  }
  const native = nativeEntries();
  const key = composioKey(env);
  if (!parsed.data.composio || key === undefined) {
    return { entries: native, composio: "off" };
  }
  try {
    const toolkits = await listedToolkits(key);
    return { entries: [...native, ...toolkits], composio: "listed" };
  } catch (error) {
    if (!(error instanceof ComposioError)) {
      throw error;
    }
    log.warn("catalog.composio_unavailable", errorFields(error));
    return { entries: native, composio: "unavailable" };
  }
};

/**
 * A listed Composio toolkit's tools, by the names its MCP server gives
 * them, as Composio lists them now.
 */
const toolsOf = async (
  key: string,
  toolkit: string
): Promise<CatalogTool[]> => {
  const tools = await composioList(
    key,
    `/tools?${new URLSearchParams({ toolkit_slug: toolkit }).toString()}`,
    toolSchema,
    toolPaging
  );
  return tools.map(({ slug, description }) => ({
    name: slug,
    description: description ?? null,
  }));
};

/**
 * A Composio toolkit's tools, only for one the catalog lists, so the two
 * never disagree on what is in it: `connect.catalog_entry_not_found` for
 * any other, and `connect.catalog_unavailable` when Composio doesn't list
 * the catalog or the tools (any failure, a 400 or 404 for a toolkit it
 * listed too).
 */
const composioTools = async (
  key: string,
  toolkit: string
): Promise<CatalogTool[]> => {
  try {
    const listed = await listedToolkits(key);
    if (!listed.some(({ id }) => id === toolkit)) {
      throw connectErrors.create("connect.catalog_entry_not_found");
    }
    return await cachedIn(
      toolCache,
      key,
      `tools:${toolkit}`,
      async () => await toolsOf(key, toolkit)
    );
  } catch (error) {
    if (!(error instanceof ComposioError)) {
      throw error;
    }
    log.warn("catalog.composio_unavailable", errorFields(error));
    throw connectErrors.create("connect.catalog_unavailable");
  }
};

/** One entry's tools, as `ConnectApi.catalogTools` describes them. */
export const catalogTools = async (
  env: Env,
  request: unknown
): Promise<CatalogTool[]> => {
  const parsed = catalogToolsRequestSchema.safeParse(request);
  if (!parsed.success) {
    throw connectErrors.create("connect.invalid");
  }
  const { composio, source, id } = parsed.data;
  if (source === "native") {
    const provider = Object.values(providers).find((each) => each.id === id);
    const connector =
      provider === undefined ? undefined : nativeConnector(provider.server);
    if (connector === undefined) {
      throw connectErrors.create("connect.catalog_entry_not_found");
    }
    return Object.keys(connector.manifest.actions).map((name) => ({
      name,
      description: null,
    }));
  }
  const key = composioKey(env);
  const toolkit = composioToolkitSchema.safeParse(id);
  // Off, Composio's toolkits aren't in the catalog at all.
  if (!composio || key === undefined || !toolkit.success) {
    throw connectErrors.create("connect.catalog_entry_not_found");
  }
  return await composioTools(key, toolkit.data);
};
