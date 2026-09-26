import { requestErrors } from "@grasp-os/shared/errors";

import { errorResponse } from "../errors.ts";
import { authBasePath, authFor } from "./auth.ts";
import { signInConfig } from "./config.ts";

/**
 * The Better Auth routes core serves; everything else under `/api/auth` is
 * not found. Better Auth and its plugins bring many more (password sign-up,
 * registering SSO providers, creating organizations, invitations), and an
 * allowlist keeps each one off until we choose it. Team changes go through
 * the organization plugin's own permission checks (`auth.ts`). Removing
 * members and changing roles go only through core's own API
 * (`members.ts`), which keeps the organization an admin: no route here
 * may change a membership or a role.
 */
const allowedRoutes = new Set([
  "POST /sign-in/sso",
  "GET /get-session",
  "POST /sign-out",
  "GET /list-sessions",
  "POST /revoke-session",
  "POST /revoke-sessions",
  "POST /revoke-other-sessions",
  "GET /organization/get-full-organization",
  "GET /organization/list-members",
  "GET /organization/list-teams",
  "POST /organization/create-team",
  "POST /organization/update-team",
  "POST /organization/remove-team",
  "GET /organization/list-team-members",
  "POST /organization/add-team-member",
  "POST /organization/remove-team-member",
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
