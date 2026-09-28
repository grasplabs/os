import { errorFields, log } from "@grasp-os/shared/log";
import {
  deriveRouterSecret,
  routerHostKey,
  routerClientIpHeader,
  routerHostSchema,
  routerSecretHeader,
} from "@grasp-os/shared/router";

import { routeCache } from "./route-cache.ts";

/** Where one hostname goes, and the secret its core expects. */
interface Route {
  origin: string;
  secret: string;
}

/**
 * How long this isolate trusts what it read from the hostname map (and
 * Secrets Store), found or not. A new or changed host, or a raised
 * generation, takes effect within this cache plus KV's propagation (about
 * 60 s), so while rotating, core must accept the previous secret for at
 * least 2 minutes.
 */
const routeCacheMs = 30_000;

/** Hostnames remembered per isolate. */
const maxCachedHosts = 1000;

const routes = routeCache<Route | null>(maxCachedHosts, routeCacheMs);

/**
 * Reads a host's entry from the map and derives its secret. An entry that
 * doesn't parse, or names anything but an https `*.workers.dev` origin,
 * routes nowhere. Throws when the router key can't be read, so nothing is
 * forwarded (and nothing cached) without the right secret.
 */
const loadRoute = async (host: string, env: Env): Promise<Route | null> => {
  const stored = await env.HOSTS.get(host, "json");
  if (stored === null) {
    return null;
  }
  const parsed = routerHostSchema.safeParse(stored);
  if (!parsed.success) {
    log.error("router.host_refused", { host });
    return null;
  }
  const { clientId, coreUrl, generation } = parsed.data;
  const routerKey = await env.ROUTER_KEY.get();
  return {
    origin: new URL(coreUrl).origin,
    secret: await deriveRouterSecret(routerKey, clientId, generation),
  };
};

const routeFor = async (host: string, env: Env): Promise<Route | null> => {
  const cached = routes.get(host, Date.now());
  if (cached !== undefined) {
    return cached.value;
  }
  const route = await loadRoute(host, env);
  routes.set(host, route, Date.now());
  return route;
};

/**
 * Forwards each request on a client's hostname to that client's core, with
 * the router secret so a client's workers.dev address is no back door.
 * Pass-through only: the method, path, query, headers and body go as they
 * came (but for Host, the router secret and the client-IP header),
 * WebSocket upgrades included, and core's response comes back as it
 * is, redirects included. Logs no headers, URLs or bodies.
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const host = routerHostKey(url.hostname);

    let route: Route | null;
    try {
      route = await routeFor(host, env);
    } catch (error) {
      log.error("router.route_failed", { host, ...errorFields(error) });
      return new Response("Service unavailable", { status: 503 });
    }
    if (route === null) {
      return new Response("Not found", { status: 404 });
    }

    // Any copy the caller sent is replaced (threat model RT3): the secret
    // comes only from the map entry for the hostname the request came to.
    // The client's IP comes only from Cloudflare's `cf-connecting-ip`, which
    // the edge sets itself. The client's Host goes too: the target's host
    // comes from the URL alone.
    const headers = new Headers(request.headers);
    headers.delete("host");
    headers.set(routerSecretHeader, route.secret);
    headers.delete(routerClientIpHeader);
    const clientIp = request.headers.get("cf-connecting-ip");
    if (clientIp !== null) {
      headers.set(routerClientIpHeader, clientIp);
    }
    try {
      return await fetch(`${route.origin}${url.pathname}${url.search}`, {
        method: request.method,
        headers,
        body: request.body,
        redirect: "manual",
      });
    } catch (error) {
      // The error's kind only: a failed fetch's message or stack can carry
      // the target URL, and with it an OAuth callback's code and state.
      log.error("router.forward_failed", {
        host,
        errorName: error instanceof Error ? error.name : typeof error,
      });
      return new Response("Bad gateway", { status: 502 });
    }
  },
} satisfies ExportedHandler<Env>;
