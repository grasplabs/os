import { maxRetryAfterSeconds } from "@grasp-os/connector-kit/manifest";
import type { CapabilityClaims } from "@grasp-os/shared/capability";
import { connectErrors } from "@grasp-os/shared/connect";
import type {
  ConnectCall,
  HeldOutcome,
  PendingReference,
} from "@grasp-os/shared/connect";
import type { Json } from "@grasp-os/shared/json";
import type { BatchItem } from "drizzle-orm/batch";
import { z } from "zod";

import {
  allowedTool,
  composioServer,
  usableConnection,
} from "./connections.ts";
import type { Connection } from "./connections.ts";
import { nativeAction, nativeServer } from "./connectors.ts";
import { hashCall, idempotencyStore, replay } from "./idempotency.ts";
import type { StoredAnswer } from "./idempotency.ts";
import { McpError } from "./mcp.ts";
import type {
  McpServer,
  McpServerTool,
  McpTool,
  McpToolResult,
} from "./mcp.ts";
import { hold, waitingUnder } from "./pending.ts";
import type { HeldAction } from "./pending.ts";
import {
  checkResourceScope,
  composioTool,
  didNothing,
  hasSideEffect,
  withProvenance,
} from "./policy.ts";

const retryAfterSchema = z.object({
  error: z.object({
    retryAfterSeconds: z.number().int().nonnegative().max(maxRetryAfterSeconds),
  }),
});

/**
 * `connect.server_unavailable` for a call its tool says did nothing, with
 * the wait the tool passed on, if it did (`{ error: { retryAfterSeconds } }`,
 * as the connector kit reports a provider's `retry-after`).
 */
const notPerformed = ({ output }: McpToolResult): Error => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    parsed = undefined;
  }
  const wait = retryAfterSchema.safeParse(parsed).data?.error.retryAfterSeconds;
  return connectErrors.create(
    "connect.server_unavailable",
    wait === undefined ? undefined : { retryAfterSeconds: wait }
  );
};

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
  /** Spends the key if that batch fails: the effect happened, unrecorded. */
  spend?: () => Promise<void>;
  /** Held for the person to confirm, not carried out. */
  pending?: PendingReference;
}

/** What a held call answers: nothing done yet. */
const heldAnswer: StoredAnswer = {
  result: { output: "null", provenance: [] },
  failed: false,
};

/** Knows once the action is found whether it has a side effect. */
export interface CallProgress {
  sideEffect?: boolean;
}

type Input = Record<string, Json>;

/** Largest input a call may carry, in bytes of JSON. */
const maxInputBytes = 64 * 1024;

