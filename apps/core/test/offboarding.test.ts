import {
  disconnectPersonalMaxOwners,
  oauthFlowLifetimeMs,
} from "@grasp-os/shared/connect";
import type { DisconnectPersonal } from "@grasp-os/shared/connect";
import { authErrors } from "@grasp-os/shared/errors";
import { authoritySchema } from "@grasp-os/shared/permissions";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { sessionEndedCloseCode } from "../src/rpc.ts";
import { allEvents } from "./audit-events.ts";
import { consentCode } from "./connect-providers.ts";
import { connectionIn, envOf, reached } from "./contexts.ts";
import { runCron } from "./cron.ts";
import { mockIdp } from "./idp.ts";
import { acmeTenant, clientOrigin } from "./sign-in-config.ts";
import {
  auditedDuring,
  callAuth,
  onlyAdmins,
  openRpc,
  outcome,
  routed,
  signIn,
  signedIn,
  signedInApi,
  staffPerson,
  unique,
  whoami,
  withSignIn,
} from "./sign-in.ts";
import { connectDb } from "./test-env.ts";

// Offboarding (threat model ID4, SC7, PM8, R15, R16): an admin removes
// someone, or ends their sessions. These tests start from the ways it can
// fail: a removed person who keeps working through a session, a socket, a
// stub or a connection, or signs in again; someone other than an admin
// removing people; an organization left without an admin; and an
// offboarding that leaves no record, or a record with more than IDs.

const idp = mockIdp();

type Person = Awaited<ReturnType<typeof signedInApi>>;

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

/** How many tokens connect's vault holds for `connectionId`. */
const tokensHeld = async (connectionId: string): Promise<number> => {
  const row = await connectDb()
    .prepare(
      "SELECT count(*) AS count FROM connection_tokens WHERE connection_id = ?"
    )
    .bind(connectionId)
    .first<{ count: number }>();
  return row?.count ?? 0;
};

