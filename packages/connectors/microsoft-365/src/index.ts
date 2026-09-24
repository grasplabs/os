import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** Native Microsoft 365 MCP server (Graph). Tools are registered here. */
export const createServer = (): McpServer =>
  new McpServer({ name: "microsoft-365", version: "0.0.0" });
