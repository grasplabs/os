import { authErrors } from "@grasp-os/shared/errors";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { mockIdp } from "./idp.ts";
import type { Claims } from "./idp.ts";
import {
  acmeTenant,
  clientOrigin,
  otherTenant,
  signInConfig,
} from "./sign-in-config.ts";
import {
  auditedDuring,
  coreOrigin,
  entraPerson,
  finishSignIn,
  googlePerson,
  openRpc,
  routed,
  sessionCookieName,
  signIn,
  signedIn,
  staffPerson,
  startSignIn,
  whoami,
  withSignIn,
} from "./sign-in.ts";

const idp = mockIdp();

/** Whether anything about the person with this email was stored. */
const stored = async (email: unknown) => {
  const row = await env.DB.prepare(
    "SELECT count(*) AS count FROM users WHERE email = ?"
  )
    .bind(String(email).toLowerCase())
    .first<{ count: number }>();
  return (row?.count ?? 0) > 0;
};

/** The error code a refused sign-in sends the browser back to the frontend with. */
const errorOf = (location: string | null) => {
  const url = new URL(location ?? "", clientOrigin);
  return url.pathname === "/" ? url.searchParams.get("error") : null;
};

/** What became of a sign-in: the error it was sent back with, and what was kept. */
const outcome = async (providerId: string, claims: Claims) => {
  const result = await signIn(idp, providerId, claims);
  return {
    error: errorOf(result.location),
    signedIn: result.session !== undefined,
    stored: await stored(claims.email),
  };
};

/** A refusal with `error`, with nobody signed in and nothing stored. */
const refused = (error: string) => ({ error, signedIn: false, stored: false });

/** The attributes of the session cookie a response sets, except its lifetime. */
const sessionCookieAttributes = (response: Response) =>
  response.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith(`${sessionCookieName}=`))
    ?.toLowerCase()
    .split("; ")
    .slice(1)
    .filter((attribute) => !/^(?:max-age|expires)=/u.test(attribute))
    .toSorted();

