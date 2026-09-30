/**
 * The client grid: every client with what the console recorded of it
 * (release, ring, last deploy), read from D1 and shown at once, and, for
 * each active one, what its account shows now: drift, whether it runs the
 * shared secrets in Secrets Store, whether the router reaches its core,
 * its errors over the last day, and what it cost this month.
 *
 * The live columns are read after the page shows (`gridLive`): a few
 * clients at a time, each within a deadline, with what every client needs
 * (Secrets Store, the analytics of all their accounts, release manifests)
 * read once. Each client's answer is kept for a minute, so reloading the
 * page doesn't read the accounts again. Whatever doesn't answer in time
 * shows as unknown, and is read again the next time: only an answer with
 * nothing unknown in it is kept. Nothing live fails the grid.
 */
import { deadline } from "@grasp-os/shared/deadline";
import { log } from "@grasp-os/shared/log";
import { deriveRouterSecret } from "@grasp-os/shared/router";
import { asc, sql } from "drizzle-orm";
import { z } from "zod";

import { accountUsage, monthCostUsd } from "../cloudflare/analytics.ts";
import type { AccountUsage } from "../cloudflare/analytics.ts";
import { cloudflareApi } from "../cloudflare/api.ts";
import type { CloudflareApi } from "../cloudflare/api.ts";
import { consoleDatabase } from "../db/act.ts";
import type { ConsoleDatabase } from "../db/act.ts";
import { clientDeploys, clients, clientWorkers } from "../db/schema.ts";
import {
  clientDomain,
  deployerToken,
  deploySecrets,
  MissingStoreSecretError,
} from "../deploy/context.ts";
import { errorCode } from "../deploy/deploy.ts";
import { importedManifest } from "../deploy/release.ts";
import { answeringVersion, mappedRoute } from "../deploy/router.ts";
import type { RouterHosts } from "../deploy/router.ts";
import type { DeploySecrets } from "../deploy/secrets.ts";
import { defaultLiveReadLimits, eachLimited, within } from "../live-reads.ts";
import type { LiveReadLimits } from "../live-reads.ts";
import { driftOf } from "../rollout/drift.ts";
import type { ManifestOf } from "../rollout/drift.ts";
import { sharedSecretsStatus, storeCheck } from "../rollout/shared-secrets.ts";
import type { StoreCheck } from "../rollout/shared-secrets.ts";

/** Whether the router reaches a client's core, as its health check answers. */
export type Reach = "reachable" | "unreachable" | "no_route" | "unknown";

const driftStates = [
  "in_sync",
  "drifted",
  "split",
  "off_pin",
  "unknown",
] as const;

/** What a client's account shows now, read after the grid shows. */
const liveStatusSchema = z.object({
  drift: z.enum(driftStates),
  /** Whether it runs the shared secrets in Secrets Store now; null when that can't be told. */
  sharedSecretsCurrent: z.boolean().nullable(),
  reach: z.enum(["reachable", "unreachable", "no_route", "unknown"]),
  /** Its Workers' requests and errors over the last day; null when unknown. */
  day: z.object({ requests: z.number(), errors: z.number() }).nullable(),
  /** What it cost this month so far, in USD, estimated; null when unknown. */
  costUsd: z.object({ workers: z.number(), ai: z.number() }).nullable(),
});
export type LiveStatus = z.infer<typeof liveStatusSchema>;

/** A client as the grid shows it at once, from what the console recorded. */
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
}

/** How long a client's health check may take, from when it's sent. */
const healthTimeoutMs = 5000;

/**
 * How reading live columns may go: how many clients at once and how long
 * one client may take all told (`LiveReadLimits`), and whether answers are
 * kept a minute.
 */
export interface LiveOptions extends LiveReadLimits {
  cache: boolean;
}

export const defaultLiveOptions: LiveOptions = {
  ...defaultLiveReadLimits,
  cache: true,
};

/** The cache clients' live answers are kept in. */
const cacheName = "grid-live";

/** How long a client's live answer is kept. */
const cacheSeconds = 60;

/** Where a client's live answer is kept: a URL only the console uses. */
const cacheKey = (clientId: string): string =>
  `https://grid-live.console.invalid/${encodeURIComponent(clientId)}`;

