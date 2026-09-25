import { auditIdentifierMaxLength } from "@grasp-os/shared/audit";
import type { Json } from "@grasp-os/shared/json";
import { z } from "zod";

// A minimal Model Context Protocol client over the Streamable HTTP
// transport: `initialize`, `tools/list` and `tools/call`, nothing else.
// Everything a server sends is untrusted: each response is read up to a
// size cap and validated before anything uses it.
//
// It talks through a `fetch` it is given, so any MCP server connect can
// send a Request to fits: a Composio server over the internet, or a native
// connector in its own isolate. One client makes one call: it starts a
// fresh session and leaves nothing behind for the next call to trip over.

/** The MCP revision connect speaks. */
const protocolVersion = "2025-06-18";

/** Largest response connect reads from an MCP server, in bytes. */
const maxResponseBytes = 1024 * 1024;

/** How long one MCP request may take, response included. */
const requestTimeoutMs = 30_000;

/** Most `tools/list` pages read while looking for a tool. */
const maxToolPages = 20;

/** Most resource IDs one call may report reading. */
export const maxProvenanceItems = 1000;

/**
 * Tool `_meta` key: the name of the input property that holds the one
 * resource (a mailbox, a calendar) a call of the tool acts on. Only a tool
 * that names it can be called with a capability for a single resource.
 */
export const resourceMetaKey = "grasp-os/resource";

/** Result `_meta` key: the IDs of the resources the call read. */
export const provenanceMetaKey = "grasp-os/provenance";

/** Sends one request to the server. */
export type McpFetch = (request: Request) => Promise<Response>;

/** A tool, as far as connect decides anything by it. */
export interface McpTool {
  name: string;
  /**
   * Only a tool the server declares read-only (`readOnlyHint: true`) is a
   * read. Anything else, a missing or malformed hint too, is a side effect.
   */
  readOnly: boolean;
  /** The input property holding the resource it acts on, if it names one. */
  resourceField: string | undefined;
}

/** What a tool call returned. */
export interface McpToolResult {
  /** Its structured content, or else its text content, as JSON text. */
  output: string;
  provenance: string[];
  /** The tool reported an error instead of a result. */
  isError: boolean;
}

/**
 * A request to the server failed. `declined` is true only when the server
 * answered that it didn't take the request (unauthorised, redirected, or a
 * JSON-RPC error for a malformed or unknown request). Anything else, a
 * dropped connection or an unreadable reply, leaves open whether a tool
 * call ran before it failed.
 */
export class McpError extends Error {
  readonly declined: boolean;

  constructor(message: string, declined = false, cause?: unknown) {
    super(message, { cause });
    this.name = "McpError";
    this.declined = declined;
  }
}

/** JSON-RPC errors that mean the server refused the request as sent. */
const refusedRequestCodes: ReadonlySet<number> = new Set([
  -32_700, -32_600, -32_601, -32_602,
]);

/** HTTP statuses that mean the server didn't act on the request. */
const isDeclinedStatus = (status: number): boolean =>
  status === 401 || status === 403 || (status >= 300 && status < 400);

const rpcResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
});
type RpcResponse = z.infer<typeof rpcResponseSchema>;

const initializeResultSchema = z.object({ protocolVersion: z.string().min(1) });

const metaSchema = z.record(z.string(), z.unknown()).optional();

const toolsPageSchema = z.object({
  tools: z.array(
    z.object({
      name: z.string(),
      annotations: z.object({ readOnlyHint: z.unknown() }).partial().optional(),
      _meta: metaSchema,
    })
  ),
  nextCursor: z.string().optional(),
});

const callResultSchema = z.object({
  content: z
    .array(z.object({ type: z.string(), text: z.string().optional() }))
    .default([]),
  structuredContent: z.record(z.string(), z.json()).optional(),
  isError: z.boolean().default(false),
  _meta: metaSchema,
});

const provenanceSchema = z
  .array(z.string().min(1).max(auditIdentifierMaxLength))
  .max(maxProvenanceItems)
  .default([]);

const sseEventEnd = /\r?\n\r?\n/u;
const sseLine = /\r?\n/u;

/** The data of each complete event in an event stream's text. */
const sseData = (text: string): string[] =>
  text
    .split(sseEventEnd)
    .slice(0, -1)
    .map((event) =>
      event
        .split(sseLine)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trimStart())
        .join("\n")
    );

const parseMessage = (text: string): RpcResponse | undefined => {
  try {
    const message = rpcResponseSchema.safeParse(JSON.parse(text));
    return message.success ? message.data : undefined;
  } catch {
    return undefined;
  }
};

/** The answer to request `id` among the complete events of a stream. */
const answerIn = (stream: string, id: number): RpcResponse | undefined =>
  sseData(stream)
    .map(parseMessage)
    .find((message) => message?.id === id);

/**
 * The answer to request `id`: the JSON body, or the first event carrying it
 * in an event stream (which the server may keep open after it). Reads at
 * most {@link maxResponseBytes}.
 */