const isInput = (input: Json): input is Input =>
  typeof input === "object" && input !== null && !Array.isArray(input);

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
const toolFor = async (
  server: McpServer,
  action: string
): Promise<McpServerTool> => {
  let tool: McpServerTool | undefined;
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
 * The tool a call names, and how to reach its server. A native connector's
 * tool comes from its manifest, and its server (an isolate, with the
 * connection's token for its egress) is only opened once the call passed
 * every check. A Composio server is asked for its tools, and only for one
 * its admin allowed, which is what the admin's rule says it is.
 */
const actionFor = async (
  env: Env,
  connection: Connection,
  claims: CapabilityClaims,
  action: string
): Promise<{ tool: McpTool; open: () => Promise<McpServer> }> => {
  if (connection.serverKind === "native") {
    const native = nativeAction(connection, action);
    return {
      tool: native.tool,
      open: async () => await nativeServer(env, connection, native, claims),
    };
  }
  // Only a tool the admin allowed, asked for before anything goes out,
  // and taken to be what the admin said it is.
  const rule = allowedTool(connection, action);
  if (rule === undefined) {
    throw connectErrors.create("connect.action_not_found");
  }
  const server = composioServer(env, connection);
  const tool = composioTool(await toolFor(server, action), rule);
  return { tool, open: async () => await Promise.resolve(server) };
};

/**
 * Whether a side effect waits for its person. One a person is there for
 * (`interactive`) waits for them to confirm it on a view of the exact
 * input (R7). So does every one of a context that read restricted data
 * (R12), whatever it is: what it sends may carry that data, so the person
 * it acts for decides, warned. Its reads of a native connector go on; on
 * Composio every call of such a context is a side effect (policy.ts). A
 * workflow run's other side effects come
 * from reviewed code or pass a decision, and run. The held action a
 * person just confirmed (`held`) runs.
 */
const mustHold = (
  { restricted, authority }: CapabilityClaims,
  held: HeldAction | undefined
): boolean =>
  held === undefined && (restricted || authority.mode === "interactive");

/**
 * The connection a call may use, as `usableConnection` says; for a held
 * action, only while it reaches the account it reached when the action was
 * held (CN15).
 */
export const connectionFor = async (
  env: Env,
  claims: CapabilityClaims,
  connectionId: string,
  held?: HeldAction
): Promise<Connection> => {
  const connection = await usableConnection(
    env.DB,
    connectionId,
    claims.authority.onBehalfOf
  );
  if (held !== undefined && connection.accountId !== held.accountId) {
    throw connectErrors.create("connect.connection_changed");
  }
  return connection;
};

/**
 * How the held call `claims` name ended, for a caller whose capability for
 * that call is verified: authorised now as the call itself would be, on a
 * connection it may use now, and for the resource the call was for.
 * Throws `connect.pending_not_found` when no such call was held or stored. `pendingActionId` is the held action, while it
 * waits.
 */
export const heldOutcome = async (
  env: Env,
  claims: CapabilityClaims
): Promise<{ outcome: HeldOutcome; pendingActionId?: string }> => {
  const { authority, connectionId, resource, action, idempotencyKey } = claims;
  if (idempotencyKey === null) {
    throw connectErrors.create("connect.invalid");
  }
  await connectionFor(env, claims, connectionId);
  const pendingActionId = await waitingUnder(env, claims);
  if (pendingActionId !== undefined) {
    return { outcome: { state: "waiting" }, pendingActionId };
  }
  const row = await idempotencyStore(
    env.DB,
    {
      subject: authority.subject,
      onBehalfOf: authority.onBehalfOf,
      connectionId,
      action,
      idempotencyKey,
      resource,
    },
    ""
  ).find();
  // Only the call for the resource this capability was checked for.
  if (row === undefined || row.resource !== resource) {
    throw connectErrors.create("connect.pending_not_found");
  }
  let answer: StoredAnswer;
  try {
    answer = replay(row, row.inputHash, Date.now());
  } catch (error) {
    const reason = connectErrors.codeOf(error);
    if (reason === "connect.declined") {
      return { outcome: { state: "declined" } };
    }
    // Confirmed, and being carried out now.
    if (reason === "connect.call_in_progress") {
      return { outcome: { state: "waiting" } };
    }
    if (reason === undefined) {
      throw error;
    }
    // Its outcome is unknown, or its answer is no longer kept.
    return { outcome: { state: "failed", reason, output: null } };
  }
  return {
    outcome: answer.failed
      ? {
          state: "failed",
          reason: "connect.action_failed",
          output: answer.result.output,
        }
      : { state: "done", result: answer.result },
  };
};

/**
 * Carries out one call whose capability is verified: `claims` say exactly
 * this connection, resource, action and idempotency key, for this subject
 * and person. A side effect a person is there for, or of a restricted
 * context, is held for the person instead (`pending`), unless it is the
 * held action `held` they just confirmed.
 * Throws a `connect.*` error when it refuses the call or the call fails;
 * `progress` says how far it got.
 */
export const carryOut = async (
  env: Env,
  claims: CapabilityClaims,
  call: Omit<ConnectCall, "capability">,
  progress: CallProgress,
  held?: HeldAction
): Promise<CallDone> => {
  const { authority, resource, idempotencyKey } = claims;
  const connection = await connectionFor(env, claims, call.connectionId, held);
  const { input } = call;
  // MCP tools take an object of arguments.
  if (!isInput(input)) {
    throw connectErrors.create("connect.invalid");
  }
  if (
    new TextEncoder().encode(JSON.stringify(input)).byteLength > maxInputBytes
  ) {
    throw connectErrors.create("connect.input_too_large");
  }
  // A repeat of a side effect gets its stored result before anything goes
  // out, not even a look at the server's tools.
  const inputHash = await hashCall(resource, input);
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
            resource,
          },
          inputHash
        );
  const stored = await store?.replay();
  if (stored !== undefined) {
    progress.sideEffect = true;
    return { ...stored, sideEffect: true, replayed: true };
  }

  const { tool, open } = await actionFor(env, connection, claims, call.action);
  const sideEffect = hasSideEffect(
    tool,
    connection.serverKind,
    claims.restricted
  );
  progress.sideEffect = sideEffect;
  checkResourceScope(resource, tool, input);
  if (sideEffect && mustHold(claims, held)) {
    // A workflow run's key is its step's and never made by connect:
    // without one its side effect is refused, not held.
    if (idempotencyKey === null && authority.mode !== "interactive") {
      throw connectErrors.create("connect.idempotency_key_required");
    }
    const pending = await hold(env, claims, connection, {
      input,
      inputHash,
      idempotencyKey,
    });
    return { ...heldAnswer, sideEffect, replayed: false, pending };
  }

  if (!sideEffect) {
    // Every refusal is behind: only now may a token be read.
    const server = await open();
    let read: McpToolResult;
    try {
      read = withProvenance(
        connection,
        tool.name,
        await server.call(tool.name, input)
      );
    } catch (error) {
      throw error instanceof McpError
        ? connectErrors.create("connect.server_unavailable")
        : error;
    }
    if (didNothing(connection.serverKind, read)) {
      throw notPerformed(read);
    }
    return { ...answerOf(read), sideEffect, replayed: false };
  }

  if (store === undefined) {
    throw connectErrors.create("connect.idempotency_key_required");
  }
  // Every refusal is behind: only now may a token be read.
  const server = await open();
  const earlier = await store.claim();
  if (earlier !== undefined) {
    return { ...earlier, sideEffect, replayed: true };
  }
  let done: McpToolResult;
  try {
    done = withProvenance(
      connection,
      tool.name,
      await server.call(tool.name, input)
    );
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
  // ...unless the tool is one connect trusts to say it did nothing: then
  // the key is free, and the caller may try again.
  if (didNothing(connection.serverKind, done)) {
    await store.release();
    throw notPerformed(done);
  }
  const answer = answerOf(done);
  return {
    ...answer,
    sideEffect,
    replayed: false,
    commit: store.completion(answer),
    spend: store.spend,
  };
};
