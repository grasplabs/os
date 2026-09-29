/**
 * The secrets a deploy gives each of a release's Workers.
 *
 * A client's own secrets are derived, never stored: each is
 * `HMAC(masterKey, "<purpose>:<clientId>:<generation>")`
 * (`deriveClientSecret`), the router secret under `ROUTER_KEY` and the
 * rest under `CLIENT_KEY`, both from Secrets Store. Everything else a
 * Worker needs is shared by every client (the OAuth apps' secrets, the
 * Composio key), and the caller passes it.
 *
 * Raising the client's generation (`rotateClientSecrets`) rotates all of
 * them at once. Until the new generation is live (a deploy has made it
 * so, `clients.rotation_live_at`) and for `rotationWindowMs` after, the
 * keys that support rotation also get the previous generation's value: core accepts the
 * previous router secret while every router isolate moves to the new one,
 * connect checks capabilities signed with the previous key, and its cron
 * seals tokens again under the new vault key. Rotating also changes
 * `BETTER_AUTH_SECRET`, which has no previous value: everyone is signed
 * out and signs in again.
 */
import { deriveClientSecret } from "@grasp-os/shared/client-secrets";
import type { SecretEncoding } from "@grasp-os/shared/client-secrets";
import type { WorkerEntry } from "@grasp-os/shared/release";

import type { Secret } from "../cloudflare/workers.ts";
import { DeployError } from "./errors.ts";

/**
 * How long after a rotation went live a Worker still gets the previous
 * generation's keys: long enough for connect's cron to seal every token
 * again.
 */
export const rotationWindowMs = 7 * 24 * 60 * 60 * 1000;

/** The secrets a deploy gives the Workers, from Secrets Store. */
export interface DeploySecrets {
  /** `ROUTER_KEY`: each client's router secret is derived from it. */
  routerKey: string;
  /** `CLIENT_KEY`: each client's other secrets are derived from it. */
  clientKey: string;
  /**
   * The secrets shared by every client, by app (`core`, `connect`), then
   * by name. Never a reserved name (`reservedSecretNames`).
   */
  shared: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

/** One of a client's secrets, derived for it. */
interface DerivedSecret {
  name: string;
  /** The label it's derived under. */
  purpose: string;
  master: "routerKey" | "clientKey";
  /** As the Worker parses it. */
  encoding: SecretEncoding;
  /** Where the previous generation's value goes, for a key its Worker rotates. */
  previous?: string;
}

/** Core's router secret (core's src/router-secret.ts): 64 hex characters. */
const routerSecret: DerivedSecret = {
  name: "ROUTER_SECRET",
  purpose: "router",
  master: "routerKey",
  encoding: "hex",
  previous: "ROUTER_SECRET_PREVIOUS",
};

/** Core's auth secret (core's src/auth/auth.ts): 64 hex characters. */
const authSecret: DerivedSecret = {
  name: "BETTER_AUTH_SECRET",
  purpose: "better-auth",
  master: "clientKey",
  encoding: "hex",
};

/**
 * Core signs capabilities with it, connect checks them (at least 32
 * characters); only connect checks with the previous one.
 */
const capabilityKey = (previous?: string): DerivedSecret => ({
  name: "CAPABILITY_SIGNING_KEY",
  purpose: "capability",
  master: "clientKey",
  encoding: "hex",
  ...(previous === undefined ? {} : { previous }),
});

/** Connect's vault key (connect's src/vault.ts): 32 bytes, base64. */
const tokenEncryptionKey: DerivedSecret = {
  name: "TOKEN_ENCRYPTION_KEY",
  purpose: "token-encryption",
  master: "clientKey",
  encoding: "base64",
  previous: "TOKEN_ENCRYPTION_KEY_PREVIOUS",
};

/** Each app's derived secrets. */
const derivedSecrets: Readonly<Record<string, readonly DerivedSecret[]>> = {
  core: [routerSecret, authSecret, capabilityKey()],
  connect: [
    capabilityKey("CAPABILITY_SIGNING_KEY_PREVIOUS"),
    tokenEncryptionKey,
  ],
};

/**
 * Client `clientId`'s core auth secret at `generation`, as its core has
 * it: what the console signs what it tells core with keys derived from
 * (src/rollout/activity.ts).
 */
export const clientAuthSecret = async (
  secrets: Pick<DeploySecrets, "routerKey" | "clientKey">,
  clientId: string,
  generation: number
): Promise<string> =>
  await deriveClientSecret(
    secrets[authSecret.master],
    authSecret.purpose,
    clientId,
    generation,
    authSecret.encoding
  );

/**
 * Every name a derived secret or its previous value takes, on any Worker:
 * none can be given as a shared secret.
 */
export const reservedSecretNames: ReadonlySet<string> = new Set(
  Object.values(derivedSecrets).flatMap((secrets) =>
    secrets.flatMap(({ name, previous }) =>
      previous === undefined ? [name] : [name, previous]
    )
  )
);

/** The client whose secrets are derived, and its rotation. */
export interface ClientGeneration {
  id: string;
  /** Its generation, from 1. */
  generation: number;
  /** When a deploy made this generation live; null until one has. */
  rotationLiveAt: Date | null;
}

/**
 * Every secret the Worker `app` runs with: its derived ones for the client
 * and its generation (with the previous generation's, where the Worker
 * takes it, until `rotationWindowMs` after the generation went live), and the
 * shared ones given for it. Throws `reserved_secret_name` for a shared
 * secret under a reserved name, and `missing_secret` for a required one it
 * has no value for, so nothing is uploaded without it.
 */
export const workerSecrets = async (
  app: string,
  worker: WorkerEntry,
  secrets: DeploySecrets,
  client: ClientGeneration,
  now: Date
): Promise<Secret[]> => {
  const values = new Map(Object.entries(secrets.shared[app] ?? {}));
  const reserved = [...values.keys()].find((name) =>
    reservedSecretNames.has(name)
  );
  if (reserved !== undefined) {
    throw new DeployError(
      "reserved_secret_name",
      `${worker.name}'s ${reserved} is derived, never given`
    );
  }
  const rotating =
    client.generation > 1 &&
    (client.rotationLiveAt === null ||
      now.getTime() - client.rotationLiveAt.getTime() < rotationWindowMs);
  const derive = async (secret: DerivedSecret, generation: number) =>
    await deriveClientSecret(
      secrets[secret.master],
      secret.purpose,
      client.id,
      generation,
      secret.encoding
    );
  for (const secret of derivedSecrets[app] ?? []) {
    // oxlint-disable-next-line no-await-in-loop -- a few per Worker
    values.set(secret.name, await derive(secret, client.generation));
    if (secret.previous !== undefined && rotating) {
      // oxlint-disable-next-line no-await-in-loop -- a few per Worker
      values.set(secret.previous, await derive(secret, client.generation - 1));
    }
  }
  const missing = worker.requiredSecrets.find((name) => !values.has(name));
  if (missing !== undefined) {
    throw new DeployError(
      "missing_secret",
      `No value for ${worker.name}'s secret ${missing}`
    );
  }
  return [...values].map(([name, value]) => ({ name, value }));
};
