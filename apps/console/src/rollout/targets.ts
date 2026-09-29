/**
 * Who a rollout reaches and in what order, and what each client ran
 * before it did.
 *
 * Ring 0 is Grasp's own deployments (`grasp-os-internal`): every rollout
 * reaches them first, then, once a staff member approves, what it was
 * started for: one ring, one client, or every client, ring by ring, with
 * an approval between each.
 */
import { and, eq, inArray, or } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { z } from "zod";

import type { CloudflareApi } from "../cloudflare/api.ts";
import { liveVersion } from "../cloudflare/workers.ts";
import type { ConsoleDatabase } from "../db/act.ts";
import {
  clients,
  clientWorkers,
  releases,
  rolloutTargets,
} from "../db/schema.ts";
import { mappedGeneration } from "../deploy/router.ts";
import type { RouterHosts } from "../deploy/router.ts";

/** The ring every rollout reaches first: Grasp's own deployments. */
export const firstRing = 0;

/** What a rollout is started for, besides ring 0. */
export const rolloutScopeSchema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("all") }),
  z.object({ scope: z.literal("ring"), ring: z.int().nonnegative() }),
  z.object({ scope: z.literal("client"), clientId: z.string().min(1) }),
]);
export type RolloutScope = z.infer<typeof rolloutScopeSchema>;

/** A client a rollout reaches, and the ring it's reached in. */
export interface RolloutTarget {
  clientId: string;
  ring: number;
}

/** Which clients `scope` names, besides ring 0's; undefined for every client. */
const scopeFilter = (scope: RolloutScope): SQL | undefined => {
  if (scope.scope === "all") {
    return undefined;
  }
  return scope.scope === "ring"
    ? inArray(clients.ring, [firstRing, scope.ring])
    : or(eq(clients.ring, firstRing), eq(clients.id, scope.clientId));
};

/** Targets in the order a rollout reaches them: by ring, then by client. */
const byRing = (a: RolloutTarget, b: RolloutTarget): number =>
  a.ring - b.ring || a.clientId.localeCompare(b.clientId);

/**
 * The active clients a rollout for `scope` reaches, each in the ring it's
 * in now: ring 0's, and the scope's. In the order it reaches them.
 */
export const targetsOf = async (
  db: ConsoleDatabase,
  scope: RolloutScope
): Promise<RolloutTarget[]> => {
  const rows = await db
    .select({ clientId: clients.id, ring: clients.ring })
    .from(clients)
    .where(and(eq(clients.status, "active"), scopeFilter(scope)));
  return rows.toSorted(byRing);
};

/** A rollout's targets grouped by ring, in the order it reaches them. */
export interface RingOfTargets {
  ring: number;
  clientIds: string[];
}

/** Rollout `rolloutId`'s targets, ring by ring. */
export const ringsOf = async (
  db: ConsoleDatabase,
  rolloutId: string
): Promise<RingOfTargets[]> => {
  const rows = await db
    .select({ clientId: rolloutTargets.clientId, ring: rolloutTargets.ring })
    .from(rolloutTargets)
    .where(eq(rolloutTargets.rolloutId, rolloutId));
  const rings: RingOfTargets[] = [];
  for (const { clientId, ring } of rows.toSorted(byRing)) {
    const last = rings.at(-1);
    if (last?.ring === ring) {
      last.clientIds.push(clientId);
    } else {
      rings.push({ ring, clientIds: [clientId] });
    }
  }
  return rings;
};

/**
 * What a client ran before a rollout reached it: the release, the version
 * each Worker ran with all its traffic, and the secrets generation the
 * router's map had for it. A rollback puts these back.
 */
export const previousRunSchema = z.object({
  release: z.string().nullable(),
  generation: z.int().nullable(),
  versions: z.record(z.string(), z.string()),
});
export type PreviousRun = z.infer<typeof previousRunSchema>;

/** The client a rollout reaches, as it reads it. */
export interface TargetClient {
  id: string;
  accountId: string;
  status: "provisioning" | "active" | "offboarded";
  pinnedReleaseId: string | null;
  /**
   * Whether its secrets rotated and no deploy made the new generation
   * live yet (src/deploy/rotation.ts): a deploy must still reach it.
   */
  rotationPending: boolean;
  /**
   * The Workers the console deployed to it, with the release it last made
   * live on each and when that release was built.
   */
  workers: {
    worker: string;
    scriptName: string;
    releaseId: string | null;
    releaseBuiltAt: Date | null;
  }[];
}

