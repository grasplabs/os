/**
 * An HMAC-SHA256 key of core's own for one `purpose`, derived (HKDF) from
 * the deployment's auth secret, which only core holds. Each purpose gets a
 * key of its own, so a MAC made for one never passes for another, and none
 * needs a secret of its own. Rotating the auth secret changes every one.
 */
export const derivedHmacKey = async (
  env: Pick<Env, "BETTER_AUTH_SECRET">,
  purpose: string,
  usages: ("sign" | "verify")[]
): Promise<CryptoKey> => {
  const secret = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.BETTER_AUTH_SECRET),
    "HKDF",
    false,
    ["deriveKey"]
  );
  return await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(),
      info: new TextEncoder().encode(purpose),
    },
    secret,
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages
  );
};
