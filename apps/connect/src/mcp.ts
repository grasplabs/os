import {
  mcpProtocolVersion,
  notPerformedMetaKey,
  provenanceMetaKey,
  provenanceSchema,
  resourceMetaKey,
} from "@grasp-os/connector-kit/manifest";
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

/**
 * Largest response connect reads from an MCP server, by default, in bytes;
 * a native connector's may be 16 MiB (`nativeResponseBytes`).
 */
const maxResponseBytes = 1024 * 1024;

/** How long one call may take, all its MCP requests together. */
export const callTimeoutMs = 30_000;

/** Most `tools/list` pages read while looking for a tool. */
const maxToolPages = 20;

/** Sends one request to the server. */
type McpFetch = (request: Request) => Promise<Response>;

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
  /** The properties its input schema declares, if it declares any. */
  inputProperties: readonly string[] | undefined;
}

/** What a tool call returned. */
export interface McpToolResult {
  /**
   * Its structured content, or else its text, or else its content blocks
   * as they are, as JSON text.
   */
  output: string;
  provenance: string[];
  /** The tool reported an error instead of a result. */
  isError: boolean;
  /**
   * The tool says it reported an error without doing anything
   * (`notPerformedMetaKey`). Only a server connect trusts is taken at its
   * word on this (policy.ts).
   */
  notPerformed: boolean;
}

/**
 * A request to the server failed. `declined` is true only when the request
 * provably never reached a tool: the server refused it as unauthorised
 * (401, 403), couldn't parse it, or has no such method. Anything else, a
 * dropped connection, an unreadable reply, a 429 (a server of its own
 * making may send one for its provider's, after a write), or a JSON-RPC
 * error a tool may throw after acting (such as invalid params), leaves
 * open whether the call ran.
 */
export class McpError extends Error {
  readonly declined: boolean;

  constructor(message: string, declined = false, cause?: unknown) {
    super(message, { cause });
    this.name = "McpError";
    this.declined = declined;
  }
}

/** JSON-RPC errors raised before any tool runs: parse error, no such method. */
const refusedRequestCodes: ReadonlySet<number> = new Set([-32_700, -32_601]);

/**
 * HTTP statuses that mean the server didn't act on the request. This
 * assumes a server sends them only before any tool runs, as its transport
 * does: a tool's own answer, error or not, comes in a 200.
 */
const isDeclinedStatus = (status: number): boolean =>
  status === 401 || status === 403;

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
      inputSchema: z
        .object({ properties: z.record(z.string(), z.unknown()).optional() })
        .optional(),
      _meta: metaSchema,
    })
  ),
  nextCursor: z.string().optional(),
});

const callResultSchema = z.object({
  content: z.array(z.record(z.string(), z.json())).default([]),
  structuredContent: z.record(z.string(), z.json()).optional(),
  isError: z.boolean().default(false),
  _meta: metaSchema,
});

const reportedProvenanceSchema = provenanceSchema.default([]);

const sseEventEnd = /\r?\n\r?\n/u;
const sseLine = /\r?\n/u;

const parseMessage = (text: string): RpcResponse | undefined => {
  try {
    const message = rpcResponseSchema.safeParse(JSON.parse(text));
    return message.success ? message.data : undefined;
  } catch {
    return undefined;
  }
};

/** The JSON-RPC message in one event of a stream, if it carries one. */
const eventMessage = (event: string): RpcResponse | undefined =>
  parseMessage(
    event
      .split(sseLine)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trimStart())
      .join("\n")
  );

/**
 * Reads an event stream as it arrives, one complete event at a time, and
 * keeps only the incomplete rest: many tiny events cost no more than a few
 * large ones.
 */
