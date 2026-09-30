import {
  connectionCallbackPath,
  connectionOwnersMax,
} from "@grasp-os/shared/connect";
import type { ConnectionPerson } from "@grasp-os/shared/connect";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { env, exports } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it, vi } from "vite-plus/test";

import { connections, connectionTokens, oauthFlows } from "../src/db/schema.ts";
import { disconnect, finishConnection, startConnection } from "../src/oauth.ts";
import { accessTokenFor } from "../src/tokens.ts";
import {
  auditEvents,
  clientOrigin,
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
import {
  acmeDomain,
  acmeTenant,
  clients,
  otherTenant,
} from "./provider-config.ts";
import { racingDb } from "./racing-db.ts";

// Connecting an account through OAuth. The ways it could go wrong come
// first: a flow finished by someone other than who started it (the login
// swap: an attacker's account attached to a victim, or the victim's to the
// attacker), a state tampered with or replayed, a code without its PKCE
// verifier, an account from outside the organization, a person who isn't
// an admin connecting what the organization shares. And for a connection
// whose access ran out, which connecting its account again brings back
// with its ID and permissions: anyone but its owner (or, if shared, an
// admin) doing so, another account taking its place, a disconnected one
// or a removed person's coming back, a state replayed or past its time,
// two reconnects, or a reconnect and a disconnect or an offboarding, at
// once, in either order, and a grant left behind that nobody holds.

const providers = fakeProviders();
const audit = auditEvents();

/** The person's own connections, leaving out the shared ones of other tests. */
const ownConnections = async (person: ConnectionPerson) => {
  const listed = await exports.default.listConnections(person);
  return listed.filter(({ ownerUserId }) => ownerUserId === person.userId);
};

const finish = async (
  person: ConnectionPerson,
  state: string,
  code?: string,
  error?: string
) =>
  await outcome(
    exports.default.finishConnection({ person, state, code, error })
  );

const base64Url43 = /^[\w-]{43}$/u;

describe("starting a connection", () => {
  it("sends the person to the organization's tenant with PKCE (S256) and a fresh state", async () => {
    const anna = someone();
    const first = await startAs(anna);
    const second = await startAs(anna);
    const params = Object.fromEntries(first.searchParams);
    expect({
      endpoint: first.origin + first.pathname,
      ...params,
    }).toMatchObject({
      endpoint: `https://login.microsoftonline.com/${acmeTenant}/oauth2/v2.0/authorize`,
      response_type: "code",
      client_id: clients.microsoft.id,
      redirect_uri: `${clientOrigin}${connectionCallbackPath}`,
      code_challenge_method: "S256",
    });
    // 256 random bits each; the verifier stays in connect.
    expect(`${params.state} ${params.code_challenge}`).toMatch(
      /^[\w-]{43} [\w-]{43}$/u
    );
    expect(stateOf(first)).not.toBe(stateOf(second));
    expect(params.scope?.split(" ")).toContain("offline_access");
    expect(Object.keys(params)).not.toContain("code_verifier");
  });

  it("keeps neither the state nor the verifier in the clear", async () => {
    const url = await startAs(someone());
    const [flow] = await drizzle(env.DB)
      .select()
      .from(oauthFlows)
      .where(eq(oauthFlows.stateHash, await sha256Hex(stateOf(url))));
    expect(flow?.verifier).toMatch(/^v1\./u);
    expect(JSON.stringify(flow)).not.toContain(stateOf(url));
  });

  it("asks Google for the organization's Workspace, with offline access", async () => {
    const url = await startAs(someone(), { provider: "google" });
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      hd: acmeDomain,
      access_type: "offline",
      prompt: "consent",
      client_id: clients.google.id,
    });
  });

  it("of a shared connection is refused to anyone but an admin", async () => {
    const anna = someone();
    const refused = await Promise.all(
      [anna, someone("builder")].map(
        async (person) => await outcome(startAs(person, { scope: "shared" }))
      )
    );
    expect(refused).toStrictEqual(["role.forbidden", "role.forbidden"]);
    await expect(
      outcome(startAs(someone("admin"), { scope: "shared" }))
    ).resolves.toBe("ok");
    const audited = await audit.events();
    expect(
      audited.find(
        ({ actor }) => actor.type === "person" && actor.userId === anna.userId
      )
    ).toMatchObject({
      actor: { type: "person", userId: anna.userId },
      action: "connection.connect",
      detail: { outcome: "refused", reason: "role.forbidden" },
    });
  });

  it("is refused while the provider's app or the token key isn't set up", async () => {
    const request = {
      person: someone(),
      provider: "google",
      scope: "personal",
      origin: clientOrigin,
      tenant: acmeDomain,
      returnTo: "/",
    };
    const unset = [
      { ...env, GOOGLE_CLIENT_SECRET: undefined },
      { ...env, GOOGLE_CLIENT_ID: "" },
      { ...env, TOKEN_ENCRYPTION_KEY: undefined },
      { ...env, TOKEN_ENCRYPTION_KEY: "too-short" },
    ];
    const refused = await Promise.all(
      unset.map(
        async (without) => await outcome(startConnection(without, request))
      )
    );
    expect(refused).toStrictEqual(
      unset.map(() => "connection.provider_unavailable")
    );
  });

  it("is refused for anything but a tenant of the provider's kind", async () => {
    const tenants = ["acme.test/../evil", "not-a-tenant", "evil.test#"];
    const refused = await Promise.all(
      tenants.map(
        async (tenant) => await outcome(startAs(someone(), { tenant }))
      )
    );
    expect(refused).toStrictEqual(
      tenants.map(() => "connection.provider_unavailable")
    );
  });
});

