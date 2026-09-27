import {
  composioConsentText,
  connectionCallbackPath,
  connectionErrors,
  finishConnectionSchema,
  oauthFlowLifetimeMs,
  startToolkitConnectionSchema,
} from "@grasp-os/shared/connect";
import type { ConnectionPerson } from "@grasp-os/shared/connect";
import { randomToken, sha256Hex } from "@grasp-os/shared/encoding";
import { identifierSchema } from "@grasp-os/shared/ids";
import { errorFields, log } from "@grasp-os/shared/log";
import { isAdmin, roleErrors } from "@grasp-os/shared/roles";
import { eq, lte } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { recordEvents } from "./audit.ts";
import { composioTools } from "./catalog.ts";
import { ComposioError, composioKey, composioRequest } from "./composio.ts";
import { auditRefusal, connectionEvent } from "./connection-audit.ts";
import { isComposioServerUrl } from "./connections.ts";
import type { Connection } from "./connections.ts";
import { composioCleanups, composioFlows, connections } from "./db/schema.ts";

// Connecting a Composio toolkit: one shared connection per toolkit, scoped
// to the tools the admin allows. Composio holds its tokens, in its cloud,
// so an admin connects it only after consenting to exactly that
// (`composioConsentText`), and their consent goes into the audit log with
// who gave it (threat model CN18).
//
// Starting makes, at Composio, an auth config for the toolkit (Composio's
// own app for it) and a connected account for this deployment's Composio
// user, and sends the admin's browser to Composio's auth link. Composio
// sends it back to core's callback, with the flow's `state`, as a
// provider's OAuth flow does; the flow finishes only for the admin who
// started it, as an OAuth flow does (CN4). Finishing checks the account is
// the one this flow made, active, for this toolkit, then makes an MCP
// server at Composio with only that toolkit's auth config and the allowed
// tools, and stores the connection with that server's URL for that one
// connected account: never Composio's single Tool Router URL.
//
// Whatever goes wrong after something was made at Composio, it is deleted
// there again. What Composio doesn't take, or what can't be deleted while
// connect has no key, is recorded and tried again by the cron trigger,
// waiting longer each time, until it is gone: a flow that didn't finish, or
// a disconnected connection, leaves no account behind for long.

type ToolkitFlow = typeof composioFlows.$inferSelect;

/**
 * This deployment's one Composio user, whose connected accounts all its
 * Composio connections are: its origin's host. A Composio project may
 * serve more than one deployment, and the host tells their users apart.
 */
const composioUserOf = (origin: string): string => new URL(origin).host;

const idSchema = identifierSchema;

const authConfigSchema = z.object({
  auth_config: z.object({ id: idSchema }),
});

const linkSchema = z.object({
  redirect_url: z.url({ protocol: /^https$/u }),
  connected_account_id: idSchema,
});

const connectedAccountSchema = z.object({
  id: idSchema,
  status: z.string(),
  toolkit: z.object({ slug: z.string() }),
  auth_config: z.object({ id: idSchema }),
});

const mcpServerSchema = z.object({ id: idSchema });

const mcpUrlsSchema = z.object({
  connected_account_urls: z.array(z.string()),
});

/** What Composio answers to a deletion: whatever it is, it's not read. */
const anyAnswer = z.unknown();

/** What connect made at Composio for one connection or flow. */
interface AtComposio {
  serverId?: string | null;
  connectedAccountId?: string | null;
  authConfigId?: string | null;
}

/** What connect made at Composio, by the area of Composio's API it's in. */
const areas = [
  ["serverId", "mcp"],
  ["connectedAccountId", "connected_accounts"],
  ["authConfigId", "auth_configs"],
] as const;

const isNothing = (made: AtComposio): boolean =>
  areas.every(([field]) => made[field] === undefined || made[field] === null);

/**
 * Deletes what connect made at Composio, server first, then the account
 * (which deletes its tokens), then the auth config. What Composio no
 * longer has (404) is gone. Each failure is logged and never thrown: what
 * is left to delete.
 */
