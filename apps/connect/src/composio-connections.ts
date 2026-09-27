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
import { eq, lte, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";
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

type Area = (typeof areas)[number][1];

/** One thing at Composio to delete: its area and its ID. */
type Target = readonly [Area, string];

const targetsOf = (made: AtComposio): Target[] =>
  areas.flatMap(([field, area]) => {
    const id = made[field];
    return id === undefined || id === null ? [] : [[area, id] as const];
  });

/**
 * The marker everything a flow makes at Composio carries in its name,
 * found by it even when no ID of it was recorded: `grasp-` and the first
 * 24 hex digits of the flow ID, 30 characters, as Composio allows for an
 * MCP server's name. `handOverFlows` computes the same in SQL.
 */
export const markerOf = (flowId: string): string =>
  `grasp-${flowId.replaceAll("-", "").slice(0, 24)}`;

const listSchema = z.object({ items: z.array(z.unknown()) });
const namedSchema = z.object({ id: idSchema, name: z.string().nullish() });

/** Most things of one kind a marker is looked up for: it names one flow's. */
const markedMax = 50;

/** The IDs of the items of the list at `path`, those `keep` keeps. */
const listedIds = async (
  key: string,
  path: string,
  keep: (item: z.infer<typeof namedSchema>) => boolean = () => true
): Promise<string[]> => {
  const { items } = await composioRequest(key, { path, schema: listSchema });
  return items.flatMap((item) => {
    const parsed = namedSchema.safeParse(item);
    return parsed.success && keep(parsed.data) ? [parsed.data.id] : [];
  });
};

/**
 * Everything at Composio that carries `marker`: auth configs and MCP
 * servers by their name, which Composio can filter by, and the connected
 * accounts of those auth configs, which it can filter by too. `undefined`
 * when Composio doesn't answer: then not everything may be found.
 */
const findMarked = async (
  key: string,
  marker: string
): Promise<Target[] | undefined> => {
  const query = (params: Record<string, string>) =>
    new URLSearchParams({ ...params, limit: String(markedMax) }).toString();
  const named = ({ name }: z.infer<typeof namedSchema>) => name === marker;
  try {
    const authConfigs = await listedIds(
      key,
      `/auth_configs?${query({ search: marker })}`,
      named
    );
    const servers = await listedIds(
      key,
      `/mcp/servers?${query({ name: marker })}`,
      named
    );
    const accounts: string[] = [];
    for (const authConfig of authConfigs) {
      accounts.push(
        // oxlint-disable-next-line no-await-in-loop -- one flow has one auth config
        ...(await listedIds(
          key,
          `/connected_accounts?${query({ auth_config_ids: authConfig })}`
        ))
      );
    }
    return [
      ...servers.map((id) => ["mcp", id] as const),
      ...accounts.map((id) => ["connected_accounts", id] as const),
      ...authConfigs.map((id) => ["auth_configs", id] as const),
    ];
  } catch (error) {
    if (!(error instanceof ComposioError)) {
      throw error;
    }
    log.warn("composio.find_marked_failed", errorFields(error));
    return undefined;
  }
};

/**
 * Deletes `targets` at Composio, servers first, then accounts (which
 * deletes their tokens), then auth configs. What Composio no longer has
 * (404) is gone. Each failure is logged and never thrown: what is left.
 */
const deleteAtComposio = async (
  key: string,
  targets: readonly Target[]
): Promise<Target[]> => {
  const order = (area: Area) => areas.findIndex(([, each]) => each === area);
  const unique = [
    ...new Map(targets.map((each) => [each.join(":"), each])).values(),
  ];
  unique.sort(([a], [b]) => order(a) - order(b));
  const left: Target[] = [];
  for (const target of unique) {
    const [area, id] = target;
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
        left.push(target);
      }
    }
  }
  return left;
};

/**
 * Deletes at Composio what `made` names and, with a `marker`, everything
 * that carries it (found first, so an auth config's accounts are found
 * before it goes). `complete` only when everything was found and deleted.
 */