describe("finishing a connection", () => {
  it("connects the person's account, with its tokens sealed", async () => {
    const anna = someone();
    const connectionId = await connectAccount(
      providers,
      anna,
      ownAccount(anna)
    );
    await expect(ownConnections(anna)).resolves.toMatchObject([
      {
        id: connectionId,
        provider: "microsoft",
        scope: "personal",
        status: "active",
        connectedBy: anna.userId,
        accountName: anna.email,
      },
    ]);
    // The exchange carried the verifier and the same redirect URI.
    const [exchange] = providers.tokenRequests("authorization_code");
    expect(exchange?.form.get("code_verifier")).toMatch(base64Url43);
    expect(exchange?.form.get("redirect_uri")).toBe(
      `${clientOrigin}${connectionCallbackPath}`
    );
    // Nothing connect stored holds a token in the clear.
    const stored = JSON.stringify(
      await drizzle(env.DB)
        .select()
        .from(connectionTokens)
        .where(eq(connectionTokens.connectionId, connectionId))
    );
    expect(stored).toContain('"sealed":"v1.');
    expect(
      providers.state.issued.filter((token) => stored.includes(token))
    ).toStrictEqual([]);
  });

  it("is recorded in the audit log, with IDs only", async () => {
    const anna = someone();
    const connectionId = await connectAccount(
      providers,
      anna,
      ownAccount(anna)
    );
    const audited = await audit.events();
    expect(audited).toMatchObject([
      {
        actor: { type: "person", userId: anna.userId },
        action: "connection.connect",
        target: { type: "connection", id: connectionId },
        detail: { provider: "microsoft", scope: "personal", outcome: "ok" },
      },
    ]);
    expect(JSON.stringify(audited)).not.toContain(anna.email);
  });

  it("is refused to anyone but the person who started it, and spends the flow (login swap)", async () => {
    const anna = someone();
    const bob = someone();
    // Bob starts a flow and gets Anna to finish it with her account: her
    // session isn't his, so nothing is exchanged and nothing is attached.
    const bobsFlow = await startAs(bob);
    const annasCode = providers.authorize(bobsFlow.href, ownAccount(anna));
    // And the other way: Bob consents with his own account and gets Anna
    // to open the callback URL; it lands with her session on his state.
    const bobsOther = await startAs(bob);
    const bobsCode = providers.authorize(bobsOther.href, ownAccount(bob));
    const results = [
      await finish(anna, stateOf(bobsFlow), annasCode),
      await finish(anna, stateOf(bobsOther), bobsCode),
      // Both flows are spent: not even Bob finishes them now.
      await finish(bob, stateOf(bobsOther), bobsCode),
    ];
    expect(results).toStrictEqual(results.map(() => "connection.flow_invalid"));
    expect(providers.tokenRequests("authorization_code")).toStrictEqual([]);
    await expect(ownConnections(anna)).resolves.toStrictEqual([]);
    const audited = await audit.events();
    expect(audited.map(({ actor, detail }) => [actor, detail])).toMatchObject(
      [anna, anna, bob].map(({ userId }) => [
        { userId },
        { outcome: "refused", reason: "connection.flow_invalid" },
      ])
    );
  });

  it("is refused with a state that was tampered with, and exchanges nothing", async () => {
    const anna = someone();
    const url = await startAs(anna);
    const code = providers.authorize(url.href, ownAccount(anna));
    const state = stateOf(url);
    const tampered = [
      `${state.slice(0, -1)}${state.endsWith("A") ? "B" : "A"}`,
      state.toUpperCase(),
      `${state}x`,
      "",
    ];
    const refused = await Promise.all(
      tampered.map(async (other) => await finish(anna, other, code))
    );
    expect(refused).toStrictEqual([
      "connection.flow_invalid",
      "connection.flow_invalid",
      "connection.flow_invalid",
      "connection.invalid",
    ]);
    expect(providers.tokenRequests("authorization_code")).toStrictEqual([]);
    // The real state still works.
    await expect(finish(anna, state, code)).resolves.toBe("ok");
  });

  it("takes a state once: a replayed callback is refused", async () => {
    const anna = someone();
    const url = await startAs(anna);
    const code = providers.authorize(url.href, ownAccount(anna));
    const results = await Promise.all([
      finish(anna, stateOf(url), code),
      finish(anna, stateOf(url), code),
    ]);
    expect(results.toSorted()).toStrictEqual(["connection.flow_invalid", "ok"]);
    await expect(finish(anna, stateOf(url), code)).resolves.toBe(
      "connection.flow_invalid"
    );
    expect(providers.tokenRequests("authorization_code")).toHaveLength(1);
    await expect(ownConnections(anna)).resolves.toHaveLength(1);
  });

  it("is refused once the flow has expired", async () => {
    const anna = someone();
    const url = await startAs(anna);
    const code = providers.authorize(url.href, ownAccount(anna));
    await drizzle(env.DB)
      .update(oauthFlows)
      .set({ expiresAt: new Date(Date.now() - 1) })
      .where(eq(oauthFlows.userId, anna.userId));
    await expect(finish(anna, stateOf(url), code)).resolves.toBe(
      "connection.flow_invalid"
    );
    expect(providers.tokenRequests("authorization_code")).toStrictEqual([]);
  });

  it("gets nothing for a code whose PKCE challenge isn't the flow's", async () => {
    // A code issued for another authorization (another challenge) doesn't
    // redeem with this flow's verifier: the provider refuses it.
    const anna = someone();
    const url = await startAs(anna);
    const other = new URL(url);
    other.searchParams.set("code_challenge", "A".repeat(43));
    const code = providers.authorize(other.href, ownAccount(anna));
    await expect(finish(anna, stateOf(url), code)).resolves.toBe(
      "connection.provider_refused"
    );
    await expect(ownConnections(anna)).resolves.toStrictEqual([]);
  });

  it("refuses an account outside the organization, and revokes what was minted", async () => {
    const anna = someone();
    const outsiders: Account[] = [
      { ...ownAccount(anna), tenant: otherTenant },
      { ...ownAccount(anna), audience: "someone-elses-app" },
      // A B2B guest in the tenant, homed elsewhere.
      {
        ...ownAccount(anna),
        guestFrom: `https://sts.windows.net/${otherTenant}/`,
      },
      {
        provider: "google",
        tenant: "evil.test",
        subject: "g-1",
        email: "x@evil.test",
      },
      { provider: "google", subject: "g-2", email: "someone@gmail.test" },
      {
        provider: "google",
        tenant: acmeDomain,
        subject: "g-3",
        email: anna.email,
        emailVerified: false,
      },
    ];
    const refused = await Promise.all(
      outsiders.map(
        async (account) =>
          await outcome(connectAccount(providers, anna, account))
      )
    );
    expect(refused).toStrictEqual(
      outsiders.map(() => "connection.wrong_account")
    );
    await expect(ownConnections(anna)).resolves.toStrictEqual([]);
    // Google's three grants were revoked; Entra has no revocation endpoint.
    expect(providers.revocations()).toHaveLength(3);
    expect(providers.state.grants.size).toBe(3);
  });

  it("of a shared connection is refused to someone no longer an admin", async () => {
    const ada = someone("admin");
    const url = await startAs(ada, { scope: "shared" });
    const code = providers.authorize(url.href, mailboxAccount());
    await expect(
      finish({ ...ada, role: "builder" }, stateOf(url), code)
    ).resolves.toBe("role.forbidden");
    expect(providers.tokenRequests("authorization_code")).toStrictEqual([]);
  });

  it("stores a shared connection with no owner, for everyone to see", async () => {
    const ada = someone("admin");
    const connectionId = await connectAccount(
      providers,
      ada,
      mailboxAccount(),
      {
        scope: "shared",
      }
    );
    const listed = await exports.default.listConnections(someone());
    expect(listed.find(({ id }) => id === connectionId)).toMatchObject({
      scope: "shared",
      ownerUserId: null,
      connectedBy: ada.userId,
    });
  });

  it("spends the flow when the person declines at the provider", async () => {
    const anna = someone();
    const url = await startAs(anna);
    await expect(
      finish(anna, stateOf(url), undefined, "access_denied")
    ).resolves.toBe("connection.provider_refused");
    await expect(finish(anna, stateOf(url), "late-code")).resolves.toBe(
      "connection.flow_invalid"
    );
  });

  it("returns the browser to where the flow began", async () => {
    const anna = someone();
    const url = await startAs(anna, { returnTo: "/chat/42?tab=files" });
    const code = providers.authorize(url.href, ownAccount(anna));
    const finished = await exports.default.finishConnection({
      person: anna,
      state: stateOf(url),
      code,
    });
    expect(finished.returnTo).toBe("/chat/42?tab=files");
  });
});

