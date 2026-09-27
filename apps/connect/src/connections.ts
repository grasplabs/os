import {
  composioToolName,
  composioToolsSchema,
  connectErrors,
  connectionOwnersSchema,
} from "@grasp-os/shared/connect";
import type { ConnectionOwner } from "@grasp-os/shared/connect";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { composioKey } from "./composio.ts";
import { connections } from "./db/schema.ts";
import { mcpServer } from "./mcp.ts";
import type { McpServer } from "./mcp.ts";

// The connection registry: which connections exist, whose they are, and
// which MCP server carries out their actions.

export type Connection = typeof connections.$inferSelect;

/**
 * Where Composio serves the MCP servers it creates: `composio.mcp.generate`
 * returns `https://backend.composio.dev/v3/mcp/<server id>?user_id=...`.
 */
const composioMcpHost = "backend.composio.dev";
const composioMcpPath = "/v3/mcp/";

/**
 * A Composio server's URL, as stored: HTTPS on Composio's MCP host, and
 * never with credentials in it (connect's key is added per call, in a
 * header). Anything else is never called, whatever the registry says.
 */
const composioUrlSchema = z.url({ protocol: /^https$/u }).refine((url) => {
  const { host, pathname, username, password } = new URL(url);
  return (
    host === composioMcpHost &&
    pathname.startsWith(composioMcpPath) &&
    username === "" &&
    password === ""
  );
});

/**
 * The connection a call may use: it exists, it is someone's personal
 * connection only if the call acts for that person, and it is active. Never
 * more than the person (R5): a personal connection holds one person's own
 * account, so an App or agent acting for anyone else can't reach it, even
 * with a permission for it.
 */
export const usableConnection = async (
  db: D1Database,
  connectionId: string,
  onBehalfOf: string
): Promise<Connection> => {
  const connection = await drizzle(db)
    .select()
    .from(connections)
    .where(eq(connections.id, connectionId))
    .get();
  if (connection === undefined) {
    throw connectErrors.create("connect.connection_not_found");
  }
  // Before the status, so nobody else learns anything about it.
  if (
    connection.scope === "personal" &&
    connection.ownerUserId !== onBehalfOf
  ) {
    throw connectErrors.create("connect.not_owner");
  }
  if (connection.status !== "active") {
    throw connectErrors.create("connect.connection_inactive");
  }
  return connection;
};

/** Whether `url` is one connect would call as a Composio server. */
export const isComposioServerUrl = (url: string): boolean =>
  composioUrlSchema.safeParse(url).success;

/**
 * The tools the admin allowed on a Composio connection, as stored: none
 * when they aren't recorded or can't be read.
 */
const storedTools = ({ tools }: Pick<Connection, "tools">) => {
  if (tools === null) {
    return [];
  }
  let stored: unknown;
  try {
    stored = JSON.parse(tools);
  } catch {
    return [];
  }
  return composioToolsSchema.safeParse(stored).data ?? [];
};

/** The names of the tools the admin allowed on a Composio connection. */
export const allowedToolNames = (connection: Pick<Connection, "tools">) =>
  storedTools(connection).map(composioToolName);

/**
 * What the admin said about a tool they allowed on a Composio connection
 * (`ComposioToolRule`): whether it only reads, and which input property
 * names its resource.
 */
export interface ToolRule {
  read: boolean;
  resource: string | undefined;
}

/**
 * The admin's rule for `action` on a Composio connection, if they allowed
 * it. One whose tools aren't recorded, or can't be read, allows none. A
 * tool allowed by name alone is a side effect with no resource.
 */
export const allowedTool = (
  connection: Connection,
  action: string
): ToolRule | undefined => {
  const tool = storedTools(connection).find(
    (each) => composioToolName(each) === action
  );
  if (tool === undefined) {
    return undefined;
  }
  return typeof tool === "string"
    ? { read: false, resource: undefined }
    : { read: tool.read === true, resource: tool.resource };
};

/**
 * The Composio MCP server behind the connection, if its URL is one, with
 * connect's Composio key on each request (Composio requires it), and
 * never while the key is unset.
 */
export const composioServer = (env: Env, connection: Connection): McpServer => {
  const url = composioUrlSchema.safeParse(connection.server);
  const key = composioKey(env);
  if (!url.success || key === undefined) {
    throw connectErrors.create("connect.server_unavailable");
  }
  return mcpServer(url.data, async (request) => {
    const headers = new Headers(request.headers);
    headers.set("x-api-key", key);
    return await fetch(new Request(request, { headers }));
  });
};

/**
 * Whose each connection `request` names is (`ConnectApi.connectionOwners`),
 * disconnected ones too: what an App read through a connection before it
 * was disconnected is still its owner's alone. Unknown IDs are left out.
 */
export const connectionOwners = async (
  db: D1Database,
  request: unknown
): Promise<ConnectionOwner[]> => {
  const ids = connectErrors.parse(
    "connect.invalid",
    connectionOwnersSchema,
    request
  );
  if (ids.length === 0) {
    return [];
  }
  return await drizzle(db)
    .select({ id: connections.id, ownerUserId: connections.ownerUserId })
    .from(connections)
    .where(inArray(connections.id, ids));
};
