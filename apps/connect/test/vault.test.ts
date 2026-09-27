import type { ConnectionPerson } from "@grasp-os/shared/connect";
import { env, exports } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vite-plus/test";

import { connections, connectionTokens, oauthFlows } from "../src/db/schema.ts";
import { finishConnection, resealFlows } from "../src/oauth.ts";
import { accessTokenFor, resealTokens } from "../src/tokens.ts";
import { VaultError, vaultFor } from "../src/vault.ts";
import {
  agentFor,
  auditEvents,
  callAs,
  connectAccount,
  mailboxAccount,
  outcome,
  ownAccount,
  someone,
  startAs,
  stateOf,
} from "./connect.ts";
import { fakeProviders } from "./oauth-provider.ts";
import type { Account } from "./oauth-provider.ts";

// The token vault: tokens sealed at rest, opened only with connect's key,
// refreshed one at a time, and gone for good on disconnect. The ways it
// could fail come first: a copy of the database read without the key, a
// ciphertext changed or moved to another connection, a rotated key, two
// refreshes racing (or one racing a disconnect) and storing stale tokens,
// a disconnect that leaves a usable grant behind.

const providers = fakeProviders();
const audit = auditEvents();

/** Another 32-byte key, as a rotation brings. */
const newKey = btoa("a-new-token-key-of-exactly-32-b!");

const tokenRow = async (connectionId: string) =>
  await drizzle(env.DB)
    .select()
    .from(connectionTokens)
    .where(eq(connectionTokens.connectionId, connectionId))
    .get();

const statusOf = async (connectionId: string) => {
  const row = await drizzle(env.DB)
    .select({ status: connections.status })
    .from(connections)
    .where(eq(connections.id, connectionId))
    .get();
  return row?.status;
};

/** Makes the stored access token about to expire, so the next read refreshes. */
const expire = async (connectionId: string): Promise<void> => {
  await drizzle(env.DB)
    .update(connectionTokens)
    .set({ accessExpiresAt: new Date(Date.now() + 1000) })
    .where(eq(connectionTokens.connectionId, connectionId));
};

/** Connects the person's own account at `provider`. */
const connected = async (
  provider: Account["provider"],
  person: ConnectionPerson = someone()
): Promise<string> =>
  await connectAccount(providers, person, ownAccount(person, provider));

const firstAccessToken = (): string =>
  providers.state.issued.find((token) => token.startsWith("access")) ?? "";

/**
 * Stores what a refresh in another isolate would: a new generation with a
 * fresh access token. Returns that token.
 */
const refreshedElsewhere = async (connectionId: string): Promise<string> => {
  const vault = await vaultFor(env);
  const row = await tokenRow(connectionId);
  const theirs = `access-from-elsewhere-${crypto.randomUUID()}`;
  const sealed = await vault?.seal(
    JSON.stringify({ accessToken: theirs, refreshToken: "refresh-elsewhere" }),
    `token:${connectionId}`
  );
  await drizzle(env.DB)
    .update(connectionTokens)
    .set({
      sealed: sealed ?? "",
      accessExpiresAt: new Date(Date.now() + 3_600_000),
      generation: (row?.generation ?? 0) + 1,
      refreshUntil: null,
    })
    .where(eq(connectionTokens.connectionId, connectionId));
  return theirs;
};

/** Waits until connect has sent its refresh to the provider. */
const refreshSent = async (): Promise<void> => {
  while (providers.tokenRequests("refresh_token").length === 0) {
    // oxlint-disable-next-line no-await-in-loop -- polls the fake provider
    await scheduler.wait(5);
  }
};