describe("tokens", () => {
  it("never leave connect: no answer and no log line carries one", async () => {
    const lines: string[] = [];
    for (const method of ["info", "warn", "error", "log"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        lines.push(JSON.stringify(args));
      });
    }
    const anna = someone();
    const url = await startAs(anna, { provider: "google" });
    const code = providers.authorize(url.href, ownAccount(anna, "google"));
    const finished = await exports.default.finishConnection({
      person: anna,
      state: stateOf(url),
      code,
    });
    // Failures too: a replayed code, a revocation the provider fails.
    const replayed = await finish(anna, stateOf(url), code);
    providers.state.revoke = () => providers.oauthError("server_error", 503);
    const listed = await ownConnections(anna);
    const disconnected = await exports.default.disconnect({
      person: anna,
      connectionId: finished.connectionId,
    });
    const audited = await audit.events();
    const seen = JSON.stringify([
      url.href,
      finished,
      replayed,
      listed,
      disconnected,
      lines,
      audited,
    ]);
    expect(
      [...providers.state.issued, code].filter((secret) =>
        seen.includes(secret)
      )
    ).toStrictEqual([]);
  });
});

describe("whose account", () => {
  it("tells core whose each connection is, disconnected ones too", async () => {
    const anna = someone();
    const ada = someone("admin");
    const personal = await connectAccount(providers, anna, ownAccount(anna));
    const shared = await connectAccount(providers, ada, mailboxAccount(), {
      scope: "shared",
    });
    await exports.default.disconnect({ person: anna, connectionId: personal });

    const owners = await exports.default.connectionOwners([
      personal,
      shared,
      "connection-unknown",
    ]);
    expect(owners.toSorted((a, b) => a.id.localeCompare(b.id))).toStrictEqual(
      [
        { id: personal, ownerUserId: anna.userId },
        { id: shared, ownerUserId: null },
      ].toSorted((a, b) => a.id.localeCompare(b.id))
    );
    await expect(
      Promise.all([
        exports.default.connectionOwners([]),
        outcome(
          exports.default.connectionOwners(
            Array.from({ length: connectionOwnersMax + 1 }, () => personal)
          )
        ),
      ])
    ).resolves.toStrictEqual([[], "connect.invalid"]);
  });

  it("a personal connection must be to the person's own account", async () => {
    const anna = someone();
    const colleague = someone();
    // Anna signs in with Entra: only that account is hers at Microsoft,
    // whatever another one's address says.
    const notHers: Account[] = [
      ownAccount(colleague),
      mailboxAccount(),
      { ...mailboxAccount(), email: anna.email },
      // At Google, where she doesn't sign in, her address decides.
      ownAccount(colleague, "google"),
    ];
    const refused = await Promise.all(
      notHers.map(
        async (account) =>
          await outcome(connectAccount(providers, anna, account))
      )
    );
    expect(refused).toStrictEqual(
      notHers.map(() => "connection.not_own_account")
    );
    await expect(
      Promise.all([
        outcome(connectAccount(providers, anna, ownAccount(anna))),
        outcome(connectAccount(providers, anna, ownAccount(anna, "google"))),
      ])
    ).resolves.toStrictEqual(["ok", "ok"]);
  });

  it("already connected can't be connected again, and keeps its grant", async () => {
    const anna = someone();
    const account = ownAccount(anna, "google");
    await connectAccount(providers, anna, account);
    const again = await Promise.all([
      outcome(connectAccount(providers, anna, account)),
      outcome(
        connectAccount(providers, someone("admin"), account, {
          scope: "shared",
        })
      ),
    ]);
    expect(again).toStrictEqual([
      "connection.already_connected",
      "connection.already_connected",
    ]);
    // Revoking the new tokens would have revoked the first connection's
    // grant too: Google revokes a grant as a whole.
    expect(providers.revocations()).toStrictEqual([]);
    expect(providers.grantHolds(account)).toBeTruthy();
    await expect(ownConnections(anna)).resolves.toHaveLength(1);
  });

  it("refused for another reason, doesn't revoke the grant a connection already holds", async () => {
    const anna = someone();
    const account = ownAccount(anna, "google");
    await connectAccount(providers, anna, account);
    // The same account again, with an ID token that fails the checks.
    const refused = await Promise.all(
      [
        { ...account, emailVerified: false },
        { ...account, audience: "someone-elses-app" },
      ].map(
        async (again) => await outcome(connectAccount(providers, anna, again))
      )
    );
    expect(refused).toStrictEqual([
      "connection.wrong_account",
      "connection.wrong_account",
    ]);
    expect(providers.revocations()).toStrictEqual([]);
    expect(providers.grantHolds(account)).toBeTruthy();
  });

  it("is never Grasp staff's to connect", async () => {
    const staff: ConnectionPerson = { ...someone("admin"), staff: true };
    const started = await Promise.all(
      (["personal", "shared"] as const).map(
        async (scope) => await outcome(startAs(staff, { scope }))
      )
    );
    expect(started).toStrictEqual([
      "connection.staff_not_allowed",
      "connection.staff_not_allowed",
    ]);
    // Nor finish a flow a person started, in a session that became staff's.
    const anna = someone();
    const url = await startAs(anna);
    const code = providers.authorize(url.href, ownAccount(anna));
    await expect(
      finish({ ...anna, staff: true }, stateOf(url), code)
    ).resolves.toBe("connection.staff_not_allowed");
    expect(providers.tokenRequests("authorization_code")).toStrictEqual([]);
  });
});

