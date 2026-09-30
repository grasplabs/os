/**
 * Which old shared secrets can be revoked at their providers after a
 * secrets rollout, secret by secret: only one a rotation is proven to
 * have changed and to have reached every active client that holds it.
 *
 * Each version a deploy uploads records a keyed fingerprint of each shared
 * secret it runs with, by name (`sharedSecretPrints`: they tell nothing of
 * the values). A secrets rollout records Secrets Store's, by name, when it
 * starts, and each target's previous run (the versions it ran before the
 * rollout reached it, `previous`). A secret's old value can be revoked
 * when all of:
 * - the rollout rotated it: a target it reached ran another value before
 *   (none did: the store held what they ran, so deploy-ops may not have
 *   written a new value, and there's nothing to revoke yet);
 * - Secrets Store still holds what it held at the start;
 * - every active client runs the store's value on every Worker of its
 *   release that holds the secret, read live from its account as drift
 *   reads it (src/rollout/drift.ts): a Worker that's unrecorded, split,
 *   unreadable, or live on a version without fingerprints is behind on
 *   every secret it holds, and so is a client whose account doesn't
 *   answer in time;
 * - no client is still being provisioned with a Worker made live: its
 *   run isn't a rollout's target, and may hold the store's earlier values
 *   for the Workers it has yet to upload, so it counts as behind on every
 *   secret, unread.
 * A secret the rollout didn't rotate is never called revocable.
 *
 * Read on demand: it reads every active client's account, a few at a
 * time, each within a deadline (src/live-reads.ts).
 */
import { and, eq, exists } from "drizzle-orm";
import { z } from "zod";

import { cloudflareApi } from "../cloudflare/api.ts";
import { consoleDatabase } from "../db/act.ts";
import type { ConsoleDatabase } from "../db/act.ts";
import {
  clients,
  clientWorkers,
  rollouts,
  rolloutTargets,
} from "../db/schema.ts";
import {
  deployerToken,
  deploySecrets,
  MissingStoreSecretError,
} from "../deploy/context.ts";
import { recordedPrintOf } from "../deploy/deploy.ts";
import { sharedSecretPrints } from "../deploy/secrets.ts";
import type { DeploySecrets } from "../deploy/secrets.ts";
import { defaultLiveReadLimits, eachLimited, within } from "../live-reads.ts";
import type { LiveReadLimits } from "../live-reads.ts";
import { driftOf } from "./drift.ts";
import type { ClientDrift } from "./drift.ts";
import { parsePrevious } from "./targets.ts";

/** Shared-secret fingerprints, by secret name. */
export type SharedPrints = Record<string, string>;

const sharedPrintsSchema = z.record(z.string(), z.string());

/** Client ids in order. */
const byId = (a: string, b: string): number => a.localeCompare(b);

/**
 * The fingerprint of each shared secret in `secrets`, by name: a secret
 * two apps share has one value, so one fingerprint.
 */
export const storePrints = async (
  secrets: Pick<DeploySecrets, "clientKey" | "shared">
): Promise<SharedPrints> => {
  const byApp = await Promise.all(
    Object.keys(secrets.shared).map(
      async (app) => await sharedSecretPrints(secrets, app)
    )
  );
  return Object.fromEntries(byApp.flatMap((prints) => Object.entries(prints)));
};

/** The shared secrets each app holds, by app, from `secrets`. */
const holdersOf = (
  secrets: Pick<DeploySecrets, "shared">
): Record<string, string[]> =>
  Object.fromEntries(
    Object.entries(secrets.shared).map(([app, values]) => [
      app,
      Object.keys(values),
    ])
  );

/**
 * The shared-secret fingerprints client `clientId`'s deploys recorded for
 * `app`'s version `version`, by name; null when none are on record.
 */
const recordedShared = async (
  db: ConsoleDatabase,
  clientId: string,
  app: string,
  version: string
): Promise<SharedPrints | null> => {
  const text = await recordedPrintOf(db, clientId, app, version, "shared");
  if (text === null) {
    return null;
  }
  const parsed = sharedPrintsSchema.safeParse(JSON.parse(text));
  return parsed.success ? parsed.data : null;
};

