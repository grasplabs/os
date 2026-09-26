import {
  egressHeader,
  hostSchema,
  httpMethods,
  pathMatches,
  redirectHostMatches,
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
// it leaves. Redirects aren't followed, except one from a route that
// names the hosts it may lead to (a download), which the handler follows
// itself, without the token. A response is cut off past a size limit. Raw
// sockets are refused. Connect's
// `global_fetch_strictly_public` keeps an allowed name that resolves to a
// private address from being reached (R9).
//
// What the allowlist doesn't constrain: the query string and the body of
// an allowed request are the connector's own (threat model EG3).
//
// A provider's 429 goes back to the connector as it is. Whether its call
// did nothing (`notPerformedMetaKey`) is the connector's to say: this
// handler sees one request at a time, can't tell whether an earlier
// request of the same call already wrote, and can't cheaply tell connect's
// side of the call.

/** Largest provider response a connector may read, in bytes. */
export const maxEgressResponseBytes = 10 * 1024 * 1024;

/** The status a refused request gets: it never reached the provider. */
const egressRefusedStatus = 403;

/** The status a response gets when it redirected or was too large. */
export const egressFailedStatus = 502;

/**
 * The handler's own answer, marked as such (`egressHeader`), so a
 * connector can tell it from the provider's. The header is dropped from
 * every provider response, so a provider can't pass one off.
 */
const egressAnswer = (
  kind: "refused" | "failed",
  body: string | null = null
): Response =>
  new Response(body, {
    status: kind === "refused" ? egressRefusedStatus : egressFailedStatus,
    headers: { [egressHeader]: kind },
  });

/**
 * Request headers the connector can't send: credentials (the token is
 * connect's to add); method overrides, which some providers (Google)
 * honour on a POST, turning it into a method the action doesn't declare
 * (Q11); and hop-by-hop headers that could change the connection itself.
 */
const connectorHeadersRefused = [
  "authorization",
  "proxy-authorization",
  "cookie",
  "host",
  "x-http-method-override",
  "x-http-method",
  "x-method-override",
  "upgrade",
  "connection",
  "te",
];

/** Response headers that no longer hold for the body as passed on. */
const responseHeadersDropped = [
  "content-encoding",
  "content-length",
  egressHeader,
];

const egressPropsSchema = z.strictObject({
  /** Which connector, for the log: its name and version. */
  connector: z.string().min(1),
  /** Which call, for the log: its capability's ID. */
  callId: z.string().min(1),
  /** The connector's hosts. */
  hosts: z.array(z.string().min(1)).min(1),
  /** The requests the called action declares. */
  routes: z.array(routeSchema),
  /**
   * Path parameters bound to one value: the action's resource property,
   * to the resource the call's capability names.
   */
  values: z.record(z.string(), z.string()),
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
  call: { connector: string; callId?: string; hosts: readonly string[] },
  reason: string,
  url: URL,
  method: string
): Response => {
  log.warn("egress.refused", {
    connector: call.connector,
    callId: call.callId,
    reason,
    host: call.hosts.includes(url.hostname) ? url.hostname : "other",
    method: knownMethods.has(method) ? method : "other",
  });
  return egressAnswer("refused", "Refused by connect's egress allowlist");
};

/**
 * The deployment's own download hosts, from connect's `DOWNLOAD_HOSTS` var
 * (a JSON array of exact host names, such as the client's
 * `contoso.sharepoint.com` and `contoso-my.sharepoint.com`, set by the
 * console). A download redirect must lead to one of them as well as match
 * its route's pattern: another tenant's SharePoint is never followed.
 * Unset or invalid, no redirect is followed.
 */
const downloadHostsOf = (raw: unknown): ReadonlySet<string> => {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      value = undefined;
    }
  }
  const hosts = z.array(hostSchema).max(32).safeParse(value);
  if (raw !== undefined && !hosts.success) {
    log.error("config.invalid", { var: "DOWNLOAD_HOSTS" });
  }
  return new Set(hosts.data);
};

/** The route the request is for, if the call declares it. */
const routeFor = (
  { routes, values }: Pick<EgressProps, "routes" | "values">,
  method: string,
  url: URL
): Route | undefined =>
  routes.find(
    (route) =>
      route.method === method &&
      route.host === url.hostname &&
      pathMatches(route.path, url.pathname, values)
  );

/** Redirects a route's `redirects` hosts may be followed for. */
const followedStatuses: ReadonlySet<number> = new Set([
  301, 302, 303, 307, 308,
]);

/**
 * Where a redirect from `route` leads, if the route follows it there:
 * HTTPS to one of its redirect hosts that is also one of the deployment's
 * `downloadHosts`, on its own port, without credentials in the URL.
 */