describe("signing in", () => {
  it("signs in someone from the client's Entra tenant, as a user", async () => {
    const person = entraPerson(acmeTenant);
    const started = await startSignIn("microsoft");
    // The IdP sends them back to the client's hostname, not core's own.
    expect(started.authorizationUrl.searchParams.get("redirect_uri")).toBe(
      `${clientOrigin}/api/auth/sso/callback/microsoft`
    );

    const { response, location, session } = await signIn(
      idp,
      "microsoft",
      person
    );
    expect(location).toBe("/");
    // Host-only (no Domain), HTTPS-only, out of reach of scripts.
    expect(sessionCookieAttributes(response)).toStrictEqual([
      "httponly",
      "path=/",
      "samesite=lax",
      "secure",
    ]);
    await expect(whoami(session)).resolves.toMatchObject({
      email: person.email,
      name: person.name,
      role: "user",
      teams: [],
      staff: false,
    });
  });

  it("signs in someone from the client's Google Workspace", async () => {
    const person = googlePerson();
    const session = await signedIn(idp, "google", person);
    await expect(whoami(session)).resolves.toMatchObject({
      email: person.email,
      role: "user",
    });
  });

  it("makes the configured admins admins on their first sign-in", async () => {
    const person = entraPerson(acmeTenant);
    // Configured in another case than the IdP sends it.
    const session = await signedIn(idp, "microsoft", person, {
      coreEnv: withSignIn({ admins: [String(person.email).toUpperCase()] }),
    });
    await expect(whoami(session)).resolves.toMatchObject({ role: "admin" });
  });

  it("never links an account at the other IdP by its email", async () => {
    const person = entraPerson(acmeTenant);
    await signedIn(idp, "microsoft", person);
    const other = await outcome(
      "google",
      googlePerson({ email: person.email })
    );
    expect(other).toMatchObject({ signedIn: false, stored: true });
    expect(other.error).not.toBeNull();
  });

  it("keeps none of the IdP's tokens", async () => {
    const person = entraPerson(acmeTenant);
    await signedIn(idp, "microsoft", person);
    await signedIn(idp, "microsoft", person);
    const account = await env.DB.prepare(
      "SELECT access_token, refresh_token, id_token FROM accounts WHERE account_id = ?"
    )
      .bind(person.sub)
      .first();
    expect(account).toStrictEqual({
      access_token: null,
      refresh_token: null,
      id_token: null,
    });
  });

  it("offers the configured IdPs, and none while sign-in isn't set up", async () => {
    const { core } = await openRpc();
    await expect(core.signInOptions()).resolves.toStrictEqual([
      { providerId: "microsoft", label: "Microsoft" },
      { providerId: "google", label: "Google" },
      { providerId: "grasp-staff", label: "Grasp staff" },
    ]);
    core[Symbol.dispose]();

    const unconfigured = { ...env, SIGN_IN: undefined };
    // Without config, the page's own origin (core's address here) is accepted.
    const off = await openRpc(undefined, {
      coreEnv: unconfigured,
      origin: coreOrigin,
    });
    await expect(off.core.signInOptions()).resolves.toStrictEqual([]);
    off.core[Symbol.dispose]();
    const start = await routed(
      "/api/auth/sign-in/sso",
      {
        method: "POST",
        headers: { origin: clientOrigin, "content-type": "application/json" },
        body: JSON.stringify({ providerId: "microsoft", callbackURL: "/" }),
      },
      unconfigured
    );
    expect(start.status).toBe(404);
  });

  it("offers nothing when its config doesn't parse, and says which var and where", async () => {
    const logged = vi.spyOn(console, "error");
    try {
      const configs = [
        `{"origin": "https://acme.test"`,
        { ...signInConfig, domains: "acme.test" },
      ];
      const offered = await Promise.all(
        configs.map(async (config) => {
          const { core } = await openRpc(undefined, {
            coreEnv: { ...env, SIGN_IN: config },
            origin: coreOrigin,
          });
          try {
            return await core.signInOptions();
          } finally {
            core[Symbol.dispose]();
          }
        })
      );
      expect(offered).toStrictEqual([[], []]);
      // Once per config, however often it's read: it's parsed once.
      const invalid = logged.mock.calls
        .map(([line]: unknown[]) => line)
        .filter(
          (line) =>
            z.object({ event: z.literal("config.invalid") }).safeParse(line)
              .success
        );
      // In either order: the two connections run at once.
      expect(new Set(invalid)).toStrictEqual(
        new Set([
          { event: "config.invalid", var: "SIGN_IN", paths: "<root>" },
          { event: "config.invalid", var: "SIGN_IN", paths: "domains" },
        ])
      );
      expect(invalid).toHaveLength(2);
    } finally {
      logged.mockRestore();
    }
  });

  it("gives a connection without a session nothing but the public calls", async () => {
    const { core } = await openRpc();
    await expect(core.ping()).resolves.toBe("pong");
    const refusal = await core
      .authenticate()
      .whoami()
      .catch((error: unknown) => error);
    expect(authErrors.codeOf(refusal)).toBe("auth.unauthenticated");
    core[Symbol.dispose]();
  });
});

describe("tenant and domain spoofing", () => {
  it("refuses a token another Entra tenant issued", async () => {
    const outsider = entraPerson(otherTenant, "acme.test", {
      iss: `https://login.microsoftonline.com/${otherTenant}/v2.0`,
    });
    await expect(outcome("microsoft", outsider)).resolves.toStrictEqual(
      refused("invalid_provider")
    );
  });

  it("refuses a token for another app", async () => {
    const person = entraPerson(acmeTenant, "acme.test", { aud: "other-app" });
    await expect(outcome("microsoft", person)).resolves.toStrictEqual(
      refused("invalid_provider")
    );
  });

  it("refuses an Entra account outside the pinned tenant, whatever its email", async () => {
    const outcomes = await Promise.all([
      outcome("microsoft", entraPerson(otherTenant)),
      outcome(
        "microsoft",
        entraPerson(acmeTenant, "acme.test", { oid: undefined })
      ),
    ]);
    expect(outcomes).toStrictEqual([
      refused("tenant_mismatch"),
      refused("tenant_mismatch"),
    ]);
  });

  it("refuses B2B guests in the tenant, and anyone it can't tell apart from one", async () => {
    const outcomes = await Promise.all([
      outcome("microsoft", entraPerson(acmeTenant, "acme.test", { acct: 1 })),
      outcome(
        "microsoft",
        entraPerson(acmeTenant, "acme.test", { acct: undefined })
      ),
    ]);
    expect(outcomes).toStrictEqual([
      refused("guest_not_allowed"),
      refused("guest_not_allowed"),
    ]);
  });

  it("refuses emails outside the client's domains, lookalikes included", async () => {
    const domains = [
      "gmail.com",
      "evil.acme.test",
      "acme.test.evil.example",
      "acme.testx",
    ];
    const outcomes = await Promise.all(
      domains.map(
        async (domain) =>
          await outcome("microsoft", entraPerson(acmeTenant, domain))
      )
    );
    expect(outcomes).toStrictEqual(
      domains.map(() => refused("domain_not_allowed"))
    );
  });

  it("refuses a Google account with a client email that isn't in the client's Workspace", async () => {
    const outcomes = await Promise.all([
      // A consumer Google account can carry any address, but has no `hd`.
      outcome("google", googlePerson({ hd: undefined })),
      outcome("google", googlePerson({ hd: "evil.example" })),
      outcome("google", googlePerson({ email_verified: false })),
    ]);
    expect(outcomes).toStrictEqual([
      refused("tenant_mismatch"),
      refused("tenant_mismatch"),
      refused("email_unverified"),
    ]);
  });

  it("checks again on every sign-in, not only the first", async () => {
    const person = entraPerson(acmeTenant);
    await signedIn(idp, "microsoft", person);
    await expect(
      outcome("microsoft", { ...person, tid: otherTenant })
    ).resolves.toStrictEqual({
      error: "tenant_mismatch",
      signedIn: false,
      stored: true,
    });
  });
});

