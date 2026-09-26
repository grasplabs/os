import { auditIdentifierMaxLength } from "@grasp-os/shared/audit";
import type { OAuthProvider } from "@grasp-os/shared/connect";
import { z } from "zod";

import {
  connectorManifestSchema,
  maskMetaKey,
  maxProvenanceItems,
  notPerformedMetaKey,
  provenanceMetaKey,
  resourceMetaKey,
} from "./manifest.ts";
import type { ActionManifest, ConnectorManifest, Route } from "./manifest.ts";

// How a native connector is written: its tools, each with what connect
// decides by (read-only or not, the one resource it acts on, the requests
// it sends), strict input and typed output; and the MCP server connect
// talks to, in the connector's own isolate.
//
// A connector reaches its provider with plain `fetch`. The isolate's only
// way out is connect's egress handler, which adds the connection's token
// and lets through only the requests the called tool declares: the token
// is never in the isolate, and nothing else is reachable (threat model R9).
// A fresh isolate serves each call, but code must still keep nothing in
// module state: it would be a bug the day that changes.

/** What a tool returns: its output, and the IDs of what it read. */
export interface ToolResult<Output> {
  output: Output;
  /** The provider's IDs of the resources the output came from. */
  provenance?: readonly string[];
}

export interface ToolDefinition<
  Input extends z.ZodObject,
  Output extends z.ZodObject,
> {
  /** The action's name, as permissions name it, such as `mail.list`. */
  name: string;
  description: string;
  /**
   * Strict all the way down (`z.strictObject`): unknown keys are refused,
   * never dropped, and there are no aliases or case-insensitive keys, so
   * nothing but `resource` can select a resource. `defineTool` refuses
   * input whose JSON Schema leaves anything open (`z.unknown()`,
   * `z.any()`, records, loose objects).
   *
   * What it can't see, reviewers must refuse: `z.preprocess` and
   * `.transform` run before or after the schema it checks, so they can
   * read a key under another name (an alias), or rename one, unseen.
   */
  input: Input;
  output: Output;
  /** Only a read-only tool runs without an idempotency key (R7). */
  readOnly: boolean;
  /** Whether it may destroy something; any tool that isn't read-only by default. */
  destructive?: boolean;
  /**
   * The one input property that selects the resource it acts on (a
   * mailbox, a calendar), so a permission can be held to one resource. No
   * other property, at any depth, may select a resource.
   */
  resource?: Extract<keyof z.input<Input>, string>;
  /**
   * Output fields (dotted paths, through arrays) that may be masked: each
   * must allow `null`, which is what a masked field becomes.
   */
  mask?: readonly string[];
  /**
   * Its inputs that search through maskable fields, with those fields'
   * names: `{ search: ["subject", "body"] }`. Connect refuses a call that
   * uses one while its permission masks any of those fields.
   */
  searches?: Partial<
    Record<Extract<keyof z.input<Input>, string>, readonly string[]>
  >;
  /**
   * The only requests it may send (threat model Q11). A parameter named
   * after the resource property (`{mailbox}`), in a path or a route's
   * `query`, must hold the resource a call's capability names, whenever it
   * names one. An `unbound` route can't be held to it: the tool must check
   * the resource in the provider's answer itself.
   */
  routes: readonly Route[];
  run: (input: z.output<Input>) => Promise<ToolResult<z.input<Output>>>;
}

/** What a caller may act on in a tool's error, besides its message. */
export interface ToolErrorDetails {
  /** What went wrong, for code to act on, such as `throttled`. */
  code: string;
  /** How long the provider asks callers to wait before trying again. */
  retryAfterSeconds?: number;
}

/**
 * An error whose message the caller may see, such as "No such message",
 * maybe with a code for callers to act on (`code`, `retryAfterSeconds`).
 * Any other error is reported as the action having failed.
 *
 * `notPerformed: true` says the tool did nothing at all, so it may be
 * tried again with the same idempotency key (`notPerformedMetaKey`): say,
 * the provider answered 429 to the tool's first and only write. Set it
 * only when that is certain. A write that may have reached the provider
 * (a timeout, a 5xx after sending) is not that, and neither is any failure
 * after an earlier write of the same call went through: so no shared
 * "429 means not performed" helper for tools that write more than once.
 * A read-only tool changes nothing, so it may set it for any failure
 * trying again may fix, such as a provider's 5xx.
 */
export class ToolError extends Error {
  readonly details: ToolErrorDetails | undefined;
  readonly notPerformed: boolean;

  constructor(
    message: string,
    {
      notPerformed = false,
      code,
      retryAfterSeconds,
    }: Partial<ToolErrorDetails> & { notPerformed?: boolean } = {}
  ) {
    super(message);
    this.name = "ToolError";
    this.notPerformed = notPerformed;
    this.details =
      code === undefined
        ? undefined
        : {
            code,
            ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
          };
  }
}

type JsonObject = Record<string, unknown>;

interface CallResult {
  content: { type: "text"; text: string }[];
  structuredContent?: JsonObject;
  isError?: boolean;
  _meta?: JsonObject;
}

