import { connectionCallbackPath } from "@grasp-os/shared/connect";
import type { ConnectionPerson } from "@grasp-os/shared/connect";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { env, exports } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it, vi } from "vite-plus/test";

import { connectionTokens, oauthFlows } from "../src/db/schema.ts";
import { startConnection } from "../src/oauth.ts";
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
import {
  acmeDomain,
  acmeTenant,
  clients,
  fakeProviders,
  otherTenant,
} from "./oauth-provider.ts";
import type { Account } from "./oauth-provider.ts";

// Connecting an account through OAuth. The ways it could go wrong come
// first: a flow finished by someone other than who started it (the login
// swap: an attacker's account attached to a victim, or the victim's to the
// attacker), a state tampered with or replayed, a code without its PKCE
// verifier, an account from outside the organization, a person who isn't
// an admin connecting what the organization shares.

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
    expect(
      audit.events.find(
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
    expect(audit.events).toMatchObject([
      {
        actor: { type: "person", userId: anna.userId },
        action: "connection.connect",
        target: { type: "connection", id: connectionId },
        detail: { provider: "microsoft", scope: "personal", outcome: "ok" },
      },
    ]);
    expect(JSON.stringify(audit.events)).not.toContain(anna.email);
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
    expect(
      audit.events.map(({ actor, detail }) => [actor, detail])
    ).toMatchObject(
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
      "connection.invalid_request",
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
    const seen = JSON.stringify([
      url.href,
      finished,
      replayed,
      listed,
      disconnected,
      lines,
      audit.events,
    ]);
    expect(
      [...providers.state.issued, code].filter((secret) =>
        seen.includes(secret)
      )
    ).toStrictEqual([]);
  });
});

describe("whose account", () => {
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

describe("a flow that can't finish", () => {
  it("is spent, so its code can't be brought back later", async () => {
    const anna = someone();
    const abandoned = await startAs(anna);
    const malformed = await startAs(anna);
    await exports.default.abandonFlow(stateOf(abandoned));
    await expect(
      finish(anna, stateOf(malformed), "x".repeat(5000))
    ).resolves.toBe("connection.invalid_request");
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
