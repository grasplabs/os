import { toHex } from "./encoding.ts";

/**
 * A client's secrets, derived rather than stored: each is
 * `HMAC-SHA256(masterKey, "<purpose>:<clientId>:<generation>")`, so
 * nothing per client is kept anywhere. The console derives them to set on
 * a client's Workers, and the router derives the router secret on every
 * forward. Raising the client's generation rotates them.
 *
 * The master keys live in Secrets Store (grasp-os-ops): `ROUTER_KEY` for
 * the router secret, which the router holds too, and `CLIENT_KEY` for the
 * rest, which only the console holds.
 */

/** A client's id as the console gives it: no `:`, so the derivation stays unambiguous. */
export const clientIdPattern = /^[A-Za-z0-9_-]{1,64}$/u;

/** A purpose, such as `router`: no `:` either. */
const purposePattern = /^[a-z][a-z0-9-]{0,31}$/u;

/**
 * How a secret is written for the Worker that reads it: lowercase hex, or
 * standard base64 (connect's `TOKEN_ENCRYPTION_KEY`: 32 bytes of it).
 */
export type SecretEncoding = "hex" | "base64";

const encoder = new TextEncoder();

/** Bytes as standard base64, with padding. */
const toBase64 = (bytes: Uint8Array): string =>
  btoa(String.fromCodePoint(...bytes));

/**
 * Client `clientId`'s secret for `purpose` at `generation`:
 * `HMAC-SHA256(masterKey, "<purpose>:<clientId>:<generation>")`, 32 bytes,
 * in `encoding`. Throws a `TypeError` for an empty key, or a purpose,
 * client id or generation that could make two derivations collide.
 */
export const deriveClientSecret = async (
  masterKey: string,
  purpose: string,
  clientId: string,
  generation: number,
  encoding: SecretEncoding = "hex"
): Promise<string> => {
  if (masterKey === "") {
    throw new TypeError("No master key");
  }
  if (!purposePattern.test(purpose)) {
    throw new TypeError("Not a secret purpose");
  }
  if (!clientIdPattern.test(clientId)) {
    throw new TypeError("Not a client id");
  }
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new TypeError("Not a secret generation");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(masterKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(`${purpose}:${clientId}:${generation}`)
    )
  );
  return encoding === "hex" ? toHex(mac) : toBase64(mac);
};

/**
 * An HMAC-SHA256 key for one `purpose`, derived from `secret` with HKDF
 * (SHA-256, no salt, the purpose as info): each purpose gets a key of its
 * own, so a MAC made for one never passes for another. Core derives its
 * own keys this way from its auth secret (core's src/derived-keys.ts);
 * the console, which derives that secret, signs what it tells core with
 * one (@grasp-os/shared/platform-change).
 */
export const hkdfHmacKey = async (
  secret: string,
  purpose: string,
  usages: ("sign" | "verify")[]
): Promise<CryptoKey> => {
  const material = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    "HKDF",
    false,
    ["deriveKey"]
  );
  return await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(),
      info: encoder.encode(purpose),
    },
    material,
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages
  );
};
