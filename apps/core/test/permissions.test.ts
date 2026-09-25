import type { Role } from "@grasp-os/shared";
import { capabilityErrors, signCapability } from "@grasp-os/shared/capability";
import { connectErrors } from "@grasp-os/shared/connect";
import {
  authoritySchema,
  permissionErrors,
  permissionObjectSchema,
} from "@grasp-os/shared/permissions";
import type {
  Authority,
  PermissionRequest,
  PermissionSubjectInput,
} from "@grasp-os/shared/permissions";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { bindingsFor } from "../src/bindings.ts";
import { authorize } from "../src/permissions.ts";
import { mockIdp } from "./idp.ts";
import { auditedDuring, openRpc, signedInWithRole } from "./sign-in.ts";

// Apps and agents start with nothing: a person asks, an admin grants, and
// every call is checked again on the server, down to connect, which only
// acts on a capability core signed for exactly that call. These tests try
// to get around each of those.

const idp = mockIdp();

/** A signed-in person's permission API, on a connection of their own. */
const permissionApi = async (role: Role) => {
  const person = await signedInWithRole(idp, role);
  const { core } = await openRpc(person.session);
  return { ...person, api: core.authenticate() };
};

const unique = () => crypto.randomUUID().slice(0, 8);

const newApp = () => ({ type: "app" as const, appId: `app-${unique()}` });

/** Outlook, as a connection an App may be given. */
const outlook = (subject: PermissionSubjectInput): PermissionRequest => ({
  subject,
  object: { type: "connection", connectionId: "connection-outlook" },
  actions: ["mail.list"],
  binding: "OUTLOOK",
});

const actingFor = (
  subject: PermissionSubjectInput,
  userId: string
): Authority =>
  authoritySchema.parse({ subject, onBehalfOf: userId, mode: "interactive" });

/** The code a promise was refused with, or "ok" if it wasn't. */
const outcome = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return "ok";
  } catch (error) {
    return (
      permissionErrors.codeOf(error) ??
      connectErrors.codeOf(error) ??
      capabilityErrors.codeOf(error) ??
      String(error)
    );
  }
};

type Stub = Awaited<ReturnType<typeof bindingsFor>>[string];

/**
 * What App code gets when it calls a connection stub from its env.
 * Connections don't exist in connect yet, so "connect.connection_not_found"
 * is a call that passed every check, core's and connect's.
 */
const callStub = async (
  stub: Stub | undefined,
  action = "mail.list"
): Promise<string> =>
  stub ? await outcome(stub.call(action, {})) : "no binding";

/** Builds the env as an App load or a workflow resume does, and calls `binding`. */
const callThrough = async (
  authority: Authority,
  binding: string,
  action = "mail.list"
): Promise<string> => {
  const bindings = await bindingsFor(env, authority);
  return await callStub(bindings[binding], action);
};

/** Reached through connect, as a call from an App would be. */
const reached = "connect.connection_not_found";