const eventReader = (id: number) => {
  let pending = "";
  const take = (): RpcResponse | undefined => {
    for (;;) {
      const end = sseEventEnd.exec(pending);
      if (end === null) {
        return undefined;
      }
      const message = eventMessage(pending.slice(0, end.index));
      pending = pending.slice(end.index + end[0].length);
      if (message?.id === id) {
        return message;
      }
    }
  };
  return {
    add: (text: string): RpcResponse | undefined => {
      pending += text;
      return take();
    },
    /** The stream ended: its last event may lack the closing blank line. */
    end: (): RpcResponse | undefined => {
      const message = eventMessage(pending);
      pending = "";
      return message?.id === id ? message : undefined;
    },
  };
};

/**
 * The answer to request `id`: the JSON body, or the first event carrying it
 * in an event stream (which the server may keep open after it). Reads at
 * most `maxBytes`.
 */
const readResponse = async (
  response: Response,
  id: number,
  maxBytes: number
): Promise<RpcResponse | undefined> => {
  const isStream = (response.headers.get("content-type") ?? "").startsWith(
    "text/event-stream"
  );
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  const events = eventReader(id);
  const parts: string[] = [];
  let bytes = 0;
  const add = (text: string): RpcResponse | undefined => {
    if (isStream) {
      return events.add(text);
    }
    parts.push(text);
    return undefined;
  };
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
      if (bytes > maxBytes) {
        throw new McpError(`The response is over ${maxBytes} bytes`);
      }
      const answer = add(decoder.decode(bytesRead, { stream: true }));
      if (answer !== undefined) {
        return answer;
      }
    }
  } finally {
    // Stops a stream the server keeps open once the answer is in.
    await reader?.cancel();
  }
  const answer = add(decoder.decode());
  if (isStream) {
    return answer ?? events.end();
  }
  const message = parseMessage(parts.join(""));
  return message?.id === id ? message : undefined;
};

const toolOf = (
  tool: z.infer<typeof toolsPageSchema>["tools"][number]
): McpTool => {
  const resourceField = tool._meta?.[resourceMetaKey];
  const properties = tool.inputSchema?.properties;
  return {
    name: tool.name,
    readOnly: tool.annotations?.readOnlyHint === true,
    resourceField:
      typeof resourceField === "string" ? resourceField : undefined,
    inputProperties:
      properties === undefined ? undefined : Object.keys(properties),
  };
};

const resultOf = (result: unknown): McpToolResult => {
  const parsed = callResultSchema.safeParse(result);
  const provenance = reportedProvenanceSchema.safeParse(
    parsed.data?._meta?.[provenanceMetaKey]
  );
  if (!parsed.success || !provenance.success) {
    throw new McpError("The tool's result isn't one connect can read");
  }
  const { structuredContent, content, isError, _meta: meta } = parsed.data;
  const texts = content.map((block) =>
    block.type === "text" && typeof block.text === "string"
      ? block.text
      : undefined
  );
  const text = texts.every((part) => part !== undefined)
    ? texts.join("\n")
    : undefined;
  return {
    // Other content (images, resources) goes as the blocks themselves.
    output: JSON.stringify(structuredContent ?? text ?? content),
    provenance: provenance.data,
    isError,
    notPerformed: isError && meta?.[notPerformedMetaKey] === true,
  };
};

/** The one MCP server a connection's calls go to. */
export interface McpServer {
  /** The tool named exactly `name`, or undefined if the server has none. */
  tool: (name: string) => Promise<McpTool | undefined>;
  /** Calls the tool once. Throws {@link McpError} if it didn't answer. */
  call: (name: string, input: Record<string, Json>) => Promise<McpToolResult>;
}

/**
 * A client for the MCP server at `endpoint`, reached through `send`,
 * reading responses of up to `maxBytes`.
 */
export const mcpServer = (
  endpoint: string,
  send: McpFetch,
  maxBytes: number = maxResponseBytes
): McpServer => {
  let nextId = 1;
  let sessionId: string | null = null;
  let version = mcpProtocolVersion;
  let session: Promise<void> | undefined;
  // One deadline for the whole call, however many requests it takes.
  const deadline = AbortSignal.timeout(callTimeoutMs);

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
        signal: deadline,
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
      message = await readResponse(response, id, maxBytes);
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
        protocolVersion: mcpProtocolVersion,
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
