import { authErrors } from "@grasp-os/shared/errors";
import { authoritySchema } from "@grasp-os/shared/permissions";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { bindingsFor } from "../src/bindings.ts";
import { sessionEndedCloseCode } from "../src/rpc.ts";
import { allEvents } from "./audit-events.ts";
import { consentCode } from "./connect-providers.ts";
import { connectionIn, newChat } from "./contexts.ts";
import { mockIdp } from "./idp.ts";
import { acmeTenant } from "./sign-in-config.ts";
import {
  auditedDuring,
  callAuth,
  openRpc,
  outcome,
  routed,
  signIn,
  signedIn,
  signedInWithRole,
  staffPerson,
  unique,
  whoami,
} from "./sign-in.ts";

// Offboarding (threat model ID4, SC7, PM8, R15, R16): an admin removes
// someone, or ends their sessions. These tests start from the ways it can
// fail: a removed person who keeps working through a session, a socket, a
// stub or a connection, or signs in again; someone other than an admin
// removing people; an organization left without an admin; and an
// offboarding that leaves no record, or a record with more than IDs.

const idp = mockIdp();

/** Someone signed in with `role`, their open connection and its API. */
const personWith = async (role: Role) => {
  const signed = await signedInWithRole(idp, role);
  const { core, closed } = await openRpc(signed.session);
  return { ...signed, closed, api: core.authenticate() };
};

type Person = Awaited<ReturnType<typeof personWith>>;

/** Who `session` is now, or the code a new connection is refused with. */
const nowSignedIn = async (session: string) => {
  try {
    const { role } = await whoami(session);
    return role;
  } catch (error) {
    return authErrors.codeOf(error) ?? String(error);
  }
};

/** `person` as core names them to connect. */
const asConnectPerson = (person: Person, role: Role, staff = false) => ({
  userId: person.userId,
  role,
  staff,
  email: String(person.person.email),
  accounts: [],
});

/** Connects `person`'s own Microsoft account as a personal connection. */
const connectOwnAccount = async (person: Person): Promise<string> => {
  const { url } = await person.api.connections.start({
    provider: "microsoft",
    scope: "personal",
  });
  const authorization = new URL(url);
  const query = new URLSearchParams({
    code: consentCode(authorization, acmeTenant, String(person.person.oid)),
    state: authorization.searchParams.get("state") ?? "",
  });
  await routed(`/api/connections/callback?${query.toString()}`, {
    headers: { cookie: person.session },
  });
  const [connection] = await person.api.connections.list();
  if (connection === undefined) {
    throw new Error("Not connected");
  }
  return connection.id;
};

const isDatabase = (value: unknown): value is D1Database =>
  typeof value === "object" &&
  value !== null &&
  "prepare" in value &&
  "batch" in value;

/** How many tokens connect's vault holds for `connectionId`. */
const tokensHeld = async (connectionId: string): Promise<number> => {
  // Connect's database, which the tests bind to core as well.
  const connectDb: unknown = Reflect.get(env, "CONNECT_DB");
  if (!isDatabase(connectDb)) {
    throw new TypeError("Expected connect's database as CONNECT_DB");
  }
  const row = await connectDb
    .prepare(
      "SELECT count(*) AS count FROM connection_tokens WHERE connection_id = ?"
    )
    .bind(connectionId)
    .first<{ count: number }>();
  return row?.count ?? 0;
};

