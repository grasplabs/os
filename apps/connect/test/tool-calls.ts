/**
 * Calling a native connector's tools as core does, and reading back what
 * they answered and sent: shared by the connectors' contract tests.
 */
import { connectErrors } from "@grasp-os/shared/connect";
import type { ConnectionPerson, ConnectResult } from "@grasp-os/shared/connect";
import { z } from "zod";

import { agentFor, callAs, outcome } from "./connect.ts";
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
): Promise<ConnectResult> =>
  await callAs(
    agentFor(connection.person.userId),
    { connectionId: connection.id, action, input, ...extra },
    { mask }
  );

/** A tool's input, as a call carries it. */
export type Input = Extract<Call["input"], Record<string, unknown>>;

/**
 * How each tool of `inputs` ends for each of `values` as its `field`,
 * under a capability for `resource`.
 */
export const refusalsFor = async (
  connection: Connection,
  inputs: Record<string, Input>,
  field: string,
  resource: string,
  values: readonly string[]
): Promise<Set<string>> =>
  new Set(
    await Promise.all(
      Object.entries(inputs).flatMap(([action, input]) =>
        values.map(
          async (value) =>
            await outcome(
              callTool(
                connection,
                action,
                { [field]: value, ...input },
                { resource, idempotencyKey: crypto.randomUUID() }
              )
            )
        )
      )
    )
  );

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
