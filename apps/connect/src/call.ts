import type { CapabilityClaims } from "@grasp-os/shared/capability";
import { connectErrors } from "@grasp-os/shared/connect";
import type { ConnectCall } from "@grasp-os/shared/connect";
import type { Json } from "@grasp-os/shared/json";
import type { BatchItem } from "drizzle-orm/batch";

import { serverOf, usableConnection } from "./connections.ts";
import { hashCall, idempotencyStore } from "./idempotency.ts";
import type { StoredAnswer } from "./idempotency.ts";
import { McpError } from "./mcp.ts";
import type { McpServer, McpTool, McpToolResult } from "./mcp.ts";

/**
 * A call connect carried out, or answered from its stored answer: its
 * result, or the tool's error (`failed`), which goes back to the caller as
 * `connect.action_failed` once it is audited.
 */
export interface CallDone extends StoredAnswer {
  sideEffect: boolean;
  replayed: boolean;
  /** Stores a side effect's answer, in one batch with its audit events. */
  commit?: BatchItem<"sqlite">;
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

/** The tool's answer, as connect stores and returns it. */
const answerOf = ({
  output,
  provenance,
  isError,
}: McpToolResult): StoredAnswer => ({
  result: { output, provenance },
  failed: isError,
});

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
            onBehalfOf: authority.onBehalfOf,
            connectionId: call.connectionId,
            action: call.action,
            idempotencyKey,
          },
          await hashCall(resource, input)
        );
  const stored = await store?.replay();
  if (stored !== undefined) {
    progress.sideEffect = true;
    return { ...stored, sideEffect: true, replayed: true };
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
        ...answerOf(await server.call(tool.name, input)),
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
  const earlier = await store.claim();
  if (earlier !== undefined) {
    return { ...earlier, sideEffect, replayed: true };
  }
  let answer: StoredAnswer;
  try {
    answer = answerOf(await server.call(tool.name, input));
  } catch (error) {
    // Only a server that turned the call away frees the key. A tool that
    // reports an error may have acted first, so its answer is kept below.
    if (error instanceof McpError && error.declined) {
      await store.release();
      throw connectErrors.create("connect.server_unavailable");
    }
    await store.spend();
    throw connectErrors.create("connect.outcome_unknown");
  }
  return {
    ...answer,
    sideEffect,
    replayed: false,
    commit: store.completion(answer),
  };
};
