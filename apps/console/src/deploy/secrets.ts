/**
 * The secrets a deploy gives each of a release's Workers.
 *
 * A client's own secrets are derived, never stored: each is
 * `HMAC(masterKey, "<purpose>:<clientId>:<generation>")`
 * (`deriveClientSecret`), the router secret under `ROUTER_KEY` and the
 * rest under `CLIENT_KEY`, both from Secrets Store. Raising the client's
 * generation rotates them all; connect's keys that support rotation get
 * the previous generation's value too, so tokens sealed and capabilities
 * signed before still open. Everything else a Worker needs is shared by
 * every client (the OAuth apps' secrets, the Composio key), and the caller
 * passes it.
 */
import { deriveClientSecret } from "@grasp-os/shared/client-secrets";
import type { SecretEncoding } from "@grasp-os/shared/client-secrets";
import type { WorkerEntry } from "@grasp-os/shared/release";

import type { Secret } from "../cloudflare/workers.ts";

/** The secrets a deploy gives the Workers, from Secrets Store. */
export interface DeploySecrets {
  /** `ROUTER_KEY`: each client's router secret is derived from it. */
  routerKey: string;
  /** `CLIENT_KEY`: each client's other secrets are derived from it. */
  clientKey: string;
  /**
   * The secrets shared by every client, by app (`core`, `connect`), then
   * by name. Never one of the derived ones.
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

/** Core's router secret (core's src/router-secret.ts). */
const routerSecret: DerivedSecret = {
  name: "ROUTER_SECRET",
  purpose: "router",
  master: "routerKey",
  encoding: "hex",
};

/** Core's auth secret (core's src/auth/auth.ts): 64 hex characters. */
const authSecret: DerivedSecret = {
  name: "BETTER_AUTH_SECRET",
  purpose: "better-auth",
  master: "clientKey",
  encoding: "hex",
};

/** Core signs capabilities with it, connect checks them: at least 32 characters. */
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

/** A Worker's required secret that the deploy wasn't given. */
export class MissingSecretError extends Error {
  constructor(worker: string, name: string) {
    super(`No value for ${worker}'s secret ${name}`);
    this.name = "MissingSecretError";
  }
}

/**
 * Every secret the Worker `app` runs with: its derived ones for the client
 * and its generation (with the previous generation's where the Worker
 * rotates the key), and the shared ones given for it. Throws for a shared
 * secret given under a derived one's name, and `MissingSecretError` for a
 * required secret it has no value for, so nothing is uploaded without it.
 */
export const workerSecrets = async (
  app: string,
  worker: WorkerEntry,
  secrets: DeploySecrets,
  client: { id: string; generation: number }
): Promise<Secret[]> => {
  const values = new Map(Object.entries(secrets.shared[app] ?? {}));
  const derive = async (secret: DerivedSecret, generation: number) =>
    await deriveClientSecret(
      secrets[secret.master],
      secret.purpose,
      client.id,
      generation,
      secret.encoding
    );
  for (const secret of derivedSecrets[app] ?? []) {
    const names = [secret.name, secret.previous].filter(
      (name): name is string => name !== undefined
    );
    if (names.some((name) => values.has(name))) {
      throw new Error(
        `${worker.name}'s ${secret.name} is derived, never given`
      );
    }
    // oxlint-disable-next-line no-await-in-loop -- a few per Worker
    values.set(secret.name, await derive(secret, client.generation));
    // A client starts at generation 1 (`clients.generation`): only a
    // rotated one has a previous value.
    if (secret.previous !== undefined && client.generation > 1) {
      // oxlint-disable-next-line no-await-in-loop -- a few per Worker
      values.set(secret.previous, await derive(secret, client.generation - 1));
    }
  }
  for (const name of worker.requiredSecrets) {
    if (!values.has(name)) {
      throw new MissingSecretError(worker.name, name);
    }
  }
  return [...values].map(([name, value]) => ({ name, value }));
};
