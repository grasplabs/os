import type { AuditActor, AuditDetailValue } from "@grasp-os/shared/audit";
import {
  connectErrors,
  connectionCallbackPath,
  connectionErrors,
  connectionPersonSchema,
  disconnectSchema,
  finishConnectionSchema,
  oauthProviderSchema,
  startConnectionSchema,
} from "@grasp-os/shared/connect";
import type {
  ConnectionPerson,
  ConnectionScope,
  ConnectionSummary,
} from "@grasp-os/shared/connect";
import { randomToken, sha256Hex, toBase64Url } from "@grasp-os/shared/encoding";
import { errorFields, log } from "@grasp-os/shared/log";
import { isAdmin, roleErrors } from "@grasp-os/shared/roles";
import { and, desc, eq, like, lte, ne, or, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { drizzle } from "drizzle-orm/d1";
import type { z } from "zod";

import { recordEventIf, recordEvents } from "./audit.ts";
import { connections, connectionTokens, oauthFlows } from "./db/schema.ts";
import { exchangeCode, idTokenClaims, revokeToken } from "./oauth-client.ts";
import type { TokenSet } from "./oauth-client.ts";
import { providers } from "./providers.ts";
import type {
  OAuthClientCredentials,
  ProviderAccount,
  ProviderConfig,
} from "./providers.ts";
import { discardMint, firstTokens, revocableToken } from "./tokens.ts";
import { resealBatchSize, vaultFor } from "./vault.ts";
import type { Vault } from "./vault.ts";

// Connecting an account: the OAuth 2.0 authorization code flow with PKCE,
// for every provider in src/providers.ts.
//
// A person starts it from their browser, signed in to core, and the
// provider sends the browser back to core's callback on the same origin,
// where their session cookie comes along (`SameSite=Lax` goes with a
// top-level navigation). Core says who the person is on both requests, and
// a flow only finishes for the person who started it. So a flow can't be
// finished in anyone else's name: an attacker who gets a victim to finish
// the attacker's flow (or to open a callback URL carrying the attacker's
// code) is refused, because the victim's session isn't the flow's person,
// and nothing is exchanged (threat model CN4). The `state` is 256 random
// bits, single-use and valid for ten minutes; only its hash is stored. The
// PKCE verifier never leaves connect, so the code alone, which core sees on
// the callback, is useless (CN3).

/** How long a person has to finish at the provider. */
const flowLifetimeMs = 10 * 60 * 1000;

const actorOf = (person: ConnectionPerson): AuditActor =>
  person.staff
    ? { type: "staff", userId: person.userId }
    : { type: "person", userId: person.userId };

/** One connect or disconnect, for the audit log: IDs, never tokens. */
const event = (
  person: ConnectionPerson,
  action: "connection.connect" | "connection.disconnect",
  connectionId: string | undefined,
  detail: Record<string, AuditDetailValue>
) => ({
  actor: actorOf(person),
  action,
  target:
    connectionId === undefined
      ? undefined
      : { type: "connection", id: connectionId },
  detail,
});

/** Records a refused or failed attempt; if that fails too, it is logged. */
const auditRefusal = async (
  env: Env,
  person: ConnectionPerson,
  action: "connection.connect" | "connection.disconnect",
  detail: Record<string, AuditDetailValue>,
  connectionId?: string
): Promise<void> => {
  try {
    await recordEvents(env, [event(person, action, connectionId, detail)]);
  } catch (error) {
    log.error("audit.record_failed", errorFields(error));
  }
};

const parse = <Schema extends z.ZodType>(
  schema: Schema,
  request: unknown
): z.output<Schema> => {
  const parsed = schema.safeParse(request);
  if (!parsed.success) {
    throw connectionErrors.create("connection.invalid_request");
  }
  return parsed.data;
};

/**
 * Grasp staff, in a staff window, can't connect anything: accounts belong
 * to the client's people and admins.
 */
const refuseStaff = async (
  env: Env,
  person: ConnectionPerson,
  detail: Record<string, AuditDetailValue>
): Promise<void> => {
  if (!person.staff) {
    return;
  }
  await auditRefusal(env, person, "connection.connect", {
    ...detail,
    outcome: "refused",
    reason: "connection.staff_not_allowed",
  });
  throw connectionErrors.create("connection.staff_not_allowed");
};

/**
 * Whether `account` is the person's own: the account they sign in with at
 * that provider (its Entra object ID or Google subject), or, where they
 * sign in elsewhere, the one with their verified email. A personal
 * connection is used only in its owner's own context (R5), so it must hold
 * their own account, not a colleague's or a shared mailbox's.
 */
const isOwnAccount = (
  person: ConnectionPerson,
  provider: string,
  account: ProviderAccount
): boolean => {
  const signIns = person.accounts.filter((each) => each.provider === provider);
  if (signIns.length > 0) {
    return signIns.some(({ subject }) => subject === account.id);
  }
  return account.email?.toLowerCase() === person.email.toLowerCase();
};

/** The live connection that already holds `accountId`, if any. */
const connectionHolding = async (
  env: Env,
  provider: string,
  accountId: string
): Promise<string | undefined> => {
  const held = await drizzle(env.DB)
    .select({ id: connections.id })
    .from(connections)
    .where(
      and(
        eq(connections.provider, provider),
        eq(connections.accountId, accountId),
        ne(connections.status, "disconnected")
      )
    )
    .get();
  return held?.id;
};

/** Only admins connect or disconnect what the organization shares. */
const mayManage = (person: ConnectionPerson, scope: ConnectionScope): boolean =>
  scope === "personal" || isAdmin(person.role);

interface Ready {
  provider: ProviderConfig;
  client: OAuthClientCredentials;
  vault: Vault;
}

/** The provider, with its client and the vault, or refused while unset. */
const ready = async (env: Env, providerId: string): Promise<Ready> => {
  const parsed = oauthProviderSchema.safeParse(providerId);
  const provider = parsed.success ? providers[parsed.data] : undefined;
  const client = provider?.client(env);
  const vault = await vaultFor(env);
  if (provider === undefined || client === undefined || vault === undefined) {
    throw connectionErrors.create("connection.provider_unavailable");
  }
  return { provider, client, vault };
};

const pkceChallenge = async (verifier: string): Promise<string> =>
  toBase64Url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
    )
  );