describe("login CSRF, session fixation and replay", () => {
  it("won't finish a sign-in in a browser that didn't start it", async () => {
    // An attacker signs in as themselves and sends the victim the callback.
    const started = await startSignIn("microsoft");
    const callback = idp.authorize(
      started.authorizationUrl,
      entraPerson(acmeTenant)
    );
    const noState = await finishSignIn(callback);
    expect(noState.headers.get("location")).toMatch(/error=state/u);
    expect(noState.headers.getSetCookie().join(",")).not.toContain(
      `${sessionCookieName}=`
    );

    // The victim's browser has a sign-in of its own in progress.
    const victims = await startSignIn("microsoft");
    const crossed = await finishSignIn(callback, { cookie: victims.cookie });
    expect(crossed.headers.getSetCookie().join(",")).not.toContain(
      `${sessionCookieName}=`
    );
  });

  it("won't finish the same sign-in twice", async () => {
    const first = await signIn(idp, "microsoft", entraPerson(acmeTenant));
    expect(first.session).toBeDefined();
    const replayed = await finishSignIn(first.callback, {
      cookie: first.cookie,
    });
    expect(replayed.headers.getSetCookie().join(",")).not.toContain(
      `${sessionCookieName}=`
    );
  });

  it("gives a new session on sign-in, whatever session the browser had", async () => {
    const attacker = entraPerson(acmeTenant);
    const planted = await signedIn(idp, "microsoft", attacker);
    const victim = entraPerson(acmeTenant);
    const session = await signedIn(idp, "microsoft", victim, {
      cookie: planted,
    });

    expect(session).not.toBe(planted);
    await expect(whoami(session)).resolves.toMatchObject({
      email: victim.email,
    });
    await expect(whoami(planted)).resolves.toMatchObject({
      email: attacker.email,
    });
  });

  it("treats a forged or altered session cookie as nobody", async () => {
    const session = await signedIn(idp, "microsoft", entraPerson(acmeTenant));
    const [name, value = ""] = session.split("=");
    const [token = "", signature = ""] = decodeURIComponent(value).split(".");
    const forged = [
      `${name}=${encodeURIComponent(`${token}x.${signature}`)}`,
      `${name}=${encodeURIComponent(token)}`,
      `${name}=${encodeURIComponent(`${crypto.randomUUID()}.${signature}`)}`,
      // The same token under the name Better Auth uses without the prefix.
      `better-auth.session_token=${value}`,
    ];
    for (const cookie of forged) {
      // oxlint-disable-next-line no-await-in-loop -- sequential for readable failures
      const refusal = await whoami(cookie).catch((error: unknown) => error);
      expect(authErrors.codeOf(refusal)).toBe("auth.unauthenticated");
    }
  });
});

const day = 24 * 60 * 60 * 1000;

