import { composioConsentText } from "@grasp-os/shared/connect";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { requestGranted } from "./apps.ts";
import { consentCode, tokensFor } from "./connect-providers.ts";
import { mockIdp } from "./idp.ts";
import { acmeTenant, clientOrigin, otherTenant } from "./sign-in-config.ts";
import {
  auditedDuring,
  openRpc,
  outcome,
  routed,
  signedIn,
  signedInApi,
  signedInWithRole,
  staffPerson,
} from "./sign-in.ts";

// Connecting an account, through core: the person starts over `/rpc`, the
// provider (a stand-in for Entra behind the real connect) sends the browser
// back to core's callback, and core hands the rest to connect. Core never
// sees a token, and the callback attaches nothing to anyone but the person
// who started the flow, nor sends the browser anywhere but this origin.

const idp = mockIdp();

/** A signed-in person with their `connections` API. */
const person = async (role: "admin" | "user" = "user") => {
  const { session, userId, person: claims } = await signedInWithRole(idp, role);
  const { core } = await openRpc(session);
  return {
    session,
    userId,
    // Their own Microsoft account: the Entra object ID they sign in with.
    oid: String(claims.oid),
    name: String(claims.name),
    connections: core.authenticate().connections,
  };
};

/** The provider sending `session`'s browser back to core. */
const backFromProvider = async (
  session: string | undefined,
  query: Record<string, string>,
  coreEnv: Env = env
): Promise<Response> =>
  await routed(
    `/api/connections/callback?${new URLSearchParams(query).toString()}`,
    { headers: session === undefined ? {} : { cookie: session } },
    coreEnv
  );

/** Calls `method` on connect's binding, as any code in core could. */
const askConnect = async (
  method: string,
  ...args: unknown[]
): Promise<unknown> => {
  const target: unknown = Reflect.get(env.CONNECT, method);
  if (typeof target !== "function") {
    throw new TypeError(`No method ${method}`);
  }
  return await Reflect.apply(target, env.CONNECT, args);
};

const subject = () => `oid-${crypto.randomUUID()}`;

