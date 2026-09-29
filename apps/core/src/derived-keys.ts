import { hkdfHmacKey } from "@grasp-os/shared/client-secrets";

/**
 * Keys derived in this isolate, so each is derived once rather than on
 * every call. Keyed by the secret too, as a test (or a rotation) can give
 * the same isolate another env.
 */
const derived = new Map<string, CryptoKey>();

/**
 * An HMAC-SHA256 key of core's own for one `purpose`, derived (HKDF,
 * `hkdfHmacKey`) from the deployment's auth secret, which only core holds,
 * and the console that derives it from its client key. Each purpose gets
 * a key of its own, so a MAC made for one never passes for another, and
 * none needs a secret of its own. Rotating the auth secret changes every
 * one.
 */
export const derivedHmacKey = async (
  env: Pick<Env, "BETTER_AUTH_SECRET">,
  purpose: string,
  usages: ("sign" | "verify")[]
): Promise<CryptoKey> => {
  const cacheKey = JSON.stringify([env.BETTER_AUTH_SECRET, purpose, usages]);
  const cached = derived.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  const key = await hkdfHmacKey(env.BETTER_AUTH_SECRET, purpose, usages);
  derived.set(cacheKey, key);
  return key;
};
