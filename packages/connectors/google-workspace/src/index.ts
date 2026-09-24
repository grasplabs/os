import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** Native Google Workspace MCP server. Tools are registered here. */
export const createServer = (): McpServer =>
  new McpServer({ name: "google-workspace", version: "0.0.0" });
