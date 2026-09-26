import { auditEventSchema } from "@grasp-os/shared/audit";
import type { AuditEvent } from "@grasp-os/shared/audit";
/**
 * Drives sign-in the way a browser on the client's page does, through the
 * router: requests go to core's own address with the router secret.
 */
import type { Role } from "@grasp-os/shared/roles";
import { routerSecretHeader } from "@grasp-os/shared/router";
import type { CoreApi } from "@grasp-os/shared/rpc";
import { newWebSocketRpcSession } from "capnweb";
import { env } from "cloudflare:workers";
import { vi } from "vite-plus/test";
import { z } from "zod";

import worker from "../src/index.ts";
import { loggedEvents, logHead } from "./audit-events.ts";
import type { Claims, Idp } from "./idp.ts";
import {
  acmeTenant,
  clientOrigin,
  signInConfig,
  staffOid,
} from "./sign-in-config.ts";

/** Where the router sends requests: core's own address. */
export const coreOrigin = "https://grasp-os-core.acme.workers.test";

export const sessionCookieName = "__Host-grasp.session_token";

/** Core's env with a different sign-in config. */
export const withSignIn = (changes: Record<string, unknown>): Env => ({
  ...env,
  SIGN_IN: { ...signInConfig, ...changes },
});

/** A request to the client's hostname, as core receives it from the router. */
export const routed = async (
  path: string,
  init: RequestInit = {},
  coreEnv: Env = env
): Promise<Response> => {
  const headers = new Headers(init.headers);
  headers.set(routerSecretHeader, env.ROUTER_SECRET);
  // A browser follows redirects to other origins; the tests look at them.
  const request = new Request(`${coreOrigin}${path}`, {
    redirect: "manual",
    ...init,
    headers,
  });
  return await worker.fetch(request, coreEnv);
};

/** The `name=value` pairs a response sets, as a `Cookie` header. */
const cookiesFrom = (response: Response): string =>
  response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0] ?? "")
    .filter((pair) => !pair.endsWith("="))
    .join("; ");

/** The session cookie a response sets, as a `Cookie` header, if any. */
const sessionCookieFrom = (response: Response): string | undefined =>
  cookiesFrom(response)
    .split("; ")
    .find((pair) => pair.startsWith(`${sessionCookieName}=`));

const startedSchema = z.object({ url: z.url(), redirect: z.literal(true) });

interface SignInOptions {
  /** Cookies the browser already has. */
  cookie?: string;
  coreEnv?: Env;
  /** Where the browser goes once signed in; the start page by default. */
  callbackURL?: string;
}

/** Asks core to start signing in; returns the IdP URL and the browser's cookies. */
export const startSignIn = async (
  providerId: string,
  { cookie = "", coreEnv = env, callbackURL = "/" }: SignInOptions = {}
) => {
  const response = await routed(
    "/api/auth/sign-in/sso",
    {
      method: "POST",
      headers: {
        origin: clientOrigin,
        "content-type": "application/json",
        cookie,
      },
      body: JSON.stringify({
        providerId,
        callbackURL,
        errorCallbackURL: "/",
      }),
    },
    coreEnv
  );
  if (!response.ok) {
    throw new Error(`Sign-in did not start: ${response.status}`);
  }
  const { url } = startedSchema.parse(await response.json());
  return { authorizationUrl: new URL(url), cookie: cookiesFrom(response) };
};

/** Follows the IdP's redirect back to core, as the browser would. */
export const finishSignIn = async (
  callback: URL,
  { cookie = "", coreEnv = env }: SignInOptions = {}
) =>
  await routed(
    `${callback.pathname}${callback.search}`,
    { headers: { cookie } },
    coreEnv
  );

/**
 * Signs a person in end to end: core, the IdP, back to core. Returns core's
 * final response (a redirect to the frontend) and the session cookie it set.
 */
export const signIn = async (
  idp: Idp,
  providerId: string,
  claims: Claims,
  options: SignInOptions = {}
) => {
  const started = await startSignIn(providerId, options);
  const callback = idp.authorize(started.authorizationUrl, claims);
  const cookie = [options.cookie, started.cookie].filter(Boolean).join("; ");
  const response = await finishSignIn(callback, { ...options, cookie });
  return {
    response,
    location: response.headers.get("location"),
    session: sessionCookieFrom(response),
    callback,
    cookie,
  };
};

/** Signs in and returns the session cookie; fails the test if refused. */
export const signedIn = async (
  idp: Idp,
  providerId: string,
  claims: Claims,
  options: SignInOptions = {}
): Promise<string> => {
  const { session, location } = await signIn(idp, providerId, claims, options);
  if (session === undefined) {
    throw new Error(`Sign-in refused: ${location}`);
  }
  return session;
};