describe("removing a member", () => {
  it("fails their open connection's next call, and closes it", async () => {
    const admin = await signedInApi(idp, "admin");
    const person = await signedInApi(idp, "user");
    await expect(person.api.whoami()).resolves.toMatchObject({ role: "user" });

    await admin.api.members.remove(person.userId);

    await expect(outcome(person.api.whoami())).resolves.toBe(
      "auth.unauthenticated"
    );
    await expect(person.closed).resolves.toBe(sessionEndedCloseCode);
  });

  it("ends every session they have, in every browser", async () => {
    const admin = await signedInApi(idp, "admin");
    const person = await signedInApi(idp, "user");
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
    const admin = await signedInApi(idp, "admin");
    const person = await signedInApi(idp, "builder");
    await admin.api.members.remove(person.userId);

    const again = await signIn(idp, "microsoft", person.person);
    expect(again.session).toBeUndefined();
    const listed = await admin.api.members.list();
    expect(listed.map(({ userId }) => userId)).not.toContain(person.userId);
  });

  it("stops every stub an App or agent holds for them", async () => {
    const admin = await signedInApi(idp, "admin");
    const person = await signedInApi(idp, "builder");
    const { id: appId } = await admin.api.apps.create({
      name: `App ${unique()}`,
    });
    const app = { type: "app" as const, appId };
    const { id } = await person.api.permissions.request({
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
    const held = await envOf(authority);
    const call = async () =>
      await outcome(
        connectionIn(held, "OUTLOOK")?.call("mail.list", {}) ??
          Promise.reject(new Error("No binding"))
      );
    await expect(call()).resolves.toBe(reached);

    await admin.api.members.remove(person.userId);

    await expect(call()).resolves.toBe("permission.person_inactive");
    await expect(outcome(envOf(authority))).resolves.toBe(
      "permission.person_inactive"
    );
  });

  it("disconnects their personal connections and deletes the tokens", async () => {
    const admin = await signedInApi(idp, "admin");
    const person = await signedInApi(idp, "user");
    const connectionId = await connectOwnAccount(person);
    await expect(tokensHeld(connectionId)).resolves.toBeGreaterThan(0);

    await expect(
      admin.api.members.remove(person.userId)
    ).resolves.toStrictEqual({ connectionsDisconnected: 1 });

    await expect(tokensHeld(connectionId)).resolves.toBe(0);
    await expect(
      env.CONNECT.listConnections(asConnectPerson(person, "user"))
    ).resolves.toStrictEqual([]);
    // Connect's own events reach the same log once they're drained from its
    // outbox, as core's cron trigger does (and `allEvents` does first).
    const events = await allEvents();
    const disconnected = events.find(
      ({ action, target }) =>
        action === "connection.disconnect" && target?.id === connectionId
    );
    expect(disconnected).toMatchObject({
      source: "connect",
      actor: { type: "person", userId: admin.userId },
      target: { type: "connection", id: connectionId },
      detail: { ownerUserId: person.userId, outcome: "ok" },
    });
  });

  it("can be tried again, and is recorded once", async () => {
    const admin = await signedInApi(idp, "admin");
    const person = await signedInApi(idp, "user");
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
    const admin = await signedInApi(idp, "admin");
    const person = await signedInApi(idp, "user");
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
    const admin = await signedInApi(idp, "admin");
    const person = await signedInApi(idp, "builder");

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
    const admin = await signedInApi(idp, "admin");
    const person = await signedInApi(idp, "user");
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
    const target = await signedInApi(idp, "user");
    for (const role of ["user", "builder"] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one person at a time
      const caller = await signedInApi(idp, role);
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
    const target = await signedInApi(idp, "user");
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
    const admin = await signedInApi(idp, "admin");
    await expect(
      Promise.all([
        outcome(admin.api.members.remove(admin.userId)),
        outcome(admin.api.members.revokeSessions(admin.userId)),
      ])
    ).resolves.toStrictEqual(["member.self", "member.self"]);
    await expect(admin.api.whoami()).resolves.toMatchObject({ role: "admin" });
  });

  it("never leaves the organization without an admin, even when two remove each other at once", async () => {
    const first = await signedInApi(idp, "admin");
    const second = await signedInApi(idp, "admin");
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
    const admin = await signedInApi(idp, "admin");
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
    const admin = await signedInApi(idp, "admin");
    const person = await signedInApi(idp, "builder");
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
    const admin = await signedInApi(idp, "admin");
    const person = await signedInApi(idp, "user");
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
    const person = await signedInApi(idp, "user");
    const connectionId = await connectOwnAccount(person);
    const colleague = await signedInApi(idp, "builder");
    await expect(
      Promise.all([
        outcome(
          env.CONNECT.disconnectPersonal({
            person: asConnectPerson(colleague, "builder"),
            ownerUserIds: [person.userId],
          })
        ),
        outcome(
          env.CONNECT.disconnectPersonal({
            person: asConnectPerson(colleague, "admin", true),
            ownerUserIds: [person.userId],
          })
        ),
      ])
    ).resolves.toStrictEqual(["role.forbidden", "role.forbidden"]);
    await expect(tokensHeld(connectionId)).resolves.toBeGreaterThan(0);
  });
});

describe("removing a member, while their OAuth flows are open", () => {
  it("spends the flows they started, so none finishes into a connection", async () => {
    const admin = await signedInApi(idp, "admin");
    const person = await signedInApi(idp, "user");
    const { url } = await person.api.connections.start({
      provider: "microsoft",
      scope: "personal",
    });
    const authorization = new URL(url);

    await admin.api.members.remove(person.userId);

    const finished = env.CONNECT.finishConnection({
      person: {
        ...asConnectPerson(person, "user"),
        accounts: [
          { provider: "microsoft", subject: String(person.person.oid) },
        ],
      },
      state: authorization.searchParams.get("state") ?? "",
      code: consentCode(authorization, acmeTenant, String(person.person.oid)),
    });
    await expect(outcome(finished)).resolves.toBe("connection.flow_invalid");
  });

  it("disconnects a connection that finished anyway, on the next cron run", async () => {
    const admin = await signedInApi(idp, "admin");
    const person = await signedInApi(idp, "user");
    await admin.api.members.remove(person.userId);
    // A flow already past its spending when the removal ran, finishing
    // after it: connect itself doesn't know who is a member.
    const owner = {
      ...asConnectPerson(person, "user"),
      accounts: [
        { provider: "microsoft" as const, subject: String(person.person.oid) },
      ],
    };
    const { url } = await env.CONNECT.startConnection({
      person: owner,
      provider: "microsoft",
      scope: "personal",
      origin: clientOrigin,
      tenant: acmeTenant,
      returnTo: "/",
    });
    const authorization = new URL(url);
    const { connectionId } = await env.CONNECT.finishConnection({
      person: owner,
      state: authorization.searchParams.get("state") ?? "",
      code: consentCode(authorization, acmeTenant, String(person.person.oid)),
    });
    await expect(tokensHeld(connectionId)).resolves.toBeGreaterThan(0);

    await runCron();

    await expect(tokensHeld(connectionId)).resolves.toBe(0);
    await expect(env.CONNECT.listConnections(owner)).resolves.toStrictEqual([]);
  });
});

/** Connect as it is, but for its offboarding call, which is `call`. */
const connectWith = (
  call: (request: DisconnectPersonal) => Promise<{ disconnected: number }>
): Env["CONNECT"] =>
  new Proxy(env.CONNECT, {
    get: (target, key) => {
      if (key === "disconnectPersonal") {
        return call;
      }
      // Everything else as connect has it: its audit outbox, say, which
      // the same cron run drains.
      const value: unknown = Reflect.get(target, key);
      return value;
    },
  });

/** Connect whose offboarding call fails, as when it can't be reached. */
const connectDown = connectWith(() => {
  throw new Error("connect unreachable");
});

/** Connect as it is, counting its offboarding calls. */
const countingConnect = () => {
  const calls: DisconnectPersonal[] = [];
  const connect = connectWith(async (request) => {
    calls.push(request);
    return await env.CONNECT.disconnectPersonal(request);
  });
  return { calls, connect };
};

/** Past the OAuth flow's lifetime after every removal made so far. */
const afterFlowsExpire = async (run: () => Promise<void>): Promise<void> => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + oauthFlowLifetimeMs + 60_000);
  try {
    await run();
  } finally {
    vi.useRealTimers();
  }
};

const dayMs = 24 * 60 * 60 * 1000;

/** Records `count` people as removed at `removedAt`, as a removal would. */
const removedLongAgo = async (count: number, removedAt: number) => {
  const now = Date.now();
  const ids = Array.from({ length: count }, () => `removed-${unique()}`);
  await env.DB.batch(
    ids.flatMap((id) => [
      env.DB.prepare(
        "INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES (?, 'Removed', ?, 1, ?, ?)"
      ).bind(id, `${id}@acme.test`, now, now),
      env.DB.prepare(
        "INSERT INTO member_removals (organization_id, user_id, removed_at) VALUES ('organization', ?, ?)"
      ).bind(id, removedAt),
    ])
  );
};

describe("the cron trigger's disconnect retry", () => {
  it("retries every removal until its disconnect completes, however many and however old", async () => {
    const admin = await signedInApi(idp, "admin");
    const person = await signedInApi(idp, "user");
    const connectionId = await connectOwnAccount(person);
    // The removal's own disconnect fails, and so does the next retry.
    const { core } = await openRpc(admin.session, {
      coreEnv: { ...env, CONNECT: connectDown },
    });
    await expect(
      outcome(core.authenticate().members.remove(person.userId))
    ).resolves.toBe("member.connections_pending");
    await runCron({ CONNECT: connectDown });
    await expect(tokensHeld(connectionId)).resolves.toBeGreaterThan(0);
    // As if all that was months ago, with more removals still pending
    // since than one call to connect takes.
    await env.DB.prepare(
      "UPDATE member_removals SET removed_at = ? WHERE user_id = ?"
    )
      .bind(Date.now() - 90 * dayMs, person.userId)
      .run();
    await removedLongAgo(
      disconnectPersonalMaxOwners + 50,
      Date.now() - 60 * dayMs
    );

    await afterFlowsExpire(async () => {
      await runCron();
    });

    await expect(tokensHeld(connectionId)).resolves.toBe(0);
    // Every one of them completed: the next run finds nothing to do.
    const { calls, connect } = countingConnect();
    await afterFlowsExpire(async () => {
      await runCron({ CONNECT: connect });
    });
    expect(calls).toStrictEqual([]);
  });

  it("sends connect a few batches at a time, and still gets through them all", async () => {
    // Its own removal time, to find these removals by.
    const removedAt = Date.now() - dayMs - Math.floor(Math.random() * dayMs);
    await removedLongAgo(disconnectPersonalMaxOwners * 6, removedAt);
    let inFlight = 0;
    let mostInFlight = 0;
    const connect = connectWith(async (request) => {
      inFlight += 1;
      mostInFlight = Math.max(mostInFlight, inFlight);
      try {
        return await env.CONNECT.disconnectPersonal(request);
      } finally {
        inFlight -= 1;
      }
    });

    await runCron({ CONNECT: connect });

    expect(mostInFlight).toBeGreaterThan(1);
    expect(mostInFlight).toBeLessThanOrEqual(4);
    const pending = await env.DB.prepare(
      "SELECT count(*) AS count FROM member_removals WHERE removed_at = ? AND disconnected_at IS NULL"
    )
      .bind(removedAt)
      .first<{ count: number }>();
    expect(pending?.count).toBe(0);
  });
});

/** How many admins the organization has now. */
const activeAdmins = async (): Promise<number> => {
  const row = await env.DB.prepare(
    `SELECT count(*) AS count FROM members
     WHERE role = 'admin' AND user_id NOT IN (SELECT user_id FROM member_removals)`
  ).first<{ count: number }>();
  return row?.count ?? 0;
};

describe("changing a member's role", () => {
  it("applies on their next call, and is audited with identifiers only", async () => {
    const admin = await signedInApi(idp, "admin");
    const person = await signedInApi(idp, "user");
    const audited = await auditedDuring(async () => {
      await admin.api.members.setRole(person.userId, "builder");
    });
    await expect(person.api.whoami()).resolves.toMatchObject({
      role: "builder",
    });
    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({
      actor: { type: "person", userId: admin.userId },
      action: "member.role.updated",
      target: { type: "member" },
      detail: { userId: person.userId, previousRole: "user", role: "builder" },
    });
  });

  it("records each change against the role it replaced, and refuses one that another admin's change overtook", async () => {
    const [first, second, person] = await Promise.all([
      signedInApi(idp, "admin"),
      signedInApi(idp, "admin"),
      signedInApi(idp, "user"),
    ]);
    // The second admin's change lands after the first admin's change read
    // the role, just before it writes.
    let overtaken = false;
    const overtakingDb = new Proxy(env.DB, {
      get: (target, key) => {
        if (key === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            if (!overtaken) {
              overtaken = true;
              await second.api.members.setRole(person.userId, "builder");
            }
            return await target.batch(statements);
          };
        }
        const value: unknown = Reflect.get(target, key, target);
        if (typeof value !== "function") {
          return value;
        }
        const bound: unknown = value.bind(target);
        return bound;
      },
    });
    const { core } = await openRpc(first.session, {
      coreEnv: { ...env, DB: overtakingDb },
    });

    const audited = await auditedDuring(async () => {
      await expect(
        outcome(core.authenticate().members.setRole(person.userId, "admin"))
      ).resolves.toBe("member.role_changed");
    });
    await expect(person.api.whoami()).resolves.toMatchObject({
      role: "builder",
    });
    expect(
      audited
        .filter(({ action }) => action === "member.role.updated")
        .map(({ detail }) => detail)
    ).toStrictEqual([
      { userId: person.userId, previousRole: "user", role: "builder" },
    ]);

    // Trying again changes it from the role it has now.
    const again = await auditedDuring(async () => {
      await core.authenticate().members.setRole(person.userId, "admin");
    });
    expect(again.map(({ detail }) => detail)).toStrictEqual([
      { userId: person.userId, previousRole: "builder", role: "admin" },
    ]);
  });

  it("is for admins only, and only to one of Grasp's roles", async () => {
    const admin = await signedInApi(idp, "admin");
    const person = await signedInApi(idp, "builder");
    await expect(
      Promise.all([
        outcome(person.api.members.setRole(person.userId, "admin")),
        ...["owner", "member", "admin,builder"].map(
          async (role) =>
            await outcome(
              admin.api.members.setRole(
                person.userId,
                // SAFETY: not a role at all: what a client could send anyway.
                // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
                role as Role
              )
            )
        ),
      ])
    ).resolves.toStrictEqual([
      "role.forbidden",
      "member.role_invalid",
      "member.role_invalid",
      "member.role_invalid",
    ]);
    await expect(person.api.whoami()).resolves.toMatchObject({
      role: "builder",
    });
  });

  it("goes only through core's own API, not Better Auth's member route", async () => {
    const admin = await signedInApi(idp, "admin");
    const person = await signedInApi(idp, "user");
    const changed = await callAuth(
      "/organization/update-member-role",
      admin.session,
      { memberId: person.userId, role: "admin" }
    );
    expect(changed.status).toBe(404);
    await expect(person.api.whoami()).resolves.toMatchObject({ role: "user" });
  });
});

