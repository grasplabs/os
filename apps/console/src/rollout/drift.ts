/**
 * Drift: what a client's account runs, read live, against what the
 * console last made live there (`client_workers`, which deploys, rollouts
 * and rollbacks keep). A Worker running another version was changed
 * outside the console (a `wrangler deploy`, a rollback in the
 * dashboard); one whose traffic is split is part way through a gradual
 * deployment, or was left so.
 */
import { log } from "@grasp-os/shared/log";
import { eq } from "drizzle-orm";

import type { CloudflareApi } from "../cloudflare/api.ts";
import { listDeployments } from "../cloudflare/workers.ts";
import type { WorkerDeployment } from "../cloudflare/workers.ts";
import type { ConsoleDatabase } from "../db/act.ts";
import { clients, clientWorkers } from "../db/schema.ts";
import { errorCode } from "../deploy/deploy.ts";
import { importedManifest } from "../deploy/release.ts";

/**
 * A Worker's drift: `in_sync` (all its traffic on the version the console
 * made live), `drifted` (all of it on another), `split` (between
 * versions), or `unknown` (the account didn't answer).
 */
export type DriftState = "in_sync" | "drifted" | "split" | "unknown";

/**
 * A client's drift: its worst Worker's, or `off_pin` when it runs what the
 * console made live but that isn't the release it's pinned to, or
 * `unknown` when the console has made nothing live on it yet.
 */
export type ClientDriftState = DriftState | "off_pin";

/** One of a client's Workers, as drift reads it. */
export interface WorkerDrift {
  worker: string;
  scriptName: string;
  /** The version the console last made live; null when it has no record of the Worker. */
  recorded: string | null;
  /** Its current deployment's versions and shares; null when unknown. */
  live: WorkerDeployment["versions"] | null;
  state: DriftState;
}

/** A client's drift. */
export interface ClientDrift {
  clientId: string;
  /**
   * The release it should run: the one it's pinned to, else the one the
   * console last made live on it.
   */
  intendedRelease: string | null;
  /** Its drift: drifted, then split, off its pin, unknown, in sync. */
  state: ClientDriftState;
  workers: WorkerDrift[];
}

/** The drift of a Worker whose current deployment is `live`. */
const stateOf = (
  recorded: string | null,
  live: WorkerDeployment["versions"]
): DriftState => {
  const [only, ...others] = live;
  if (others.length > 0) {
    return "split";
  }
  return only?.version_id === recorded && only.percentage === 100
    ? "in_sync"
    : "drifted";
};

/** A client's drift is the worst it has, in this order. */
const severity: readonly ClientDriftState[] = [
  "drifted",
  "split",
  "off_pin",
  "unknown",
  "in_sync",
];

/**
 * A release's manifest, as the console imported it: `importedManifest`,
 * or one read once for many clients (the grid).
 */
export type ManifestOf = (
  releaseId: string
) => ReturnType<typeof importedManifest>;

/**
 * Every Worker the releases `releaseIds` have, by app, with its script's
 * name: what a client on them should run, whether or not the console
 * recorded each.
 */
const expectedWorkers = async (
  manifestOf: ManifestOf,
  releaseIds: readonly (string | null)[]
): Promise<Map<string, string>> => {
  const expected = new Map<string, string>();
  for (const id of new Set(releaseIds)) {
    if (id === null) {
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- one or two releases
    const manifest = await manifestOf(id);
    for (const [app, { name }] of Object.entries(manifest?.workers ?? {})) {
      expected.set(app, name);
    }
  }
  return expected;
};

/**
 * Client `clientId`'s drift, read live from its account; null when the
 * console has no such client. Every Worker of the releases it runs or is
 * pinned to is read, recorded or not: one the console has no record of
 * (a deploy that stopped part way, or whose record was lost) is never in
 * sync, `drifted` when its account answers. A Worker whose deployments
 * can't be read is `unknown`, and logged.
 */
export const driftOf = async (
  api: CloudflareApi,
  db: ConsoleDatabase,
  clientId: string,
  manifestOf: ManifestOf = async (id) => await importedManifest(db, id)
): Promise<ClientDrift | null> => {
  const [client] = await db
    .select({
      accountId: clients.accountId,
      pinnedReleaseId: clients.pinnedReleaseId,
    })
    .from(clients)
    .where(eq(clients.id, clientId));
  if (client === undefined) {
    return null;
  }
  const recorded = await db
    .select({
      worker: clientWorkers.worker,
      scriptName: clientWorkers.scriptName,
      releaseId: clientWorkers.releaseId,
      versionId: clientWorkers.versionId,
    })
    .from(clientWorkers)
    .where(eq(clientWorkers.clientId, clientId));
  const expected = await expectedWorkers(manifestOf, [
    ...recorded.map(({ releaseId }) => releaseId),
    ...(client.pinnedReleaseId === null ? [] : [client.pinnedReleaseId]),
  ]);
  const unrecorded = [...expected]
    .filter(([worker]) => !recorded.some((row) => row.worker === worker))
    .map(([worker, scriptName]) => ({ worker, scriptName, versionId: null }));
  const workers = await Promise.all(
    [...recorded, ...unrecorded].map(
      async ({ worker, scriptName, versionId }) => {
        try {
          const [current] = await listDeployments(
            api,
            client.accountId,
            scriptName
          );
          const live = current?.versions ?? [];
          return {
            worker,
            scriptName,
            recorded: versionId,
            live,
            state: stateOf(versionId, live),
          };
        } catch (error) {
          log.warn("drift.unread", {
            clientId,
            worker,
            error: errorCode(error),
          });
          return {
            worker,
            scriptName,
            recorded: versionId,
            live: null,
            state: "unknown" as const,
          };
        }
      }
    )
  );
  const states = new Set<ClientDriftState>(workers.map(({ state }) => state));
  const releases = new Set(recorded.map(({ releaseId }) => releaseId));
  const [recordedRelease = null] = releases.size === 1 ? releases : [];
  if (recorded.length === 0) {
    states.add("unknown");
  }
  const { pinnedReleaseId } = client;
  if (
    pinnedReleaseId !== null &&
    recorded.some(({ releaseId }) => releaseId !== pinnedReleaseId)
  ) {
    states.add("off_pin");
  }
  return {
    clientId,
    intendedRelease: pinnedReleaseId ?? recordedRelease,
    state: severity.find((state) => states.has(state)) ?? "in_sync",
    workers,
  };
};