interface RpcOptions {
  /** The page the connection comes from. */
  origin?: string;
  coreEnv?: Env;
}

/** Opens `/rpc` with `cookie`, from the client's own page unless told otherwise. */
export const openRpc = async (
  cookie?: string,
  { origin = clientOrigin, coreEnv = env }: RpcOptions = {}
) => {
  const headers = new Headers({ Upgrade: "websocket", Origin: origin });
  if (cookie !== undefined) {
    headers.set("cookie", cookie);
  }
  const response = await routed("/rpc", { headers }, coreEnv);
  const socket = response.webSocket;
  if (!socket) {
    throw new Error(`Expected a WebSocket, got ${response.status}`);
  }
  const closed = Promise.withResolvers<number>();
  socket.addEventListener("close", (event) => {
    closed.resolve(event.code);
  });
  socket.accept();
  const core = newWebSocketRpcSession<CoreApi>(socket);
  return { core, closed: closed.promise };
};

/** Who the session behind `cookie` is, on a connection of its own. */
export const whoami = async (cookie?: string, coreEnv: Env = env) => {
  const { core } = await openRpc(cookie, { coreEnv });
  try {
    using session = core.authenticate();
    return await session.whoami();
  } finally {
    core[Symbol.dispose]();
  }
};

/** Calls Better Auth's API as a browser on the client's page. */
export const callAuth = async (
  path: string,
  cookie: string,
  body?: unknown
): Promise<Response> => {
  const headers = new Headers({ origin: clientOrigin, cookie });
  if (body === undefined) {
    return await routed(`/api/auth${path}`, { headers });
  }
  headers.set("content-type", "application/json");
  return await routed(`/api/auth${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
};

/**
 * The code a promise was refused with, or "ok" if it wasn't: an error's
 * `code` (every expected error has one, and keeps it over RPC), or else
 * the error as text.
 */
export const outcome = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return "ok";
  } catch (error) {
    return typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string"
      ? error.code
      : String(error);
  }
};

/**
 * The audit events core sent while `run` ran, as the audit log stored them,
 * in log order: waits for the log to have each of them, by ID.
 */
export const auditedDuring = async (
  run: () => Promise<unknown>
): Promise<AuditEvent[]> => {
  const after = await logHead();
  const sent = vi.spyOn(env.AUDIT_QUEUE, "send");
  let ids: string[];
  try {
    await run();
    ids = sent.mock.calls.map(([event]) => auditEventSchema.parse(event).id);
  } finally {
    sent.mockRestore();
  }
  return await loggedEvents(ids, after);
};

/** A short random name part, so tests don't share people or things. */
export const unique = () => crypto.randomUUID().slice(0, 8);

/** Someone in the client's Entra tenant. */
export const entraPerson = (
  tenantId: string,
  domain = "acme.test",
  claims: Claims = {}
): Claims => {
  const id = unique();
  return {
    sub: `entra-sub-${id}`,
    oid: `entra-oid-${id}`,
    tid: tenantId,
    // A member of the tenant, not a B2B guest.
    acct: 0,
    email: `person-${id}@${domain}`,
    name: `Person ${id}`,
    ...claims,
  };
};

/** The Grasp staff member the config lets in, signing in from Grasp's tenant. */
export const staffPerson = (claims: Claims = {}): Claims =>
  entraPerson(signInConfig.staff.tenantId, "grasp.test", {
    oid: staffOid,
    ...claims,
  });

/** Someone in the client's Google Workspace. */
export const googlePerson = (claims: Claims = {}): Claims => {
  const id = unique();
  return {
    sub: `google-sub-${id}`,
    hd: "acme.test",
    email: `person-${id}@acme.test`,
    email_verified: true,
    name: `Person ${id}`,
    ...claims,
  };
};

/** Someone signed in with `role`, as the configured admins or made so by one. */
export const signedInWithRole = async (idp: Idp, role: Role) => {
  const person = entraPerson(acmeTenant);
  const session = await signedIn(idp, "microsoft", person, {
    coreEnv: withSignIn({ admins: [person.email] }),
  });
  const { userId } = await whoami(session);
  if (role !== "admin") {
    await env.DB.prepare("UPDATE members SET role = ? WHERE user_id = ?")
      .bind(role, userId)
      .run();
  }
  return { session, userId, person };
};

/** Someone signed in with `role`, and their API, on a connection of their own. */
export const signedInApi = async (idp: Idp, role: Role) => {
  const person = await signedInWithRole(idp, role);
  const { core, closed } = await openRpc(person.session);
  return { ...person, core, closed, api: core.authenticate() };
};