const flowContext = (stateHash: string): string => `flow:${stateHash}`;

/** Starts a flow: the provider URL to send the person's browser to. */
export const startConnection = async (
  env: Env,
  request: unknown
): Promise<{ url: string }> => {
  const {
    person,
    provider: providerId,
    scope,
    origin,
    returnTo,
    ...rest
  } = parse(startConnectionSchema, request);
  await refuseStaff(env, person, { provider: providerId, scope });
  if (!mayManage(person, scope)) {
    await auditRefusal(env, person, "connection.connect", {
      provider: providerId,
      scope,
      outcome: "refused",
      reason: "role.forbidden",
    });
    throw roleErrors.create("role.forbidden");
  }
  const { provider, client, vault } = await ready(env, providerId);
  const tenant = rest.tenant.toLowerCase();
  if (!provider.isTenant(tenant) || new URL(origin).origin !== origin) {
    throw connectionErrors.create("connection.provider_unavailable");
  }

  const state = randomToken();
  const verifier = randomToken();
  const stateHash = await sha256Hex(state);
  const redirectUri = new URL(connectionCallbackPath, origin).href;
  await drizzle(env.DB)
    .insert(oauthFlows)
    .values({
      stateHash,
      userId: person.userId,
      provider: provider.id,
      scope,
      tenant,
      redirectUri,
      returnTo,
      verifier: await vault.seal(verifier, flowContext(stateHash)),
      expiresAt: new Date(Date.now() + flowLifetimeMs),
    });

  const url = new URL(provider.authorizationEndpoint(tenant));
  const params = {
    ...provider.authorizationParams(tenant),
    response_type: "code",
    client_id: client.id,
    redirect_uri: redirectUri,
    scope: provider.scopes.join(" "),
    state,
    code_challenge: await pkceChallenge(verifier),
    code_challenge_method: "S256",
  };
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return { url: url.href };
};