const settleAtComposio = async (
  key: string,
  made: AtComposio,
  marker: string | null
): Promise<{ left: Target[]; complete: boolean }> => {
  const marked = marker === null ? [] : await findMarked(key, marker);
  const left = await deleteAtComposio(key, [
    ...targetsOf(made),
    ...(marked ?? []),
  ]);
  return { left, complete: marked !== undefined && left.length === 0 };
};

/** What is left, as a cleanup row's ID columns hold it (the marker finds the rest). */
const idsOf = (left: readonly Target[]) => {
  const first = (area: Area) =>
    left.find(([each]) => each === area)?.[1] ?? null;
  return {
    serverId: first("mcp"),
    connectedAccountId: first("connected_accounts"),
    authConfigId: first("auth_configs"),
  };
};

/** The first wait before trying a failed cleanup again. */
const firstRetryMs = 60 * 1000;

/**
 * When the cron trigger may start on a cleanup recorded while a start or a
 * finish is still under way (a few Composio requests of at most ten
 * seconds each): long after either is done, so it never deletes what one
 * of them is about to keep.
 */
const underWayMs = 5 * 60 * 1000;

/** The longest wait between two tries of a cleanup. */
const maxRetryMs = 24 * 60 * 60 * 1000;

/** How long to wait after `attempts` failed tries: doubling, up to a day. */
const retryDelayMs = (attempts: number): number =>
  Math.min(firstRetryMs * 2 ** attempts, maxRetryMs);

// Cleanups follow the outbox's pattern: record, then act, then clear. What
// connect gives up at Composio is recorded as a `composio_cleanups` row in
// the same transaction as the change that gives it up (a flow taken, a
// connection disconnected), so neither is ever kept without the other.
// Only then is Composio asked to delete it, and only once it has is the
// row cleared. Whatever happens in between (no key, Composio failing, a
// crash), the row is there for the cron trigger (`retryComposioCleanups`).

// A flow's cleanup row is written before anything is made at Composio
// (intent first), and everything made there carries the flow's marker
// (`markerOf`) in its name. Each ID is written to the row as soon as it is
// known, the fast path; should that write fail, the marker still finds it.

/**
 * Carries out the recorded cleanup `id` of `made` (and, with a `marker`,
 * of everything carrying it): deletes it at Composio, then clears the row,
 * or keeps in it what is left for the cron trigger. Never throws: it runs
 * where another error may be on its way, and a row it fails to clear is
 * only tried again. Whether the account `made` names, if any, is deleted.
 */
