import {
  connectErrors,
  connectionErrors,
  connectionScopeSchema,
  oauthProviderSchema,
  returnPathMaxLength,
} from "@grasp-os/shared/connect";
import type {
  ConnectionPerson,
  ConnectionsApi,
  ConnectionSummary,
  OAuthProvider,
} from "@grasp-os/shared/connect";
import { authErrors } from "@grasp-os/shared/errors";
import { errorFields, log } from "@grasp-os/shared/log";
import { roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { RpcTarget } from "capnweb";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { providerIds, signInConfig } from "./auth/config.ts";
import type { SignInConfig } from "./auth/config.ts";
import { identify } from "./auth/identity.ts";
import { accounts } from "./db/core/schema.ts";
import { featureEnabled } from "./features.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";

// Connecting accounts, as core's part in it: the signed-in person's API
// over `/rpc`, and the callback the provider sends the browser back to.
// Everything else is connect's: the flow's state and PKCE verifier, and the
// tokens, which never come to core (threat model R1). Core says who the
// person is, read from their session on each request, and where the
// deployment is (its origin and its tenant at the provider, both from
// deployment config, never from a request).

/** What the frontend sends to start: checked here, as it came over the wire. */
const startRequestSchema = z.strictObject({
  provider: oauthProviderSchema,
  scope: connectionScopeSchema,
  returnTo: z.string().default("/"),
});
type StartRequest = Parameters<ConnectionsApi["start"]>[0];

/**
 * The person as connect needs them: who, their role, and the accounts they
 * sign in with (a personal connection must be to one of them), read now.
 * Entra accounts by their object ID, which is the same for every app in
 * the tenant; Google ones by their subject.
 */
export const personOf = async (
  env: Env,
  { userId, role, staff, email }: Identity
): Promise<ConnectionPerson> => {
  const signIns = await drizzle(env.DB)
    .select({
      providerId: accounts.providerId,
      accountId: accounts.accountId,
      oid: accounts.oid,
    })
    .from(accounts)
    .where(eq(accounts.userId, userId));
  const accountsOf: ConnectionPerson["accounts"] = [];
  for (const { providerId, accountId, oid } of signIns) {
    if (providerId === providerIds.entra && oid !== null) {
      accountsOf.push({ provider: "microsoft", subject: oid });
    } else if (providerId === providerIds.google) {
      accountsOf.push({ provider: "google", subject: accountId });
    }
  }
  return { userId, role, staff, email, accounts: accountsOf };
};

/** The organization's tenant at `provider`, from the sign-in config. */
const tenantOf = (
  config: SignInConfig,
  provider: OAuthProvider
): string | undefined =>
  provider === "microsoft"
    ? config.entra?.tenantId
    : config.google?.hostedDomain;

/**
 * `path` as a URL on `origin`, or `undefined` when it would lead anywhere
 * else: another origin (`//evil.test`, `/\evil.test`, and tabs or newlines
 * the URL parser drops), another scheme, or a fragment. What the browser is
 * sent back to comes only from here, so the callback is no open redirect.
 */
const onOrigin = (origin: string, path: string): URL | undefined => {
  if (!path.startsWith("/") || path.length > returnPathMaxLength) {
    return undefined;
  }
  try {
    const url = new URL(path, origin);
    // `/.//evil.test` resolves to the path `//evil.test`, which a browser
    // would take for another host if it were ever used as a path again.
    const safe =
      url.origin === origin &&
      url.hash === "" &&
      !url.pathname.startsWith("//");
    return safe ? url : undefined;
  } catch {
    return undefined;
  }
};

/**
 * A signed-in person's `connections`. Every call checks the session (and
 * the `connections` flag) first; connect checks the rest: who may connect
 * or disconnect what.
 */
export class ConnectionsRpc extends RpcTarget implements ConnectionsApi {
  readonly #env: Env;
  readonly #check: SessionCheck;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
  }

  /** The person behind the session, checked now, as connect needs them. */
  async #person(): Promise<ConnectionPerson> {
    return await withPerson(
      this.#check,
      async (identity) => await personOf(this.#env, identity)
    );
  }

  async start(request: StartRequest): Promise<{ url: string }> {
    const person = await this.#person();
    const parsed = startRequestSchema.safeParse(request);
    if (!parsed.success) {
      throw connectionErrors.create("connection.invalid_request");
    }
    const { provider, scope, returnTo } = parsed.data;
    const config = signInConfig(this.#env);
    const tenant =
      config === undefined ? undefined : tenantOf(config, provider);
    if (config === undefined || tenant === undefined) {
      throw connectionErrors.create("connection.provider_unavailable");
    }
    const back = onOrigin(config.origin, returnTo);
    if (back === undefined) {
      throw connectionErrors.create("connection.invalid_request");
    }
    return await this.#env.CONNECT.startConnection({
      person,
      provider,
      scope,
      origin: config.origin,
      tenant,
      returnTo: `${back.pathname}${back.search}`,
    });
  }

  async list(): Promise<ConnectionSummary[]> {
    const person = await this.#person();
    return await this.#env.CONNECT.listConnections(person);
  }

  async disconnect(connectionId: string): Promise<{ revoked: boolean }> {
    const person = await this.#person();
    return await this.#env.CONNECT.disconnect({ person, connectionId });
  }
}

/** Why a flow didn't finish, as the page the browser returns to reads it. */
const errorCodeOf = (error: unknown): string => {
  const code =
    connectionErrors.codeOf(error) ??
    connectErrors.codeOf(error) ??
    roleErrors.codeOf(error);
  if (code === undefined) {
    log.error("connection.finish_failed", errorFields(error));
  }
  return code ?? "internal.unexpected";
};

/**
 * Sends the browser on, never caching the answer, and never passing the
 * callback's URL (it carries the code) on as a referrer.
 */
const redirect = (to: URL): Response =>
  new Response(null, {
    status: 303,
    headers: {
      location: to.href,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });

/**
 * The provider's redirect back, on the client's origin. The session cookie
 * comes along (a top-level navigation sends `SameSite=Lax` cookies), and
 * connect finishes the flow only for the person who started it, so a
 * callback URL opened by anyone else (sent by an attacker, say) attaches
 * nothing to anyone. Core forwards the code without logging it: the request
 * log has the path only.
 */
export const handleConnectionCallback = async (
  request: Request,
  env: Env
): Promise<Response | undefined> => {
  const config = signInConfig(env);
  if (
    request.method !== "GET" ||
    config === undefined ||
    !featureEnabled(env, "connections")
  ) {
    return undefined;
  }
  const home = new URL("/", config.origin);
  const failed = (code: string): Response => {
    home.searchParams.set("connectionError", code);
    return redirect(home);
  };
  const params = new URL(request.url).searchParams;
  const state = params.get("state");
  if (state === null || state === "") {
    return failed("connection.flow_invalid");
  }
  const identity = await identify(env, request.headers);
  if (identity === undefined) {
    // Spent, so the code in this URL can't be brought back to finish it.
    await env.CONNECT.abandonFlow(state);
    return failed(authErrors.create("auth.unauthenticated").code);
  }
  let finished: { connectionId: string; returnTo: string };
  try {
    finished = await env.CONNECT.finishConnection({
      person: await personOf(env, identity),
      state,
      code: params.get("code") ?? undefined,
      // Only whether there is one matters; the provider's text isn't kept.
      error: params.get("error")?.slice(0, 64) ?? undefined,
    });
  } catch (error) {
    return failed(errorCodeOf(error));
  }
  const back = onOrigin(config.origin, finished.returnTo) ?? home;
  back.searchParams.set("connection", finished.connectionId);
  return redirect(back);
};