describe("sealed tokens", () => {
  it("open with connect's key and no other", async () => {
    const connectionId = await connected("microsoft");
    await expect(accessTokenFor(env, connectionId)).resolves.toBe(
      firstAccessToken()
    );
    await expect(
      accessTokenFor({ ...env, TOKEN_ENCRYPTION_KEY: newKey }, connectionId)
    ).rejects.toThrow(VaultError);
  });

  it("don't open once changed, and the provider isn't asked", async () => {
    const connectionId = await connected("microsoft");
    const row = await tokenRow(connectionId);
    const sealed = row?.sealed ?? "";
    const flipped = `${sealed.slice(0, -2)}${sealed.endsWith("AA") ? "BB" : "AA"}`;
    await drizzle(env.DB)
      .update(connectionTokens)
      .set({ sealed: flipped })
      .where(eq(connectionTokens.connectionId, connectionId));
    await expect(accessTokenFor(env, connectionId)).rejects.toThrow(VaultError);
    expect(providers.tokenRequests("refresh_token")).toStrictEqual([]);
  });

  it("don't open when moved to another connection", async () => {
    const annas = await connected("microsoft");
    const bobs = await connected("microsoft");
    const annasRow = await tokenRow(annas);
    await drizzle(env.DB)
      .update(connectionTokens)
      .set({ sealed: annasRow?.sealed ?? "" })
      .where(eq(connectionTokens.connectionId, bobs));
    await expect(accessTokenFor(env, bobs)).rejects.toThrow(VaultError);
  });

  it("survive a key rotation: opened with the previous key, then sealed again with the new one", async () => {
    const connectionId = await connected("microsoft");
    const rotating = {
      ...env,
      TOKEN_ENCRYPTION_KEY: newKey,
      TOKEN_ENCRYPTION_KEY_PREVIOUS: env.TOKEN_ENCRYPTION_KEY,
    };
    const rotated = { ...env, TOKEN_ENCRYPTION_KEY: newKey };
    await expect(accessTokenFor(rotating, connectionId)).resolves.toBe(
      firstAccessToken()
    );
    await expect(accessTokenFor(rotated, connectionId)).rejects.toThrow(
      VaultError
    );
    // The cron trigger seals them again; then the previous key can go.
    await resealTokens(rotating);
    const newVault = await vaultFor(rotated);
    const resealed = await tokenRow(connectionId);
    expect(resealed?.sealed.split(".")[1]).toBe(newVault?.keyId);
    await expect(accessTokenFor(rotated, connectionId)).resolves.toBe(
      firstAccessToken()
    );
  });

  it("let a flow started before a key rotation finish after it", async () => {
    const person = someone();
    const url = await startAs(person);
    const code = providers.authorize(url.href, ownAccount(person));
    const rotating = {
      ...env,
      TOKEN_ENCRYPTION_KEY: newKey,
      TOKEN_ENCRYPTION_KEY_PREVIOUS: env.TOKEN_ENCRYPTION_KEY,
    };
    await resealFlows(rotating);
    const rotated = { ...env, TOKEN_ENCRYPTION_KEY: newKey };
    await expect(
      outcome(finishConnection(rotated, { person, state: stateOf(url), code }))
    ).resolves.toBe("ok");
  });

  it("need a key of 32 bytes: anything else seals nothing", async () => {
    const keys = ["", "short", btoa("31-bytes-is-one-byte-too-short!")];
    const vaults = await Promise.all(
      keys.map(
        async (key) => await vaultFor({ ...env, TOKEN_ENCRYPTION_KEY: key })
      )
    );
    expect(vaults).toStrictEqual([undefined, undefined, undefined]);
  });
});