describe("connecting an account", () => {
  it("goes from the person's browser through the provider and back, and the connection is active", async () => {
    const anna = await person();
    const account = anna.oid;
    const { url } = await anna.connections.start({
      provider: "microsoft",
      scope: "personal",
      returnTo: "/connections?tab=mine",
    });
    const authorization = new URL(url);
    const response = await backFromProvider(anna.session, {
      code: consentCode(authorization, acmeTenant, account),
      state: authorization.searchParams.get("state") ?? "",
    });
    const [connection] = await anna.connections.list();
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      `${clientOrigin}/connections?tab=mine&connection=${connection?.id}`
    );
    expect({
      cache: response.headers.get("cache-control"),
      referrer: response.headers.get("referrer-policy"),
    }).toStrictEqual({ cache: "no-store", referrer: "no-referrer" });
    expect(connection).toMatchObject({
      provider: "microsoft",
      scope: "personal",
      status: "active",
      ownerUserId: anna.userId,
      accountName: `${account}@acme.test`,
      connectedBy: anna.userId,
      connectedByName: anna.name,
    });
    // Only a Composio connection has tools the admin allowed.
    expect(connection).not.toHaveProperty("tools");
  });

  it("never hands core a token, nor logs the code", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => {
      lines.push(JSON.stringify(args));
    });
    const anna = await person();
    const account = anna.oid;
    const { url } = await anna.connections.start({
      provider: "microsoft",
      scope: "personal",
    });
    const authorization = new URL(url);
    const code = consentCode(authorization, acmeTenant, account);
    const response = await backFromProvider(anna.session, {
      code,
      state: authorization.searchParams.get("state") ?? "",
    });
    const listed = await anna.connections.list();
    const seen = JSON.stringify([
      url,
      response.headers.get("location"),
      listed,
      lines,
    ]);
    expect(
      [...tokensFor(account), code].filter((secret) => seen.includes(secret))
    ).toStrictEqual([]);
    // Nor can core ask connect for one: no RPC method returns a token.
    const connectionId = listed[0]?.id;
    const asked = await Promise.all(
      ["accessTokenFor", "revocableToken", "openTokens"].map(
        async (method) => await outcome(askConnect(method, connectionId))
      )
    );
    expect(asked.filter((result) => result === "ok")).toStrictEqual([]);
  });

  it("attaches nothing when someone else's browser comes back with the flow (login swap)", async () => {
    const anna = await person();
    const mallory = await person();
    // Mallory starts, consents with her own account, and gets Anna to open
    // the callback URL: it arrives with Anna's session on Mallory's flow.
    const { url } = await mallory.connections.start({
      provider: "microsoft",
      scope: "personal",
    });
    const authorization = new URL(url);
    const query = {
      code: consentCode(authorization, acmeTenant, mallory.oid),
      state: authorization.searchParams.get("state") ?? "",
    };
    const response = await backFromProvider(anna.session, query);
    expect(response.headers.get("location")).toBe(
      `${clientOrigin}/connections?connectionError=connection.flow_invalid`
    );
    // The flow is spent: Mallory can't finish it either.
    const again = await backFromProvider(mallory.session, query);
    expect(again.headers.get("location")).toBe(
      `${clientOrigin}/connections?connectionError=connection.flow_invalid`
    );
    await expect(
      Promise.all([anna.connections.list(), mallory.connections.list()])
    ).resolves.toStrictEqual([
      expect.not.arrayContaining([
        expect.objectContaining({ scope: "personal" }),
      ]),
      expect.not.arrayContaining([
        expect.objectContaining({ scope: "personal" }),
      ]),
    ]);
  });

  it("finishes nothing without a session, and spends the flow", async () => {
    const anna = await person();
    const { url } = await anna.connections.start({
      provider: "microsoft",
      scope: "personal",
    });
    const authorization = new URL(url);
    const query = {
      code: consentCode(authorization, acmeTenant, anna.oid),
      state: authorization.searchParams.get("state") ?? "",
    };
    const response = await backFromProvider(undefined, query);
    expect(response.headers.get("location")).toBe(
      `${clientOrigin}/connections?connectionError=auth.unauthenticated`
    );
    // The same URL, brought back later with a session, finishes nothing.
    const later = await backFromProvider(anna.session, query);
    expect(later.headers.get("location")).toBe(
      `${clientOrigin}/connections?connectionError=connection.flow_invalid`
    );
    await expect(anna.connections.list()).resolves.toStrictEqual([]);
  });

  it("refuses an account from another tenant", async () => {
    const anna = await person();
    const { url } = await anna.connections.start({
      provider: "microsoft",
      scope: "personal",
    });
    const authorization = new URL(url);
    const response = await backFromProvider(anna.session, {
      code: consentCode(authorization, otherTenant, subject()),
      state: authorization.searchParams.get("state") ?? "",
    });
    expect(response.headers.get("location")).toBe(
      `${clientOrigin}/connections?connectionError=connection.wrong_account`
    );
  });

  it("sends the browser back only to a path on this origin", async () => {
    const anna = await person();
    const elsewhere = [
      "//evil.test/connections",
      "/.//evil.test",
      "/\\evil.test",
      "/\t/evil.test",
      "https://evil.test/",
      "mailto:someone@evil.test",
      "/connections#fragment",
      `/${"a".repeat(600)}`,
    ];
    const refused = await Promise.all(
      elsewhere.map(
        async (returnTo) =>
          await outcome(
            anna.connections.start({
              provider: "microsoft",
              scope: "personal",
              returnTo,
            })
          )
      )
    );
    expect(refused).toStrictEqual(elsewhere.map(() => "connection.invalid"));
  });

  it("refuses someone else's account as a personal connection", async () => {
    const anna = await person();
    const { url } = await anna.connections.start({
      provider: "microsoft",
      scope: "personal",
    });
    const authorization = new URL(url);
    const response = await backFromProvider(anna.session, {
      code: consentCode(authorization, acmeTenant, subject()),
      state: authorization.searchParams.get("state") ?? "",
    });
    expect(response.headers.get("location")).toBe(
      `${clientOrigin}/connections?connectionError=connection.not_own_account`
    );
  });

  it("is refused to Grasp staff", async () => {
    const session = await signedIn(idp, "grasp-staff", staffPerson());
    const { core } = await openRpc(session);
    const { connections } = core.authenticate();
    const started = await Promise.all(
      (["personal", "shared"] as const).map(
        async (scope) =>
          await outcome(connections.start({ provider: "microsoft", scope }))
      )
    );
    expect(started).toStrictEqual([
      "connection.staff_not_allowed",
      "connection.staff_not_allowed",
    ]);
  });

  it("of a shared account is for admins only", async () => {
    const [user, admin] = await Promise.all([person(), person("admin")]);
    const started = await Promise.all(
      [user, admin].map(
        async ({ connections }) =>
          await outcome(
            connections.start({ provider: "microsoft", scope: "shared" })
          )
      )
    );
    expect(started).toStrictEqual(["role.forbidden", "ok"]);
  });

  it("can be undone: disconnecting stops the connection", async () => {
    const anna = await person();
    const { url } = await anna.connections.start({
      provider: "microsoft",
      scope: "personal",
    });
    const authorization = new URL(url);
    await backFromProvider(anna.session, {
      code: consentCode(authorization, acmeTenant, anna.oid),
      state: authorization.searchParams.get("state") ?? "",
    });
    const [connection] = await anna.connections.list();
    const bob = await person();
    await expect(
      outcome(bob.connections.disconnect(connection?.id ?? ""))
    ).resolves.toBe("connect.not_owner");
    await expect(
      anna.connections.disconnect(connection?.id ?? "")
    ).resolves.toStrictEqual({ revoked: false });
    await expect(anna.connections.list()).resolves.toStrictEqual([]);
  });
});

