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
// (`native`) or Composio's cloud (`composio`).

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
        logo: null,
        toolCount: Object.keys(connector.manifest.actions).length,
      },
    ];
  });

/** Most pages of Composio's lists read for one answer. */
const maxPages = 5;

/** Items per page asked of Composio: its maximum. */
const pageSize = 1000;

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
      logo: z.string().nullish(),
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

/** A logo URL, only if it is HTTPS without credentials in it. */
const logoOf = (logo: string | null | undefined): string | null => {
  if (logo === undefined || logo === null || !URL.canParse(logo)) {
    return null;
  }
  const url = new URL(logo);
  return url.protocol === "https:" && url.username === "" && url.password === ""
    ? url.href
    : null;
};

/**
 * Every item of one of Composio's lists at `path`, page after page, up to
 * {@link maxPages}, each item as `schema` reads it; items it can't read are
 * left out.
 */
const composioList = async <Item>(
  key: string,
  path: string,
  schema: z.ZodType<Item>
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
      break;
    }
  }
  return items;
};

/**
 * Composio's toolkits that can be connected with Composio's own app for
 * them (managed auth), so an admin needs nothing but their consent.
 */
const composioEntries = async (key: string): Promise<CatalogEntry[]> => {
  const toolkits = await composioList(
    key,
    "/toolkits?sort_by=alphabetically",
    toolkitSchema
  );
  return toolkits
    .filter(({ composio_managed_auth_schemes: managed }) => managed.length > 0)
    .map(({ slug, name, meta }) => ({
      source: "composio",
      id: slug,
      name,
      logo: logoOf(meta.logo),
      categories: meta.categories.flatMap((category) => {
        const parsed = categorySchema.safeParse(category);
        return parsed.success ? [parsed.data.name] : [];
      }),
      toolCount: meta.tools_count,
    }));
};

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
    return {
      entries: [...native, ...(await composioEntries(key))],
      composio: "listed",
    };
  } catch (error) {
    if (!(error instanceof ComposioError)) {
      throw error;
    }
    log.warn("catalog.composio_unavailable", errorFields(error));
    return { entries: native, composio: "unavailable" };
  }
};

/**
 * A Composio toolkit's tools, by the names its MCP server gives them. A
 * toolkit Composio lists no tools for, or refuses to list tools for, isn't
 * one: every toolkit in the catalog has tools, and one without any
 * couldn't do anything.
 */
const composioTools = async (
  key: string,
  toolkit: string
): Promise<CatalogTool[]> => {
  let tools: z.infer<typeof toolSchema>[];
  try {
    tools = await composioList(
      key,
      `/tools?${new URLSearchParams({ toolkit_slug: toolkit }).toString()}`,
      toolSchema
    );
  } catch (error) {
    if (!(error instanceof ComposioError)) {
      throw error;
    }
    // Composio's answer to a toolkit it doesn't know.
    if (error.status === 400 || error.status === 404) {
      throw connectErrors.create("connect.catalog_entry_not_found");
    }
    log.warn("catalog.composio_unavailable", errorFields(error));
    throw connectErrors.create("connect.catalog_unavailable");
  }
  if (tools.length === 0) {
    throw connectErrors.create("connect.catalog_entry_not_found");
  }
  return tools.map(({ slug, description }) => ({
    name: slug,
    description: description ?? null,
  }));
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