describe("refreshing", () => {
  it("gets a new access token once the stored one is about to expire, and keeps it", async () => {
    const connectionId = await connected("microsoft");
    await expire(connectionId);
    const refreshed = await accessTokenFor(env, connectionId);
    expect(refreshed).not.toBe(firstAccessToken());
    await expect(accessTokenFor(env, connectionId)).resolves.toBe(refreshed);
    expect(providers.tokenRequests("refresh_token")).toHaveLength(1);
    await expect(tokenRow(connectionId)).resolves.toMatchObject({
      generation: 2,
      refreshUntil: null,
    });
  });

  it("keeps a rotated refresh token, or the old one when the provider doesn't rotate", async () => {
    const connectionId = await connected("microsoft");
    const firstRefreshToken = providers.state.issued.find((token) =>
      token.startsWith("refresh")
    );
    await expire(connectionId);
    await accessTokenFor(env, connectionId);
    const rotatedRefreshToken = providers.state.issued.at(-1);
    providers.state.rotate = false;
    await expire(connectionId);
    await accessTokenFor(env, connectionId);
    await expire(connectionId);
    await accessTokenFor(env, connectionId);
    expect(
      providers
        .tokenRequests("refresh_token")
        .map(({ form }) => form.get("refresh_token"))
    ).toStrictEqual([
      firstRefreshToken,
      rotatedRefreshToken,
      rotatedRefreshToken,
    ]);
  });

  it("happens once for calls that need it at the same time", async () => {
    const connectionId = await connected("microsoft");
    await expire(connectionId);
    const tokens = await Promise.all(
      Array.from(
        { length: 5 },
        async () => await accessTokenFor(env, connectionId)
      )
    );
    expect(new Set(tokens).size).toBe(1);
    expect(providers.tokenRequests("refresh_token")).toHaveLength(1);
  });

  it("waits for a refresh under way elsewhere instead of starting another", async () => {
    const connectionId = await connected("microsoft");
    await expire(connectionId);
    // Another isolate holds the lease, and stores its result shortly.
    await drizzle(env.DB)
      .update(connectionTokens)
      .set({ refreshUntil: new Date(Date.now() + 10_000) })
      .where(eq(connectionTokens.connectionId, connectionId));
    const waiting = accessTokenFor(env, connectionId);
    await scheduler.wait(250);
    const theirs = await refreshedElsewhere(connectionId);
    await expect(waiting).resolves.toBe(theirs);
    expect(providers.tokenRequests("refresh_token")).toStrictEqual([]);
  });

  it("takes over a lease whose holder is gone", async () => {
    const connectionId = await connected("microsoft");
    await expire(connectionId);
    await drizzle(env.DB)
      .update(connectionTokens)
      .set({ refreshUntil: new Date(Date.now() - 1) })
      .where(eq(connectionTokens.connectionId, connectionId));
    await expect(accessTokenFor(env, connectionId)).resolves.not.toBe(
      firstAccessToken()
    );
    expect(providers.tokenRequests("refresh_token")).toHaveLength(1);
  });

  it("that finishes after a disconnect stores nothing, and its tokens are revoked", async () => {
    const person = someone();
    const connectionId = await connected("google", person);
    await expire(connectionId);
    const provider = Promise.withResolvers<Response>();
    providers.state.refresh = async () => await provider.promise;
    const refreshing = outcome(accessTokenFor(env, connectionId));
    await refreshSent();
    await exports.default.disconnect({ person, connectionId });
    provider.resolve(new Response(null, { status: 200 }));
    await expect(refreshing).resolves.toBe("connect.connection_inactive");
    await expect(tokenRow(connectionId)).resolves.toBeUndefined();
    // The disconnect revoked the stored grant; the refresh's new one too.
    const minted = providers.state.issued.at(-1);
    expect(
      providers.revocations().map(({ form }) => form.get("token"))
    ).toContain(minted);
  });

  it("that loses to one elsewhere (its lease lapsed) gives the stored token, and revokes nothing", async () => {
    const person = someone();
    const connectionId = await connected("google", person);
    await expire(connectionId);
    const provider = Promise.withResolvers<Response>();
    providers.state.refresh = async () => await provider.promise;
    const refreshing = accessTokenFor(env, connectionId);
    await refreshSent();
    const theirs = await refreshedElsewhere(connectionId);
    provider.resolve(new Response(null, { status: 200 }));
    await expect(refreshing).resolves.toBe(theirs);
    // Revoking what it got would revoke the grant the winner's tokens are
    // from: Google revokes a grant as a whole.
    expect(providers.revocations()).toStrictEqual([]);
    expect(providers.grantHolds(ownAccount(person, "google"))).toBeTruthy();
  });

  it("that hears the grant is gone after one elsewhere replaced it leaves the connection be", async () => {
    const connectionId = await connected("microsoft");
    await expire(connectionId);
    const provider = Promise.withResolvers<Response>();
    providers.state.refresh = async () => await provider.promise;
    const refreshing = accessTokenFor(env, connectionId);
    await refreshSent();
    const theirs = await refreshedElsewhere(connectionId);
    provider.resolve(providers.oauthError("invalid_grant"));
    await expect(refreshing).resolves.toBe(theirs);
    await expect(statusOf(connectionId)).resolves.toBe("active");
    const audited = await audit.events();
    expect(
      audited.filter(({ action }) => action === "connection.needs_reauth")
    ).toStrictEqual([]);
  });

  it("marks the connection for reconnecting once the grant is gone, and records it", async () => {
    const person = someone();
    const connectionId = await connected("microsoft", person);
    await expire(connectionId);
    providers.state.refresh = () => providers.oauthError("invalid_grant");
    await expect(outcome(accessTokenFor(env, connectionId))).resolves.toBe(
      "connect.connection_inactive"
    );
    await expect(statusOf(connectionId)).resolves.toBe("needs_reauth");
    await expect(tokenRow(connectionId)).resolves.toBeUndefined();
    const audited = await audit.events();
    expect(audited.at(-1)).toMatchObject({
      actor: { type: "system" },
      action: "connection.needs_reauth",
      target: { id: connectionId },
    });
    await expect(
      outcome(
        callAs(agentFor(person.userId), {
          connectionId,
          action: "mail.list",
          input: {},
        })
      )
    ).resolves.toBe("connect.connection_inactive");
  });

  it("keeps the grant when the provider is down or busy", async () => {
    const connectionId = await connected("microsoft");
    await expire(connectionId);
    const failures = [
      () => providers.oauthError("server_error", 503),
      () => providers.oauthError("invalid_grant", 500),
      () => providers.oauthError("temporarily_unavailable", 429),
      () => new Response("<html>WAF</html>", { status: 403 }),
    ];
    const outcomes: string[] = [];
    for (const failure of failures) {
      providers.state.refresh = failure;
      // oxlint-disable-next-line no-await-in-loop -- one failure after another
      outcomes.push(await outcome(accessTokenFor(env, connectionId)));
    }
    expect(outcomes).toStrictEqual(
      failures.map(() => "connection.refresh_failed")
    );
    await expect(statusOf(connectionId)).resolves.toBe("active");
    // The lease was let go: the next call refreshes.
    providers.state.refresh = undefined;
    await expect(accessTokenFor(env, connectionId)).resolves.not.toBe(
      firstAccessToken()
    );
  });
});