const readResponse = async (
  response: Response,
  id: number
): Promise<RpcResponse | undefined> => {
  const isStream = (response.headers.get("content-type") ?? "").startsWith(
    "text/event-stream"
  );
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- a stream is read in order
      const chunk = await reader?.read();
      if (chunk === undefined || chunk.done) {
        break;
      }
      const bytesRead: unknown = chunk.value;
      if (!(bytesRead instanceof Uint8Array)) {
        throw new McpError("The response isn't a byte stream");
      }
      bytes += bytesRead.byteLength;
      if (bytes > maxResponseBytes) {
        throw new McpError(`The response is over ${maxResponseBytes} bytes`);
      }
      text += decoder.decode(bytesRead, { stream: true });
      const answer = isStream ? answerIn(text, id) : undefined;
      if (answer !== undefined) {
        return answer;
      }
    }
  } finally {
    // Stops a stream the server keeps open once the answer is in.
    await reader?.cancel();
  }
  if (isStream) {
    return answerIn(`${text}\n\n`, id);
  }
  const message = parseMessage(text);
  return message?.id === id ? message : undefined;
};

const toolOf = (tool: z.infer<typeof toolsPageSchema>["tools"][number]) => {
  const resourceField = tool._meta?.[resourceMetaKey];
  return {
    name: tool.name,
    readOnly: tool.annotations?.readOnlyHint === true,
    resourceField:
      typeof resourceField === "string" ? resourceField : undefined,
  };
};

const resultOf = (result: unknown): McpToolResult => {
  const parsed = callResultSchema.safeParse(result);
  const provenance = provenanceSchema.safeParse(
    parsed.data?._meta?.[provenanceMetaKey]
  );
  if (!parsed.success || !provenance.success) {
    throw new McpError("The tool's result isn't one connect can read");
  }
  const { structuredContent, content, isError } = parsed.data;
  const text = content
    .map((block) => block.text)
    .filter((part) => part !== undefined)
    .join("\n");
  return {
    output: JSON.stringify(structuredContent ?? text),
    provenance: provenance.data,
    isError,
  };
};

/** The one MCP server a connection's calls go to. */
export interface McpServer {
  /** The tool named exactly `name`, or undefined if the server has none. */
  tool: (name: string) => Promise<McpTool | undefined>;
  /** Calls the tool once. Throws {@link McpError} if it didn't answer. */
  call: (name: string, input: Record<string, Json>) => Promise<McpToolResult>;
}

/** A client for the MCP server at `endpoint`, reached through `send`. */
export const mcpServer = (endpoint: string, send: McpFetch): McpServer => {
  let nextId = 1;
  let sessionId: string | null = null;
  let version = protocolVersion;
  let session: Promise<void> | undefined;

  const post = async (body: object): Promise<Response> => {
    const headers = new Headers({
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": version,
    });
    if (sessionId !== null) {
      headers.set("mcp-session-id", sessionId);
    }
    const response = await send(
      new Request(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        // A redirect could carry the request somewhere else: never follow.
        redirect: "manual",
        signal: AbortSignal.timeout(requestTimeoutMs),
      })
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new McpError(
        `The server answered ${response.status}`,
        isDeclinedStatus(response.status)
      );
    }
    return response;
  };

  const request = async (method: string, params: object): Promise<unknown> => {
    const id = nextId;
    nextId += 1;
    let message: RpcResponse | undefined;
    try {
      const response = await post({ jsonrpc: "2.0", id, method, params });
      if (method === "initialize") {
        sessionId = response.headers.get("mcp-session-id");
      }
      message = await readResponse(response, id);
    } catch (error) {
      // A connection that failed or timed out may have delivered the request.
      throw error instanceof McpError
        ? error
        : new McpError(`${method} failed`, false, error);
    }
    if (message === undefined) {
      throw new McpError(`No readable answer to ${method}`);
    }
    if (message.error !== undefined) {
      throw new McpError(
        `The server refused ${method} (${message.error.code})`,
        refusedRequestCodes.has(message.error.code)
      );
    }
    return message.result;
  };

  const start = async (): Promise<void> => {
    const initialized = initializeResultSchema.safeParse(
      await request("initialize", {
        protocolVersion,
        capabilities: {},
        clientInfo: { name: "grasp-os-connect", version: "1.0.0" },
      })
    );
    if (!initialized.success) {
      throw new McpError("The server didn't initialize");
    }
    version = initialized.data.protocolVersion;
    try {
      const notified = await post({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      });
      await notified.body?.cancel();
    } catch (error) {
      throw error instanceof McpError
        ? error
        : new McpError("notifications/initialized failed", false, error);
    }
  };

  const started = async (): Promise<void> => {
    session ??= start();
    await session;
  };

  return {
    tool: async (name) => {
      await started();
      let found: McpTool | undefined;
      let cursor: string | undefined;
      let pages = 0;
      do {
        const tools = toolsPageSchema.safeParse(
          // oxlint-disable-next-line no-await-in-loop -- pages come one after another
          await request("tools/list", cursor === undefined ? {} : { cursor })
        );
        if (!tools.success) {
          throw new McpError("The server's tool list isn't readable");
        }
        // Names match exactly: no case folding, no normalising.
        const tool = tools.data.tools.find((each) => each.name === name);
        found = tool === undefined ? undefined : toolOf(tool);
        cursor = tools.data.nextCursor;
        pages += 1;
      } while (
        found === undefined &&
        cursor !== undefined &&
        pages < maxToolPages
      );
      return found;
    },
    call: async (name, input) => {
      await started();
      return resultOf(await request("tools/call", { name, arguments: input }));
    },
  };
};