/** A tool, as the server lists and calls it. */
export interface Tool {
  name: string;
  /** What connect decides the tool's calls by, before running any. */
  action: ActionManifest;
  /** As `tools/list` describes it. */
  description: JsonObject;
  call: (args: unknown) => Promise<CallResult>;
}

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The keywords that say what a JSON Schema node allows. */
const typeKeywords = ["type", "anyOf", "oneOf", "allOf", "const", "enum"];

const typesOf = (schema: JsonObject): unknown[] =>
  Array.isArray(schema.type) ? schema.type : [schema.type];

/**
 * Whether a JSON Schema allows only what it spells out, at every depth and
 * in every branch: each node names its type (an empty schema, as
 * `z.unknown()` and `z.any()` make, allows anything), each object names
 * its properties and refuses any other (`additionalProperties: false`),
 * and each array says what its items are. References and patterns count
 * as open.
 */
const isClosed = (schema: unknown): boolean => {
  if (schema === false) {
    return true;
  }
  if (
    !isObject(schema) ||
    !typeKeywords.some((keyword) => keyword in schema) ||
    ["$ref", "patternProperties", "not", "if", "dependentSchemas"].some(
      (keyword) => keyword in schema
    )
  ) {
    return false;
  }
  const types = typesOf(schema);
  const branches = [schema.anyOf, schema.oneOf, schema.allOf].flatMap(
    (branch): unknown[] => (Array.isArray(branch) ? branch : [])
  );
  const isObjectSchema = types.includes("object") || "properties" in schema;
  const properties = isObject(schema.properties) ? schema.properties : {};
  const objectClosed =
    !isObjectSchema ||
    (schema.additionalProperties === false &&
      Object.values(properties).every(isClosed));
  const prefixItems = Array.isArray(schema.prefixItems)
    ? schema.prefixItems
    : [];
  const arrayClosed =
    !(types.includes("array") || "items" in schema) ||
    ("items" in schema &&
      isClosed(schema.items) &&
      prefixItems.every(isClosed) &&
      (!("additionalItems" in schema) || isClosed(schema.additionalItems)));
  return branches.every(isClosed) && objectClosed && arrayClosed;
};

/** The node of a JSON Schema a dotted path leads to, through arrays. */
const nodeAt = (schema: unknown, path: string): unknown => {
  let node = schema;
  for (const key of path.split(".")) {
    while (isObject(node) && typesOf(node).includes("array")) {
      node = node.items;
    }
    node =
      isObject(node) && isObject(node.properties)
        ? node.properties[key]
        : undefined;
  }
  return node;
};

/** Whether a JSON Schema node allows `null`, in any of its branches. */
const allowsNull = (node: unknown): boolean =>
  isObject(node) &&
  (typesOf(node).includes("null") ||
    (Array.isArray(node.anyOf) && node.anyOf.some(allowsNull)));

const provenanceSchema = z
  .array(z.string().min(1).max(auditIdentifierMaxLength))
  .max(maxProvenanceItems);

/** An error result: its message, its code when it has one, and whether it did nothing. */
const failure = (
  text: string,
  details?: ToolErrorDetails,
  notPerformed = false
): CallResult => ({
  content: [{ type: "text", text }],
  ...(details === undefined
    ? {}
    : { structuredContent: { error: { message: text, ...details } } }),
  isError: true,
  ...(notPerformed ? { _meta: { [notPerformedMetaKey]: true } } : {}),
});

/** Where input didn't parse, without the values that were sent. */
const issuesOf = (error: z.ZodError): string =>
  error.issues
    .map((issue) => {
      const keys = issue.code === "unrecognized_keys" ? issue.keys : [];
      const at = [...issue.path, ...keys].map(String).join(".");
      return `${issue.code}${at === "" ? "" : ` at ${at}`}`;
    })
    .join("; ");

/**
 * A tool. Throws if it breaks the connector contract: input that isn't
 * strict everywhere, a resource that isn't one of its string properties.
 */
export const defineTool = <
  Input extends z.ZodObject,
  Output extends z.ZodObject,
