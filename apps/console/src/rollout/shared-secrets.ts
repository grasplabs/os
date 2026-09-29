/**
 * Whether clients run the shared secrets Secrets Store holds now: what
 * tells staff an old shared secret can be revoked at its provider (every
 * active client runs the new one), whatever a secrets rollout skipped or
 * didn't reach, and however long ago deploy-ops wrote the store.
 *
 * Each version a deploy uploads records a fingerprint of the shared
 * secrets it runs with (`sharedSecretsFingerprint`, keyed, so it tells
 * nothing of the values). A client is current when every Worker the
 * console made live on it (`client_workers`) has a recorded fingerprint
 * equal to the store's now. A version without one (a rollback to a
 * version from before fingerprints, or anything outside the console)
 * counts as not current: only a match proves the new secret is there.
 */
import { and, eq, sql } from "drizzle-orm";

import type { ConsoleDatabase } from "../db/act.ts";
import { clientDeploys, clients, clientWorkers } from "../db/schema.ts";
import { deploySecrets, MissingStoreSecretError } from "../deploy/context.ts";
import { sharedSecretsFingerprint } from "../deploy/secrets.ts";

/**
 * Whether each active client (or only `clientId`) runs the shared secrets
 * in Secrets Store now, by client id; null when the store can't be read
 * (a secret missing from it), so nothing can be said.
 */
export const sharedSecretsCurrent = async (
  env: Env,
  db: ConsoleDatabase,
  clientId?: string
): Promise<Map<string, boolean> | null> => {
  let secrets: Awaited<ReturnType<typeof deploySecrets>>;
  try {
    secrets = await deploySecrets(env);
  } catch (error) {
    if (error instanceof MissingStoreSecretError) {
      return null;
    }
    throw error;
  }
  // One query for them all: each Worker's live version, as the console
  // recorded it, and the shared fingerprint the latest deploy that
  // uploaded that version recorded for it (on the client's deploys index).
  const rows = await db
    .select({
      clientId: clientWorkers.clientId,
      worker: clientWorkers.worker,
      shared: sql<
        string | null
      >`(SELECT json_extract(${clientDeploys.versions}, '$.byApp.' || ${clientWorkers.worker} || '.shared') FROM ${clientDeploys} WHERE ${clientDeploys.clientId} = ${clientWorkers.clientId} AND json_extract(${clientDeploys.versions}, '$.byApp.' || ${clientWorkers.worker} || '.version') = ${clientWorkers.versionId} ORDER BY ${clientDeploys.createdAt} DESC LIMIT 1)`,
    })
    .from(clientWorkers)
    .innerJoin(clients, eq(clients.id, clientWorkers.clientId))
    .where(
      and(
        eq(clients.status, "active"),
        clientId === undefined ? undefined : eq(clients.id, clientId)
      )
    );
  const expected = new Map<string, string>();
  for (const worker of new Set(rows.map((row) => row.worker))) {
    // oxlint-disable-next-line no-await-in-loop -- one per app, two at most
    expected.set(worker, await sharedSecretsFingerprint(secrets, worker));
  }
  const current = new Map<string, boolean>();
  for (const row of rows) {
    const matches =
      row.shared !== null && row.shared === expected.get(row.worker);
    current.set(row.clientId, (current.get(row.clientId) ?? true) && matches);
  }
  return current;
};