const staffWindow = (opened: number, until: number) =>
  withSignIn({
    staff: {
      ...signInConfig.staff,
      opened: new Date(opened).toISOString(),
      until: new Date(until).toISOString(),
    },
  });
const closedWindow = staffWindow(
  Date.parse("2000-01-01T00:00:00Z"),
  Date.parse("2000-01-02T00:00:00Z")
);

describe("Grasp staff access", () => {
  it("lets listed staff in through Grasp's tenant, for an hour at most, and logs it", async () => {
    const startedAt = Date.now();
    let session = "";
    const audited = await auditedDuring(async () => {
      session = await signedIn(idp, "grasp-staff", staffPerson());
    });
    const identity = await whoami(session);

    expect(identity).toMatchObject({ staff: true, role: "admin", teams: [] });
    expect(Date.parse(identity.expiresAt)).toBeLessThanOrEqual(
      startedAt + 60 * 60 * 1000 + 1000
    );
    expect(audited).toContainEqual(
      expect.objectContaining({
        action: "staff.session.started",
        actor: { type: "staff", userId: identity.userId },
      })
    );
  });

  it("lets in only the staff the window names", async () => {
    await expect(
      outcome("grasp-staff", staffPerson({ oid: crypto.randomUUID() }))
    ).resolves.toStrictEqual(refused("staff_not_listed"));
  });

  it("ends a staff session when its person is taken off the list", async () => {
    const session = await signedIn(idp, "grasp-staff", staffPerson());
    const delisted = withSignIn({
      staff: { ...signInConfig.staff, oids: [crypto.randomUUID()] },
    });
    const refusal = await whoami(session, delisted).catch(
      (error: unknown) => error
    );
    expect(authErrors.codeOf(refusal)).toBe("auth.unauthenticated");
  });

  it("never lets a staff session outlive the window", async () => {
    const until = Date.now() + 10 * 60 * 1000;
    const shortWindow = staffWindow(Date.now() - 60 * 1000, until);
    const session = await signedIn(idp, "grasp-staff", staffPerson(), {
      coreEnv: shortWindow,
    });
    const identity = await whoami(session, shortWindow);
    expect(Date.parse(identity.expiresAt)).toBeLessThanOrEqual(until);
  });

  it("ends staff sessions when the window closes", async () => {
    const session = await signedIn(idp, "grasp-staff", staffPerson());
    const refusal = await whoami(session, closedWindow).catch(
      (error: unknown) => error
    );
    expect(authErrors.codeOf(refusal)).toBe("auth.unauthenticated");
  });

  it("offers and allows no staff sign-in while no window is open", async () => {
    const noStaff = { providerId: "grasp-staff", label: "Grasp staff" };
    const now = Date.now();
    const shut = [
      closedWindow,
      withSignIn({ staff: undefined }),
      // Not open yet.
      staffWindow(now + day, now + 2 * day),
      // Longer than the seven days allowed, even this close to its end.
      staffWindow(now - 6 * day, now + 2 * day),
    ];
    const offered = await Promise.all(
      shut.map(async (coreEnv) => {
        const { core } = await openRpc(undefined, { coreEnv });
        try {
          return await core.signInOptions();
        } finally {
          core[Symbol.dispose]();
        }
      })
    );
    for (const options of offered) {
      expect(options).not.toContainEqual(noStaff);
    }
    const started = await Promise.all(
      shut.map(
        async (coreEnv) =>
          await startSignIn("grasp-staff", { coreEnv }).catch(
            (error: unknown) => error
          )
      )
    );
    for (const attempt of started) {
      expect(attempt).toBeInstanceOf(Error);
    }
  });

  it("won't finish a staff sign-in once the window has closed", async () => {
    const started = await startSignIn("grasp-staff");
    const callback = idp.authorize(started.authorizationUrl, staffPerson());
    const finished = await finishSignIn(callback, {
      cookie: started.cookie,
      coreEnv: closedWindow,
    });
    expect(finished.headers.getSetCookie().join(",")).not.toContain(
      `${sessionCookieName}=`
    );
  });

  it("keeps staff and client sign-ins apart", async () => {
    const outcomes = await Promise.all([
      outcome("grasp-staff", entraPerson(acmeTenant, "grasp.test")),
      outcome("microsoft", staffPerson()),
    ]);
    expect(outcomes).toStrictEqual([
      refused("tenant_mismatch"),
      refused("tenant_mismatch"),
    ]);
  });
});
