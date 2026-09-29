/**
 * Whether the old shared secrets can be revoked at their providers after
 * a secrets rollout: only once a rotation is proven to have reached every
 * active client.
 *
 * Each version a deploy uploads records a keyed fingerprint of the shared
 * secrets it runs with (`sharedSecretsFingerprint`: it tells nothing of
 * the values). A secrets rollout records Secrets Store's fingerprints when
 * it starts, and each target's previous run (the versions it ran before
 * the rollout reached it, `previous`). The go-ahead needs all of:
 * - Secrets Store still holds what it held at the start (`store_changed`
 *   otherwise: roll the new values out first);
 * - every target the rollout reached ran something else before
 *   (`unchanged` otherwise: the store held what it already ran, so
 *   deploy-ops may not have written a new value, and there's nothing to
 *   revoke yet), as its recorded fingerprints show (`unproven` when they
 *   don't);
 * - every active client runs the store's shared secrets, read live from
 *   its account as drift reads it (src/rollout/drift.ts), every Worker of
 *   its release: one unrecorded, split, unreadable, or live on a version
 *   without a fingerprint is `behind`.
 *
 * Read on demand: it reads every active client's account.
 */
import { eq } from "drizzle-orm";
import { z } from "zod";

import { consoleDatabase } from "../db/act.ts";
import type { ConsoleDatabase } from "../db/act.ts";
import { clients, rollouts, rolloutTargets } from "../db/schema.ts";
import {
  deployerApi,
  deploySecrets,
  MissingStoreSecretError,
} from "../deploy/context.ts";
import { recordedPrintOf } from "../deploy/deploy.ts";
import { sharedSecretsFingerprint } from "../deploy/secrets.ts";
import type { DeploySecrets } from "../deploy/secrets.ts";
import { driftOf } from "./drift.ts";
import type { ClientDrift } from "./drift.ts";
import { parsePrevious } from "./targets.ts";

/** Shared-secrets fingerprints, by app. */
export type SharedPrints = Record<string, string>;

const sharedPrintsSchema = z.record(z.string(), z.string());

/** The fingerprints of the shared secrets `secrets` gives each app. */
export const storePrints = async (
  secrets: Pick<DeploySecrets, "clientKey" | "shared">
): Promise<SharedPrints> =>
  Object.fromEntries(
    await Promise.all(
      Object.keys(secrets.shared).map(
        async (app): Promise<[string, string]> => [
          app,
          await sharedSecretsFingerprint(secrets, app),
        ]
      )
    )
  );

/** Client ids in order. */
const byId = (a: string, b: string): number => a.localeCompare(b);

/** Whether two sets of fingerprints are the same, app by app. */
const samePrints = (a: SharedPrints, b: SharedPrints): boolean => {
  const apps = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...apps].every((app) => a[app] === b[app]);
};

/**
 * Whether the client whose drift is `drift` (read live, `driftOf`) runs
 * `expected`: every Worker of its release recorded, and sending all its
 * traffic to one version whose recorded shared fingerprint is the app's
 * in `expected`.
 */
export const runsSharedSecrets = async (
  db: ConsoleDatabase,
  drift: ClientDrift | null,
  expected: SharedPrints
): Promise<boolean> => {
  if (drift === null || drift.workers.length === 0) {
    return false;
  }
  const { clientId } = drift;
  const matches = await Promise.all(
    drift.workers.map(async ({ worker, recorded, live }) => {
      const [only, ...others] = live ?? [];
      if (
        recorded === null ||
        only === undefined ||
        others.length > 0 ||
        only.percentage !== 100
      ) {
        return false;
      }
      const print = await recordedPrintOf(
        db,
        clientId,
        worker,
        only.version_id,
        "shared"
      );
      return print !== null && print === expected[worker];
    })
  );
  return matches.every(Boolean);
};