/**
 * Takes the flow `state` names: deleted before anything is checked, so it
 * is spent whatever happens next, even when it isn't this person's.
 */
const takeFlow = async (env: Env, state: string) => {
  const stateHash = await sha256Hex(state);
  const [flow] = await drizzle(env.DB)
    .delete(oauthFlows)
    .where(eq(oauthFlows.stateHash, stateHash))
    .returning();
  return flow;
};

/**
 * Spends the flow `state` names, if it is one: a flow that came back but
 * can't finish (no session, a malformed request) can't be finished later
 * with the same code.
 */
export const abandonFlow = async (env: Env, state: unknown): Promise<void> => {
  const parsed = finishConnectionSchema.shape.state.safeParse(state);
  if (parsed.success) {
    await takeFlow(env, parsed.data);
  }
};

/**
 * Drops tokens minted for a connection that won't be made, revoking them
 * unless a live connection holds the same account: at Google, revoking any
 * token of a grant revokes all of it.
 */
const dropMint = async (
  env: Env,
  { provider, client }: Ready,
  tokens: TokenSet,
  accountId: string | undefined
): Promise<void> => {
  const held =
    accountId === undefined
      ? undefined
      : await connectionHolding(env, provider.id, accountId);
  if (held === undefined) {
    await discardMint(provider, client, tokens);
  }
};

/** A second live connection to the same account (the unique index). */
const isDuplicate = (error: unknown): boolean =>
  error instanceof Error &&
  error.message.includes("UNIQUE") &&
  error.message.includes("connections");

/** Stores a new connection with its tokens and its event, all or nothing. */
const storeConnection = async (
  env: Env,
  { provider, vault }: Ready,
  flow: typeof oauthFlows.$inferSelect,
  person: ConnectionPerson,
  account: ProviderAccount,
  tokens: TokenSet & { refreshToken: string }
): Promise<string> => {
  const connectionId = crypto.randomUUID();
  const now = new Date();
  const db = drizzle(env.DB);
  const writes: BatchItem<"sqlite">[] = [
    db.insert(connections).values({
      id: connectionId,
      provider: provider.id,
      scope: flow.scope,
      ownerUserId: flow.scope === "personal" ? person.userId : null,
      status: "active",
      serverKind: "native",
      server: provider.server,
      tenant: flow.tenant,
      accountId: account.id,
      accountName: account.name,
      connectedBy: person.userId,
      createdAt: now,
      updatedAt: now,
    }),
    db
      .insert(connectionTokens)
      .values(await firstTokens(vault, connectionId, tokens, now)),
  ];
  await recordEvents(
    env,
    [
      event(person, "connection.connect", connectionId, {
        provider: provider.id,
        scope: flow.scope,
        outcome: "ok",
      }),
    ],
    writes
  );
  return connectionId;
};

/**
 * Finishes a flow with the provider's answer, for the person who started
 * it: exchanges the code, checks the account is in the organization's
 * tenant, and stores the connection with its tokens, sealed.
 */
