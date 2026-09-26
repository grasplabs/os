/**
 * Calling a native connector's tools as core does, and reading back what
 * they answered and sent: shared by the connectors' contract tests.
 */
import { signCapability } from "@grasp-os/shared/capability";
import { connectErrors } from "@grasp-os/shared/connect";
import type { ConnectionPerson, ConnectResult } from "@grasp-os/shared/connect";
import { env, exports } from "cloudflare:workers";
import { z } from "zod";

import { agentFor } from "./connect.ts";
import type { Call } from "./connect.ts";
import type { SentRequest } from "./internet.ts";

/** A connection, and the person it is theirs. */
export interface Connection {
  id: string;
  person: ConnectionPerson;
}

export type Extra = Partial<Omit<Call, "connectionId" | "action" | "input">> & {
  /** The fields the call's permission masks. */
  mask?: string[];
};

/** Calls `action` as an agent's workflow run for the connection's owner. */
export const callTool = async (
  connection: Connection,
  action: string,
  input: Call["input"],
  { mask, ...extra }: Extra = {}
): Promise<ConnectResult> => {
  const stated = { connectionId: connection.id, action, input, ...extra };
  const capability = await signCapability(
    env.CAPABILITY_SIGNING_KEY,
    agentFor(connection.person.userId),
    { ...stated, mask }
  );
  return await exports.default.call({ ...stated, capability });
};

/** A call's result, with its output parsed. */
export const resultOf = async (
  result: Promise<ConnectResult>
): Promise<{ output: unknown; provenance: string[] }> => {
  const { output, provenance } = await result;
  const parsed: unknown = JSON.parse(output);
  return { output: parsed, provenance };
};

/** A call's output, parsed. */
export const outputOf = async (
  result: Promise<ConnectResult>
): Promise<unknown> => {
  const { output } = await resultOf(result);
  return output;
};

/** The error a tool reported, as its caller gets it. */
export const toolError = async (
  promise: Promise<unknown>
): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    if (
      connectErrors.codeOf(error) === "connect.action_failed" &&
      error instanceof Error &&
      "details" in error &&
      typeof error.details === "object" &&
      error.details !== null &&
      "output" in error.details &&
      typeof error.details.output === "string"
    ) {
      const output: unknown = JSON.parse(error.details.output);
      return output;
    }
    throw error;
  }
  throw new Error("The call didn't fail");
};

/**
 * How a call ended: `ok`, or its code, with the wait a retryable
 * `connect.server_unavailable` passes on.
 */
export const retryable = async (
  promise: Promise<unknown>
): Promise<{ code: string; retryAfterSeconds?: number }> => {
  try {
    await promise;
    return { code: "ok" };
  } catch (error) {
    const { details } = z
      .object({
        details: z.object({ retryAfterSeconds: z.number() }).optional(),
      })
      .parse(error);
    return {
      code: connectErrors.codeOf(error) ?? String(error),
      ...details,
    };
  }
};

/** What left connect, each request with its query and JSON body parsed. */
export const parsedRequests = (sent: readonly SentRequest[]) =>
  sent.map(({ method, host, path, headers, body }) => {
    const url = new URL(path, `https://${host}`);
    let parsed: unknown;
    try {
      parsed = body === "" ? undefined : JSON.parse(body);
    } catch {
      parsed = body;
    }
    return {
      method,
      host,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      search: url.searchParams,
      headers,
      body: parsed,
    };
  });