describe("disconnecting", () => {
  it("revokes the grant at Google, deletes the tokens and records it", async () => {
    const person = someone();
    const connectionId = await connected("google", person);
    const refreshToken = providers.state.issued.find((token) =>
      token.startsWith("refresh")
    );
    await expect(
      exports.default.disconnect({ person, connectionId })
    ).resolves.toStrictEqual({ revoked: true });
    expect(
      providers.revocations().map(({ form }) => form.get("token"))
    ).toStrictEqual([refreshToken]);
    await expect(tokenRow(connectionId)).resolves.toBeUndefined();
    const audited = await audit.events();
    expect(audited.at(-1)).toMatchObject({
      actor: { type: "person", userId: person.userId },
      action: "connection.disconnect",
      target: { type: "connection", id: connectionId },
      detail: { outcome: "ok", revoked: true },
    });
    await expect(
      outcome(
        callAs(agentFor(person.userId), {
          connectionId,
          action: "mail.list",
          input: {},
        })
      )
    ).resolves.toBe("connect.connection_inactive");
  });

  it("deletes the tokens where the provider can't revoke them, or is down", async () => {
    const person = someone();
    const microsoft = await connected("microsoft", person);
    const google = await connected("google", person);
    providers.state.revoke = () => providers.oauthError("server_error", 503);
    const results = await Promise.all(
      [microsoft, google].map(
        async (connectionId) =>
          await exports.default.disconnect({ person, connectionId })
      )
    );
    expect(results).toStrictEqual([{ revoked: false }, { revoked: false }]);
    await expect(
      Promise.all([tokenRow(microsoft), tokenRow(google)])
    ).resolves.toStrictEqual([undefined, undefined]);
    await expect(
      Promise.all([statusOf(microsoft), statusOf(google)])
    ).resolves.toStrictEqual(["disconnected", "disconnected"]);
  });

  it("of a personal connection is for its owner only, and of a shared one for admins only", async () => {
    const anna = someone();
    const admin = someone("admin");
    const annas = await connected("microsoft", anna);
    const shared = await connectAccount(providers, admin, mailboxAccount(), {
      scope: "shared",
    });
    const refused = await Promise.all([
      outcome(
        exports.default.disconnect({ person: someone(), connectionId: annas })
      ),
      outcome(
        exports.default.disconnect({ person: admin, connectionId: annas })
      ),
      outcome(
        exports.default.disconnect({ person: anna, connectionId: shared })
      ),
    ]);
    expect(refused).toStrictEqual([
      "connect.not_owner",
      "connect.not_owner",
      "role.forbidden",
    ]);
    await expect(
      Promise.all([statusOf(annas), statusOf(shared)])
    ).resolves.toStrictEqual(["active", "active"]);
    await expect(
      exports.default.disconnect({ person: admin, connectionId: shared })
    ).resolves.toStrictEqual({ revoked: false });
    const audited = await audit.events();
    expect(
      audited
        .filter(({ action }) => action === "connection.disconnect")
        .map(({ detail }) => detail.outcome)
    ).toStrictEqual(["refused", "refused", "refused", "ok"]);
  });
});

