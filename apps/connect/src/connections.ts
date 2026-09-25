import { connectErrors } from "@grasp-os/shared/connect";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { connections } from "./db/schema.ts";
import { mcpServer } from "./mcp.ts";
import type { McpServer } from "./mcp.ts";

// The connection registry: which connections exist, whose they are, and
// which MCP server carries out their actions.

export type Connection = typeof connections.$inferSelect;

/**
 * A Composio server's URL, as stored. Only HTTPS, and never with
 * credentials in it: those are added per call.
 */
const composioUrlSchema = z.url({ protocol: /^https$/u }).refine((url) => {
  const { username, password } = new URL(url);
  return username === "" && password === "";
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

/** The MCP server that carries out the connection's actions. */
export const serverOf = (connection: Connection): McpServer => {
  switch (connection.serverKind) {
    case "composio": {
      const url = composioUrlSchema.safeParse(connection.server);
      if (!url.success) {
        throw connectErrors.create("connect.server_unavailable");
      }
      return mcpServer(url.data, async (request) => await fetch(request));
    }
    case "native": {
      // Native connectors run in their own isolates, loaded through LOADER
      // with an egress allowlist. Until that loader exists, a native
      // connection has no server to reach, and nothing is sent anywhere.
      throw connectErrors.create("connect.server_unavailable");
    }
    default: {
      return connection.serverKind satisfies never;
    }
  }
};