describe("the catalog", () => {
  /** Someone signed in's `connections`. */
  const userConnections = async () => {
    const { session } = await signedInWithRole(idp, "user");
    const { core } = await openRpc(session);
    return await core.authenticate().connections;
  };

  it("lists Composio's toolkits next to the native providers", async () => {
    const connections = await userConnections();
    const { entries, composio } = await connections.catalog();
    expect(composio).toBe("listed");
    expect(entries.map(({ source, id }) => `${source}:${id}`)).toStrictEqual([
      "native:microsoft",
      "native:google",
      "composio:hubspot",
    ]);
  });
});

describe("connecting a Composio toolkit", () => {
  /** An admin's `connections`. */
  const signedInAdmin = async () => {
    const { session, userId } = await signedInWithRole(idp, "admin");
    const { core } = await openRpc(session);
    return {
      session,
      userId,
      coreEnv: env,
      connections: core.authenticate().connections,
    };
  };

  const request = {
    toolkit: "hubspot",
    // Each tool by name, or with the admin's rule for it.
    tools: [
      { name: "HUBSPOT_LIST_CONTACTS", read: true },
      "HUBSPOT_CREATE_CONTACT",
    ],
    consent: composioConsentText,
    returnTo: "/connections?tab=shared",
  };

  it("goes from the admin's consent through Composio and back, to one shared connection", async () => {
    const admin = await signedInAdmin();
    const { url } = await admin.connections.connectToolkit(request);
    // Composio sends the browser straight back to the callback it was given.
    const state = new URL(url).searchParams.get("state") ?? "";
    const response = await backFromProvider(
      admin.session,
      { state, status: "success" },
      admin.coreEnv
    );
    const listed = await admin.connections.list();
    const connection = listed.find(({ provider }) => provider === "hubspot");
    expect(response.headers.get("location")).toBe(
      `${clientOrigin}/connections?tab=shared&connection=${connection?.id}`
    );
    // What the admin consented to: by them, for exactly these tools.
    expect(connection).toMatchObject({
      source: "composio",
      scope: "shared",
      connectedBy: admin.userId,
      tools: ["HUBSPOT_LIST_CONTACTS", "HUBSPOT_CREATE_CONTACT"],
    });
  });

  it("sends the browser back nowhere but this origin", async () => {
    const admin = await signedInAdmin();
    await expect(
      outcome(
        admin.connections.connectToolkit({
          ...request,
          returnTo: "//evil.test/connections",
        })
      )
    ).resolves.toBe("connection.invalid");
  });
});

/** The catalog `connections` lists, each entry as `source:id`. */
const listed = async (connections: {
  catalog: () => Promise<{ entries: { source: string; id: string }[] }>;
}): Promise<string[]> => {
  const { entries } = await connections.catalog();
  return entries.map(({ source, id }) => `${source}:${id}`);
};

