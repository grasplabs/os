import type { CapabilityClaims } from "@grasp-os/shared/capability";
import { connectErrors } from "@grasp-os/shared/connect";
import type { ConnectCall, ConnectResult } from "@grasp-os/shared/connect";
import type { Json } from "@grasp-os/shared/json";

import { serverOf, usableConnection } from "./connections.ts";
import { hashCall, idempotencyStore } from "./idempotency.ts";
import { McpError } from "./mcp.ts";
import type { McpServer, McpTool, McpToolResult } from "./mcp.ts";

/** A call connect carried out (or answered from its stored result). */
export interface CallDone {
  result: ConnectResult;
  sideEffect: boolean;
  replayed: boolean;
}

/** Knows once the action is found whether it has a side effect. */
export interface CallProgress {
  sideEffect?: boolean;
}

type Input = Record<string, Json>;

const isInput = (input: Json): input is Input =>
  typeof input === "object" && input !== null && !Array.isArray(input);

/**
 * Keeps a call for one resource on that resource. The capability names the
 * resource, but the call's target is in its free-form input, in the
 * property the tool declares for it: that property must name exactly the
 * capability's resource. A tool that declares none can't be called for one
 * resource at all, since nothing shows which resource it would touch.
 */
const checkResourceScope = (
  resource: string | null,
  tool: McpTool,
  input: Input
): void => {
  if (resource === null) {
    return;
  }
  const inScope =
    tool.resourceField !== undefined && input[tool.resourceField] === resource;
  if (!inScope) {
    throw connectErrors.create("connect.resource_out_of_scope");
  }
};

/** The tool's result, or its error as `connect.action_failed`. */
const resultOf = ({ output, provenance, isError }: McpToolResult) => {
  if (isError) {
    throw connectErrors.create("connect.action_failed", { output });
  }
  return { output, provenance };
};

/** Finds the action's tool, exactly as named. */
const toolFor = async (server: McpServer, action: string): Promise<McpTool> => {
  let tool: McpTool | undefined;
  try {
    tool = await server.tool(action);
  } catch (error) {
    if (error instanceof McpError) {
      throw connectErrors.create("connect.server_unavailable");
    }
    throw error;
  }
  if (tool === undefined) {
    throw connectErrors.create("connect.action_not_found");
  }
  return tool;
};

/**
 * Carries out one call whose capability is verified: `claims` say exactly
 * this connection, resource, action and idempotency key, for this subject
 * and person. Throws a `connect.*` error when it refuses the call or the
 * call fails; `progress` says how far it got.
 */
export const carryOut = async (
  env: Env,
  claims: CapabilityClaims,
  call: Omit<ConnectCall, "capability">,
  progress: CallProgress
): Promise<CallDone> => {
  const { authority, resource, idempotencyKey } = claims;
  const connection = await usableConnection(
    env.DB,
    call.connectionId,
    authority.onBehalfOf
  );
  const { input } = call;
  // MCP tools take an object of arguments.
  if (!isInput(input)) {
    throw connectErrors.create("connect.invalid_call");
  }

  // A repeat of a side effect gets its stored result before anything goes
  // out, not even a look at the server's tools.
  const store =
    idempotencyKey === null
      ? undefined
      : idempotencyStore(
          env.DB,
          {
            subject: authority.subject,
            connectionId: call.connectionId,
            action: call.action,
            idempotencyKey,
          },
          await hashCall(resource, input)
        );
  const stored = await store?.replay();
  if (stored !== undefined) {
    progress.sideEffect = true;
    return { result: stored, sideEffect: true, replayed: true };
  }

  const server = serverOf(connection);
  const tool = await toolFor(server, call.action);
  // Read or side effect is the server's word: only a tool it declares
  // read-only is a read. That fits native connectors, which are ours. For
  // Composio servers the admin's per-tool choice replaces it when they
  // connect a toolkit.
  const sideEffect = !tool.readOnly;
  progress.sideEffect = sideEffect;
  checkResourceScope(resource, tool, input);

  if (!sideEffect) {
    try {
      return {
        result: resultOf(await server.call(tool.name, input)),
        sideEffect,
        replayed: false,
      };
    } catch (error) {
      throw error instanceof McpError
        ? connectErrors.create("connect.server_unavailable")
        : error;
    }
  }

  if (store === undefined) {
    throw connectErrors.create("connect.idempotency_key_required");
  }
  const earlier = await store.claim(authority.onBehalfOf);
  if (earlier !== undefined) {
    return { result: earlier, sideEffect, replayed: true };
  }
  let answer: McpToolResult;
  try {
    answer = await server.call(tool.name, input);
  } catch (error) {
    if (error instanceof McpError && error.declined) {
      await store.release();
      throw connectErrors.create("connect.server_unavailable");
    }
    await store.spend();
    throw connectErrors.create("connect.outcome_unknown");
  }
  if (answer.isError) {
    // A tool reports an error when it didn't act (invalid input, a 429 from
    // the provider), so the key is free for a retry.
    await store.release();
  }
  const result = resultOf(answer);
  await store.complete(result);
  return { result, sideEffect, replayed: false };
};
