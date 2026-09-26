import { fromBase64Url, toBase64Url, toHex } from "@grasp-os/shared/encoding";
import { log } from "@grasp-os/shared/log";

// Seals what connect must keep secret at rest (OAuth tokens, PKCE
// verifiers) with AES-256-GCM under `TOKEN_ENCRYPTION_KEY`, a secret only
// connect holds. What D1 stores is useless without it: a copy of the
// database, or anything that reads it but isn't connect, learns nothing.
//
// Each sealed value names its key by a key ID (a hash of the key, never the
// key), and is bound to what it belongs to (its context, such as the
// connection's ID) as additional data, so a value moved to another row
// doesn't open there.
//
// Rotating the key: set the current key as `TOKEN_ENCRYPTION_KEY_PREVIOUS`
// and a new one as `TOKEN_ENCRYPTION_KEY`. New values are sealed with the
// new key, and the cron trigger seals the stored ones again with it
// (`resealTokens`, `resealFlows`); once no token (`key_id`) and no flow's
// verifier is left under the previous key's ID, remove the previous key.

/** Most values of one kind the cron trigger seals again per run. */
export const resealBatchSize = 50;

/** A key is 32 random bytes, in base64: `openssl rand -base64 32`. */
const keyBytes = 32;
/** GCM's standard nonce size; random per value. */
const ivBytes = 12;
const version = "v1";
const sealedPattern =
  /^v1\.(?<keyId>[0-9a-f]{16})\.(?<iv>[A-Za-z0-9_-]{16})\.(?<data>[A-Za-z0-9_-]+)$/u;

/** Why a sealed value didn't open. Never says anything about the value. */
export class VaultError extends Error {
  constructor(reason: "malformed" | "unknown_key" | "tampered") {
    super(`A sealed value didn't open: ${reason}`);
    this.name = "VaultError";
  }
}

interface VaultKey {
  id: string;
  key: CryptoKey;
}

/** The key's raw bytes, or `undefined` when it isn't 32 bytes of base64. */
const keyMaterial = (secret: string): Uint8Array<ArrayBuffer> | undefined => {
  try {
    const bytes = fromBase64Url(
      secret
        .trim()
        .replace(/[=]+$/u, "")
        .replaceAll("+", "-")
        .replaceAll("/", "_")
    );
    return bytes.byteLength === keyBytes ? bytes : undefined;
  } catch {
    return undefined;
  }
};

// Keys by secret, imported once per isolate.
const imported = new Map<string, Promise<VaultKey | undefined>>();

const importKey = async (secret: string): Promise<VaultKey | undefined> => {
  const bytes = keyMaterial(secret);
  if (bytes === undefined) {
    return undefined;
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`grasp-os vault key id\n${toHex(bytes)}`)
  );
  const key = await crypto.subtle.importKey(
    "raw",
    bytes,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  );
  return { id: toHex(new Uint8Array(digest)).slice(0, 16), key };
};

const keyFor = async (secret: string): Promise<VaultKey | undefined> => {
  const cached = imported.get(secret);
  if (cached !== undefined) {
    return await cached;
  }
  const loading = importKey(secret);
  imported.set(secret, loading);
  return await loading;
};

const additionalData = (context: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(
    new TextEncoder().encode(`grasp-os vault ${version}\n${context}`)
  );

/** Seals and opens values with the deployment's token key. */
export interface Vault {
  /** The ID of the key new values are sealed with. */
  keyId: string;
  /**
   * A `LIKE` pattern for values sealed with the previous key, while one is
   * set: those the cron trigger seals again. `undefined` without one.
   */
  sealedWithPrevious: string | undefined;
  seal: (plaintext: string, context: string) => Promise<string>;
  /** Throws a `VaultError` unless `sealed` was sealed for `context`. */
  open: (sealed: string, context: string) => Promise<string>;
}

/**
 * The vault, or `undefined` while `TOKEN_ENCRYPTION_KEY` is unset or not
 * a key: then nothing is sealed or opened, and connecting fails closed. A
 * previous key that isn't one is left out, so a slip while rotating can't
 * stop the current key working.
 */
export const vaultFor = async (env: Env): Promise<Vault | undefined> => {
  const secret = env.TOKEN_ENCRYPTION_KEY;
  const current =
    secret === undefined || secret === "" ? undefined : await keyFor(secret);
  if (current === undefined) {
    if (secret !== undefined && secret !== "") {
      log.error("config.invalid", { var: "TOKEN_ENCRYPTION_KEY" });
    }
    return undefined;
  }
  const previousSecret = env.TOKEN_ENCRYPTION_KEY_PREVIOUS;
  const previous =
    previousSecret === undefined || previousSecret === ""
      ? undefined
      : await keyFor(previousSecret);
  const keys = previous === undefined ? [current] : [current, previous];

  return {
    keyId: current.id,
    sealedWithPrevious:
      previous === undefined || previous.id === current.id
        ? undefined
        : `${version}.${previous.id}.%`,
    seal: async (plaintext, context) => {
      const iv = crypto.getRandomValues(new Uint8Array(ivBytes));
      const data = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: additionalData(context) },
        current.key,
        new TextEncoder().encode(plaintext)
      );
      return [
        version,
        current.id,
        toBase64Url(iv),
        toBase64Url(new Uint8Array(data)),
      ].join(".");
    },
    open: async (sealed, context) => {
      const parts = sealedPattern.exec(sealed)?.groups;
      if (
        parts?.keyId === undefined ||
        parts.iv === undefined ||
        parts.data === undefined
      ) {
        throw new VaultError("malformed");
      }
      const { keyId, iv, data } = parts;
      const key = keys.find((candidate) => candidate.id === keyId);
      if (key === undefined) {
        throw new VaultError("unknown_key");
      }
      try {
        const plaintext = await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: fromBase64Url(iv),
            additionalData: additionalData(context),
          },
          key.key,
          fromBase64Url(data)
        );
        return new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: false,
        }).decode(plaintext);
      } catch {
        throw new VaultError("tampered");
      }
    },
  };
};