/** The connection's status and whether it has tokens, as stored. */
const stored = async (connectionId: string) => {
  const db = drizzle(env.DB);
  const connection = await db
    .select({ status: connections.status })
    .from(connections)
    .where(eq(connections.id, connectionId))
    .get();
  const tokens = await db
    .select()
    .from(connectionTokens)
    .where(eq(connectionTokens.connectionId, connectionId));
  return { status: connection?.status, tokens: tokens.length };
};

/** What a connection whose access ran out is left as. */
const ranOut = { status: "needs_reauth", tokens: 0 };

/**
 * Connects `account` and lets its access run out, the way it does: the
 * provider refuses the next refresh for good. The connection's ID.
 */
const connectedThenRanOut = async (
  person: ConnectionPerson,
  account: Account,
  scope: "personal" | "shared" = "personal"
): Promise<string> => {
  const connectionId = await connectAccount(providers, person, account, {
    scope,
  });
  await drizzle(env.DB)
    .update(connectionTokens)
    .set({ accessExpiresAt: new Date(0) })
    .where(eq(connectionTokens.connectionId, connectionId));
  providers.state.refresh = () => providers.oauthError("invalid_grant");
  await expect(outcome(accessTokenFor(env, connectionId))).resolves.toBe(
    "connect.connection_inactive"
  );
  providers.state.refresh = undefined;
  return connectionId;
};

