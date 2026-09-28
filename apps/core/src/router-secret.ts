import { loopbackHosts, routerSecretHeader } from "@grasp-os/shared/router";

/** Why a request was refused. Logged; the caller only ever sees 403. */
type RouterSecretRefusal = "missing" | "mismatch" | "not_configured";

type RouterSecretCheck =
  | { ok: true; request: Request }
  | { ok: false; reason: RouterSecretRefusal };

/**
 * Local development runs without the router. Core's `dev` script passes this
 * flag with `wrangler dev --var`; it is never set in wrangler.jsonc. Even when
 * set, it only applies to requests addressed to this machine.
 */
const isLocalDevRequest = (request: Request, env: Env): boolean =>
  env.DEV_SKIP_ROUTER_SECRET === "true" &&
  loopbackHosts.has(new URL(request.url).hostname);

const encoder = new TextEncoder();

/**
 * Compares in constant time. Hashing first gives both sides the same length,
 * so neither the contents nor the length of the secret leak through timing.
 */
const matchesSecret = async (
  presented: string,
  secret: string
): Promise<boolean> => {
  const [presentedHash, secretHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(presented)),
    crypto.subtle.digest("SHA-256", encoder.encode(secret)),
  ]);
  return crypto.subtle.timingSafeEqual(presentedHash, secretHash);
};

/**
 * The secrets core accepts: the current one, and the previous one while
 * rotating. Rotating a client's secret: set the current one as
 * `ROUTER_SECRET_PREVIOUS` and the new one as `ROUTER_SECRET`, then raise
 * the client's generation in the router's map, and remove the previous one
 * once every router isolate sends the new one: at least 2 minutes after the
 * map changed (the router's 30 s cache plus KV's propagation, about 60 s).
 * Optional, so it isn't in `secrets.required`.
 */
const acceptedSecrets = (env: Env): string[] =>
  [env.ROUTER_SECRET, env.ROUTER_SECRET_PREVIOUS].filter(
    (secret): secret is string => typeof secret === "string" && secret !== ""
  );

/**
 * Checks that a request came through the router, and returns it without the
 * secret header, so nothing after this check can see, forward or log it.
 * Fails closed: without a configured secret every request is refused; a
 * previous secret alone doesn't count.
 */
export const checkRouterSecret = async (
  request: Request,
  env: Env
): Promise<RouterSecretCheck> => {
  const presented = request.headers.get(routerSecretHeader);
  const headers = new Headers(request.headers);
  headers.delete(routerSecretHeader);
  const stripped = new Request(request, { headers });

  if (isLocalDevRequest(request, env)) {
    return { ok: true, request: stripped };
  }
  if (!env.ROUTER_SECRET) {
    return { ok: false, reason: "not_configured" };
  }
  if (presented === null) {
    return { ok: false, reason: "missing" };
  }
  // Compared with every accepted secret, so the time taken doesn't tell
  // which one matched.
  const matches = await Promise.all(
    acceptedSecrets(env).map(
      async (secret) => await matchesSecret(presented, secret)
    )
  );
  if (!matches.includes(true)) {
    return { ok: false, reason: "mismatch" };
  }
  return { ok: true, request: stripped };
};