/** Whether a secrets rollout's old shared secrets can be revoked, and why not. */
export interface RevocationCheck {
  /** Every condition holds: the old shared secrets can be revoked. */
  safe: boolean;
  /** Secrets Store changed since the rollout started. */
  storeChanged: boolean;
  /** Targets it reached that already ran what the store held: nothing rotated for them. */
  unchanged: string[];
  /** Targets it reached whose previous shared secrets aren't on record. */
  unproven: string[];
  /** Active clients that don't run the store's shared secrets, read live. */
  behind: string[];
  /** Targets it skipped, and why. */
  skipped: { clientId: string; reason: string }[];
  /** Active clients it didn't target. */
  outOfScope: string[];
}

/** What a revocation check can't be made for. */
export type RevocationRefusal = "not_secrets_rollout" | "store_unreadable";

/**
 * Whether secrets rollout `rolloutId`'s old shared secrets can be revoked
 * (`RevocationCheck`); a refusal for a rollout that isn't one, or while
 * Secrets Store can't be read.
 */
export const checkRevocation = async (
  env: Env,
  rolloutId: string
): Promise<RevocationCheck | RevocationRefusal> => {
  const db = consoleDatabase(env.DB);
  const [rollout] = await db
    .select({ kind: rollouts.kind, sharedSecrets: rollouts.sharedSecrets })
    .from(rollouts)
    .where(eq(rollouts.id, rolloutId));
  const started = sharedPrintsSchema.safeParse(
    JSON.parse(rollout?.sharedSecrets ?? "null")
  );
  if (rollout?.kind !== "secrets" || !started.success) {
    return "not_secrets_rollout";
  }
  let now: SharedPrints;
  try {
    now = await storePrints(await deploySecrets(env));
  } catch (error) {
    if (error instanceof MissingStoreSecretError) {
      return "store_unreadable";
    }
    throw error;
  }
  const targets = await db
    .select({
      clientId: rolloutTargets.clientId,
      status: rolloutTargets.status,
      error: rolloutTargets.error,
      previous: rolloutTargets.previous,
    })
    .from(rolloutTargets)
    .where(eq(rolloutTargets.rolloutId, rolloutId));
  const unchanged: string[] = [];
  const unproven: string[] = [];
  for (const target of targets) {
    const previous = parsePrevious(target.previous);
    if (previous === null) {
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- a few apps per target
    const before = await Promise.all(
      Object.entries(previous.versions).map(
        async ([app, version]): Promise<[string, string | null]> => [
          app,
          await recordedPrintOf(db, target.clientId, app, version, "shared"),
        ]
      )
    );
    if (before.some(([, print]) => print === null)) {
      unproven.push(target.clientId);
    } else if (before.every(([app, print]) => print === started.data[app])) {
      unchanged.push(target.clientId);
    }
  }
  const active = await db
    .select({ id: clients.id })
    .from(clients)
    .where(eq(clients.status, "active"));
  const api = await deployerApi(env);
  const current = await Promise.all(
    active.map(
      async ({ id }) =>
        [
          id,
          await runsSharedSecrets(db, await driftOf(api, db, id), now),
        ] as const
    )
  );
  const targeted = new Set(targets.map(({ clientId }) => clientId));
  const check = {
    storeChanged: !samePrints(started.data, now),
    unchanged: unchanged.toSorted(byId),
    unproven: unproven.toSorted(byId),
    behind: current
      .filter(([, runs]) => !runs)
      .map(([id]) => id)
      .toSorted(byId),
    skipped: targets
      .filter(({ status }) => status === "skipped")
      .map(({ clientId, error }) => ({ clientId, reason: error ?? "skipped" }))
      .toSorted((a, b) => byId(a.clientId, b.clientId)),
    outOfScope: active
      .map(({ id }) => id)
      .filter((id) => !targeted.has(id))
      .toSorted(byId),
  };
  return {
    ...check,
    safe:
      !check.storeChanged &&
      check.unchanged.length === 0 &&
      check.unproven.length === 0 &&
      check.behind.length === 0 &&
      targets.some(({ previous }) => previous !== null),
  };
};