/** A flow `person` started and consented to as `account`: what comes back. */
const cameBack = async (
  person: ConnectionPerson,
  account: Account,
  scope: "personal" | "shared" = "personal"
) => {
  const url = await startAs(person, { provider: account.provider, scope });
  return {
    person,
    state: stateOf(url),
    code: providers.authorize(url.href, account),
  };
};

const reconnections = async (connectionId: string) => {
  const audited = await audit.events();
  return audited.filter(
    ({ action, target }) =>
      action === "connection.reconnected" && target?.id === connectionId
  );
};

/** Why each refused attempt the audit log names the connection in was. */
const refusalsNaming = async (connectionId: string) => {
  const audited = await audit.events();
  return audited
    .filter(
      ({ action, target, detail }) =>
        action === "connection.connect" &&
        target?.id === connectionId &&
        detail.outcome === "refused"
    )
    .map(({ detail }) => detail.reason);
};

/** Connect's database, with `race` run once, just before a write lands. */
const racingOnce = (race: () => Promise<unknown>): D1Database => {
  let raced = false;
  return racingDb(async () => {
    if (!raced) {
      raced = true;
      await race();
    }
  });
};

/** The refresh token the provider issued last. */
const lastRefreshToken = (): string | undefined =>
  providers.state.issued.findLast((token) => token.startsWith("refresh"));

const revokedTokens = (): (string | null)[] =>
  providers.revocations().map(({ form }) => form.get("token"));

