/**
 * A stand-in for an MCP server behind a connection, such as a Composio
 * toolkit's: the outside system connect calls. It is a real MCP server (the
 * official SDK's, over Streamable HTTP) at its own URL, answering connect's
 * outbound requests, so connect runs unchanged. Tests choose its tools,
 * what they return, and how the network between them fails, and read back
 * which tools actually ran.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { afterEach, beforeEach, vi } from "vite-plus/test";
import { z } from "zod";

export interface FakeTool {
  name: string;
  /** Declared read-only (`readOnlyHint: true`). */
  readOnly?: boolean;
  /** Declared as the input property naming the resource it acts on. */
  resourceField?: string;
  /** What running it with `input` returns. */
  run: (input: Record<string, unknown>) => FakeResult | Promise<FakeResult>;
}

export interface FakeResult {
  output: Record<string, unknown>;
  /** Content blocks to answer with instead of `output`, such as an image. */
  content?: { type: "image"; data: string; mimeType: string }[];
  /** The IDs of the resources it read. */
  provenance?: string[];
  /** It failed, and says so in its result. */
  isError?: boolean;
}

/**
 * How the next `tools/call` fares on the way: `ok`, `drop` (it reaches the
 * server and runs, but the answer is lost), or `unauthorised` (the server
 * turns it away with a 401 before running it).
 */
export type Network = "ok" | "drop" | "unauthorised";

interface Ran {
  tool: string;
  input: Record<string, unknown>;
}

const isToolCall = (body: unknown): boolean =>
  typeof body === "object" &&
  body !== null &&
  "method" in body &&
  body.method === "tools/call";

const serverWith = (tools: readonly FakeTool[], ran: Ran[]): McpServer => {
  const server = new McpServer({ name: "fake", version: "1.0.0" });
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        inputSchema: z.looseObject({}),
        annotations: { readOnlyHint: tool.readOnly ?? false },
        _meta:
          tool.resourceField === undefined
            ? undefined
            : { "grasp-os/resource": tool.resourceField },
      },
      async (input: Record<string, unknown>) => {
        ran.push({ tool: tool.name, input });
        const { output, content, provenance, isError } = await tool.run(input);
        return {
          content: content ?? [
            { type: "text" as const, text: JSON.stringify(output) },
          ],
          structuredContent: content === undefined ? output : undefined,
          isError,
          _meta:
            provenance === undefined
              ? undefined
              : { "grasp-os/provenance": provenance },
        };
      }
    );
  }
  return server;
};

/**
 * An MCP server at `url` with `tools`, for each test in the file. `stream`
 * makes it answer in event streams instead of JSON bodies.
 */
export const fakeMcpServer = (
  url: string,
  tools: readonly FakeTool[],
  { stream = false }: { stream?: boolean } = {}
) => {
  const state: {
    /** Every tool run, in order. */
    ran: Ran[];
    /** Every request connect sent to it. */
    requests: number;
    /** How the next tool call fares; back to `ok` after it. */
    network: Network;
  } = { ran: [], requests: 0, network: "ok" };

  const answer = async (request: Request): Promise<Response> => {
    state.requests += 1;
    const body: unknown = await request.clone().json();
    const network = isToolCall(body) ? state.network : "ok";
    if (isToolCall(body)) {
      state.network = "ok";
    }
    if (network === "unauthorised") {
      return new Response("Unauthorized", { status: 401 });
    }
    // Stateless, as a server behind a load balancer: one server per request.
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: !stream,
    });
    await serverWith(tools, state.ran).connect(transport);
    const response = await transport.handleRequest(request);
    if (network === "drop") {
      await response.text();
      throw new TypeError("Network connection lost.");
    }
    return response;
  };

  beforeEach(() => {
    state.ran = [];
    state.requests = 0;
    state.network = "ok";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      if (request.url !== url) {
        throw new Error(`Unexpected outbound request to ${request.url}`);
      }
      return await answer(request);
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  return state;
};