describe("the organization's admins", () => {
  it("can't all be demoted: the last admin stays one", async () => {
    const admin = await signedInApi(idp, "admin");
    await onlyAdmins(admin.userId);
    await expect(
      outcome(admin.api.members.setRole(admin.userId, "user"))
    ).resolves.toBe("member.last_admin");
    await expect(admin.api.whoami()).resolves.toMatchObject({ role: "admin" });
  });

  it("keep one when two admins demote themselves at once", async () => {
    for (const _round of [1, 2, 3]) {
      // oxlint-disable-next-line no-await-in-loop -- one round at a time
      const [first, second] = await Promise.all([
        signedInApi(idp, "admin"),
        signedInApi(idp, "admin"),
      ]);
      // oxlint-disable-next-line no-await-in-loop -- one round at a time
      await onlyAdmins(first.userId, second.userId);
      // oxlint-disable-next-line no-await-in-loop -- one round at a time
      const outcomes = await Promise.all([
        outcome(first.api.members.setRole(first.userId, "user")),
        outcome(second.api.members.setRole(second.userId, "user")),
      ]);
      expect(outcomes.filter((each) => each === "ok")).toHaveLength(1);
      // oxlint-disable-next-line no-await-in-loop -- one round at a time
      await expect(activeAdmins()).resolves.toBe(1);
    }
  });

  it("keep one when an admin removes another who demotes them at once", async () => {
    for (const _round of [1, 2, 3]) {
      // oxlint-disable-next-line no-await-in-loop -- one round at a time
      const [first, second] = await Promise.all([
        signedInApi(idp, "admin"),
        signedInApi(idp, "admin"),
      ]);
      // oxlint-disable-next-line no-await-in-loop -- one round at a time
      await onlyAdmins(first.userId, second.userId);
      // oxlint-disable-next-line no-await-in-loop -- one round at a time
      const outcomes = await Promise.all([
        outcome(first.api.members.remove(second.userId)),
        outcome(second.api.members.setRole(first.userId, "user")),
      ]);
      expect(outcomes.filter((each) => each === "ok")).toHaveLength(1);
      // oxlint-disable-next-line no-await-in-loop -- one round at a time
      await expect(activeAdmins()).resolves.toBe(1);
    }
  });

  it("come back through the deployment's configured admins when none is left", async () => {
    const configured = await signedInApi(idp, "admin");
    const other = await signedInApi(idp, "admin");
    const coreEnv = withSignIn({ admins: [configured.person.email] });
    // Demoted while someone else is an admin: signing in keeps the role.
    await other.api.members.setRole(configured.userId, "user");
    await signedIn(idp, "microsoft", configured.person, { coreEnv });
    await expect(nowSignedIn(configured.session)).resolves.toBe("user");

    // No admin left (as after a D1 edit): signing in restores them.
    await env.DB.prepare(
      "UPDATE members SET role = 'user' WHERE role = 'admin'"
    ).run();
    await expect(activeAdmins()).resolves.toBe(0);
    let again = "";
    const audited = await auditedDuring(async () => {
      again = await signedIn(idp, "microsoft", configured.person, { coreEnv });
    });
    await expect(nowSignedIn(again)).resolves.toBe("admin");
    expect(audited).toContainEqual(
      expect.objectContaining({
        actor: { type: "system" },
        action: "member.role.updated",
        detail: {
          userId: configured.userId,
          role: "admin",
          reason: "no_admin_left",
        },
      })
    );
  });

  it("come back only with a record of it: a restore that can't be audited doesn't happen", async () => {
    const configured = await signedInApi(idp, "admin");
    const coreEnv = withSignIn({ admins: [configured.person.email] });
    await env.DB.prepare(
      "UPDATE members SET role = 'user' WHERE role = 'admin'"
    ).run();
    // The audit outbox refuses every write while the restore runs.
    await env.DB.prepare(
      "CREATE TRIGGER audit_outbox_down BEFORE INSERT ON audit_outbox BEGIN SELECT RAISE(ABORT, 'outbox down'); END"
    ).run();
    try {
      await outcome(signIn(idp, "microsoft", configured.person, { coreEnv }));
    } finally {
      await env.DB.prepare("DROP TRIGGER audit_outbox_down").run();
    }
    await expect(activeAdmins()).resolves.toBe(0);

    // Signing in again, with the outbox back, restores and records it.
    let again = "";
    const audited = await auditedDuring(async () => {
      again = await signedIn(idp, "microsoft", configured.person, { coreEnv });
    });
    await expect(nowSignedIn(again)).resolves.toBe("admin");
    expect(
      audited.filter(
        ({ action, detail }) =>
          action === "member.role.updated" && detail?.reason === "no_admin_left"
      )
    ).toHaveLength(1);
  });

  it("don't come back when removed, configured or not", async () => {
    const configured = await signedInApi(idp, "admin");
    const admin = await signedInApi(idp, "admin");
    await admin.api.members.remove(configured.userId);
    await env.DB.prepare(
      "UPDATE members SET role = 'user' WHERE role = 'admin'"
    ).run();
    const again = await signIn(idp, "microsoft", configured.person, {
      coreEnv: withSignIn({ admins: [configured.person.email] }),
    });
    expect(again.session).toBeUndefined();
    await expect(activeAdmins()).resolves.toBe(0);
  });
});