describe("offering catalog entries", () => {
  const toolkitRequest = {
    toolkit: "hubspot",
    tools: ["HUBSPOT_LIST_CONTACTS"],
    consent: composioConsentText,
  };

  it("hides an entry from everyone but admins, refuses and records starting it, keeps what is connected, and offers it again", async () => {
    const admin = await person("admin");
    const anna = await person();
    // Connected before it is hidden.
    const { url } = await admin.connections.connectToolkit(toolkitRequest);
    const back = await backFromProvider(admin.session, {
      state: new URL(url).searchParams.get("state") ?? "",
      status: "success",
    });
    const connectionId =
      new URL(
        back.headers.get("location") ?? "",
        clientOrigin
      ).searchParams.get("connection") ?? "";
    const hidden = await auditedDuring(async () => {
      await admin.connections.setOffered("native", "google", false);
      await admin.connections.setOffered("composio", "hubspot", false);
      // Hiding what is hidden changes nothing, and records nothing.
      await admin.connections.setOffered("native", "google", false);
    });
    const { entries } = await admin.connections.catalog();
    expect({
      admin: entries.map(({ id, offered }) => `${id}:${offered}`),
      anna: await listed(anna.connections),
    }).toStrictEqual({
      admin: ["microsoft:true", "google:false", "hubspot:false"],
      anna: ["native:microsoft"],
    });
    const refused = await auditedDuring(async () => {
      await expect(
        outcome(
          anna.connections.start({ provider: "google", scope: "personal" })
        )
      ).resolves.toBe("connection.not_offered");
      // Admins included: hidden is hidden, until an admin offers it again.
      await expect(
        outcome(admin.connections.connectToolkit(toolkitRequest))
      ).resolves.toBe("connection.not_offered");
    });
    // What was connected goes on: still active, and an App is still asked
    // for it and granted it.
    const builder = await signedInApi(idp, "builder");
    const { id: app } = await builder.api.apps.create({ name: "CRM" });
    const granted = await requestGranted(idp, builder, {
      subject: { type: "app", appId: app },
      object: { type: "connection", connectionId },
      actions: ["HUBSPOT_LIST_CONTACTS"],
      binding: "HUBSPOT",
    });
    const [connected, asked] = await Promise.all([
      admin.connections.list(),
      builder.api.permissions.list({ type: "app", appId: app }),
    ]);
    expect({
      connection: connected.find(({ id }) => id === connectionId)?.status,
      permissions: asked.map(({ id, status }) => ({ id, status })),
    }).toStrictEqual({
      connection: "active",
      permissions: [{ id: granted, status: "active" }],
    });
    const offered = await auditedDuring(async () => {
      await admin.connections.setOffered("native", "google", true);
      await admin.connections.setOffered("composio", "hubspot", true);
    });
    const byAdmin = { type: "person", userId: admin.userId };
    expect(
      [...hidden, ...refused, ...offered].map(({ actor, action, detail }) => ({
        actor,
        action,
        detail,
      }))
    ).toStrictEqual([
      {
        actor: byAdmin,
        action: "connection.offer_changed",
        detail: { source: "native", provider: "google", offered: false },
      },
      {
        actor: byAdmin,
        action: "connection.offer_changed",
        detail: { source: "composio", provider: "hubspot", offered: false },
      },
      {
        actor: { type: "person", userId: anna.userId },
        action: "connection.connect",
        detail: {
          source: "native",
          provider: "google",
          scope: "personal",
          outcome: "refused",
          reason: "connection.not_offered",
        },
      },
      {
        actor: byAdmin,
        action: "connection.connect",
        detail: {
          source: "composio",
          provider: "hubspot",
          scope: "shared",
          outcome: "refused",
          reason: "connection.not_offered",
        },
      },
      {
        actor: byAdmin,
        action: "connection.offer_changed",
        detail: { source: "native", provider: "google", offered: true },
      },
      {
        actor: byAdmin,
        action: "connection.offer_changed",
        detail: { source: "composio", provider: "hubspot", offered: true },
      },
    ]);
    await expect(listed(anna.connections)).resolves.toStrictEqual([
      "native:microsoft",
      "native:google",
      "composio:hubspot",
    ]);
    await expect(
      outcome(admin.connections.connectToolkit(toolkitRequest))
    ).resolves.toBe("ok");
  });

  it("keeps a hidden entry's tools from everyone but admins, as for an entry there isn't", async () => {
    const admin = await person("admin");
    const anna = await person();
    await admin.connections.setOffered("native", "google", false);
    await admin.connections.setOffered("composio", "hubspot", false);
    const hidden = await Promise.all(
      [anna, admin].flatMap(({ connections }) => [
        outcome(connections.catalogTools("native", "google")),
        outcome(connections.catalogTools("composio", "hubspot")),
      ])
    );
    await admin.connections.setOffered("native", "google", true);
    await admin.connections.setOffered("composio", "hubspot", true);
    expect(hidden).toStrictEqual([
      "connect.catalog_entry_not_found",
      "connect.catalog_entry_not_found",
      "ok",
      "ok",
    ]);
    await expect(
      anna.connections.catalogTools("composio", "hubspot")
    ).resolves.toHaveLength(2);
  });

  it("is changed by the organization's admins only, never by staff, and only for entries there can be", async () => {
    const admin = await person("admin");
    const anna = await person();
    const staffSession = await signedIn(idp, "grasp-staff", staffPerson());
    const { core: staffCore } = await openRpc(staffSession);
    const staff = staffCore.authenticate().connections;
    await expect(
      Promise.all([
        outcome(anna.connections.setOffered("native", "microsoft", false)),
        outcome(staff.setOffered("native", "microsoft", false)),
        outcome(admin.connections.setOffered("native", "hubspot", false)),
        outcome(admin.connections.setOffered("composio", "Not A Slug", false)),
        // A slug, but of no toolkit Composio lists: a typo hides nothing.
        outcome(admin.connections.setOffered("composio", "hubsopt", false)),
        // SAFETY: a source no catalog has, as a client could send it.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
        outcome(admin.connections.setOffered("other" as never, "x", false)),
      ])
    ).resolves.toStrictEqual([
      "role.forbidden",
      "role.forbidden",
      "connection.invalid",
      "connection.invalid",
      "connection.invalid",
      "connection.invalid",
    ]);
    const { entries } = await admin.connections.catalog();
    expect(entries.every(({ offered }) => offered)).toBeTruthy();
  });
});
