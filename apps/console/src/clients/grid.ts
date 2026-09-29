/**
 * The client grid: every client with what the console recorded of it
 * (release, ring, last deploy), and, for each active one, what its
 * account shows now: drift, whether it runs the shared secrets in Secrets
 * Store, whether the router reaches its core, its error rate over the
 * last day, and what it cost this month.
 *
 * The live columns are read when the grid is: each active client's
 * account (drift, shared secrets), its core (health), and the analytics
 * of every account at once. A client whose account or core doesn't
 * answer shows those columns as unknown; nothing live fails the grid.
 */
import { log } from "@grasp-os/shared/log";
import { deriveRouterSecret } from "@grasp-os/shared/router";
import { asc, sql } from "drizzle-orm";

import { accountUsage, monthCostUsd } from "../cloudflare/analytics.ts";
import type { AccountUsage } from "../cloudflare/analytics.ts";
import type { CloudflareApi } from "../cloudflare/api.ts";
import { consoleDatabase } from "../db/act.ts";
import type { ConsoleDatabase } from "../db/act.ts";
import { clientDeploys, clients, clientWorkers } from "../db/schema.ts";
import {
  clientDomain,
  deployerApi,
  deploySecrets,
  MissingStoreSecretError,
} from "../deploy/context.ts";
import { errorCode } from "../deploy/deploy.ts";
import { answeringVersion, mappedRoute } from "../deploy/router.ts";
import type { RouterHosts } from "../deploy/router.ts";
import type { DeploySecrets } from "../deploy/secrets.ts";
import { driftOf } from "../rollout/drift.ts";
import type { ClientDriftState } from "../rollout/drift.ts";
import { runsSharedSecrets } from "../rollout/shared-secrets.ts";

/** Whether the router reaches a client's core, as its health check answers. */
export type Reach = "reachable" | "unreachable" | "no_route" | "unknown";

/** What a client's account shows now, read when the grid is. */
export interface LiveStatus {
  drift: ClientDriftState;
  /** Whether it runs the shared secrets in Secrets Store now; null when that can't be told. */
  sharedSecretsCurrent: boolean | null;
  reach: Reach;
  /** Its Workers' errors over the last day, as a share of their requests; null when unknown or idle. */
  errorRate: number | null;
  /** What it cost this month so far, in USD, estimated; null when unknown. */
  costUsd: { workers: number; ai: number } | null;
}

/** A client as the grid shows it. */
export interface GridRow {
  id: string;
  name: string;
  status: "provisioning" | "active" | "offboarded";
  ring: number;
  accountId: string;
  /** `<id>.<domain>`; null while the console has no domain. */
  hostname: string | null;
  /** The release the console made live on every Worker; null when none, or they differ. */
  release: string | null;
  pinnedReleaseId: string | null;
  /** Its latest deploy. */
  lastDeploy: {
    releaseId: string;
    status: "running" | "done" | "failed" | "superseded";
    at: Date;
  } | null;
  /** Null for a client that isn't active. */
  live: LiveStatus | null;
}

/** How long a client's health check may take. */
const healthTimeoutMs = 5000;

/**
 * Every client, as the console recorded it, by id: two queries, whatever
 * their number, with no list of ids to bind (D1 binds at most 100).
 */
const recordedClients = async (db: ConsoleDatabase) => {
  const rows = await db
    .select({
      id: clients.id,
      name: clients.name,
      status: clients.status,
      ring: clients.ring,
      accountId: clients.accountId,
      pinnedReleaseId: clients.pinnedReleaseId,
      lastDeploy: {
        releaseId: clientDeploys.releaseId,
        status: clientDeploys.status,
        at: clientDeploys.createdAt,
      },
    })
    .from(clients)
    // Its latest deploy, found through client_deploys_client_idx. Written
    // out, since `clients.id` must name the outer row's.
    .leftJoin(
      clientDeploys,
      sql`${clientDeploys.id} = (SELECT latest.id FROM client_deploys AS latest WHERE latest.client_id = clients.id ORDER BY latest.created_at DESC, latest.rowid DESC LIMIT 1)`
    )
    .orderBy(asc(clients.id));
  // Two rows a client, core's and connect's: as many as the clients.
  const workers = await db
    .select({
      clientId: clientWorkers.clientId,
      releaseId: clientWorkers.releaseId,
    })
    .from(clientWorkers);
  return rows.map((row) => {
    const releases = new Set(
      workers
        .filter(({ clientId }) => clientId === row.id)
        .map(({ releaseId }) => releaseId)
    );
    const [only = null] = releases.size === 1 ? releases : [];
    return { ...row, release: only };
  });
};