const deleteAtComposio = async (
  key: string,
  made: AtComposio
): Promise<AtComposio> => {
  const left: AtComposio = {};
  for (const [field, area] of areas) {
    const id = made[field];
    if (id === undefined || id === null) {
      continue;
    }
    try {
      // oxlint-disable-next-line no-await-in-loop -- the server before the account it serves
      await composioRequest(key, {
        method: "DELETE",
        path: `/${area}/${encodeURIComponent(id)}`,
        schema: anyAnswer,
      });
    } catch (error) {
      if (!(error instanceof ComposioError && error.status === 404)) {
        log.warn("composio.delete_failed", { area, ...errorFields(error) });
        left[field] = id;
      }
    }
  }
  return left;
};

/** The first wait before trying a failed cleanup again. */
const firstRetryMs = 60 * 1000;

/** The longest wait between two tries of a cleanup. */
const maxRetryMs = 24 * 60 * 60 * 1000;

/** How long to wait after `attempts` failed tries: doubling, up to a day. */
const retryDelayMs = (attempts: number): number =>
  Math.min(firstRetryMs * 2 ** attempts, maxRetryMs);

/**
 * Deletes at Composio what connect made there, and records what it
 * couldn't delete (all of it, without a key) for the cron trigger to try
 * again (`retryComposioCleanups`), so an account with tokens is never
 * forgotten. Never throws: it runs where another error is on its way. What
 * was left to delete.
 */
const cleanUpAtComposio = async (
  env: Env,
  made: AtComposio
): Promise<AtComposio> => {
  const key = composioKey(env);
  const left = key === undefined ? made : await deleteAtComposio(key, made);
  if (isNothing(left)) {
    return left;
  }
  const now = Date.now();
  try {
    await drizzle(env.DB)
      .insert(composioCleanups)
      .values({
        id: crypto.randomUUID(),
        serverId: left.serverId ?? null,
        connectedAccountId: left.connectedAccountId ?? null,
        authConfigId: left.authConfigId ?? null,
        retryAt: new Date(now + firstRetryMs),
        createdAt: new Date(now),
      });
  } catch (error) {
    log.error("composio.cleanup_not_recorded", errorFields(error));
  }
  return left;
};

/**
 * Failed tries after which a cleanup is logged as stuck, at every further
 * try: about a day and a half in, with the waits doubling from a minute.
 */
const stuckAttempts = 10;

/** Most cleanups one cron run tries: a few requests each. */
const cleanupBatchSize = 10;

/**
 * Tries again the cleanups at Composio that are due, waiting longer after
 * each failed try, and forgets each once everything of it is gone. Nothing
 * is tried while connect has no Composio key. The cron trigger calls it.
 */
export const retryComposioCleanups = async (env: Env): Promise<void> => {
  const key = composioKey(env);
  if (key === undefined) {
    return;
  }
  const db = drizzle(env.DB);
  const now = new Date(Date.now());
  const due = await db
    .select()
    .from(composioCleanups)
    .where(lte(composioCleanups.retryAt, now))
    .limit(cleanupBatchSize);
  for (const cleanup of due) {
    // oxlint-disable-next-line no-await-in-loop -- a small batch, in turn
    const left = await deleteAtComposio(key, cleanup);
    const row = eq(composioCleanups.id, cleanup.id);
    const attempts = cleanup.attempts + 1;
    if (!isNothing(left) && attempts >= stuckAttempts) {
      // Someone should look: logged by area, never by ID.
      log.error("composio.cleanup_stuck", {
        attempts,
        left: areas
          .filter(([field]) => typeof left[field] === "string")
          .map(([, area]) => area)
          .join(","),
      });
    }
    // oxlint-disable-next-line no-await-in-loop -- a small batch, in turn
    await (isNothing(left)
      ? db.delete(composioCleanups).where(row)
      : db
          .update(composioCleanups)
          .set({
            serverId: left.serverId ?? null,
            connectedAccountId: left.connectedAccountId ?? null,
            authConfigId: left.authConfigId ?? null,
            attempts,
            retryAt: new Date(now.getTime() + retryDelayMs(attempts)),
          })
          .where(row));
  }
};

