import { appErrors } from "@grasp-os/shared/apps";
import {
  authErrors,
  internalErrors,
  requestErrors,
} from "@grasp-os/shared/errors";
import { knowledgeErrors } from "@grasp-os/shared/knowledge";
import { permissionErrors } from "@grasp-os/shared/permissions";
import { roleErrors } from "@grasp-os/shared/roles";
import type { CoreApi, Identity, SignInOption } from "@grasp-os/shared/rpc";
import { newWebSocketRpcSession, RpcTarget } from "capnweb";

import { oidcProviders, signInConfig } from "./auth/config.ts";
import type { AuthEnv } from "./auth/config.ts";
import { identify } from "./auth/identity.ts";
import { errorResponse } from "./errors.ts";
import { errorFields, log } from "./log.ts";
import { SessionRpc } from "./session-rpc.ts";

/** What the frontend reaches over `/rpc`, signed in or not. */
export class CoreRpc extends RpcTarget implements CoreApi {
  readonly #options: SignInOption[];
  readonly #session: SessionRpc | undefined;

  constructor(options: SignInOption[], session?: SessionRpc) {
    super();
    this.#options = options;
    this.#session = session;
  }

  // Cap'n Web exposes prototype methods only, so this can't be static.
  // oxlint-disable-next-line class-methods-use-this
  ping(): "pong" {
    return "pong";
  }

  signInOptions(): SignInOption[] {
    return this.#options;
  }

  authenticate(): SessionRpc {
    if (!this.#session) {
      throw authErrors.create("auth.unauthenticated");
    }
    return this.#session;
  }
}

/**
 * Decides what an error looks like to the frontend. Errors from a known
 * family go out as they are (Cap'n Web drops the stack); anything else is
 * replaced, so internals never reach the client.
 */
export const toClientError = (
  error: Error,
  requestId: string
): Error | undefined => {
  if (
    requestErrors.codeOf(error) ||
    authErrors.codeOf(error) ||
    roleErrors.codeOf(error) ||
    permissionErrors.codeOf(error) ||
    appErrors.codeOf(error) ||
    knowledgeErrors.codeOf(error) ||
    internalErrors.codeOf(error)
  ) {
    return undefined;
  }
  const replacement = internalErrors.create("internal.unexpected", {
    requestId,
  });
  // Cap'n Web sends the stack of a replacement error; this one has none to send.
  replacement.stack = undefined;
  return replacement;
};

/** How often an idle connection checks that its session still holds. */
const sessionRecheckMs = 60_000;
/** The close code a connection gets when its session ends. */
export const sessionEndedCloseCode = 4401;

const signInOptions = (env: AuthEnv): SignInOption[] => {
  const config = signInConfig(env);
  return config
    ? oidcProviders(env, config, Date.now()).map(({ providerId, label }) => ({
        providerId,
        label,
      }))
    : [];
};

/**
 * Browsers send cookies with a WebSocket upgrade from any site and apply no
 * CORS to it, so without this check any page could open a signed-in
 * connection in the person's name (cross-site WebSocket hijacking). The
 * `Origin` a browser sends can't be forged by a page, so it must be exactly
 * the deployment's own origin from its config; a missing one is refused too.
 * The request's own URL is no guide: the router forwards it to core's
 * workers.dev address. Without sign-in config (local development) nobody can
 * have a session, and the page's own origin is accepted.
 */
const isOwnOrigin = (request: Request, env: AuthEnv): boolean =>
  request.headers.get("Origin") ===
  (signInConfig(env)?.origin ?? new URL(request.url).origin);

/** Who the connection signed in as, and how to tell they still are. */
interface ConnectionSession {
  env: AuthEnv;
  /** Only the cookie of the upgrade request. */
  headers: Headers;
  connectedAs: Identity;
}

/**
 * The signed-in API of one connection. Its check reads the session again and
 * closes the connection once it no longer holds (revoked, expired, removed
 * from the organization, staff window closed). It runs on every call, and
 * once a minute while the connection is idle, so an unused connection
 * doesn't stay open on a revoked session either.
 */
const sessionApi = (
  { env, headers, connectedAs }: ConnectionSession,
  server: WebSocket
): SessionRpc => {
  const close = (): void => {
    if (server.readyState === WebSocket.OPEN) {
      server.close(sessionEndedCloseCode, "Session ended");
    }
  };
  const check = async (): Promise<Identity> => {
    const identity = await identify(env, headers);
    if (identity?.userId !== connectedAs.userId) {
      // After the refusal is on its way to the client.
      setTimeout(close, 0);
      throw authErrors.create("auth.unauthenticated");
    }
    return identity;
  };
  const checkQuietly = async (): Promise<void> => {
    try {
      await check();
    } catch {
      // The check has closed the connection.
    }
  };
  const recheck = setInterval(() => {
    void checkQuietly();
  }, sessionRecheckMs);
  server.addEventListener("close", () => {
    clearInterval(recheck);
  });
  return new SessionRpc(env, check);
};

/**
 * Opens a Cap'n Web session over WebSocket. The session lives in this Worker
 * invocation for as long as the socket is open; hibernation applies once RPC
 * is routed to a Durable Object.
 *
 * The session cookie is checked when the connection opens, and again on
 * every call that needs the person (`sessionApi`).
 */
export const rpcResponse = async (
  request: Request,
  env: AuthEnv,
  requestId: string
): Promise<Response> => {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    const response = errorResponse(
      426,
      requestErrors.create("request.upgrade_required"),
      requestId
    );
    response.headers.set("Upgrade", "websocket");
    return response;
  }
  if (!isOwnOrigin(request, env)) {
    return errorResponse(
      403,
      requestErrors.create("request.forbidden"),
      requestId
    );
  }

  const cookie = request.headers.get("Cookie");
  const headers = new Headers(cookie === null ? {} : { cookie });
  const connectedAs = await identify(env, headers);

  const { 0: client, 1: server } = new WebSocketPair();
  // Cap'n Web also passes the reason a session ended through onSendError.
  // A closed socket is how sessions normally end, so that isn't logged.
  let open = true;
  server.addEventListener("close", () => {
    open = false;
  });
  server.accept();

  const session = connectedAs
    ? sessionApi({ env, headers, connectedAs }, server)
    : undefined;
  newWebSocketRpcSession(server, new CoreRpc(signInOptions(env), session), {
    onSendError: (error) => {
      const sent = toClientError(error, requestId);
      if (sent && open) {
        log.error("rpc.failed", { requestId, ...errorFields(error) });
      }
      return sent;
    },
  });
  return new Response(null, { status: 101, webSocket: client });
};
