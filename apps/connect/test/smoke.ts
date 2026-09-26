/**
 * What the live smoke tests share: a connection holding a token taken as
 * is, and calls through connect's whole call path with it.
 */
import type { OAuthProvider } from "@grasp-os/shared/connect";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { connections, connectionTokens } from "../src/db/schema.ts";
import { firstTokens } from "../src/tokens.ts";
import { vaultFor } from "../src/vault.ts";
import { agentFor, callAs } from "./connect.ts";

/** How long a token is taken to be valid: Entra's and Google's last an hour. */
const tokenLifetimeMs = 50 * 60 * 1000;

/** The person the smoke tests act for. */
const person = "user-smoke";

/** A shared connection to `server` holding `accessToken`, as OAuth would leave one. */
export const smokeConnection = async (
  provider: OAuthProvider,
  server: string,
  accessToken: string
): Promise<string> => {
  const vault = await vaultFor(env);
  if (vault === undefined) {
    throw new Error("No token vault in the test env");
  }
  const id = `connection-smoke-${crypto.randomUUID()}`;
  const now = new Date();
  const db = drizzle(env.DB);
  await db.insert(connections).values({
    id,
    provider,
    scope: "shared",
    status: "active",
    serverKind: "native",
    server,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(connectionTokens).values(
    await firstTokens(
      vault,
      id,
      {
        accessToken,
        // Never used: the token isn't refreshed within the test.
        refreshToken: "unused",
        expiresAt: Date.now() + tokenLifetimeMs,
      },
      now
    )
  );
  return id;
};

/** Runs `action` on the connection, held to `resource`: its output. */
export const smokeRun = async (
  connectionId: string,
  action: string,
  input: Record<string, string | number | string[]>,
  resource: string,
  idempotencyKey?: string
): Promise<Record<string, unknown>> => {
  const { output } = await callAs(agentFor(person), {
    connectionId,
    action,
    input,
    resource,
    idempotencyKey,
  });
  return z.record(z.string(), z.unknown()).parse(JSON.parse(output));
};