const detailOf = (toolkit: string) => ({ provider: toolkit, scope: "shared" });

/**
 * Only admins connect Composio toolkits, and never Grasp staff: each is a
 * shared connection, whose tokens a third party holds. Recorded when
 * refused.
 */
const refuseUnlessAdmin = async (
  env: Env,
  person: ConnectionPerson,
  toolkit: string
): Promise<void> => {
  let reason: "connection.staff_not_allowed" | "role.forbidden" | undefined;
  if (person.staff) {
    reason = "connection.staff_not_allowed";
  } else if (!isAdmin(person.role)) {
    reason = "role.forbidden";
  }
  if (reason === undefined) {
    return;
  }
  await auditRefusal(env, person, "connection.connect", {
    ...detailOf(toolkit),
    outcome: "refused",
    reason,
  });
  throw reason === "role.forbidden"
    ? roleErrors.create("role.forbidden")
    : connectionErrors.create("connection.staff_not_allowed");
};

/**
 * Starts connecting a toolkit for an admin who consented: records their
 * consent with the flow, and returns Composio's auth link.
 */
export const startToolkitConnection = async (
  env: Env,
  request: unknown
): Promise<{ url: string }> => {
  const { person, composio, toolkit, tools, origin, returnTo } =
    connectionErrors.parse(
      "connection.invalid",
      startToolkitConnectionSchema,
      request
    );
  await refuseUnlessAdmin(env, person, toolkit);
  const key = composioKey(env);
  if (!composio || key === undefined || new URL(origin).origin !== origin) {
    throw connectionErrors.create("connection.provider_unavailable");
  }
  // Only tools the toolkit has: a name that matches nothing would be an
  // allowlist entry that silently allows nothing.
  const toolkitTools = await composioTools(key, toolkit);
  const known = new Set(toolkitTools.map(({ name }) => name));
  if (!tools.every((tool) => known.has(tool))) {
    throw connectionErrors.create("connection.invalid");
  }

  const state = randomToken();
  const stateHash = await sha256Hex(state);
  const flowId = crypto.randomUUID();
  const storedTools = JSON.stringify(tools);
  const callback = new URL(connectionCallbackPath, origin);
  callback.searchParams.set("state", state);
  const made: AtComposio = {};
  try {
    const { auth_config: authConfig } = await composioRequest(key, {
      method: "POST",
      path: "/auth_configs",
      body: {
        toolkit: { slug: toolkit },
        auth_config: { type: "use_composio_managed_auth" },
      },
      schema: authConfigSchema,
    });
    made.authConfigId = authConfig.id;
    const link = await composioRequest(key, {
      method: "POST",
      path: "/connected_accounts/link",
      body: {
        auth_config_id: authConfig.id,
        user_id: composioUserOf(origin),
        callback_url: callback.href,
      },
      schema: linkSchema,
    });
    made.connectedAccountId = link.connected_account_id;
    await recordEvents(
      env,
      [
        connectionEvent(person, "connection.consent", undefined, {
          ...detailOf(toolkit),
          outcome: "ok",
          tokenHolder: "composio",
          consentHash: await sha256Hex(composioConsentText),
          flowId,
          toolsHash: await sha256Hex(storedTools),
          toolCount: tools.length,
        }),
      ],
      [
        drizzle(env.DB)
          .insert(composioFlows)
          .values({
            stateHash,
            flowId,
            userId: person.userId,
            toolkit,
            authConfigId: authConfig.id,
            connectedAccountId: link.connected_account_id,
            tools: storedTools,
            returnTo,
            expiresAt: new Date(Date.now() + oauthFlowLifetimeMs),
          }),
      ]
    );
    return { url: link.redirect_url };
  } catch (error) {
    await cleanUpAtComposio(env, made);
    if (!(error instanceof ComposioError)) {
      throw error;
    }
    await auditRefusal(env, person, "connection.connect", {
      ...detailOf(toolkit),
      outcome: "failed",
      reason: "connection.provider_refused",
    });
    throw connectionErrors.create("connection.provider_refused");
  }
};

