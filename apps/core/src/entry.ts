import { internalErrors, requestErrors } from "@grasp-os/shared/errors";

import { errorResponse } from "./errors.ts";
import { errorFields, log } from "./log.ts";
import { checkRouterSecret } from "./router-secret.ts";
import { rpcResponse } from "./rpc.ts";

/** Carries the request ID back to the caller, on every response. */
const requestIdHeader = "x-request-id";

const isApiPath = (pathname: string): boolean =>
  pathname === "/api" || pathname.startsWith("/api/");

/** Routes a request that has passed the router-secret check. */
const route = async (
  request: Request,
  env: Env,
  requestId: string
): Promise<Response> => {
  const { pathname } = new URL(request.url);
  if (pathname === "/health") {
    return Response.json({ ok: true });
  }
  if (pathname === "/rpc") {
    return rpcResponse(request, requestId);
  }
  if (isApiPath(pathname)) {
    return errorResponse(
      404,
      requestErrors.create("request.not_found"),
      requestId
    );
  }
  // The frontend's files; unknown paths get index.html (single-page app).
  return await env.ASSETS.fetch(request);
};

const respond = async (
  request: Request,
  env: Env,
  requestId: string,
  fields: Readonly<Record<string, string>>
): Promise<Response> => {
  try {
    const checked = await checkRouterSecret(request, env);
    if (checked.ok) {
      return await route(checked.request, env, requestId);
    }
    const refused = { ...fields, reason: checked.reason };
    if (checked.reason === "not_configured") {
      log.error("request.refused", refused);
    } else {
      log.warn("request.refused", refused);
    }
    return errorResponse(
      403,
      requestErrors.create("request.forbidden"),
      requestId
    );
  } catch (error) {
    log.error("request.failed", { ...fields, ...errorFields(error) });
    return errorResponse(
      500,
      internalErrors.create("internal.unexpected"),
      requestId
    );
  }
};

/**
 * Headers of a response from a binding are immutable, so it is copied. A
 * WebSocket upgrade can't be copied, but core builds that one itself.
 */
const withRequestId = (response: Response, requestId: string): Response => {
  const tagged = response.webSocket
    ? response
    : new Response(response.body, response);
  tagged.headers.set(requestIdHeader, requestId);
  return tagged;
};

/** Every request to core starts here, static files included. */
export const handleRequest = async (
  request: Request,
  env: Env
): Promise<Response> => {
  const startedAt = Date.now();
  const requestId = crypto.randomUUID();
  // Only the path: query strings can carry tokens.
  const fields = {
    requestId,
    method: request.method,
    path: new URL(request.url).pathname,
  };
  const response = await respond(request, env, requestId, fields);
  log.info("request", {
    ...fields,
    status: response.status,
    durationMs: Date.now() - startedAt,
  });
  return withRequestId(response, requestId);
};
