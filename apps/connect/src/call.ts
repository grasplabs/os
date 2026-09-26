import { maxRetryAfterSeconds } from "@grasp-os/connector-kit/manifest";
import type { CapabilityClaims } from "@grasp-os/shared/capability";
import { connectErrors } from "@grasp-os/shared/connect";
import type { ConnectCall, PendingReference } from "@grasp-os/shared/connect";
import type { Json } from "@grasp-os/shared/json";
import type { BatchItem } from "drizzle-orm/batch";
import { z } from "zod";

import { composioServer, usableConnection } from "./connections.ts";
import type { Connection } from "./connections.ts";
import { nativeAction, nativeServer } from "./connectors.ts";
import { hashCall, idempotencyStore } from "./idempotency.ts";
import type { StoredAnswer } from "./idempotency.ts";
import { masked, maskedPaths } from "./mask.ts";
import { McpError } from "./mcp.ts";
import type { McpServer, McpTool, McpToolResult } from "./mcp.ts";
import { hold } from "./pending.ts";
import type { HeldAction } from "./pending.ts";
import { checkResourceScope, didNothing, hasSideEffect } from "./policy.ts";

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

/** An answer with the fields at `masks` masked (an error has none). */
const maskedAnswer = (
  answer: StoredAnswer,
  masks: readonly string[]
): StoredAnswer =>
  answer.failed
    ? answer
    : {
        ...answer,
        result: {
          ...answer.result,
          output: masked(answer.result.output, masks),
        },
      };

/**
 * The tool's answer, as connect stores and returns it, masked. Stored
 * masked, and masked again as the capability of each repeat says.
 */
const answerOf = (
  { output, provenance, isError }: McpToolResult,
  masks: readonly string[]
): StoredAnswer =>
  maskedAnswer({ result: { output, provenance }, failed: isError }, masks);

/**
 * The output paths to mask for a call, as its capability says: the paths
 * the native action declares maskable whose field the capability names.
 * A remote server's tools declare nothing connect trusts, so nothing of
 * theirs is masked. From the release's manifest alone: nothing is loaded
 * and no token is read.
 */
const masksFor = (
  connection: Connection,
  claims: CapabilityClaims,
  action: string
): string[] => {
  if (claims.mask.length === 0 || connection.serverKind !== "native") {
    return [];
  }
  return maskedPaths(
    claims.mask,
    nativeAction(connection, action).declared.mask
  );
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
 * The tool a call names, and how to reach its server. A native connector's
 * tool comes from its manifest, and its server (an isolate, with the
 * connection's token for its egress) is only opened once the call passed
 * every check. A Composio server is asked for its tools.
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
  const server = composioServer(connection);
  const tool = await toolFor(server, action);
  return { tool, open: async () => await Promise.resolve(server) };
};

/**
 * Whether a side effect waits for its person, or refuses it without an
 * idempotency key, which every side effect needs. One a person is there
 * for (`interactive`) waits for them to confirm it on a view of the exact
 * input (R7). So does every one of a context that read restricted data
 * (R12), whatever it is: what it sends may carry that data, so the person
 * it acts for decides, warned. Its reads, where the tool is one connect
 * trusts to be a read, go on. A workflow run's other side effects come
 * from reviewed code or pass a decision, and run. The held action a
 * person just confirmed (`held`) runs.
 */
const mustHold = (
  { restricted, authority }: CapabilityClaims,
  hasKey: boolean,
  held: HeldAction | undefined
): boolean => {
  if (!hasKey) {
    throw connectErrors.create("connect.idempotency_key_required");
  }
  return held === undefined && (restricted || authority.mode === "interactive");
};

/**
 * The connection a call may use, as `usableConnection` says; for a held
 * action, only while it reaches the account it reached when the action was
 * held (CN15).
 */
export const connectionFor = async (
  env: Env,
  claims: CapabilityClaims,
  connectionId: string,
  held: HeldAction | undefined
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
  // Before a repeat is answered too: its answer is masked as this
  // capability says.
  const masks = masksFor(connection, claims, call.action);

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
          },
          inputHash
        );
  const stored = await store?.replay();
  if (stored !== undefined) {
    progress.sideEffect = true;
    return { ...maskedAnswer(stored, masks), sideEffect: true, replayed: true };
  }

  const { tool, open } = await actionFor(env, connection, claims, call.action);
  const sideEffect = hasSideEffect(connection.serverKind, tool);
  progress.sideEffect = sideEffect;
  checkResourceScope(resource, connection.serverKind, tool, input);
  if (
    sideEffect &&
    mustHold(claims, store !== undefined, held) &&
    idempotencyKey !== null
  ) {
    const pending = await hold(env, claims, connection, {
      input,
      inputHash,
      idempotencyKey,
    });
    return { ...heldAnswer, sideEffect, replayed: false, pending };
  }

  // Every refusal is behind: only now may a token be read.
  const server = await open();
  if (!sideEffect) {
    let read: McpToolResult;
    try {
      read = await server.call(tool.name, input);
    } catch (error) {
      throw error instanceof McpError
        ? connectErrors.create("connect.server_unavailable")
        : error;
    }
    if (didNothing(connection.serverKind, read)) {
      throw notPerformed(read);
    }
    return { ...answerOf(read, masks), sideEffect, replayed: false };
  }

  if (store === undefined) {
    throw connectErrors.create("connect.idempotency_key_required");
  }
  const earlier = await store.claim();
  if (earlier !== undefined) {
    return { ...maskedAnswer(earlier, masks), sideEffect, replayed: true };
  }
  let done: McpToolResult;
  try {
    done = await server.call(tool.name, input);
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
  const answer = answerOf(done, masks);
  return {
    ...answer,
    sideEffect,
    replayed: false,
    commit: store.completion(answer),
    spend: store.spend,
  };
};