/**
 * Takes the Composio flow `stateHash` names: deleted before anything is
 * checked, so it is spent whatever happens next.
 */
export const takeToolkitFlow = async (
  env: Env,
  stateHash: string
): Promise<ToolkitFlow | undefined> => {
  const [flow] = await drizzle(env.DB)
    .delete(composioFlows)
    .where(eq(composioFlows.stateHash, stateHash))
    .returning();
  return flow;
};

/**
 * Deletes at Composio what a flow that will never finish made there (one
 * that came back but can't finish), or records it to delete later.
 */
export const abandonToolkitFlow = async (
  env: Env,
  flow: ToolkitFlow
): Promise<void> => {
  await cleanUpAtComposio(env, flow);
};

/** Most Composio flows one `dropToolkitFlows` takes: a few requests each. */
const dropBatchSize = 10;

/**
 * Drops Composio flows that will never finish, those `where` matches (at
 * most {@link dropBatchSize}; a later call takes the rest), and deletes
 * what each made at Composio: an admin may have connected there and never
 * come back, leaving an account with tokens. What can't be deleted now
 * is recorded to delete later. Each flow is taken first, so two calls
 * never both handle one.
 */
export const dropToolkitFlows = async (env: Env, where: SQL): Promise<void> => {
  const db = drizzle(env.DB);
  const due = await db
    .select({ stateHash: composioFlows.stateHash })
    .from(composioFlows)
    .where(where)
    .limit(dropBatchSize);
  for (const { stateHash } of due) {
    // oxlint-disable-next-line no-await-in-loop -- a small batch, in turn
    const flow = await takeToolkitFlow(env, stateHash);
    if (flow !== undefined) {
      // oxlint-disable-next-line no-await-in-loop -- a small batch, in turn
      await abandonToolkitFlow(env, flow);
    }
  }
};

/** Drops Composio flows nobody finished in time. The cron trigger calls it. */
export const purgeExpiredToolkitFlows = async (env: Env): Promise<void> => {
  await dropToolkitFlows(env, lte(composioFlows.expiresAt, new Date()));
};

const allowedToolsSchema = z.array(z.string());

/**
 * Finishes a Composio flow for the admin who started it, once Composio
 * sent their browser back: the new connection. `composio` is core's flag.
 */
