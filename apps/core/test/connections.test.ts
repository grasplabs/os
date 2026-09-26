import { connectErrors, connectionErrors } from "@grasp-os/shared/connect";
import { featureErrors } from "@grasp-os/shared/errors";
import { roleErrors } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { consentCode, tokensFor } from "./connect-providers.ts";
import { mockIdp } from "./idp.ts";
import { acmeTenant, clientOrigin, otherTenant } from "./sign-in-config.ts";
import {
  openRpc,
  routed,
  signedIn,
  signedInWithRole,
  staffPerson,
} from "./sign-in.ts";

// Connecting an account, through core: the person starts over `/rpc`, the
// provider (a stand-in for Entra behind the real connect) sends the browser
// back to core's callback, and core hands the rest to connect. Core never
// sees a token, and the callback attaches nothing to anyone but the person
// who started the flow, nor sends the browser anywhere but this origin.

const idp = mockIdp();

/** The code a promise was refused with, or "ok" if it wasn't. */
const outcome = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return "ok";
  } catch (error) {
    return (
      connectionErrors.codeOf(error) ??
      connectErrors.codeOf(error) ??
      roleErrors.codeOf(error) ??
      featureErrors.codeOf(error) ??
      String(error)
    );
  }
};

/** A signed-in person with their `connections` API. */
const person = async (role: "admin" | "user" = "user") => {
  const { session, userId, person: claims } = await signedInWithRole(idp, role);
  const { core } = await openRpc(session);
  return {
    session,
    userId,
    // Their own Microsoft account: the Entra object ID they sign in with.
    oid: String(claims.oid),
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
    });
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
      `${clientOrigin}/?connectionError=connection.flow_invalid`
    );
    // The flow is spent: Mallory can't finish it either.
    const again = await backFromProvider(mallory.session, query);
    expect(again.headers.get("location")).toBe(
      `${clientOrigin}/?connectionError=connection.flow_invalid`
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
      `${clientOrigin}/?connectionError=auth.unauthenticated`
    );
    // The same URL, brought back later with a session, finishes nothing.
    const later = await backFromProvider(anna.session, query);
    expect(later.headers.get("location")).toBe(
      `${clientOrigin}/?connectionError=connection.flow_invalid`
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
      `${clientOrigin}/?connectionError=connection.wrong_account`
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
    expect(refused).toStrictEqual(
      elsewhere.map(() => "connection.invalid_request")
    );
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
      `${clientOrigin}/?connectionError=connection.not_own_account`
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

  it("is switched off with its flag: the callback is not found", async () => {
    const anna = await person();
    const off: Env = { ...env, FEATURES: {} };
    const response = await backFromProvider(
      anna.session,
      { code: "x", state: "y" },
      off
    );
    expect(response.status).toBe(404);
  });
});
