import { connectErrors } from "@grasp-os/shared/connect";
import type { Json } from "@grasp-os/shared/json";

import type { Connection } from "./connections.ts";
import type { McpTool, McpToolResult } from "./mcp.ts";

// What connect takes from an MCP server's description of its own tools.
// Only native connectors are ours, so only their word counts: for anything
// else, every tool is a side effect and no tool can be held to one
// resource, until the admin's per-tool allowlist for Composio toolkits
// replaces the server's word.

type ServerKind = Connection["serverKind"];

/** A plain identifier: no dots, brackets or other paths into the input. */
const resourceFieldPattern = /^[A-Za-z_]\w*$/u;

/**
 * Whether a call of `tool` may change something. Only a native connector's
 * tool that declares itself read-only (`readOnlyHint: true`) is a read.
 */
export const hasSideEffect = (kind: ServerKind, tool: McpTool): boolean =>
  kind !== "native" || !tool.readOnly;

/**
 * Keeps a call for one resource on that resource. The capability names the
 * resource, but the call's target is in its free-form input, so the tool
 * must say which input property holds it, and that property must name
 * exactly the capability's resource. The input may hold only properties
 * the tool's input schema declares, so no other spelling of the resource
 * property (another case, an alias) slips past. A tool that says none of
 * this can't be called for one resource at all.
 */
export const checkResourceScope = (
  resource: string | null,
  kind: ServerKind,
  tool: McpTool,
  input: Readonly<Record<string, Json>>
): void => {
  if (resource === null) {
    return;
  }
  const { resourceField, inputProperties } = tool;
  const declared = new Set(inputProperties);
  const inScope =
    kind === "native" &&
    resourceField !== undefined &&
    resourceFieldPattern.test(resourceField) &&
    declared.has(resourceField) &&
    Object.keys(input).every((key) => declared.has(key)) &&
    input[resourceField] === resource;
  if (!inScope) {
    throw connectErrors.create("connect.resource_out_of_scope");
  }
};

/**
 * Whether a tool's error result means the call did nothing at all
 * (`notPerformedMetaKey`), so its idempotency key is free again. Only a
 * native connector is taken at its word: a remote server's tool that acted
 * and then said it hadn't would have its side effect run twice.
 */
export const didNothing = (kind: ServerKind, result: McpToolResult): boolean =>
  kind === "native" && result.notPerformed;