export const finishConnection = async (
  env: Env,
  request: unknown
): Promise<{ connectionId: string; returnTo: string }> => {
  const parsed = finishConnectionSchema.safeParse(request);
  if (!parsed.success) {
    const given: unknown =
      typeof request === "object" && request !== null
        ? Reflect.get(request, "state")
        : undefined;
    await abandonFlow(env, given);
    throw connectionErrors.create("connection.invalid_request");
  }
  const { person, state, code, error } = parsed.data;
  const flow = await takeFlow(env, state);
  const refuse = async (
    reason: string,
    outcome: "refused" | "failed" = "refused"
  ): Promise<void> => {
    await auditRefusal(env, person, "connection.connect", {
      provider: flow?.provider ?? null,
      scope: flow?.scope ?? null,
      outcome,
      reason,
    });
  };
  const live =
    flow !== undefined &&
    flow.expiresAt.getTime() > Date.now() &&
    flow.userId === person.userId;
  if (!live) {
    await refuse("connection.flow_invalid");
    throw connectionErrors.create("connection.flow_invalid");
  }
  await refuseStaff(env, person, {
    provider: flow.provider,
    scope: flow.scope,
  });
  // The role is read again: it may have changed since the flow started.
  if (!mayManage(person, flow.scope)) {
    await refuse("role.forbidden");
    throw roleErrors.create("role.forbidden");
  }
  if (code === undefined || error !== undefined) {
    await refuse("connection.provider_refused", "failed");
    throw connectionErrors.create("connection.provider_refused");
  }
  const setUp = await ready(env, flow.provider);
  const { provider, client, vault } = setUp;

  let tokens: TokenSet;
  try {
    tokens = await exchangeCode(provider, client, flow.tenant, {
      code,
      redirectUri: flow.redirectUri,
      verifier: await vault.open(flow.verifier, flowContext(flow.stateHash)),
    });
  } catch (exchangeError) {
    log.warn("oauth.exchange_failed", {
      provider: provider.id,
      ...errorFields(exchangeError),
    });
    await refuse("connection.provider_refused", "failed");
    throw connectionErrors.create("connection.provider_refused");
  }

  const claims = idTokenClaims(tokens.idToken);
  const account = provider.account(claims, flow.tenant, client.id);
  const refusal = async (
    reason:
      | "connection.wrong_account"
      | "connection.not_own_account"
      | "connection.already_connected"
      | "connection.provider_refused"
  ): Promise<never> => {
    // Even an account refused here may be one a live connection holds.
    await dropMint(env, setUp, tokens, account?.id ?? provider.subject(claims));
    await refuse(reason);
    throw connectionErrors.create(reason);
  };
  if (account === null) {
    return await refusal("connection.wrong_account");
  }
  if (
    flow.scope === "personal" &&
    !isOwnAccount(person, provider.id, account)
  ) {
    return await refusal("connection.not_own_account");
  }
  if ((await connectionHolding(env, provider.id, account.id)) !== undefined) {
    return await refusal("connection.already_connected");
  }
  const { refreshToken } = tokens;
  if (refreshToken === undefined) {
    // Without one the connection would die within the hour.
    return await refusal("connection.provider_refused");
  }
  try {
    const connectionId = await storeConnection(
      env,
      setUp,
      flow,
      person,
      account,
      {
        ...tokens,
        refreshToken,
      }
    );
    return { connectionId, returnTo: flow.returnTo };
  } catch (storeError) {
    // Connected at the same moment by another flow: the grant is theirs.
    if (isDuplicate(storeError)) {
      await refuse("connection.already_connected");
      throw connectionErrors.create("connection.already_connected");
    }
    await dropMint(env, setUp, tokens, account.id);
    throw storeError;
  }
};

/** The person's own connections and the shared ones, never disconnected ones. */
export const listConnections = async (
  env: Env,
  request: unknown
): Promise<ConnectionSummary[]> => {
  const person = parse(connectionPersonSchema, request);
  const rows = await drizzle(env.DB)
    .select()
    .from(connections)
    .where(
      and(
        ne(connections.status, "disconnected"),
        or(
          eq(connections.scope, "shared"),
          eq(connections.ownerUserId, person.userId)
        )
      )
    )
    .orderBy(desc(connections.createdAt));
  return rows.map((row) => ({
    id: row.id,
    provider: row.provider,
    scope: row.scope,
    status: row.status,
    ownerUserId: row.ownerUserId,
    connectedBy: row.connectedBy,
    accountName: row.accountName,
    createdAt: row.createdAt.toISOString(),
  }));
};

/**
 * Revokes the grant at the provider where it can. Best effort: a provider
 * that is down doesn't keep a person from disconnecting, and the tokens are
 * deleted either way (threat model CN14).
 */
const revoke = async (
  env: Env,
  connection: typeof connections.$inferSelect
): Promise<boolean> => {
  const parsed = oauthProviderSchema.safeParse(connection.provider);
  if (!parsed.success) {
    return false;
  }
  const provider = providers[parsed.data];
  const client = provider.client(env);
  const token = await revocableToken(env, connection.id);
  if (client === undefined || token === undefined) {
    return false;
  }
  try {
    return await revokeToken(provider, client, token);
  } catch (error) {
    log.warn("oauth.revoke_failed", {
      provider: provider.id,
      ...errorFields(error),
    });
    return false;
  }
};