describe("reconnecting a connection whose access ran out", () => {
  it("gives it new tokens under the same ID, and records who did", async () => {
    const anna = someone();
    const account = ownAccount(anna);
    const connectionId = await connectedThenRanOut(anna, account);
    await expect(connectAccount(providers, anna, account)).resolves.toBe(
      connectionId
    );
    await expect(ownConnections(anna)).resolves.toMatchObject([
      { id: connectionId, status: "active", connectedBy: anna.userId },
    ]);
    // The tokens it uses now are the ones the new flow got.
    const minted = providers.state.issued.findLast((token) =>
      token.startsWith("access")
    );
    await expect(accessTokenFor(env, connectionId)).resolves.toBe(minted);
    const audited = await audit.events();
    expect(audited.at(-1)).toMatchObject({
      actor: { type: "person", userId: anna.userId },
      action: "connection.reconnected",
      target: { type: "connection", id: connectionId },
      detail: { provider: "microsoft", scope: "personal", outcome: "ok" },
    });
    // Not a second connection.
    expect(
      audited.filter(
        ({ action, detail }) =>
          action === "connection.connect" && detail.outcome === "ok"
      )
    ).toHaveLength(1);
  });

  it("is refused to anyone but the owner of a personal one, whatever they sign in to", async () => {
    const anna = someone();
    const bob = someone();
    const account = ownAccount(anna);
    const connectionId = await connectedThenRanOut(anna, account);
    // Anna's own flow, which Bob gets hold of and finishes in his session.
    const annas = await cameBack(anna, account);
    // Core names Anna's account as one Bob signs in with too: his own by
    // that, but the connection is still hers.
    const alsoBob: ConnectionPerson = {
      ...bob,
      accounts: [{ provider: "microsoft", subject: account.subject }],
    };
    const refused = [
      await finish(bob, annas.state, annas.code),
      await outcome(connectAccount(providers, bob, account)),
      await outcome(connectAccount(providers, alsoBob, account)),
      await outcome(
        connectAccount(providers, someone("admin"), account, {
          scope: "shared",
        })
      ),
    ];
    expect(refused).toStrictEqual([
      "connection.flow_invalid",
      "connection.not_own_account",
      "connection.already_connected",
      "connection.already_connected",
    ]);
    await expect(stored(connectionId)).resolves.toStrictEqual(ranOut);
    await expect(reconnections(connectionId)).resolves.toStrictEqual([]);
    // Each attempt that reached her account is recorded against her
    // connection; the flow Bob took never got as far as an account.
    await expect(refusalsNaming(connectionId)).resolves.toStrictEqual([
      "connection.not_own_account",
      "connection.already_connected",
      "connection.already_connected",
    ]);
    // Still Anna's to reconnect.
    await expect(connectAccount(providers, anna, account)).resolves.toBe(
      connectionId
    );
  });

  it("of a shared one is any admin's, and nobody else's", async () => {
    const first = someone("admin");
    const second = someone("admin");
    const user = someone();
    const mailbox = mailboxAccount();
    const connectionId = await connectedThenRanOut(first, mailbox, "shared");
    // Started as an admin, finished once they no longer are.
    const demoted = await cameBack(second, mailbox, "shared");
    const refused = [
      await outcome(startAs(user, { scope: "shared" })),
      await outcome(connectAccount(providers, user, mailbox)),
      await finish({ ...second, role: "user" }, demoted.state, demoted.code),
    ];
    expect(refused).toStrictEqual([
      "role.forbidden",
      "connection.not_own_account",
      "role.forbidden",
    ]);
    await expect(
      Promise.all([stored(connectionId), refusalsNaming(connectionId)])
    ).resolves.toStrictEqual([ranOut, ["connection.not_own_account"]]);
    await expect(
      connectAccount(providers, second, mailbox, { scope: "shared" })
    ).resolves.toBe(connectionId);
    const listed = await exports.default.listConnections(user);
    expect(listed.find(({ id }) => id === connectionId)).toMatchObject({
      status: "active",
      scope: "shared",
      // Who connected it first; the audit log says who reconnected it.
      connectedBy: first.userId,
    });
    await expect(reconnections(connectionId)).resolves.toMatchObject([
      { actor: { type: "person", userId: second.userId } },
    ]);
  });

  it("only in the scope it has: a personal one isn't made shared, nor a shared one personal", async () => {
    const anna = someone("admin");
    const bea = someone("admin");
    const personal = await connectedThenRanOut(anna, ownAccount(anna));
    const shared = await connectedThenRanOut(bea, ownAccount(bea), "shared");
    const refused = [
      await outcome(
        connectAccount(providers, anna, ownAccount(anna), { scope: "shared" })
      ),
      await outcome(connectAccount(providers, bea, ownAccount(bea))),
    ];
    expect(refused).toStrictEqual([
      "connection.already_connected",
      "connection.already_connected",
    ]);
    await expect(
      Promise.all([stored(personal), stored(shared)])
    ).resolves.toStrictEqual([ranOut, ranOut]);
  });

  it("with another account leaves it as it was: that account is refused, or connected as its own", async () => {
    const anna = someone();
    const admin = someone("admin");
    const personal = await connectedThenRanOut(anna, ownAccount(anna));
    const mailbox = mailboxAccount();
    const shared = await connectedThenRanOut(admin, mailbox, "shared");
    // Anna signs in to an account that isn't hers.
    await expect(
      outcome(connectAccount(providers, anna, mailboxAccount()))
    ).resolves.toBe("connection.not_own_account");
    // The admin signs in to another mailbox: a connection of its own.
    const other = await connectAccount(providers, admin, mailboxAccount(), {
      scope: "shared",
    });
    expect(other).not.toBe(shared);
    await expect(
      Promise.all([stored(personal), stored(shared)])
    ).resolves.toStrictEqual([ranOut, ranOut]);
    await expect(
      Promise.all([reconnections(personal), reconnections(shared)])
    ).resolves.toStrictEqual([[], []]);
  });

  it("never brings back one that was disconnected: its account connects as new", async () => {
    const anna = someone();
    const account = ownAccount(anna);
    const connectionId = await connectedThenRanOut(anna, account);
    await exports.default.disconnect({ person: anna, connectionId });
    const again = await connectAccount(providers, anna, account);
    expect(again).not.toBe(connectionId);
    await expect(stored(connectionId)).resolves.toStrictEqual({
      status: "disconnected",
      tokens: 0,
    });
    await expect(reconnections(connectionId)).resolves.toStrictEqual([]);
  });

  it("never brings back a removed person's: their flow is spent and their connection stopped", async () => {
    const anna = someone();
    const account = ownAccount(anna);
    const connectionId = await connectedThenRanOut(anna, account);
    const flow = await cameBack(anna, account);
    await exports.default.disconnectPersonal({
      person: null,
      ownerUserIds: [anna.userId],
    });
    await expect(finish(anna, flow.state, flow.code)).resolves.toBe(
      "connection.flow_invalid"
    );
    expect(providers.tokenRequests("authorization_code")).toHaveLength(1);
    await expect(stored(connectionId)).resolves.toStrictEqual({
      status: "disconnected",
      tokens: 0,
    });
  });

  it("takes a state once, and none past its time", async () => {
    const anna = someone();
    const account = ownAccount(anna);
    const connectionId = await connectedThenRanOut(anna, account);
    const stale = await cameBack(anna, account);
    await drizzle(env.DB)
      .update(oauthFlows)
      .set({ expiresAt: new Date(Date.now() - 1) })
      .where(eq(oauthFlows.userId, anna.userId));
    const pastItsTime = await finish(anna, stale.state, stale.code);
    await expect(stored(connectionId)).resolves.toStrictEqual(ranOut);

    const flow = await cameBack(anna, account);
    const inTime = await finish(anna, flow.state, flow.code);
    const token = await accessTokenFor(env, connectionId);
    // The same callback again, and the state with a new code for it.
    const another = await cameBack(anna, account);
    const replayed = [
      await finish(anna, flow.state, flow.code),
      await finish(anna, flow.state, another.code),
    ];
    expect([pastItsTime, inTime, ...replayed]).toStrictEqual([
      "connection.flow_invalid",
      "ok",
      "connection.flow_invalid",
      "connection.flow_invalid",
    ]);
    await expect(accessTokenFor(env, connectionId)).resolves.toBe(token);
    await expect(reconnections(connectionId)).resolves.toHaveLength(1);
  });

  it("twice at once is done once: the other flow changes nothing and revokes nothing", async () => {
    const anna = someone();
    const account = ownAccount(anna, "google");
    const connectionId = await connectedThenRanOut(anna, account);
    const first = await cameBack(anna, account);
    const second = await cameBack(anna, account);
    // The second flow finishes after the first found the connection
    // waiting, just before the first's write lands.
    const racing = racingOnce(
      async () => await exports.default.finishConnection(second)
    );
    await expect(
      outcome(finishConnection({ ...env, DB: racing }, first))
    ).resolves.toBe("connection.already_connected");
    await expect(stored(connectionId)).resolves.toStrictEqual({
      status: "active",
      tokens: 1,
    });
    // The second flow's tokens stand. Revoking the first's would revoke
    // them too: Google revokes a grant as a whole.
    const access = providers.state.issued.filter((token) =>
      token.startsWith("access")
    );
    await expect(accessTokenFor(env, connectionId)).resolves.toBe(
      access.at(-1)
    );
    expect(providers.revocations()).toStrictEqual([]);
    // One reconnect, and the other flow recorded against the connection.
    await expect(
      Promise.all([reconnections(connectionId), refusalsNaming(connectionId)])
    ).resolves.toMatchObject([
      [{ action: "connection.reconnected" }],
      ["connection.already_connected"],
    ]);
  });

  it("refused, or failing to be stored, revokes what was minted: it holds no grant to lose", async () => {
    const anna = someone();
    const account = ownAccount(anna, "google");
    const connectionId = await connectedThenRanOut(anna, account);
    // An admin asks for Anna's account as a shared connection.
    await expect(
      outcome(
        connectAccount(providers, someone("admin"), account, {
          scope: "shared",
        })
      )
    ).resolves.toBe("connection.already_connected");
    const refused = lastRefreshToken();
    // Anna's own reconnect, whose write fails.
    const flow = await cameBack(anna, account);
    const failing = racingDb(() => {
      throw new Error("The database is down");
    });
    await expect(
      finishConnection({ ...env, DB: failing }, flow)
    ).rejects.toThrow("The database is down");
    expect(revokedTokens()).toStrictEqual([refused, lastRefreshToken()]);
    expect(providers.grantHolds(account)).toBeFalsy();
    await expect(stored(connectionId)).resolves.toStrictEqual(ranOut);
  });

  it("losing to a disconnect leaves it disconnected: the account connects as new", async () => {
    const anna = someone();
    const account = ownAccount(anna, "google");
    const connectionId = await connectedThenRanOut(anna, account);
    const flow = await cameBack(anna, account);
    const racing = racingOnce(
      async () =>
        await exports.default.disconnect({ person: anna, connectionId })
    );
    const finished = await finishConnection({ ...env, DB: racing }, flow);
    expect(finished.connectionId).not.toBe(connectionId);
    await expect(stored(connectionId)).resolves.toStrictEqual({
      status: "disconnected",
      tokens: 0,
    });
    await expect(stored(finished.connectionId)).resolves.toStrictEqual({
      status: "active",
      tokens: 1,
    });
    await expect(reconnections(connectionId)).resolves.toStrictEqual([]);
  });

  it("landing after a disconnect read it is stopped with it: the new grant is revoked, not only deleted", async () => {
    const anna = someone();
    const account = ownAccount(anna, "google");
    const connectionId = await connectedThenRanOut(anna, account);
    const flow = await cameBack(anna, account);
    // The disconnect found it waiting, with no grant to revoke; the
    // reconnect lands just before the disconnect's write.
    const racing = racingOnce(
      async () => await exports.default.finishConnection(flow)
    );
    await expect(
      disconnect({ ...env, DB: racing }, { person: anna, connectionId })
    ).resolves.toStrictEqual({ revoked: true });
    await expect(stored(connectionId)).resolves.toStrictEqual({
      status: "disconnected",
      tokens: 0,
    });
    expect(revokedTokens()).toStrictEqual([lastRefreshToken()]);
    expect(providers.grantHolds(account)).toBeFalsy();
    const audited = await audit.events();
    expect(
      audited
        .filter(({ target }) => target?.id === connectionId)
        .map(({ action, detail }) => [action, detail.revoked])
        .slice(-2)
    ).toStrictEqual([
      ["connection.reconnected", undefined],
      ["connection.disconnect", true],
    ]);
  });

  it("of a person removed once their flow was already taken connects as new, which the next offboarding try stops", async () => {
    const anna = someone();
    const account = ownAccount(anna, "google");
    const connectionId = await connectedThenRanOut(anna, account);
    const flow = await cameBack(anna, account);
    const offboard = async () =>
      await exports.default.disconnectPersonal({
        person: null,
        ownerUserIds: [anna.userId],
      });
    // Too late to spend the flow: it is past that, about to write.
    const finished = await finishConnection(
      { ...env, DB: racingOnce(offboard) },
      flow
    );
    expect(finished.connectionId).not.toBe(connectionId);
    await expect(
      Promise.all([stored(connectionId), reconnections(connectionId)])
    ).resolves.toStrictEqual([{ status: "disconnected", tokens: 0 }, []]);
    // Core retries until a call completes with nothing left.
    await expect(offboard()).resolves.toStrictEqual({ disconnected: 1 });
    await expect(stored(finished.connectionId)).resolves.toStrictEqual({
      status: "disconnected",
      tokens: 0,
    });
    expect(providers.grantHolds(account)).toBeFalsy();
  });
});

describe("a flow that can't finish", () => {
  it("is spent, so its code can't be brought back later", async () => {
    const anna = someone();
    const abandoned = await startAs(anna);
    const malformed = await startAs(anna);
    await exports.default.abandonFlow(stateOf(abandoned));
    await expect(
      finish(anna, stateOf(malformed), "x".repeat(5000))
    ).resolves.toBe("connection.invalid");
    const results = await Promise.all(
      [abandoned, malformed].map(
        async (url) =>
          await finish(
            anna,
            stateOf(url),
            providers.authorize(url.href, ownAccount(anna))
          )
      )
    );
    expect(results).toStrictEqual([
      "connection.flow_invalid",
      "connection.flow_invalid",
    ]);
  });
});