/** Every column unknown: a client whose reads failed or ran out of time. */
const unknownStatus: LiveStatus = {
  drift: "unknown",
  sharedSecretsCurrent: null,
  reach: "unknown",
  day: null,
  costUsd: null,
};

/**
 * Whether every column of `live` was read. Only such an answer is kept:
 * an unknown is an account, the store or the analytics not answering, and
 * kept, it would still show as unknown a minute after they answer again.
 */
const allKnown = (live: LiveStatus): boolean =>
  live.drift !== "unknown" &&
  live.sharedSecretsCurrent !== null &&
  live.reach !== "unknown" &&
  live.day !== null &&
  live.costUsd !== null;

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
  const releasesOf = new Map<string, Set<string | null>>();
  for (const { clientId, releaseId } of workers) {
    const releases = releasesOf.get(clientId) ?? new Set();
    releases.add(releaseId);
    releasesOf.set(clientId, releases);
  }
  return rows.map((row) => {
    const releases = releasesOf.get(row.id) ?? new Set();
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
  hostname: string | null,
  signal: AbortSignal
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
  // Its own deadline starts as it's sent; the row's stops it too.
  const fetchCore: typeof fetch = async (input, init) =>
    await fetch(input, {
      ...init,
      signal:
        init?.signal === undefined || init.signal === null
          ? signal
          : AbortSignal.any([init.signal, signal]),
    });
  const version = await answeringVersion(
    fetchCore,
    route.coreUrl,
    secret,
    healthTimeoutMs
  );
  return version === undefined ? "unreachable" : "reachable";
};

/** What reading a client's live status takes, read once for every client: each part may be missing. */
interface LiveSources {
  env: Env;
  db: ConsoleDatabase;
  /**
   * The deployer's API, its calls stopped by `signal`; null when its token
   * can't be read.
   */
  apiFor: ((signal: AbortSignal) => CloudflareApi) | null;
  /** The router key; null when Secrets Store doesn't have it. */
  routerKey: string | null;
  /** What Secrets Store holds, to check clients against; null when it can't be read. */
  store: StoreCheck | null;
  /** The accounts' usage; null when the analytics couldn't be read at all. */
  usage: Map<string, AccountUsage> | null;
  /** Release manifests, each read once. */
  manifestOf: ManifestOf;
}

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

/**
 * A client's live status, never throwing: what can't be read is unknown.
 * Its requests stop when `signal` aborts.
 */
const liveOf = async (
  { env, db, apiFor, routerKey, store, usage, manifestOf }: LiveSources,
  row: { id: string; accountId: string; hostname: string | null },
  signal: AbortSignal
): Promise<LiveStatus> => {
  const drift =
    apiFor === null
      ? null
      : await orElse(
          async () => await driftOf(apiFor(signal), db, row.id, manifestOf),
          null,
          "grid.drift_unread",
          row.id
        );
  const [sharedSecretsCurrent, reach] = await Promise.all([
    store === null
      ? null
      : orElse(
          async () => await sharedSecretsStatus(db, drift, store),
          null,
          "grid.secrets_unread",
          row.id
        ),
    orElse(
      async () =>
        await reachOf(
          env.ROUTER_HOSTS,
          routerKey,
          row.id,
          row.hostname,
          signal
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
    day:
      used === undefined
        ? null
        : { requests: used.dayRequests, errors: used.dayErrors },
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

/**
 * `accountIds`' usage, its requests stopped after `ms`: each request's
 * answer stands as it comes, and one still going then is aborted, so only
 * its own accounts are unknown (`accountUsage` never throws).
 */
const usageWithin = async (
  ms: number,
  apiFor: (signal: AbortSignal) => CloudflareApi,
  accountIds: readonly string[],
  now: Date
): Promise<Map<string, AccountUsage>> => {
  const limit = deadline(ms);
  try {
    return await accountUsage(apiFor(limit.signal), accountIds, now);
  } finally {
    limit.clear();
  }
};

/**
 * Client `clientId`'s live answer kept within the last minute, if any. A
 * cache that fails to answer is a miss, and so is a kept answer with
 * anything unknown in it (`allKnown`; none is kept now, but one kept
 * before that rule may still be there): the answer is read again.
 */
const cached = async (clientId: string): Promise<LiveStatus | undefined> => {
  try {
    const cache = await caches.open(cacheName);
    const hit = await cache.match(cacheKey(clientId));
    if (hit === undefined) {
      return undefined;
    }
    const parsed = liveStatusSchema.safeParse(await hit.json());
    return parsed.success && allKnown(parsed.data) ? parsed.data : undefined;
  } catch (error) {
    log.warn("grid.cache_unread", { clientId, error: errorCode(error) });
    return undefined;
  }
};

/**
 * Keeps client `clientId`'s live answer for a minute: one with nothing
 * unknown in it (`allKnown`). A cache that fails to keep it is logged,
 * and the answer stands.
 */
const keep = async (clientId: string, live: LiveStatus): Promise<void> => {
  try {
    const cache = await caches.open(cacheName);
    await cache.put(
      cacheKey(clientId),
      Response.json(live, {
        headers: { "cache-control": `max-age=${cacheSeconds}` },
      })
    );
  } catch (error) {
    log.warn("grid.cache_unkept", { clientId, error: errorCode(error) });
  }
};

/** Every client, as the console recorded it, for the grid to show at once. */
export const clientGrid = async (env: Env): Promise<GridRow[]> => {
  const domain = clientDomain(env);
  const recorded = await recordedClients(consoleDatabase(env.DB));
  return recorded.map((row) => ({
    ...row,
    hostname: domain === null ? null : `${row.id}.${domain}`,
  }));
};

/**
 * Each active client's live status, by id, as of `now`: kept answers
 * from the last minute, and the rest read `options.concurrency` clients
 * at a time, each within `options.rowDeadlineMs`. An answer with anything
 * unknown in it isn't kept, so the next call reads that client again.
 */
export const gridLive = async (
  env: Env,
  now: Date,
  options: LiveOptions = defaultLiveOptions
): Promise<Record<string, LiveStatus>> => {
  const db = consoleDatabase(env.DB);
  const grid = await clientGrid(env);
  const active = grid.filter(({ status }) => status === "active");
  const answers = new Map<string, LiveStatus>();
  if (options.cache) {
    const kept = await Promise.all(
      active.map(async ({ id }) => [id, await cached(id)] as const)
    );
    for (const [id, live] of kept) {
      if (live !== undefined) {
        answers.set(id, live);
      }
    }
  }
  const toRead = active.filter(({ id }) => !answers.has(id));
  if (toRead.length > 0) {
    // The token is read once, here: every client's reads, and the
    // analytics', make their API from it, each stopped by its own deadline.
    const token = await ifStored(async () => await deployerToken(env));
    const apiFor =
      token === null
        ? null
        : (signal: AbortSignal): CloudflareApi =>
            cloudflareApi({
              token,
              waitBudgetMs: options.waitBudgetMs,
              signal,
            });
    const secrets = await ifStored(
      async (): Promise<DeploySecrets> => await deploySecrets(env)
    );
    const manifests = new Map<string, ReturnType<ManifestOf>>();
    const sources: LiveSources = {
      env,
      db,
      apiFor,
      routerKey: secrets?.routerKey ?? null,
      store: secrets === null ? null : await storeCheck(secrets),
      usage:
        apiFor === null
          ? null
          : await usageWithin(
              options.rowDeadlineMs,
              apiFor,
              toRead.map(({ accountId }) => accountId),
              now
            ),
      manifestOf: async (id) => {
        const known = manifests.get(id) ?? importedManifest(db, id);
        manifests.set(id, known);
        return await known;
      },
    };
    const read = await eachLimited(
      toRead,
      options.concurrency,
      async (row) =>
        [
          row.id,
          await within(
            options.rowDeadlineMs,
            async (signal) => await liveOf(sources, row, signal),
            unknownStatus
          ),
        ] as const
    );
    for (const [id, live] of read) {
      answers.set(id, live);
    }
    if (options.cache) {
      await Promise.all(
        read
          .filter(([, live]) => allKnown(live))
          .map(async ([id, live]) => {
            await keep(id, live);
          })
      );
    }
  }
  return Object.fromEntries(answers);
};