/**
 * Disconnects: revokes the grant where the provider can, then deletes the
 * tokens and stops the connection, in one write with its event. A
 * personal connection only by its owner, a shared one only by an admin.
 */
export const disconnect = async (
  env: Env,
  request: unknown
): Promise<{ revoked: boolean }> => {
  const { person, connectionId } = parse(disconnectSchema, request);
  const db = drizzle(env.DB);
  const connection = await db
    .select()
    .from(connections)
    .where(eq(connections.id, connectionId))
    .get();
  if (connection === undefined) {
    throw connectErrors.create("connect.connection_not_found");
  }
  const refused = async (reason: string): Promise<void> => {
    await auditRefusal(
      env,
      person,
      "connection.disconnect",
      { provider: connection.provider, outcome: "refused", reason },
      connectionId
    );
  };
  if (
    connection.scope === "personal" &&
    connection.ownerUserId !== person.userId
  ) {
    await refused("connect.not_owner");
    throw connectErrors.create("connect.not_owner");
  }
  if (!mayManage(person, connection.scope)) {
    await refused("role.forbidden");
    throw roleErrors.create("role.forbidden");
  }
  if (connection.status === "disconnected") {
    return { revoked: false };
  }
  const revoked = await revoke(env, connection);
  // Recorded only by the disconnect that stops it, if two run at once.
  const stillConnected = sql`${connections.id} = ${connectionId} AND ${connections.status} <> 'disconnected'`;
  await recordEventIf(
    env,
    event(person, "connection.disconnect", connectionId, {
      provider: connection.provider,
      scope: connection.scope,
      outcome: "ok",
      revoked,
    }),
    { from: connections, where: stillConnected },
    [
      db
        .update(connections)
        .set({ status: "disconnected", updatedAt: new Date() })
        .where(stillConnected),
      db
        .delete(connectionTokens)
        .where(eq(connectionTokens.connectionId, connectionId)),
    ]
  );
  return { revoked };
};

/**
 * Seals the verifiers of flows under way again with the current key, after
 * a rotation, as `resealTokens` does for tokens: a flow started just before
 * still finishes once the previous key is gone. The cron trigger calls it.
 */
export const resealFlows = async (env: Env): Promise<void> => {
  const vault = await vaultFor(env);
  if (vault?.sealedWithPrevious === undefined) {
    return;
  }
  const db = drizzle(env.DB);
  const flows = await db
    .select()
    .from(oauthFlows)
    .where(like(oauthFlows.verifier, vault.sealedWithPrevious))
    .limit(resealBatchSize);
  for (const flow of flows) {
    const context = flowContext(flow.stateHash);
    try {
      // oxlint-disable-next-line no-await-in-loop -- a small batch, in turn
      const verifier = await vault.open(flow.verifier, context);
      // oxlint-disable-next-line no-await-in-loop -- a small batch, in turn
      const sealed = await vault.seal(verifier, context);
      // oxlint-disable-next-line no-await-in-loop -- a small batch, in turn
      await db
        .update(oauthFlows)
        .set({ verifier: sealed })
        .where(
          and(
            eq(oauthFlows.stateHash, flow.stateHash),
            eq(oauthFlows.verifier, flow.verifier)
          )
        );
    } catch (error) {
      // Changed at rest: it can never finish, so it goes rather than hold
      // up the rest.
      log.error("vault.open_failed", errorFields(error));
      // oxlint-disable-next-line no-await-in-loop -- a small batch, in turn
      await db
        .delete(oauthFlows)
        .where(eq(oauthFlows.stateHash, flow.stateHash));
    }
  }
};

/** Deletes flows nobody finished in time. The cron trigger calls it. */
export const purgeExpiredFlows = async (env: Env): Promise<void> => {
  await drizzle(env.DB)
    .delete(oauthFlows)
    .where(lte(oauthFlows.expiresAt, new Date()));
};
