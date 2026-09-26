import { loopbackHosts, routerSecretHeader } from "@grasp-os/shared/router";

/** Why a request was refused. Logged; the caller only ever sees 403. */
export type RouterSecretRefusal = "missing" | "mismatch" | "not_configured";

export type RouterSecretCheck =
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
 * Checks that a request came through the router, and returns it without the
 * secret header, so nothing after this check can see, forward or log it.
 * Fails closed: without a configured secret every request is refused.
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
  if (!(await matchesSecret(presented, env.ROUTER_SECRET))) {
    return { ok: false, reason: "mismatch" };
  }
  return { ok: true, request: stripped };
};