/**
 * Whether the router reaches client `clientId`'s core at `hostname`: the
 * route its map has for the hostname, and core's health check answering a
 * request with the router secret the router would send.
 */
const reachOf = async (
  hosts: RouterHosts,
  routerKey: string | null,
  clientId: string,
  hostname: string | null
): Promise<Reach> => {
  if (hostname === null || routerKey === null) {
    return "unknown";
  }
  const route = await mappedRoute(hosts, hostname);
  if (route === null || route.clientId !== clientId) {
    return "no_route";
  }
  const secret = await deriveRouterSecret(
    routerKey,
    clientId,
    route.generation
  );
  const version = await answeringVersion(
    fetch,
    route.coreUrl,
    secret,
    healthTimeoutMs
  );
  return version === undefined ? "unreachable" : "reachable";
};

/** What `task` answers, or `fallback` when it throws, logged as `event`. */
const orElse = async <T>(
  task: () => Promise<T>,
  fallback: T,
  event: string,
  clientId: string
): Promise<T> => {
  try {
    return await task();
  } catch (error) {
    log.warn(event, { clientId, error: errorCode(error) });
    return fallback;
  }
};

/** What reading a client's live status takes: each part may be missing. */
interface LiveSources {
  env: Env;
  db: ConsoleDatabase;
  /** The deployer's API; null when its token can't be read. */
  api: CloudflareApi | null;
  /** Secrets Store's secrets; null when one of them can't be read. */
  store: DeploySecrets | null;
  /** Every active client's account usage; null when analytics can't be read. */
  usage: Map<string, AccountUsage> | null;
}

/** A client's live status, never throwing: what can't be read is unknown. */
const liveOf = async (
  { env, db, api, store, usage }: LiveSources,
  row: { id: string; accountId: string; hostname: string | null }
): Promise<LiveStatus> => {
  const drift =
    api === null
      ? null
      : await orElse(
          async () => await driftOf(api, db, row.id),
          null,
          "grid.drift_unread",
          row.id
        );
  const [sharedSecretsCurrent, reach] = await Promise.all([
    store === null || drift === null
      ? null
      : orElse(
          async () => await runsSharedSecrets(db, drift, store),
          null,
          "grid.secrets_unread",
          row.id
        ),
    orElse(
      async () =>
        await reachOf(
          env.ROUTER_HOSTS,
          store?.routerKey ?? null,
          row.id,
          row.hostname
        ),
      "unknown" as const,
      "grid.health_unread",
      row.id
    ),
  ]);
  const used = usage?.get(row.accountId);
  return {
    drift: drift?.state ?? "unknown",
    sharedSecretsCurrent,
    reach,
    errorRate:
      used === undefined || used.dayRequests === 0
        ? null
        : used.dayErrors / used.dayRequests,
    costUsd: used === undefined ? null : monthCostUsd(used),
  };
};

/** What `read` answers, or null when a secret it reads isn't in Secrets Store. */
const ifStored = async <T>(read: () => Promise<T>): Promise<T | null> => {
  try {
    return await read();
  } catch (error) {
    if (error instanceof MissingStoreSecretError) {
      return null;
    }
    throw error;
  }
};

/** Every client, with its live status when it's active, as of `now`. */
export const clientGrid = async (env: Env, now: Date): Promise<GridRow[]> => {
  const db = consoleDatabase(env.DB);
  const domain = clientDomain(env);
  const recorded = await recordedClients(db);
  const rows = recorded.map((row) => ({
    ...row,
    hostname: domain === null ? null : `${row.id}.${domain}`,
  }));
  const active = rows.filter(({ status }) => status === "active");
  if (active.length === 0) {
    return rows.map((row) => ({ ...row, live: null }));
  }
  const api = await ifStored(async () => await deployerApi(env));
  const store = await ifStored(async () => await deploySecrets(env));
  let usage: Map<string, AccountUsage> | null = null;
  if (api !== null) {
    try {
      usage = await accountUsage(
        api,
        active.map(({ accountId }) => accountId),
        now
      );
    } catch (error) {
      log.warn("grid.usage_unread", { error: errorCode(error) });
    }
  }
  const sources = { env, db, api, store, usage };
  const live = new Map(
    await Promise.all(
      active.map(async (row): Promise<[string, LiveStatus]> => [
        row.id,
        await liveOf(sources, row),
      ])
    )
  );
  return rows.map((row) => ({ ...row, live: live.get(row.id) ?? null }));
};