describe("permissions", () => {
  it("allow nothing until an admin grants them", async () => {
    const admin = await permissionApi("admin");
    const builder = await permissionApi("builder");
    const app = newApp();
    const authority = actingFor(app, builder.userId);

    const before = await callThrough(authority, "OUTLOOK");
    const requested = await builder.api.requestPermission(outlook(app));
    const whileRequested = await Promise.all([
      callThrough(authority, "OUTLOOK"),
      outcome(authorize(env, authority, requested.object, "mail.list")),
    ]);
    expect({ before, status: requested.status, whileRequested }).toStrictEqual({
      before: "no binding",
      status: "requested",
      whileRequested: ["no binding", "permission.denied"],
    });

    const granted = await admin.api.grantPermission(requested.id);
    expect(granted).toMatchObject({
      status: "active",
      grantedBy: admin.userId,
    });
    await expect(callThrough(authority, "OUTLOOK")).resolves.toBe(reached);
  });

  it("can only be granted and revoked by an admin, even their own", async () => {
    const admin = await permissionApi("admin");
    const app = newApp();
    for (const role of ["builder", "user"] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one person at a time
      const person = await permissionApi(role);
      // oxlint-disable-next-line no-await-in-loop -- one person at a time
      const request = await admin.api.requestPermission({
        ...outlook(app),
        binding: `OUTLOOK_${role.toUpperCase()}`,
      });
      // oxlint-disable-next-line no-await-in-loop -- one person at a time
      const refused = await Promise.all([
        outcome(person.api.grantPermission(request.id)),
        outcome(person.api.revokePermission(request.id)),
      ]);
      expect(refused).toStrictEqual([
        "permission.forbidden",
        "permission.forbidden",
      ]);
    }
    const user = await permissionApi("user");
    await expect(
      Promise.all([
        outcome(user.api.requestPermission(outlook(app))),
        outcome(user.api.listPermissions()),
      ])
    ).resolves.toStrictEqual(["permission.forbidden", "permission.forbidden"]);
    const all = await admin.api.listPermissions(app);
    expect(all.map(({ status }) => status)).toStrictEqual([
      "requested",
      "requested",
    ]);
  });

  it("stop working at the next call once revoked, in stubs already handed out", async () => {
    const admin = await permissionApi("admin");
    const app = newApp();
    const authority = actingFor(app, admin.userId);
    const { id } = await admin.api.requestPermission(outlook(app));
    await admin.api.grantPermission(id);

    // A running App or workflow keeps the env it was given.
    const { OUTLOOK: held } = await bindingsFor(env, authority);
    await expect(callStub(held)).resolves.toBe(reached);

    const revoked = await admin.api.revokePermission(id);
    expect(revoked).toMatchObject({
      status: "revoked",
      revokedBy: admin.userId,
    });
    await expect(callStub(held)).resolves.toBe("permission.denied");
    // The next load or resume doesn't get it at all.
    await expect(bindingsFor(env, authority)).resolves.toStrictEqual({});
    // And it can't be granted back to life.
    await expect(outcome(admin.api.grantPermission(id))).resolves.toBe(
      "permission.not_requested"
    );
  });

  it("belong to their subject alone: not another App, not an agent with the same ID", async () => {
    const admin = await permissionApi("admin");
    const app = newApp();
    const { id } = await admin.api.requestPermission(outlook(app));
    await admin.api.grantPermission(id);
    const others: PermissionSubjectInput[] = [
      { type: "agent", agentId: app.appId },
      newApp(),
    ];
    const results = await Promise.all(
      others.map(
        async (other) =>
          await callThrough(actingFor(other, admin.userId), "OUTLOOK")
      )
    );
    expect(results).toStrictEqual(["no binding", "no binding"]);
    const checks = await Promise.all(
      others.map(
        async (other) =>
          await outcome(
            authorize(
              env,
              actingFor(other, admin.userId),
              permissionObjectSchema.parse(outlook(app).object),
              "mail.list"
            )
          )
      )
    );
    expect(checks).toStrictEqual(["permission.denied", "permission.denied"]);
  });

  it("allow only their own actions, on their own resource", async () => {
    const admin = await permissionApi("admin");
    const app = newApp();
    const authority = actingFor(app, admin.userId);
    const finance = {
      type: "connection",
      connectionId: "connection-shared-mail",
      resource: "finance@acme.test",
    } as const;
    const { id } = await admin.api.requestPermission({
      subject: app,
      object: finance,
      actions: ["mail.list"],
      binding: "FINANCE_MAIL",
    });
    await admin.api.grantPermission(id);

    await expect(
      Promise.all([
        callThrough(authority, "FINANCE_MAIL"),
        callThrough(authority, "FINANCE_MAIL", "mail.send"),
        callThrough(authority, "FINANCE_MAIL", "mail.list; mail.send"),
      ])
    ).resolves.toStrictEqual([
      reached,
      "permission.denied",
      "connect.invalid_call",
    ]);

    const checks = await Promise.all(
      [
        finance,
        { ...finance, resource: "ceo@acme.test" },
        // One mailbox isn't the whole connection.
        { type: "connection", connectionId: finance.connectionId },
        { type: "collection", collectionId: "c" },
      ].map(
        async (object) =>
          await outcome(
            authorize(
              env,
              authority,
              permissionObjectSchema.parse(object),
              "mail.list"
            )
          )
      )
    );
    expect(checks).toStrictEqual([
      "ok",
      "permission.denied",
      "permission.denied",
      "permission.denied",
    ]);
  });

  it("stop working when the person they act for leaves", async () => {
    const admin = await permissionApi("admin");
    const builder = await permissionApi("builder");
    const app = newApp();
    const { id } = await admin.api.requestPermission(outlook(app));
    await admin.api.grantPermission(id);
    const authority = actingFor(app, builder.userId);
    const { OUTLOOK: held } = await bindingsFor(env, authority);

    await env.DB.prepare("DELETE FROM members WHERE user_id = ?")
      .bind(builder.userId)
      .run();
    await expect(callStub(held)).resolves.toBe("permission.person_inactive");
    await expect(outcome(bindingsFor(env, authority))).resolves.toBe(
      "permission.person_inactive"
    );
  });

  it("build an env with a stub for each active grant, and nothing else", async () => {
    const admin = await permissionApi("admin");
    const app = newApp();
    const grant = async (request: PermissionRequest) => {
      const { id } = await admin.api.requestPermission(request);
      return await admin.api.grantPermission(id);
    };
    await grant(outlook(app));
    await admin.api.requestPermission({ ...outlook(app), binding: "ASKED" });
    const gone = await grant({ ...outlook(app), binding: "GONE" });
    await admin.api.revokePermission(gone.id);
    await grant({
      subject: app,
      object: { type: "collection", collectionId: "collection-policies" },
      actions: ["read"],
      binding: "POLICIES",
    });
    await grant({ ...outlook(newApp()), binding: "SOMEONE_ELSES" });

    const bindings = await bindingsFor(env, actingFor(app, admin.userId));
    expect(Object.keys(bindings)).toStrictEqual(["OUTLOOK"]);
  });

  it("are refused when they would reach past a stub's names", async () => {
    const admin = await permissionApi("admin");
    const app = newApp();
    const requests: PermissionRequest[] = [
      { ...outlook(app), binding: "__proto__" },
      { ...outlook(app), binding: "constructor" },
      { ...outlook(app), binding: "outlook" },
      { ...outlook(app), actions: [] },
      { ...outlook(app), actions: ["mail.list", "mail.list"] },
      {
        subject: app,
        object: { type: "collection", collectionId: "c" },
        actions: ["delete"],
        binding: "C",
      },
      {
        subject: app,
        object: { type: "workflow", appId: "a", workflowId: "w" },
        actions: ["write"],
        binding: "W",
      },
    ];
    const refused = await Promise.all(
      requests.map(
        async (request) => await outcome(admin.api.requestPermission(request))
      )
    );
    expect(refused).toStrictEqual(requests.map(() => "permission.invalid"));
  });

  it("keep binding names unique while they're live", async () => {
    const admin = await permissionApi("admin");
    const app = newApp();
    const first = await admin.api.requestPermission(outlook(app));
    await expect(
      outcome(admin.api.requestPermission(outlook(app)))
    ).resolves.toBe("permission.conflict");
    await admin.api.revokePermission(first.id);
    await expect(
      outcome(admin.api.requestPermission(outlook(app)))
    ).resolves.toBe("ok");
  });

  it("are audited when requested, granted and revoked, by who did it", async () => {
    const admin = await permissionApi("admin");
    const builder = await permissionApi("builder");
    const app = newApp();
    let id = "";
    const events = await auditedDuring(async () => {
      ({ id } = await builder.api.requestPermission(outlook(app)));
      await admin.api.grantPermission(id);
      await admin.api.revokePermission(id);
      // Revoking again changes nothing, so it records nothing.
      await admin.api.revokePermission(id);
    });
    const target = { type: "permission", id };
    const detail = {
      subjectType: "app",
      subjectId: app.appId,
      objectType: "connection",
      connectionId: "connection-outlook",
      actions: "mail.list",
      binding: "OUTLOOK",
    };
    expect(
      events.map((event) => ({
        actor: event.actor,
        action: event.action,
        target: event.target,
        detail: event.detail,
      }))
    ).toStrictEqual([
      {
        actor: { type: "person", userId: builder.userId },
        action: "permission.requested",
        target,
        detail,
      },
      {
        actor: { type: "person", userId: admin.userId },
        action: "permission.granted",
        target,
        detail,
      },
      {
        actor: { type: "person", userId: admin.userId },
        action: "permission.revoked",
        target,
        detail,
      },
    ]);
  });
});

describe("connect, called over the service binding", () => {
  it("refuses a call without a capability core signed for exactly it", async () => {
    const authority = actingFor(newApp(), "user-anna");
    const call = {
      connectionId: "connection-outlook",
      action: "mail.list",
      input: {},
    };
    const forged = await signCapability(
      "an-attackers-own-key-of-32-characters-or-more",
      authority,
      call
    );
    const forRead = await signCapability(
      env.CAPABILITY_SIGNING_KEY,
      authority,
      call
    );
    const refused = await Promise.all([
      outcome(env.CONNECT.call({ ...call, capability: "" })),
      outcome(env.CONNECT.call({ ...call, capability: forged })),
      outcome(
        env.CONNECT.call({ ...call, action: "mail.send", capability: forRead })
      ),
    ]);
    expect(refused).toStrictEqual([
      "capability.invalid",
      "capability.invalid",
      "capability.invalid",
    ]);
    await expect(
      outcome(env.CONNECT.call({ ...call, capability: forRead }))
    ).resolves.toBe(reached);
  });
});
