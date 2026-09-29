import { z } from "zod";

import { clientIdPattern, deriveClientSecret } from "./client-secrets.ts";

/**
 * The header the router adds to every request it forwards to a client's core,
 * carrying the secret the two share. Core refuses requests without it, so a
 * core's own address is no way around the router.
 */
export const routerSecretHeader = "x-grasp-router-secret";

/**
 * The header the router sets to the client's IP, from Cloudflare's
 * `cf-connecting-ip` at the router's edge, replacing any copy the client
 * sent. Behind the router, core's own view of the caller's address is the
 * router's; only requests that passed the router-secret check carry a copy
 * core can trust.
 */
export const routerClientIpHeader = "x-grasp-client-ip";

/** This machine's hostnames: local development, never a deployment. */
export const loopbackHosts: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
]);

/**
 * A core's own address: an https `*.workers.dev` origin, nothing more. The
 * router forwards to no other host, so a changed hostname map can't send a
 * client's traffic (and cookies) to a server outside Workers.
 */
const workersDevHostname = /^(?:[a-z0-9-]+\.)+workers\.dev$/u;

const isWorkersDevOrigin = (value: string): boolean => {
  if (!URL.canParse(value)) {
    return false;
  }
  const url = new URL(value);
  return (
    url.protocol === "https:" &&
    workersDevHostname.test(url.hostname) &&
    url.username === "" &&
    url.password === "" &&
    url.port === "" &&
    url.pathname === "/" &&
    url.search === "" &&
    url.hash === ""
  );
};

/**
 * One entry of the router's hostname map (KV, key: the hostname as
 * `routerHostKey` gives it), written by the console. `generation` counts the
 * client's router secrets: raising it rotates the secret.
 */
export const routerHostSchema = z.object({
  clientId: z.string().regex(clientIdPattern),
  coreUrl: z.string().refine(isWorkersDevOrigin, {
    message: "Expected an https://*.workers.dev origin",
  }),
  generation: z.int().nonnegative(),
});
export type RouterHost = z.infer<typeof routerHostSchema>;

/** Hostnames no client gets: the platform's own, under `<domain>`. */
export const reservedClientIds: ReadonlySet<string> = new Set([
  "console",
  "internal",
  "staging",
  "www",
  "api",
]);

/**
 * A new client's id, which is its hostname's label (`<id>.<domain>`): a
 * lowercase DNS label of at most 50 characters, so the console's
 * workers.dev subdomain for it, `grasp-<id>-<6 hex>` at its longest,
 * still fits a 63-character label, and never a reserved one. So one
 * hostname is one client's.
 */
export const newClientIdSchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/u)
  .refine((id) => !reservedClientIds.has(id), "a reserved name");

/** A hostname as the map keys it: lowercase, without a trailing dot. */
export const routerHostKey = (hostname: string): string =>
  hostname.toLowerCase().replace(/\.$/u, "");

/**
 * A client's router secret: `HMAC-SHA256(routerKey, "router:<clientId>:<generation>")`
 * as lowercase hex (`deriveClientSecret`). The router derives it on every
 * forward, the console to set it on the client's core, so nothing per
 * client is stored anywhere. `routerKey` is the one `ROUTER_KEY` in
 * Secrets Store (grasp-os-ops).
 */
export const deriveRouterSecret = async (
  routerKey: string,
  clientId: string,
  generation: number
): Promise<string> =>
  await deriveClientSecret(routerKey, "router", clientId, generation);
