import { requestErrors } from "@grasp-os/shared/errors";

import { errorResponse } from "../errors.ts";
import { authBasePath, authFor } from "./auth.ts";
import { signInConfig } from "./config.ts";

/**
 * The Better Auth routes core serves; everything else under `/api/auth` is
 * not found. Better Auth and its plugin bring many more (password sign-up,
 * registering SSO providers, changing a user), and an allowlist keeps each
 * one off until we choose it. Members, roles and teams aren't Better
 * Auth's at all: they change only through core's own API (`members.ts`).
 */
const allowedRoutes = new Set([
  "POST /sign-in/sso",
  "GET /get-session",
  "POST /sign-out",
  "GET /list-sessions",
  "POST /revoke-session",
  "POST /revoke-sessions",
  "POST /revoke-other-sessions",
]);

/** The IdP redirects back here, one path per provider. */
const callbackPath = /^\/sso\/callback\/[a-z-]+$/u;

const isAllowed = (method: string, path: string): boolean =>
  allowedRoutes.has(`${method} ${path}`) ||
  (method === "GET" && callbackPath.test(path));

/** Serves `/api/auth/*`. */
export const handleAuthRequest = async (
  request: Request,
  env: Env,
  requestId: string
): Promise<Response> => {
  const path = new URL(request.url).pathname.slice(authBasePath.length);
  const auth = authFor(env, signInConfig(env));
  if (!(auth && isAllowed(request.method, path))) {
    return errorResponse(
      404,
      requestErrors.create("request.not_found"),
      requestId
    );
  }
  return await auth.handler(request);
};
