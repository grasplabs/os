import {
  httpMethods,
  pathMatches,
  routeSchema,
} from "@grasp-os/connector-kit/manifest";
import type { Route } from "@grasp-os/connector-kit/manifest";
import { log } from "@grasp-os/shared/log";
import { WorkerEntrypoint } from "cloudflare:workers";
import { z } from "zod";

// A native connector's only way out. Connect loads each call's connector
// isolate with this as its `globalOutbound`, so every request the
// connector's code sends, by `fetch` or by following a redirect, arrives
// here. Its props, which only connect sets and the connector can't read,
// hold this call's token and the requests the called action declares
// (threat model R9, Q11, EG1 to EG7). A request goes out only to one of
// those, over HTTPS, with the token added; anything else is refused before
// it leaves. Redirects are never followed, and a response is cut off past
// a size limit. Connect's `global_fetch_strictly_public` keeps an allowed
// name that resolves to a private address from being reached (R9).

/** Largest provider response a connector may read, in bytes. */
export const maxEgressResponseBytes = 10 * 1024 * 1024;

/** The status a refused request gets: it never reached the provider. */
export const egressRefusedStatus = 403;

/** The status a response gets when it redirected or was too large. */
export const egressFailedStatus = 502;

/** Request headers the connector can't set: the token is connect's to add. */
const connectorHeadersRefused = [
  "authorization",
  "proxy-authorization",
  "cookie",
  "host",
];

const egressPropsSchema = z.strictObject({
  /** Which connector, for the log: its name and version. */
  connector: z.string().min(1),
  /** The connector's hosts. */
  hosts: z.array(z.string().min(1)).min(1),
  /** The requests the called action declares. */
  routes: z.array(routeSchema),
  /** The connection's access token, for this call only. */
  token: z.string().min(1),
  /** When this call's egress closes, in ms since the epoch. */
  expiresAt: z.number().int(),
});
export type EgressProps = z.infer<typeof egressPropsSchema>;

const knownMethods: ReadonlySet<string> = new Set(httpMethods);

/**
 * Refuses a request, and logs it by the connector's own host and a known
 * method only: a host or method the connector's code made up could carry
 * data out into the logs.
 */
const refuse = (
  connector: string,
  reason: string,
  hosts: readonly string[],
  url: URL | undefined,
  method: string
): Response => {
  const host =
    url !== undefined && hosts.includes(url.hostname) ? url.hostname : "other";
  log.warn("egress.refused", {
    connector,
    reason,
    host,
    method: knownMethods.has(method) ? method : "other",
  });
  return new Response("Refused by connect's egress allowlist", {
    status: egressRefusedStatus,
  });
};

/** The route the request is for, if the call declares it. */
const routeFor = (
  routes: readonly Route[],
  method: string,
  url: URL
): Route | undefined =>
  routes.find(
    (route) =>
      route.method === method &&
      route.host === url.hostname &&
      pathMatches(route.path, url.pathname)
  );

/**
 * The response with its body cut off once it passes the size limit: the
 * connector's read fails there, and nothing past it is held in memory.
 */
const capped = (response: Response): Response => {
  const { body } = response;
  if (body === null) {
    return response;
  }
  const reader = body.getReader();
  let bytes = 0;
  const limited = new ReadableStream<Uint8Array>({
    pull: async (controller) => {
      const chunk = await reader.read();
      if (chunk.done) {
        controller.close();
        return;
      }
      const value: unknown = chunk.value;
      if (!(value instanceof Uint8Array)) {
        await reader.cancel();
        controller.error(new TypeError("The response isn't a byte stream"));
        return;
      }
      bytes += value.byteLength;
      if (bytes > maxEgressResponseBytes) {
        await reader.cancel();
        controller.error(new Error("The provider's response is too large"));
        return;
      }
      controller.enqueue(value);
    },
    cancel: async (reason) => {
      await reader.cancel(reason);
    },
  });
  return new Response(limited, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};

/**
 * The egress handler. Reached only as a connector isolate's
 * `globalOutbound`, with props connect sets for one call; without them
 * (another Worker naming this entrypoint), nothing goes out.
 */
export class ConnectorEgress extends WorkerEntrypoint<Env, EgressProps> {
  override async fetch(request: Request): Promise<Response> {
    const props = egressPropsSchema.safeParse(this.ctx.props);
    // A Request's URL is always absolute and parsed.
    const url = new URL(request.url);
    const { method } = request;
    if (!props.success) {
      return refuse("unknown", "no_call", [], url, method);
    }
    const { connector, hosts, routes, token, expiresAt } = props.data;
    const remainingMs = expiresAt - Date.now();
    if (remainingMs <= 0) {
      return refuse(connector, "expired", hosts, url, method);
    }
    // Exactly one of the connector's hosts, over HTTPS on its own port,
    // without credentials in the URL.
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.port !== "" ||
      !hosts.includes(url.hostname)
    ) {
      return refuse(connector, "host", hosts, url, method);
    }
    const route = routeFor(routes, method, url);
    if (route === undefined) {
      return refuse(connector, "route", hosts, url, method);
    }

    const headers = new Headers(request.headers);
    for (const name of connectorHeadersRefused) {
      headers.delete(name);
    }
    headers.set("authorization", `Bearer ${token}`);
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: request.body,
        // A redirect could carry the token to another host: never follow.
        redirect: "manual",
        signal: AbortSignal.timeout(remainingMs),
      });
    } catch {
      log.warn("egress.failed", {
        connector,
        host: url.hostname,
        method,
        route: route.path,
      });
      return new Response(null, { status: egressFailedStatus });
    }
    // Hosts, methods, declared paths and statuses only: never the path as
    // sent, the query, headers or bodies (R17, EG7).
    log.info("egress.request", {
      connector,
      host: url.hostname,
      method,
      route: route.path,
      status: response.status,
    });
    // 304 Not Modified goes nowhere; every other 3xx would.
    const isRedirect =
      response.status >= 300 &&
      response.status < 400 &&
      response.status !== 304;
    const declaredBytes = Number(response.headers.get("content-length"));
    if (isRedirect || declaredBytes > maxEgressResponseBytes) {
      await response.body?.cancel();
      log.warn("egress.refused", {
        connector,
        reason: isRedirect ? "redirect" : "too_large",
        host: url.hostname,
        method,
      });
      return new Response(null, { status: egressFailedStatus });
    }
    return capped(response);
  }
}