>(
  definition: ToolDefinition<Input, Output>
): Tool => {
  const { name, input, output, resource, readOnly, routes } = definition;
  const inputSchema = z.toJSONSchema(input, { io: "input" });
  const outputSchema = z.toJSONSchema(output, { io: "output" });
  if (!isClosed(inputSchema)) {
    throw new Error(`${name}: its input must be strict objects throughout`);
  }
  for (const path of definition.mask ?? []) {
    const node = nodeAt(outputSchema, path);
    if (node === undefined) {
      throw new Error(`${name}: its output has no ${path} to mask`);
    }
    if (!allowsNull(node)) {
      throw new Error(`${name}: its ${path} must be nullable to be masked`);
    }
  }
  const resourceProperty: unknown =
    resource === undefined ? undefined : inputSchema.properties?.[resource];
  if (
    resource !== undefined &&
    (!isObject(resourceProperty) || resourceProperty.type !== "string")
  ) {
    throw new Error(`${name}: its resource must be a string property`);
  }
  const meta: JsonObject = {};
  if (resource !== undefined) {
    meta[resourceMetaKey] = resource;
  }
  if (definition.mask !== undefined) {
    meta[maskMetaKey] = [...definition.mask];
  }
  return {
    name,
    action: {
      routes: [...routes],
      readOnly,
      resource: resource ?? null,
      input: Object.keys(inputSchema.properties ?? {}),
      mask: [...(definition.mask ?? [])],
      searches: Object.fromEntries(
        Object.entries(definition.searches ?? {}).map(([key, fields]) => [
          key,
          [...(fields ?? [])],
        ])
      ),
    },
    description: {
      name,
      description: definition.description,
      inputSchema,
      outputSchema,
      annotations: {
        readOnlyHint: readOnly,
        destructiveHint: definition.destructive ?? !readOnly,
        openWorldHint: true,
      },
      _meta: meta,
    },
    call: async (args) => {
      const parsed = input.safeParse(args);
      if (!parsed.success) {
        return failure(`Invalid input: ${issuesOf(parsed.error)}`);
      }
      let result: ToolResult<z.input<Output>>;
      try {
        result = await definition.run(parsed.data);
      } catch (error) {
        return error instanceof ToolError
          ? failure(error.message, error.details, error.notPerformed)
          : failure("The action failed");
      }
      const checked = output.safeParse(result.output);
      const provenance = provenanceSchema.safeParse(result.provenance ?? []);
      if (!checked.success || !provenance.success) {
        return failure("The connector's result isn't what it declares");
      }
      const structured: JsonObject = checked.data;
      // Connect reads structured content only, so the output isn't sent a
      // second time as text: a file's content would take twice the room.
      return {
        content: [],
        structuredContent: structured,
        _meta: { [provenanceMetaKey]: provenance.data },
      };
    },
  };
};

export interface ConnectorDefinition {
  name: string;
  version: string;
  provider: OAuthProvider;
  scopes: readonly string[];
  hosts: readonly string[];
  tools: readonly Tool[];
}

/** A connector: what connect knows of it, and its MCP server. */
export interface Connector {
  manifest: ConnectorManifest;
  /** Answers one MCP request (Streamable HTTP, JSON responses, stateless). */
  fetch: (request: Request) => Promise<Response>;
}

/** The MCP revision the server speaks. */
const protocolVersion = "2025-06-18";

const requestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
});

const callParamsSchema = z.object({
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()).optional(),
});

/** JSON-RPC error codes. */
const parseError = -32_700;
const invalidRequest = -32_600;
const methodNotFound = -32_601;
const invalidParams = -32_602;

type Id = string | number | null;

const answer = (id: Id, result: unknown): Response =>
  Response.json({ jsonrpc: "2.0", id, result });

const refusal = (id: Id, code: number, message: string): Response =>
  Response.json({ jsonrpc: "2.0", id, error: { code, message } });

/**
 * A connector, from its tools. Throws if two tools share a name, or the
 * manifest they make isn't valid (a route to a host it doesn't list).
 */
export const defineConnector = (definition: ConnectorDefinition): Connector => {
  const tools = new Map<string, Tool>();
  for (const tool of definition.tools) {
    if (tools.has(tool.name)) {
      throw new Error(`Two tools are named ${tool.name}`);
    }
    tools.set(tool.name, tool);
  }
  const manifest = connectorManifestSchema.parse({
    name: definition.name,
    version: definition.version,
    provider: definition.provider,
    scopes: definition.scopes,
    hosts: definition.hosts,
    actions: Object.fromEntries(
      definition.tools.map(({ name, action }) => [name, action])
    ),
  });

  const respond = async (
    id: Id,
    method: string,
    params: JsonObject
  ): Promise<Response> => {
    switch (method) {
      case "initialize": {
        return answer(id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: manifest.name, version: manifest.version },
        });
      }
      case "ping": {
        return answer(id, {});
      }
      case "tools/list": {
        return answer(id, {
          tools: [...tools.values()].map(({ description }) => description),
        });
      }
      case "tools/call": {
        const call = callParamsSchema.safeParse(params);
        // Names match exactly: no case folding, no normalising.
        const tool = call.success ? tools.get(call.data.name) : undefined;
        if (tool === undefined) {
          return refusal(id, invalidParams, "No such tool");
        }
        return answer(id, await tool.call(call.data?.arguments ?? {}));
      }
      default: {
        return refusal(id, methodNotFound, "No such method");
      }
    }
  };

  return {
    manifest,
    fetch: async (request) => {
      if (request.method !== "POST") {
        return new Response(null, { status: 405 });
      }
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return refusal(null, parseError, "Not JSON");
      }
      const message = requestSchema.safeParse(body);
      if (!message.success) {
        return refusal(null, invalidRequest, "Not a JSON-RPC request");
      }
      const { id, method, params = {} } = message.data;
      // A notification (no ID) gets no answer.
      if (id === undefined) {
        return new Response(null, { status: 202 });
      }
      return await respond(id, method, params);
    },
  };
};