describe("removing a member", () => {
  it("fails their open connection's next call, and closes it", async () => {
    const admin = await personWith("admin");
    const person = await personWith("user");
    await expect(person.api.whoami()).resolves.toMatchObject({ role: "user" });

    await admin.api.members.remove(person.userId);

    await expect(outcome(person.api.whoami())).resolves.toBe(
      "auth.unauthenticated"
    );
    await expect(person.closed).resolves.toBe(sessionEndedCloseCode);
  });

  it("ends every session they have, in every browser", async () => {
    const admin = await personWith("admin");
    const person = await personWith("user");
    const otherBrowser = await signedIn(idp, "microsoft", person.person);
    await expect(nowSignedIn(otherBrowser)).resolves.toBe("user");

    await admin.api.members.remove(person.userId);

    const sessions = await env.DB.prepare(
      "SELECT count(*) AS count FROM sessions WHERE user_id = ?"
    )
      .bind(person.userId)
      .first<{ count: number }>();
    expect(sessions?.count).toBe(0);
    await expect(
      Promise.all([nowSignedIn(person.session), nowSignedIn(otherBrowser)])
    ).resolves.toStrictEqual(["auth.unauthenticated", "auth.unauthenticated"]);
    const session = await callAuth("/get-session", person.session);
    await expect(session.json()).resolves.toBeNull();
  });

  it("keeps them out: signing in again through SSO gives no session", async () => {
    const admin = await personWith("admin");
    const person = await personWith("builder");
    await admin.api.members.remove(person.userId);

    const again = await signIn(idp, "microsoft", person.person);
    expect(again.session).toBeUndefined();
    const listed = await admin.api.members.list();
    expect(listed.map(({ userId }) => userId)).not.toContain(person.userId);
  });

  it("stops every stub an App or agent holds for them", async () => {
    const admin = await personWith("admin");
    const person = await personWith("builder");
    const { id: appId } = await admin.api.apps.create({
      name: `App ${unique()}`,
    });
    const app = { type: "app" as const, appId };
    const { id } = await admin.api.permissions.request({
      subject: app,
      object: { type: "connection", connectionId: "connection-outlook" },
      actions: ["mail.list"],
      binding: "OUTLOOK",
    });
    await admin.api.permissions.grant(id);
    const authority = authoritySchema.parse({
      subject: app,
      onBehalfOf: person.userId,
      mode: "workflow",
    });
    const held = await bindingsFor(env, authority, await newChat());
    const call = async () =>
      await outcome(
        connectionIn(held, "OUTLOOK")?.call("mail.list", {}) ??
          Promise.reject(new Error("No binding"))
      );
    // No such connection in connect: the call passed every check.
    await expect(call()).resolves.toBe("connect.connection_not_found");

    await admin.api.members.remove(person.userId);

    await expect(call()).resolves.toBe("permission.person_inactive");
    await expect(
      outcome(bindingsFor(env, authority, await newChat()))
    ).resolves.toBe("permission.person_inactive");
  });

  it("disconnects their personal connections and deletes the tokens", async () => {
    const admin = await personWith("admin");
    const person = await personWith("user");
    const connectionId = await connectOwnAccount(person);
    await expect(tokensHeld(connectionId)).resolves.toBeGreaterThan(0);

    await expect(
      admin.api.members.remove(person.userId)
    ).resolves.toStrictEqual({ connectionsDisconnected: 1 });

    await expect(tokensHeld(connectionId)).resolves.toBe(0);
    await expect(
      env.CONNECT.listConnections(asConnectPerson(person, "user"))
    ).resolves.toStrictEqual([]);
    // Connect sends its own events, to the same log.
    const disconnected = await vi.waitFor(async () => {
      const events = await allEvents();
      const found = events.find(
        ({ action, target }) =>
          action === "connection.disconnect" && target?.id === connectionId
      );
      if (found === undefined) {
        throw new Error("Not logged yet");
      }
      return found;
    });
    expect(disconnected).toMatchObject({
      source: "connect",
      actor: { type: "person", userId: admin.userId },
      target: { type: "connection", id: connectionId },
      detail: { ownerUserId: person.userId, outcome: "ok" },
    });
  });

  it("can be tried again, and is recorded once", async () => {
    const admin = await personWith("admin");
    const person = await personWith("user");
    const audited = await auditedDuring(async () => {
      await admin.api.members.remove(person.userId);
      await expect(
        admin.api.members.remove(person.userId)
      ).resolves.toStrictEqual({ connectionsDisconnected: 0 });
    });
    expect(
      audited.filter(({ action }) => action === "member.removed")
    ).toHaveLength(1);
  });

  it("is audited with who did it, and identifiers only", async () => {
    const admin = await personWith("admin");
    const person = await personWith("user");
    const audited = await auditedDuring(async () => {
      await admin.api.members.remove(person.userId);
    });
    const removed = audited.find(({ action }) => action === "member.removed");
    expect(removed).toMatchObject({
      source: "core",
      actor: { type: "person", userId: admin.userId },
      target: { type: "member" },
      detail: { userId: person.userId },
    });
    const text = JSON.stringify(removed);
    expect(text).not.toContain(String(person.person.email));
    expect(text).not.toContain(String(person.person.name));
    expect(text).not.toContain(person.session);
  });
});

describe("ending a member's sessions", () => {
  it("fails their open connection's next call and closes it, but keeps them a member", async () => {
    const admin = await personWith("admin");
    const person = await personWith("builder");

    await admin.api.members.revokeSessions(person.userId);

    await expect(outcome(person.api.whoami())).resolves.toBe(
      "auth.unauthenticated"
    );
    await expect(person.closed).resolves.toBe(sessionEndedCloseCode);
    await expect(nowSignedIn(person.session)).resolves.toBe(
      "auth.unauthenticated"
    );
    const again = await signedIn(idp, "microsoft", person.person);
    await expect(nowSignedIn(again)).resolves.toBe("builder");
  });

  it("is audited with who did it, and identifiers only", async () => {
    const admin = await personWith("admin");
    const person = await personWith("user");
    const audited = await auditedDuring(async () => {
      await admin.api.members.revokeSessions(person.userId);
    });
    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({
      source: "core",
      actor: { type: "person", userId: admin.userId },
      action: "member.sessions.revoked",
      target: { type: "member" },
      detail: { userId: person.userId },
    });
  });
});