const redirectTarget = (
  route: Route,
  downloadHosts: ReadonlySet<string>,
  from: URL,
  response: Response
): URL | undefined => {
  const location = response.headers.get("location");
  if (
    route.redirects === undefined ||
    location === null ||
    !followedStatuses.has(response.status)
  ) {
    return undefined;
  }
  let target: URL;
  try {
    target = new URL(location, from);
  } catch {
    return undefined;
  }
  const allowed =
    target.protocol === "https:" &&
    target.username === "" &&
    target.password === "" &&
    target.port === "" &&
    downloadHosts.has(target.hostname) &&
    route.redirects.some((pattern) =>
      redirectHostMatches(pattern, target.hostname)
    );
  return allowed ? target : undefined;
};

/**
 * The file a download's redirect leads to, fetched from its storage host
 * with nothing of the connector's request, or a failure if it can't be.
 * The host is the client's own (its tenant's name): logged as the
 * redirect it was, not by name.
 */
const download = async (
  { connector, callId, expiresAt }: EgressProps,
  route: Route,
  target: URL
): Promise<Response> => {
  const logged = { connector, callId, host: "redirect", method: "GET" };
  try {
    const response = await fetch(target, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(Math.max(expiresAt - Date.now(), 1)),
    });
    log.info("egress.request", {
      ...logged,
      route: route.path,
      status: response.status,
    });
    return response;
  } catch {
    log.warn("egress.failed", { ...logged, route: route.path });
    return egressAnswer("failed");
  }
};

/** Whether a response has no body, whatever its headers say. */
const isBodiless = (method: string, status: number): boolean =>
  method === "HEAD" || status === 204 || status === 304;

/**
 * The response with its body cut off once it passes the size limit: the
 * connector's read fails there, and nothing past it is held in memory.
 */
const capped = (response: Response): Response => {
  // The body arrives decoded, and its length is counted here.
  const headers = new Headers(response.headers);
  for (const name of responseHeadersDropped) {
    headers.delete(name);
  }
  const { body, status, statusText } = response;
  if (body === null) {
    return new Response(null, { status, statusText, headers });
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
  return new Response(limited, { status, statusText, headers });
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
      return refuse(
        { connector: "unknown", hosts: [] },
        "no_call",
        url,
        method
      );
    }
    const call = props.data;
    const { connector, callId, hosts, token, expiresAt } = call;
    const remainingMs = expiresAt - Date.now();
    if (remainingMs <= 0) {
      return refuse(call, "expired", url, method);
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
      return refuse(call, "host", url, method);
    }
    const route = routeFor(call, method, url);
    if (route === undefined) {
      return refuse(call, "route", url, method);
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
        callId,
        host: url.hostname,
        method,
        route: route.path,
      });
      return egressAnswer("failed");
    }
    // Hosts, methods, declared paths and statuses only: never the path as
    // sent, the query, headers or bodies (R17, EG7).
    log.info("egress.request", {
      connector,
      callId,
      host: url.hostname,
      method,
      route: route.path,
      status: response.status,
    });
    // A download: the provider sends the file's pre-authenticated URL on
    // its storage host. It is fetched here, once, with nothing of the
    // connector's request (the token least of all: that URL carries its
    // own authority, and isn't the token's audience), and the connector
    // gets only its answer, never the URL. A second redirect is refused
    // below, as any other is.
    const target = redirectTarget(
      route,
      downloadHostsOf(this.env.DOWNLOAD_HOSTS),
      url,
      response
    );
    if (target !== undefined) {
      await response.body?.cancel();
      response = await download(call, route, target);
    }
    // 304 Not Modified goes nowhere; every other 3xx would.
    const isRedirect =
      response.status >= 300 &&
      response.status < 400 &&
      response.status !== 304;
    const declaredBytes = isBodiless(method, response.status)
      ? 0
      : Number(response.headers.get("content-length"));
    if (isRedirect || declaredBytes > maxEgressResponseBytes) {
      await response.body?.cancel();
      log.warn("egress.refused", {
        connector,
        callId,
        reason: isRedirect ? "redirect" : "too_large",
        host: url.hostname,
        method,
      });
      return egressAnswer("failed");
    }
    return capped(response);
  }

  /** Raw TCP (`cloudflare:sockets`) never leaves: only HTTPS requests. */
  override connect(): never {
    const props = egressPropsSchema.safeParse(this.ctx.props);
    log.warn("egress.refused", {
      connector: props.data?.connector ?? "unknown",
      callId: props.data?.callId,
      reason: "socket",
    });
    throw new Error("Refused by connect's egress allowlist");
  }
}