/** Client `clientId`, as a rollout reads it; undefined when it's gone. */
export const targetClient = async (
  db: ConsoleDatabase,
  clientId: string
): Promise<TargetClient | undefined> => {
  const [client] = await db
    .select({
      id: clients.id,
      accountId: clients.accountId,
      status: clients.status,
      pinnedReleaseId: clients.pinnedReleaseId,
      rotatedAt: clients.rotatedAt,
      rotationLiveAt: clients.rotationLiveAt,
    })
    .from(clients)
    .where(eq(clients.id, clientId));
  if (client === undefined) {
    return undefined;
  }
  const { rotatedAt, rotationLiveAt, ...rest } = client;
  const workers = await db
    .select({
      worker: clientWorkers.worker,
      scriptName: clientWorkers.scriptName,
      releaseId: clientWorkers.releaseId,
      releaseBuiltAt: releases.builtAt,
    })
    .from(clientWorkers)
    .leftJoin(releases, eq(releases.id, clientWorkers.releaseId))
    .where(eq(clientWorkers.clientId, clientId));
  return {
    ...rest,
    rotationPending: rotatedAt !== null && rotationLiveAt === null,
    workers,
  };
};

/** A release, and when it was built: what orders releases. */
export interface ReleaseAt {
  id: string;
  builtAt: Date;
}

/**
 * Why a rollout of `release` skips `client`, or null when it deploys it:
 * it's pinned to another release (`pinned`), whatever it runs now;
 * every Worker runs the release already and no secrets rotation waits
 * for a deploy (`on_release`); or one runs a release built after it
 * (`newer`), which the release's code may not run against (migrations
 * only expand for the release after), unless the client is pinned to
 * this release.
 */
export const skipReason = (
  client: TargetClient,
  release: ReleaseAt
): string | null => {
  if (
    client.pinnedReleaseId !== null &&
    client.pinnedReleaseId !== release.id
  ) {
    return "pinned";
  }
  if (
    !client.rotationPending &&
    client.workers.length > 0 &&
    client.workers.every((worker) => worker.releaseId === release.id)
  ) {
    return "on_release";
  }
  const newer = client.workers.some(
    ({ releaseBuiltAt }) =>
      releaseBuiltAt !== null && releaseBuiltAt > release.builtAt
  );
  return newer && client.pinnedReleaseId !== release.id ? "newer" : null;
};

/** A client whose Worker's traffic is split between versions: a rollout doesn't start on it. */
export class TrafficSplitError extends Error {
  constructor(scriptName: string) {
    super(`${scriptName}'s traffic is split between versions`);
    this.name = "TrafficSplitError";
  }
}

/**
 * What `client` runs now, for a rollback to put back: each Worker's
 * version with all its traffic, and the router map's generation. A Worker
 * whose traffic is split has no one version to go back to, so the
 * rollout doesn't start on it (`TrafficSplitError`).
 */
export const previousRunOf = async (
  api: CloudflareApi,
  hosts: RouterHosts,
  hostname: string,
  client: TargetClient
): Promise<PreviousRun> => {
  const versions: Record<string, string> = {};
  for (const { worker, scriptName } of client.workers) {
    // oxlint-disable-next-line no-await-in-loop -- two Workers
    const live = await liveVersion(api, client.accountId, scriptName);
    if (live === undefined) {
      throw new TrafficSplitError(scriptName);
    }
    versions[worker] = live;
  }
  const onReleases = new Set(client.workers.map(({ releaseId }) => releaseId));
  const [release = null] = onReleases.size === 1 ? onReleases : [];
  return {
    release,
    generation: await mappedGeneration(hosts, hostname),
    versions,
  };
};

/** Parses a target's recorded `previous`; null when it has none. */
export const parsePrevious = (previous: string | null): PreviousRun | null => {
  if (previous === null) {
    return null;
  }
  const parsed = previousRunSchema.safeParse(JSON.parse(previous));
  return parsed.success ? parsed.data : null;
};