/**
 * For each shared secret, whether the client whose drift is `drift` (read
 * live, `driftOf`) runs `expected`'s value on every Worker of its release
 * that holds it (`holders`), by name. A Worker that's unrecorded, split,
 * unreadable or live on a version without fingerprints runs none of the
 * secrets it holds; a client with no Worker read runs none at all.
 */
const liveMatches = async (
  db: ConsoleDatabase,
  drift: ClientDrift | null,
  holders: Readonly<Record<string, readonly string[]>>,
  expected: SharedPrints
): Promise<Map<string, boolean>> => {
  const names = [...new Set(Object.values(holders).flat())];
  const matches = new Map(names.map((name) => [name, true]));
  if (drift === null || drift.workers.length === 0) {
    return new Map(names.map((name) => [name, false]));
  }
  const workers = await Promise.all(
    drift.workers.map(async ({ worker, recorded, live }) => {
      const [only, ...others] = live ?? [];
      const serving =
        recorded === null ||
        only === undefined ||
        others.length > 0 ||
        only.percentage !== 100
          ? null
          : only.version_id;
      return {
        held: holders[worker] ?? [],
        prints:
          serving === null
            ? null
            : await recordedShared(db, drift.clientId, worker, serving),
      };
    })
  );
  for (const { held, prints } of workers) {
    for (const name of held) {
      const runs = prints !== null && prints[name] === expected[name];
      matches.set(name, (matches.get(name) ?? true) && runs);
    }
  }
  return matches;
};

/**
 * What Secrets Store holds, as clients are checked against it: the shared
 * secrets each app holds, and their fingerprints (`storePrints`). Worked
 * out once for however many clients are checked.
 */
export interface StoreCheck {
  holders: Record<string, string[]>;
  expected: SharedPrints;
}

/** What `secrets`' store holds, to check clients against (`sharedSecretsStatus`). */
export const storeCheck = async (
  secrets: Pick<DeploySecrets, "clientKey" | "shared">
): Promise<StoreCheck> => ({
  holders: holdersOf(secrets),
  expected: await storePrints(secrets),
});

/**
 * Whether the client whose drift is `drift` (read live, `driftOf`) runs
 * every shared secret in the store now (`check`), on every Worker holding
 * it; null when that can't be told: its drift is unknown (nothing
 * recorded, or its account didn't answer), or a Worker's live versions
 * weren't read. Only what was read and differs is behind.
 */
export const sharedSecretsStatus = async (
  db: ConsoleDatabase,
  drift: ClientDrift | null,
  check: StoreCheck
): Promise<boolean | null> => {
  if (
    drift === null ||
    drift.state === "unknown" ||
    drift.workers.some(({ live }) => live === null)
  ) {
    return null;
  }
  const matches = await liveMatches(db, drift, check.holders, check.expected);
  return [...matches.values()].every(Boolean);
};

/** Which of a secrets rollout's old shared secrets can be revoked, and why not the rest. */
export interface RevocationCheck {
  /** Secrets whose old values can be revoked, by name: rotated, and everywhere. */
  revocable: string[];
  /** Secrets the rollout changed for a client it reached, by name. */
  rotated: string[];
  /** Secrets Secrets Store changed since the rollout started, by name. */
  storeChanged: string[];
  /**
   * Per rotated secret, the clients not known to run the store's value:
   * active ones that don't, read live, or whose account didn't answer in
   * time, and every client still being provisioned with a Worker made
   * live.
   */
  behind: Record<string, string[]>;
  /** Targets it reached whose previous shared secrets aren't on record. */
  unproven: string[];
  /** Targets it skipped, and why. */
  skipped: { clientId: string; reason: string }[];
  /** Active clients it didn't target. */
  outOfScope: string[];
}

/** What a revocation check can't be made for. */
export type RevocationRefusal = "not_secrets_rollout" | "store_unreadable";

/**
 * The secrets whose fingerprint in `before`, what a client ran before
 * rollout, differs from `started`'s, what the store held when it started.
 */
const changedSince = (before: SharedPrints, started: SharedPrints): string[] =>
  Object.keys(started).filter(
    (name) => before[name] !== undefined && before[name] !== started[name]
  );

/**
 * The clients still being provisioned that have a Worker the console made
 * live: what a revocation check counts as behind without reading them.
 */