const finishToolkitConnection = async (
  env: Env,
  person: ConnectionPerson,
  flow: ToolkitFlow,
  composio: boolean
): Promise<{ connectionId: string; returnTo: string }> => {
  const detail = detailOf(flow.toolkit);
  const refuse = async (
    reason: string,
    outcome: "refused" | "failed" = "refused"
  ): Promise<void> => {
    await auditRefusal(env, person, "connection.connect", {
      ...detail,
      outcome,
      reason,
    });
  };
  const key = composioKey(env);
  const made: AtComposio = {
    connectedAccountId: flow.connectedAccountId,
    authConfigId: flow.authConfigId,
  };
  try {
    const live =
      flow.expiresAt.getTime() > Date.now() && flow.userId === person.userId;
    if (!live) {
      await refuse("connection.flow_invalid");
      throw connectionErrors.create("connection.flow_invalid");
    }
    // The role is read again: it may have changed since the flow started.
    await refuseUnlessAdmin(env, person, flow.toolkit);
    if (!composio || key === undefined) {
      await refuse("connection.provider_unavailable");
      throw connectionErrors.create("connection.provider_unavailable");
    }
    const account = await composioRequest(key, {
      path: `/connected_accounts/${encodeURIComponent(flow.connectedAccountId)}`,
      schema: connectedAccountSchema,
    });
    const isThisFlows =
      account.id === flow.connectedAccountId &&
      account.status === "ACTIVE" &&
      account.toolkit.slug === flow.toolkit &&
      account.auth_config.id === flow.authConfigId;
    if (!isThisFlows) {
      await refuse("connection.provider_refused", "failed");
      throw connectionErrors.create("connection.provider_refused");
    }
    const tools = allowedToolsSchema.parse(JSON.parse(flow.tools));
    const server = await composioRequest(key, {
      method: "POST",
      path: "/mcp/servers",
      body: {
        // 4 to 30 letters, digits, spaces and hyphens.
        name: `grasp-${crypto.randomUUID().slice(0, 8)}`,
        auth_config_ids: [flow.authConfigId],
        allowed_tools: tools,
      },
      schema: mcpServerSchema,
    });
    made.serverId = server.id;
    const { connected_account_urls: urls } = await composioRequest(key, {
      method: "POST",
      path: "/mcp/servers/generate",
      body: {
        mcp_server_id: server.id,
        connected_account_ids: [flow.connectedAccountId],
      },
      schema: mcpUrlsSchema,
    });
    const [url] = urls;
    if (urls.length !== 1 || url === undefined || !isComposioServerUrl(url)) {
      throw new ComposioError("Composio's server URL isn't one connect calls");
    }
    const connectionId = crypto.randomUUID();
    const now = new Date();
    await recordEvents(
      env,
      [
        connectionEvent(person, "connection.connect", connectionId, {
          ...detail,
          outcome: "ok",
          tokenHolder: "composio",
          flowId: flow.flowId,
          toolsHash: await sha256Hex(flow.tools),
          toolCount: tools.length,
        }),
      ],
      [
        drizzle(env.DB).insert(connections).values({
          id: connectionId,
          provider: flow.toolkit,
          scope: "shared",
          ownerUserId: null,
          status: "active",
          serverKind: "composio",
          server: url,
          accountId: flow.connectedAccountId,
          connectedBy: person.userId,
          composioServerId: server.id,
          composioAuthConfigId: flow.authConfigId,
          tools: flow.tools,
          createdAt: now,
          updatedAt: now,
        }),
      ]
    );
    return { connectionId, returnTo: flow.returnTo };
  } catch (error) {
    await cleanUpAtComposio(env, made);
    if (!(error instanceof ComposioError)) {
      throw error;
    }
    await refuse("connection.provider_refused", "failed");
    throw connectionErrors.create("connection.provider_refused");
  }
};

/**
 * Finishes the Composio flow `request` names, as `finishConnection` does an
 * OAuth flow: a Composio flow comes back to the same callback, without a
 * code. `undefined` when the request names no Composio flow, for
 * `finishConnection` to take it from there.
 */
export const finishToolkitFlow = async (
  env: Env,
  request: unknown
): Promise<{ connectionId: string; returnTo: string } | undefined> => {
  const parsed = finishConnectionSchema.safeParse(request);
  if (!parsed.success) {
    return undefined;
  }
  const { person, state, composio = false } = parsed.data;
  const flow = await takeToolkitFlow(env, await sha256Hex(state));
  if (flow === undefined) {
    return undefined;
  }
  return await finishToolkitConnection(env, person, flow, composio);
};

/**
 * Deletes a Composio connection's server, account and auth config at
 * Composio, which deletes its tokens there, or records what it couldn't
 * delete to try again later: whether the account is deleted now.
 */
export const revokeAtComposio = async (
  env: Env,
  connection: Connection
): Promise<boolean> => {
  const left = await cleanUpAtComposio(env, {
    serverId: connection.composioServerId,
    connectedAccountId: connection.accountId,
    authConfigId: connection.composioAuthConfigId,
  });
  return connection.accountId !== null && left.connectedAccountId === undefined;
};