const carryOutCleanup = async (
  env: Env,
  id: string,
  made: AtComposio,
  marker: string | null
): Promise<boolean> => {
  const key = composioKey(env);
  if (key === undefined) {
    return false;
  }
  const { left, complete } = await settleAtComposio(key, made, marker);
  const db = drizzle(env.DB);
  const row = eq(composioCleanups.id, id);
  try {
    await (complete
      ? db.delete(composioCleanups).where(row)
      : db.update(composioCleanups).set(idsOf(left)).where(row));
  } catch (error) {
    log.error("composio.cleanup_not_cleared", errorFields(error));
  }
  const account = made.connectedAccountId;
  return (
    typeof account === "string" &&
    !left.some(
      ([area, each]) => area === "connected_accounts" && each === account
    )
  );
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
    const { left, complete } = await settleAtComposio(
      key,
      cleanup,
      cleanup.marker
    );
    const row = eq(composioCleanups.id, cleanup.id);
    const attempts = cleanup.attempts + 1;
    if (!complete && attempts >= stuckAttempts) {
      // Someone should look: logged by area, never by ID.
      log.error("composio.cleanup_stuck", {
        attempts,
        left: [...new Set(left.map(([area]) => area))].join(","),
      });
    }
    // oxlint-disable-next-line no-await-in-loop -- a small batch, in turn
    await (complete
      ? db.delete(composioCleanups).where(row)
      : db
          .update(composioCleanups)
          .set({
            ...idsOf(left),
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
  const marker = markerOf(flowId);
  const db = drizzle(env.DB);
  const thisCleanup = eq(composioCleanups.id, flowId);
  // Intent first: should anything after this fail, or the isolate go, the
  // cron trigger finds what was made by its marker (`underWayMs` from now,
  // long after this start is done). If this fails, nothing is made.
  await db.insert(composioCleanups).values({
    id: flowId,
    marker,
    retryAt: new Date(Date.now() + underWayMs),
    createdAt: new Date(Date.now()),
  });
  const made: AtComposio = {};
  try {
    const { auth_config: authConfig } = await composioRequest(key, {
      method: "POST",
      path: "/auth_configs",
      body: {
        toolkit: { slug: toolkit },
        auth_config: { type: "use_composio_managed_auth", name: marker },
      },
      schema: authConfigSchema,
    });
    made.authConfigId = authConfig.id;
    await db
      .update(composioCleanups)
      .set({ authConfigId: authConfig.id })
      .where(thisCleanup);
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
    await db
      .update(composioCleanups)
      .set({ connectedAccountId: link.connected_account_id })
      .where(thisCleanup);
    // The flow takes over what the cleanup row held, in one transaction.
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
        db.delete(composioCleanups).where(thisCleanup),
        db.insert(composioFlows).values({
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
    await carryOutCleanup(env, flowId, made, marker);
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

interface FlowRow {
  state_hash: string;
  flow_id: string;
  user_id: string;
  toolkit: string;
  auth_config_id: string;
  connected_account_id: string;
  tools: string;
  return_to: string;
  expires_at: number;
}

/**
 * Takes the Composio flows `where` (SQL over `composio_flows`, with
 * `binds`) matches, and hands what each made at Composio over to a cleanup
 * row due at `retryAt`, keyed by its flow ID, in one transaction: a flow
 * is never gone without its cleanup recorded. Two takes of one flow never
 * both get it. The flows taken.
 */
const handOverFlows = async (
  env: Env,
  where: string,
  binds: readonly unknown[],
  retryAt: number
): Promise<ToolkitFlow[]> => {
  const [, taken] = await env.DB.batch<FlowRow>([
    env.DB.prepare(
      // The marker as `markerOf` makes it.
      `INSERT INTO composio_cleanups (id, server_id, connected_account_id, auth_config_id, marker, attempts, retry_at, created_at) SELECT flow_id, NULL, connected_account_id, auth_config_id, 'grasp-' || substr(replace(flow_id, '-', ''), 1, 24), 0, ?, ? FROM composio_flows WHERE ${where}`
    ).bind(retryAt, Date.now(), ...binds),
    env.DB.prepare(
      `DELETE FROM composio_flows WHERE ${where} RETURNING *`
    ).bind(...binds),
  ]);
  return (taken?.results ?? []).map((row) => ({
    stateHash: row.state_hash,
    flowId: row.flow_id,
    userId: row.user_id,
    toolkit: row.toolkit,
    authConfigId: row.auth_config_id,
    connectedAccountId: row.connected_account_id,
    tools: row.tools,
    returnTo: row.return_to,
    expiresAt: new Date(row.expires_at),
  }));
};

/**
 * Takes the Composio flow `stateHash` names, its cleanup recorded (due
 * `underWayMs` from now, once whoever took it is done): spent whatever
 * happens next.
 */
export const takeToolkitFlow = async (
  env: Env,
  stateHash: string
): Promise<ToolkitFlow | undefined> => {
  const [flow] = await handOverFlows(
    env,
    "state_hash = ?",
    [stateHash],
    Date.now() + underWayMs
  );
  return flow;
};

/**
 * Deletes at Composio what a flow taken for good made there (one that
 * came back but can't finish); its cleanup row keeps what can't be.
 */
export const abandonToolkitFlow = async (
  env: Env,
  flow: ToolkitFlow
): Promise<void> => {
  await carryOutCleanup(env, flow.flowId, flow, markerOf(flow.flowId));
};

/**
 * Hands every Composio flow of the people `userIds` over to cleanup rows
 * due now, in one transaction, however many there are: someone removed
 * can finish none. The cron trigger deletes them at Composio, a bounded
 * number a run.
 */
export const dropToolkitFlowsOf = async (
  env: Env,
  userIds: readonly string[]
): Promise<void> => {
  await handOverFlows(
    env,
    "user_id IN (SELECT value FROM json_each(?))",
    [JSON.stringify(userIds)],
    Date.now()
  );
};

/**
 * Hands the Composio flows nobody finished in time over to cleanup rows
 * due now, for the cron trigger to delete at Composio. It calls this.
 */
export const purgeExpiredToolkitFlows = async (env: Env): Promise<void> => {
  const now = Date.now();
  await handOverFlows(env, "expires_at <= ?", [now], now);
};

/**
 * Whether `url`, as Composio generated it, is the server connect calls for
 * this server and this one connected account, and nothing wider: Composio's
 * MCP host, the server's own path, and exactly this account (never a
 * user-wide URL).
 */
const isServerFor = (
  url: string,
  serverId: string,
  connectedAccountId: string
): boolean => {
  if (!isComposioServerUrl(url)) {
    return false;
  }
  const { pathname, searchParams } = new URL(url);
  const path = `/v3/mcp/${encodeURIComponent(serverId)}`;
  const accounts = searchParams.getAll("connected_account_id");
  return (
    (pathname === path || pathname === `${path}/mcp`) &&
    accounts.length === 1 &&
    accounts[0] === connectedAccountId &&
    !searchParams.has("user_id")
  );
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
        // Its flow's marker: 4 to 30 letters, digits and hyphens.
        name: markerOf(flow.flowId),
        auth_config_ids: [flow.authConfigId],
        allowed_tools: tools,
      },
      schema: mcpServerSchema,
    });
    made.serverId = server.id;
    await drizzle(env.DB)
      .update(composioCleanups)
      .set({ serverId: server.id })
      .where(eq(composioCleanups.id, flow.flowId));
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
    if (
      urls.length !== 1 ||
      url === undefined ||
      !isServerFor(url, server.id, flow.connectedAccountId)
    ) {
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
        // The connection takes over what the flow's cleanup row held.
        drizzle(env.DB)
          .delete(composioCleanups)
          .where(eq(composioCleanups.id, flow.flowId)),
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
    await carryOutCleanup(env, flow.flowId, made, markerOf(flow.flowId));
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
 * The cleanup of a Composio connection being disconnected: an insert of
 * its server, account and auth config into `composio_cleanups` as `id`,
 * only while `stillConnected` matches it, for the same transaction that
 * marks it disconnected (src/oauth.ts). Calls stop with that transaction,
 * whatever becomes of the deletion at Composio after it.
 */
export const disconnectCleanup = (
  db: DrizzleD1Database,
  id: string,
  stillConnected: SQL
) =>
  db.insert(composioCleanups).select(
    db
      .select({
        id: sql<string>`${id}`.as("id"),
        serverId: connections.composioServerId,
        connectedAccountId: connections.accountId,
        authConfigId: connections.composioAuthConfigId,
        marker: sql<string | null>`NULL`.as("marker"),
        attempts: sql<number>`0`.as("attempts"),
        retryAt: sql<Date>`${Date.now() + firstRetryMs}`.as("retry_at"),
        createdAt: sql<Date>`${Date.now()}`.as("created_at"),
      })
      .from(connections)
      .where(stillConnected)
  );

/**
 * Deletes a disconnected Composio connection's server, account and auth
 * config at Composio, which deletes its tokens there, as the cleanup row
 * `id` its disconnect recorded says; the row keeps what can't be deleted
 * now. Whether the account is deleted now.
 */
export const revokeAtComposio = async (
  env: Env,
  id: string,
  connection: Connection
): Promise<boolean> =>
  await carryOutCleanup(
    env,
    id,
    {
      serverId: connection.composioServerId,
      connectedAccountId: connection.accountId,
      authConfigId: connection.composioAuthConfigId,
    },
    null
  );