describe("offboarding", () => {
  it("is for admins only, and refusals change nothing and record nothing", async () => {
    const target = await personWith("user");
    for (const role of ["user", "builder"] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one person at a time
      const caller = await personWith(role);
      // oxlint-disable-next-line no-await-in-loop -- one person at a time
      const audited = await auditedDuring(async () => {
        await expect(
          Promise.all([
            outcome(caller.api.members.list()),
            outcome(caller.api.members.remove(target.userId)),
            outcome(caller.api.members.revokeSessions(target.userId)),
          ])
        ).resolves.toStrictEqual([
          "role.forbidden",
          "role.forbidden",
          "role.forbidden",
        ]);
      });
      expect(audited).toStrictEqual([]);
    }
    await expect(target.api.whoami()).resolves.toMatchObject({ role: "user" });
  });

  it("is refused to Grasp staff, even with the admin role", async () => {
    const target = await personWith("user");
    const staff = await signedIn(idp, "grasp-staff", staffPerson());
    const { core } = await openRpc(staff);
    const api = core.authenticate();
    await expect(api.whoami()).resolves.toMatchObject({
      role: "admin",
      staff: true,
    });
    await expect(
      Promise.all([
        outcome(api.members.list()),
        outcome(api.members.remove(target.userId)),
        outcome(api.members.revokeSessions(target.userId)),
      ])
    ).resolves.toStrictEqual([
      "role.forbidden",
      "role.forbidden",
      "role.forbidden",
    ]);
    await expect(target.api.whoami()).resolves.toMatchObject({ role: "user" });
  });

  it("can't be turned on the admin themselves", async () => {
    const admin = await personWith("admin");
    await expect(
      Promise.all([
        outcome(admin.api.members.remove(admin.userId)),
        outcome(admin.api.members.revokeSessions(admin.userId)),
      ])
    ).resolves.toStrictEqual(["member.self", "member.self"]);
    await expect(admin.api.whoami()).resolves.toMatchObject({ role: "admin" });
  });

  it("never leaves the organization without an admin, even when two remove each other at once", async () => {
    const first = await personWith("admin");
    const second = await personWith("admin");
    // The two of them are the only admins left.
    await env.DB.prepare(
      "UPDATE members SET role = 'user' WHERE role = 'admin' AND user_id NOT IN (?, ?)"
    )
      .bind(first.userId, second.userId)
      .run();

    const outcomes = await Promise.all([
      outcome(first.api.members.remove(second.userId)),
      outcome(second.api.members.remove(first.userId)),
    ]);

    expect(outcomes.filter((each) => each === "ok")).toHaveLength(1);
    const admins = await env.DB.prepare(
      `SELECT count(*) AS count FROM members
       WHERE role = 'admin' AND user_id NOT IN (SELECT user_id FROM member_removals)`
    ).first<{ count: number }>();
    expect(admins?.count).toBe(1);
  });

  it("refuses people who aren't members, staff included", async () => {
    const admin = await personWith("admin");
    const staff = await signedIn(idp, "grasp-staff", staffPerson());
    const { userId: staffId } = await whoami(staff);
    for (const userId of ["nobody", staffId]) {
      // oxlint-disable-next-line no-await-in-loop -- one at a time
      await expect(
        Promise.all([
          outcome(admin.api.members.remove(userId)),
          outcome(admin.api.members.revokeSessions(userId)),
        ])
      ).resolves.toStrictEqual(["member.not_found", "member.not_found"]);
    }
    await expect(nowSignedIn(staff)).resolves.toBe("admin");
  });

  it("lists the members for admins, with their roles", async () => {
    const admin = await personWith("admin");
    const person = await personWith("builder");
    const listed = await admin.api.members.list();
    const member = listed.find(({ userId }) => userId === person.userId);
    expect(member).toMatchObject({
      name: String(person.person.name),
      email: String(person.person.email),
      role: "builder",
    });
    expect(Number.isNaN(Date.parse(member?.joinedAt ?? ""))).toBeFalsy();
  });

  it("goes only through core's own API, not Better Auth's member route", async () => {
    const admin = await personWith("admin");
    const person = await personWith("user");
    const removed = await callAuth(
      "/organization/remove-member",
      admin.session,
      { memberIdOrEmail: String(person.person.email) }
    );
    expect(removed.status).toBe(404);
    await expect(person.api.whoami()).resolves.toMatchObject({ role: "user" });
  });
});

describe("connect's offboarding call", () => {
  it("disconnects someone's personal connections for admins only", async () => {
    const person = await personWith("user");
    const connectionId = await connectOwnAccount(person);
    const colleague = await personWith("builder");
    await expect(
      Promise.all([
        outcome(
          env.CONNECT.disconnectPersonal({
            person: asConnectPerson(colleague, "builder"),
            ownerUserId: person.userId,
          })
        ),
        outcome(
          env.CONNECT.disconnectPersonal({
            person: asConnectPerson(colleague, "admin", true),
            ownerUserId: person.userId,
          })
        ),
      ])
    ).resolves.toStrictEqual(["role.forbidden", "role.forbidden"]);
    await expect(tokensHeld(connectionId)).resolves.toBeGreaterThan(0);
  });
});
