import { actorOf } from "@grasp-os/shared/audit";
import {
  catalogSourceSchema,
  composioToolkitSchema,
  connectErrors,
  connectionErrors,
  connectionOwnersMax,
  connectionScopeSchema,
  oauthProviderSchema,
  returnPathMaxLength,
} from "@grasp-os/shared/connect";
import type {
  CatalogSource,
  ConnectionScope,
  CatalogTool,
  ConnectionOwner,
  ConnectionPerson,
  ConnectionsApi,
  ListedConnection,
  OAuthProvider,
  OfferedCatalog,
} from "@grasp-os/shared/connect";
import type { SignInConfig } from "@grasp-os/shared/deployment-config";
import { authErrors } from "@grasp-os/shared/errors";
import { errorFields, log } from "@grasp-os/shared/log";
import { isAdmin, requireAdmin, roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { RpcTarget } from "capnweb";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import {
  auditedBatch,
  keepAuditEvent,
  outboxedIfChanged,
} from "./audit-outbox.ts";
import { providerIds, signInConfig } from "./auth/config.ts";
import { identify } from "./auth/identity.ts";
import { accounts, hiddenConnectors, users } from "./db/core/schema.ts";
import { inList } from "./db/d1.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";

// Connecting accounts, as core's part in it: the signed-in person's API
// over `/rpc`, and the callback the provider sends the browser back to.
// Everything else is connect's: the flow's state and PKCE verifier, and the
// tokens, which never come to core (threat model R1). Core says who the
// person is, read from their session on each request, and where the
// deployment is (its origin and its tenant at the provider, both from
// deployment config, never from a request).

/** What the frontend sends to connect a toolkit, checked as `returnTo` is. */
const connectToolkitRequestSchema = z.object({
  returnTo: z.string().default("/"),
});
type ConnectToolkitRequest = Parameters<ConnectionsApi["connectToolkit"]>[0];

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

/**
 * Whose each of the connections `ids` is, from connect, a page of IDs at
 * a time (`ConnectApi.connectionOwners`); unknown ones are left out.
 */
export const connectionOwnersOf = async (
  env: Env,
  ids: readonly string[]
): Promise<ConnectionOwner[]> => {
  const pages: string[][] = [];
  for (let start = 0; start < ids.length; start += connectionOwnersMax) {
    pages.push(ids.slice(start, start + connectionOwnersMax));
  }
  const owners = await Promise.all(
    pages.map(async (page) => await env.CONNECT.connectionOwners(page))
  );
  return owners.flat();
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

// Which catalog entries are offered: every one, but those an admin hid
// (`hidden_connectors`). Core decides it, as the only caller that starts a
// flow at connect: a hidden entry isn't listed to anyone but admins, and
// starting to connect it is refused and recorded, whoever asks. Hiding
// never touches a connection already made; disconnecting it is separate.
// Such a connection goes on as before: permissions on it are still
// requested and granted (a blueprint copy's requests included), since
// hiding is about what people connect, not what is connected. But one that
// needs reconnecting (`needs_reauth`) can't be until the entry is offered
// again, as reconnecting starts a flow.

/** One catalog entry an admin offers or hides, as it came over the wire. */
const offerSchema = z.discriminatedUnion("source", [
  z.strictObject({
    source: z.literal("native"),
    id: oauthProviderSchema,
    offered: z.boolean(),
  }),
  z.strictObject({
    source: z.literal("composio"),
    id: composioToolkitSchema,
    offered: z.boolean(),
  }),
]);

/** A catalog entry's key, as the audit log names it. */
const entryKey = (source: CatalogSource, id: string): string =>
  `${source}:${id}`;

/** The keys of the entries an admin hid. */
const hiddenEntries = async (env: Env): Promise<Set<string>> => {
  const rows = await drizzle(env.DB)
    .select({
      source: hiddenConnectors.source,
      id: hiddenConnectors.connectorId,
    })
    .from(hiddenConnectors);
  return new Set(rows.map(({ source, id }) => entryKey(source, id)));
};

/** Whether an admin hid the entry `source` `id`. */
const isHidden = async (
  env: Env,
  source: CatalogSource,
  id: string
): Promise<boolean> => {
  const hidden = await drizzle(env.DB)
    .select({ id: hiddenConnectors.connectorId })
    .from(hiddenConnectors)
    .where(
      and(
        eq(hiddenConnectors.source, source),
        eq(hiddenConnectors.connectorId, id)
      )
    )
    .get();
  return hidden !== undefined;
};

/**
 * Refuses to start connecting the entry `source` `id`, as a `scope`
 * connection, while it is hidden, and records the refusal as connect
 * records its own (`provider`, `scope`, `outcome`, `reason`): someone went
 * around the catalog they were shown.
 */
const requireOffered = async (
  env: Env,
  person: ConnectionPerson,
  {
    source,
    id,
    scope,
  }: { source: CatalogSource; id: string; scope: ConnectionScope }
): Promise<void> => {
  if (!(await isHidden(env, source, id))) {
    return;
  }
  await keepAuditEvent(env, drizzle(env.DB), {
    actor: actorOf(person),
    action: "connection.connect",
    detail: {
      source,
      provider: id,
      scope,
      outcome: "refused",
      reason: "connection.not_offered",
    },
  });
  throw connectionErrors.create("connection.not_offered");
};

/**
 * Refuses to hide the Composio toolkit `slug` unless Composio lists it: a
 * misspelled slug would otherwise be hidden without a word, while the
 * toolkit meant stays offered. While Composio isn't listed, hiding is
 * refused as unavailable. Offering one again needs no
 * check, so an entry hidden before Composio dropped it can always be let
 * go.
 */
const requireListedToolkit = async (env: Env, slug: string): Promise<void> => {
  const catalog = await env.CONNECT.catalog();
  if (catalog.composio !== "listed") {
    throw connectionErrors.create("connection.provider_unavailable");
  }
  const listed = catalog.entries.some(
    ({ source, id }) => source === "composio" && id === slug
  );
  if (!listed) {
    throw connectionErrors.create("connection.invalid");
  }
};

/**
 * A signed-in person's `connections`. Every call checks the session
 * first; connect checks the rest: who may connect
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
      throw connectionErrors.create("connection.invalid");
    }
    const { provider, scope, returnTo } = parsed.data;
    await requireOffered(this.#env, person, {
      source: "native",
      id: provider,
      scope,
    });
    const config = signInConfig(this.#env);
    const tenant =
      config === undefined ? undefined : tenantOf(config, provider);
    if (config === undefined || tenant === undefined) {
      throw connectionErrors.create("connection.provider_unavailable");
    }
    const back = onOrigin(config.origin, returnTo);
    if (back === undefined) {
      throw connectionErrors.create("connection.invalid");
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

  /**
   * Connecting a Composio toolkit, for an admin who consented; connect
   * checks the rest (the role, the toolkit, the tools, the consent).
   */
  async connectToolkit(
    request: ConnectToolkitRequest
  ): Promise<{ url: string }> {
    const person = await this.#person();
    const parsed = connectToolkitRequestSchema.safeParse(request);
    const config = signInConfig(this.#env);
    if (config === undefined) {
      throw connectionErrors.create("connection.provider_unavailable");
    }
    const back = parsed.success
      ? onOrigin(config.origin, parsed.data.returnTo)
      : undefined;
    if (back === undefined) {
      throw connectionErrors.create("connection.invalid");
    }
    const { toolkit, tools, consent } = request;
    // Connect refuses a toolkit that isn't one; a hidden one is refused here.
    const slug = composioToolkitSchema.safeParse(toolkit);
    if (slug.success) {
      // A toolkit is always a shared connection.
      await requireOffered(this.#env, person, {
        source: "composio",
        id: slug.data,
        scope: "shared",
      });
    }
    return await this.#env.CONNECT.startToolkitConnection({
      person,
      toolkit,
      tools,
      consent,
      origin: config.origin,
      returnTo: `${back.pathname}${back.search}`,
    });
  }

  async list(): Promise<ListedConnection[]> {
    const person = await this.#person();
    const listed = await this.#env.CONNECT.listConnections(person);
    const ids = [
      ...new Set(listed.flatMap(({ connectedBy }) => connectedBy ?? [])),
    ];
    const people =
      ids.length === 0
        ? []
        : await drizzle(this.#env.DB)
            .select({ id: users.id, name: users.name })
            .from(users)
            .where(inList(users.id, ids));
    const names = new Map(people.map(({ id, name }) => [id, name]));
    return listed.map((connection) => ({
      ...connection,
      connectedByName:
        connection.connectedBy === null
          ? null
          : (names.get(connection.connectedBy) ?? null),
    }));
  }

  async disconnect(connectionId: string): Promise<{ revoked: boolean }> {
    const person = await this.#person();
    return await this.#env.CONNECT.disconnect({ person, connectionId });
  }

  // Anyone signed in may see what can be connected; connect checks the
  // request itself.

  async catalog(): Promise<OfferedCatalog> {
    return await withPerson(this.#check, async ({ role }) => {
      const [catalog, hidden] = await Promise.all([
        this.#env.CONNECT.catalog(),
        hiddenEntries(this.#env),
      ]);
      const entries = catalog.entries.map((entry) => ({
        ...entry,
        offered: !hidden.has(entryKey(entry.source, entry.id)),
      }));
      return {
        ...catalog,
        // Admins choose what is offered, so they see what isn't.
        entries: isAdmin(role)
          ? entries
          : entries.filter(({ offered }) => offered),
      };
    });
  }

  async setOffered(
    source: CatalogSource,
    id: string,
    offered: boolean
  ): Promise<void> {
    await withPerson(this.#check, async (identity) => {
      requireAdmin(identity);
      // Staff are admins, but never decide what a client's people connect.
      if (identity.staff) {
        throw roleErrors.create("role.forbidden");
      }
      const parsed = offerSchema.safeParse({ source, id, offered });
      if (!parsed.success) {
        throw connectionErrors.create("connection.invalid");
      }
      const entry = parsed.data;
      if (entry.source === "composio" && !entry.offered) {
        await requireListedToolkit(this.#env, entry.id);
      }
      const db = drizzle(this.#env.DB);
      // Recorded only when it changed something: offering what is offered
      // already, or hiding what is hidden, leaves no event.
      const event = outboxedIfChanged(db, {
        actor: actorOf(identity),
        action: "connection.offer_changed",
        target: {
          type: "catalog_entry",
          id: entryKey(entry.source, entry.id),
        },
        detail: {
          source: entry.source,
          provider: entry.id,
          offered: entry.offered,
        },
      });
      const thisEntry = and(
        eq(hiddenConnectors.source, entry.source),
        eq(hiddenConnectors.connectorId, entry.id)
      );
      await (entry.offered
        ? auditedBatch(this.#env, db, [
            db.delete(hiddenConnectors).where(thisEntry),
            event,
          ])
        : auditedBatch(this.#env, db, [
            db
              .insert(hiddenConnectors)
              .values({
                source: entry.source,
                connectorId: entry.id,
                hiddenBy: identity.userId,
                hiddenAt: new Date(),
              })
              .onConflictDoNothing(),
            event,
          ]));
    });
  }

  async catalogTools(
    source: CatalogSource,
    id: string
  ): Promise<CatalogTool[]> {
    const { role } = await this.#check();
    // A hidden entry isn't in anyone's catalog but an admin's, so to
    // everyone else it has no tools either: as for an entry there isn't.
    const entry = catalogSourceSchema.safeParse(source);
    if (
      !isAdmin(role) &&
      entry.success &&
      typeof id === "string" &&
      (await isHidden(this.#env, entry.data, id))
    ) {
      throw connectErrors.create("connect.catalog_entry_not_found");
    }
    return await this.#env.CONNECT.catalogTools({
      source,
      id,
    });
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
  if (request.method !== "GET" || config === undefined) {
    return undefined;
  }
  // A flow that fails returns to the Connections page, where people start
  // connecting and can read why: its own `returnTo` stays with connect,
  // which may never have found the flow.
  const connectionsPage = new URL("/connections", config.origin);
  const failed = (code: string): Response => {
    connectionsPage.searchParams.set("connectionError", code);
    return redirect(connectionsPage);
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
  const back = onOrigin(config.origin, finished.returnTo) ?? connectionsPage;
  back.searchParams.set("connection", finished.connectionId);
  return redirect(back);
};
