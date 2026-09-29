/** Reading rollouts, as the rollout pages show them. */
import { desc, eq } from "drizzle-orm";

import { consoleDatabase } from "../db/act.ts";
import type { ConsoleDatabase } from "../db/act.ts";
import { clients, rollouts, rolloutTargets } from "../db/schema.ts";
import { listReleases } from "../releases/queries.ts";
import { instanceStatus } from "../runners.ts";
import type { RunStatus } from "../runners.ts";
import { sharedSecretsCurrent } from "./shared-secrets.ts";
import { firstRing } from "./targets.ts";

/** How many rollouts the list shows: the latest. */
const listed = 50;

/** A rollout as the list shows it. */
export interface RolloutSummary {
  id: string;
  kind: (typeof rollouts.kind.enumValues)[number];
  releaseId: string | null;
  status: (typeof rollouts.status.enumValues)[number];
  ring: number;
  startedBy: string;
  createdAt: Date;
}

/** The latest rollouts, newest first. */
export const listRollouts = async (
  db: ConsoleDatabase
): Promise<RolloutSummary[]> =>
  await db
    .select({
      id: rollouts.id,
      kind: rollouts.kind,
      releaseId: rollouts.releaseId,
      status: rollouts.status,
      ring: rollouts.ring,
      startedBy: rollouts.startedBy,
      createdAt: rollouts.createdAt,
    })
    .from(rollouts)
    .orderBy(desc(rollouts.createdAt))
    .limit(listed);

/** One client in a rollout, as its page shows it. */
export interface TargetView {
  clientId: string;
  ring: number;
  status: (typeof rolloutTargets.status.enumValues)[number];
  error: string | null;
  updatedAt: Date;
}

/** A rollout, as its page shows it. */
export interface RolloutView extends RolloutSummary {
  /** Its run's status, as Workflows has it: `paused` while staff paused it. */
  run: RunStatus;
  /** Its clients, ring by ring, then by id. */
  targets: TargetView[];
  /**
   * For a secrets rollout, whether the old shared secrets can be revoked:
   * which active clients run the ones in Secrets Store now
   * (src/rollout/shared-secrets.ts), and those it didn't target. Null for
   * a release rollout, or while the store can't be read.
   */
  sharedSecrets: SharedSecretsView | null;
}

/** Where every active client is on the shared secrets in Secrets Store now. */
export interface SharedSecretsView {
  /** The active clients that run them now, by id. */
  current: string[];
  /** The active clients that don't, by id: until none is left, keep the old ones. */
  behind: string[];
  /** The active clients the rollout didn't target, by id. */
  outOfScope: string[];
}

/**
 * Where every active client is on the shared secrets in Secrets Store
 * now, for rollout targets `targets`; null while the store can't be read.
 */
const sharedSecretsView = async (
  env: Env,
  db: ConsoleDatabase,
  targets: readonly { clientId: string }[]
): Promise<SharedSecretsView | null> => {
  const current = await sharedSecretsCurrent(env, db);
  if (current === null) {
    return null;
  }
  const active = await db
    .select({ id: clients.id })
    .from(clients)
    .where(eq(clients.status, "active"));
  const ids = active.map(({ id }) => id).toSorted((a, b) => a.localeCompare(b));
  const targeted = new Set(targets.map(({ clientId }) => clientId));
  return {
    current: ids.filter((id) => current.get(id) === true),
    behind: ids.filter((id) => current.get(id) !== true),
    outOfScope: ids.filter((id) => !targeted.has(id)),
  };
};

/** Rollout `id`, or null when there's none. */
export const getRollout = async (
  env: Env,
  id: string
): Promise<RolloutView | null> => {
  const db = consoleDatabase(env.DB);
  const [rollout] = await db
    .select({
      id: rollouts.id,
      kind: rollouts.kind,
      releaseId: rollouts.releaseId,
      status: rollouts.status,
      ring: rollouts.ring,
      startedBy: rollouts.startedBy,
      createdAt: rollouts.createdAt,
    })
    .from(rollouts)
    .where(eq(rollouts.id, id));
  if (rollout === undefined) {
    return null;
  }
  const targets = await db
    .select({
      clientId: rolloutTargets.clientId,
      ring: rolloutTargets.ring,
      status: rolloutTargets.status,
      error: rolloutTargets.error,
      updatedAt: rolloutTargets.updatedAt,
    })
    .from(rolloutTargets)
    .where(eq(rolloutTargets.rolloutId, id));
  const { status } = await instanceStatus(env.ROLLOUT, id, rollout.createdAt);
  return {
    ...rollout,
    run: status,
    targets: targets.toSorted(
      (a, b) => a.ring - b.ring || a.clientId.localeCompare(b.clientId)
    ),
    sharedSecrets:
      rollout.kind === "secrets"
        ? await sharedSecretsView(env, db, targets)
        : null,
  };
};

/** What the form to start a rollout offers. */
export interface RolloutOptions {
  /** The imported releases, newest first. */
  releases: { id: string; notes: string }[];
  /** The ring every rollout reaches first (`firstRing`). */
  firstRing: number;
  /** Each ring active clients are in, with how many, in order. */
  rings: { ring: number; clients: number }[];
  /** The active clients past ring 0, by id: those a rollout can be started for. */
  clientIds: string[];
}

/** What a rollout can be started with. */
export const rolloutOptions = async (
  db: ConsoleDatabase
): Promise<RolloutOptions> => {
  const { releases } = await listReleases(db);
  const active = await db
    .select({ id: clients.id, ring: clients.ring })
    .from(clients)
    .where(eq(clients.status, "active"));
  const counts = new Map<number, number>();
  for (const { ring } of active) {
    counts.set(ring, (counts.get(ring) ?? 0) + 1);
  }
  return {
    releases: releases.map(({ id, notes }) => ({ id, notes })),
    firstRing,
    rings: [...counts]
      .map(([ring, count]) => ({ ring, clients: count }))
      .toSorted((a, b) => a.ring - b.ring),
    clientIds: active
      .filter(({ ring }) => ring !== firstRing)
      .map(({ id }) => id)
      .toSorted((a, b) => a.localeCompare(b)),
  };
};