describe("the cron trigger", () => {
  it("drops flows nobody finished in time", async () => {
    const person = someone();
    await startAs(person);
    await drizzle(env.DB)
      .update(oauthFlows)
      .set({ expiresAt: new Date(Date.now() - 1) })
      .where(eq(oauthFlows.userId, person.userId));
    await exports.default.scheduled();
    await expect(
      drizzle(env.DB)
        .select()
        .from(oauthFlows)
        .where(eq(oauthFlows.userId, person.userId))
    ).resolves.toStrictEqual([]);
  });
});

describe("when something breaks", () => {
  it("a token that doesn't open doesn't hold up resealing the rest", async () => {
    const broken = await connected("microsoft");
    const fine = await connected("microsoft");
    const row = await tokenRow(broken);
    const sealed = row?.sealed ?? "";
    await drizzle(env.DB)
      .update(connectionTokens)
      .set({
        sealed: `${sealed.slice(0, -2)}${sealed.endsWith("AA") ? "BB" : "AA"}`,
      })
      .where(eq(connectionTokens.connectionId, broken));
    const rotating = {
      ...env,
      TOKEN_ENCRYPTION_KEY: newKey,
      TOKEN_ENCRYPTION_KEY_PREVIOUS: env.TOKEN_ENCRYPTION_KEY,
    };
    await resealTokens(rotating);
    // It can never be used: its connection is marked for reconnecting.
    await expect(
      Promise.all([statusOf(broken), tokenRow(broken)])
    ).resolves.toStrictEqual(["needs_reauth", undefined]);
    const newVault = await vaultFor(rotating);
    const resealed = await tokenRow(fine);
    expect(resealed?.sealed.split(".")[1]).toBe(newVault?.keyId);
  });

  it("a refresh lets its lease go whatever fails", async () => {
    const connectionId = await connected("microsoft");
    await expire(connectionId);
    const row = await tokenRow(connectionId);
    const sealed = row?.sealed ?? "";
    await drizzle(env.DB)
      .update(connectionTokens)
      .set({
        sealed: `${sealed.slice(0, -2)}${sealed.endsWith("AA") ? "BB" : "AA"}`,
      })
      .where(eq(connectionTokens.connectionId, connectionId));
    await expect(accessTokenFor(env, connectionId)).rejects.toThrow(VaultError);
    await expect(tokenRow(connectionId)).resolves.toMatchObject({
      refreshUntil: null,
    });
  });

  it("two disconnects at once are recorded once", async () => {
    const person = someone();
    const connectionId = await connected("microsoft", person);
    await Promise.all([
      exports.default.disconnect({ person, connectionId }),
      exports.default.disconnect({ person, connectionId }),
    ]);
    const audited = await audit.events();
    expect(
      audited.filter(
        ({ action, detail }) =>
          action === "connection.disconnect" && detail.outcome === "ok"
      )
    ).toHaveLength(1);
  });
});