const provisioningWithWorker = async (
  db: ConsoleDatabase
): Promise<string[]> => {
  const rows = await db
    .select({ id: clients.id })
    .from(clients)
    .where(
      and(
        eq(clients.status, "provisioning"),
        exists(
          db
            .select({ worker: clientWorkers.worker })
            .from(clientWorkers)
            .where(eq(clientWorkers.clientId, clients.id))
        )
      )
    );
  return rows.map(({ id }) => id);
};

/**
 * Which of secrets rollout `rolloutId`'s old shared secrets can be revoked
 * (`RevocationCheck`); a refusal for a rollout that isn't one, or while
 * Secrets Store can't be read. Active clients are read `limits.concurrency`
 * at a time, each within `limits.rowDeadlineMs`; one that doesn't answer
 * by then is behind on every secret.
 */
export const checkRevocation = async (
  env: Env,
  rolloutId: string,
  limits: LiveReadLimits = defaultLiveReadLimits
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
  let secrets: DeploySecrets;
  try {
    secrets = await deploySecrets(env);
  } catch (error) {
    if (error instanceof MissingStoreSecretError) {
      return "store_unreadable";
    }
    throw error;
  }
  const now = await storePrints(secrets);
  const holders = holdersOf(secrets);
  const targets = await db
    .select({
      clientId: rolloutTargets.clientId,
      status: rolloutTargets.status,
      error: rolloutTargets.error,
      previous: rolloutTargets.previous,
    })
    .from(rolloutTargets)
    .where(eq(rolloutTargets.rolloutId, rolloutId));
  const rotated = new Set<string>();
  const unproven: string[] = [];
  for (const target of targets) {
    const previous = parsePrevious(target.previous);
    if (previous === null) {
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- a few apps per target
    const before = await Promise.all(
      Object.entries(previous.versions).map(
        async ([app, version]) =>
          await recordedShared(db, target.clientId, app, version)
      )
    );
    if (before.some((prints) => prints === null)) {
      unproven.push(target.clientId);
      continue;
    }
    for (const prints of before) {
      for (const name of changedSince(prints ?? {}, started.data)) {
        rotated.add(name);
      }
    }
  }
  const storeChanged = Object.keys({ ...started.data, ...now }).filter(
    (name) => started.data[name] !== now[name]
  );
  const active = await db
    .select({ id: clients.id })
    .from(clients)
    .where(eq(clients.status, "active"));
  // Read once: every client's reads make their API from it, each stopped
  // by its own deadline.
  const token = await deployerToken(env);
  const live = await eachLimited(
    active,
    limits.concurrency,
    async ({ id }) =>
      [
        id,
        await within(
          limits.rowDeadlineMs,
          async (signal) => {
            const api = cloudflareApi({
              token,
              waitBudgetMs: limits.waitBudgetMs,
              signal,
            });
            return await liveMatches(
              db,
              await driftOf(api, db, id),
              holders,
              now
            );
          },
          // No answer in time: it runs none of them, as far as is known.
          await liveMatches(db, null, holders, now)
        ),
      ] as const
  );
  const provisioning = await provisioningWithWorker(db);
  const behind = Object.fromEntries(
    [...rotated].map((name) => [
      name,
      [
        ...live
          .filter(([, matches]) => matches.get(name) !== true)
          .map(([id]) => id),
        ...provisioning,
      ].toSorted(byId),
    ])
  );
  const targeted = new Set(targets.map(({ clientId }) => clientId));
  return {
    revocable: [...rotated]
      .filter(
        (name) =>
          !storeChanged.includes(name) && (behind[name] ?? []).length === 0
      )
      .toSorted(),
    rotated: [...rotated].toSorted(),
    storeChanged: storeChanged.toSorted(),
    behind,
    unproven: unproven.toSorted(byId),
    skipped: targets
      .filter(({ status }) => status === "skipped")
      .map(({ clientId, error }) => ({ clientId, reason: error ?? "skipped" }))
      .toSorted((a, b) => byId(a.clientId, b.clientId)),
    outOfScope: active
      .map(({ id }) => id)
      .filter((id) => !targeted.has(id))
      .toSorted(byId),
  };
};
