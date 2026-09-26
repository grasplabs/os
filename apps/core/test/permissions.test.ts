import { auditEventSchema } from "@grasp-os/shared/audit";
import { capabilityErrors, signCapability } from "@grasp-os/shared/capability";
import { connectErrors } from "@grasp-os/shared/connect";
import {
  authoritySchema,
  bindingNameSchema,
  permissionErrors,
  permissionObjectSchema,
} from "@grasp-os/shared/permissions";
import type {
  Authority,
  Permission,
  PermissionRequest,
  PermissionSubjectInput,
} from "@grasp-os/shared/permissions";
import type { Role } from "@grasp-os/shared/roles";
import { roleErrors } from "@grasp-os/shared/roles";
import { createScheduledController } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { bindingsFor } from "../src/bindings.ts";
import worker from "../src/index.ts";
import { authorize } from "../src/permissions.ts";
import { connectionIn, newChat } from "./contexts.ts";
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

type Api = Awaited<ReturnType<typeof permissionApi>>["api"];

/** A new App in the registry, as a permission's subject. */
const newApp = async (api: Api) => {
  const { id } = await api.apps.create({ name: `App ${unique()}` });
  return { type: "app" as const, appId: id };
};

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
      roleErrors.codeOf(error) ??
      connectErrors.codeOf(error) ??
      capabilityErrors.codeOf(error) ??
      String(error)
    );
  }
};

/** The env an agent gets for `authority`, in a chat of its own. */
const envOf = async (authority: Authority) =>
  await bindingsFor(env, authority, await newChat());

/**
 * What App code gets when it calls the connection stub `binding` from its
 * env. These tests register no connection in connect, so
 * "connect.connection_not_found" is a call that passed every check, core's
 * and connect's capability check.
 */
const callStub = async (
  bindings: Awaited<ReturnType<typeof envOf>>,
  binding = "OUTLOOK",
  action = "mail.list"
): Promise<string> => {
  const stub = connectionIn(bindings, binding);
  return stub ? await outcome(stub.call(action, {})) : "no binding";
};

/** Builds the env as a workflow start or resume does, and calls `binding`. */
const callThrough = async (
  authority: Authority,
  binding: string,
  action = "mail.list"
): Promise<string> => await callStub(await envOf(authority), binding, action);

/** Runs core's cron trigger, as Cloudflare does every minute. */
const runCron = async () => {
  await worker.scheduled(createScheduledController(), env);
};

/** Reached through connect, as a call from an App would be. */
const reached = "connect.connection_not_found";

describe("permissions", () => {
  it("allow nothing until an admin grants them", async () => {
    const admin = await permissionApi("admin");
    const builder = await permissionApi("builder");
    const app = await newApp(admin.api);
    const authority = actingFor(app, builder.userId);

    const before = await callThrough(authority, "OUTLOOK");
    const requested = await builder.api.permissions.request(outlook(app));
    const whileRequested = await Promise.all([
      callThrough(authority, "OUTLOOK"),
      outcome(
        authorize(env, authority, requested.object, "mail.list", requested.id)
      ),
    ]);
    expect({ before, status: requested.status, whileRequested }).toStrictEqual({
      before: "no binding",
      status: "requested",
      whileRequested: ["no binding", "permission.denied"],
    });

    const granted = await admin.api.permissions.grant(requested.id);
    expect(granted).toMatchObject({
      status: "active",
      grantedBy: admin.userId,
    });
    await expect(callThrough(authority, "OUTLOOK")).resolves.toBe(reached);
  });

  it("can only be granted and revoked by an admin, even their own", async () => {
    const admin = await permissionApi("admin");
    const app = await newApp(admin.api);
    for (const role of ["builder", "user"] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one person at a time
      const person = await permissionApi(role);
      // oxlint-disable-next-line no-await-in-loop -- one person at a time
      const request = await admin.api.permissions.request({
        ...outlook(app),
        binding: `OUTLOOK_${role.toUpperCase()}`,
      });
      // oxlint-disable-next-line no-await-in-loop -- one person at a time
      const refused = await Promise.all([
        outcome(person.api.permissions.grant(request.id)),
        outcome(person.api.permissions.revoke(request.id)),
      ]);
      expect(refused).toStrictEqual(["role.forbidden", "role.forbidden"]);
    }
    const user = await permissionApi("user");
    await expect(
      Promise.all([
        outcome(user.api.permissions.request(outlook(app))),
        outcome(user.api.permissions.list()),
      ])
    ).resolves.toStrictEqual(["role.forbidden", "role.forbidden"]);
    const all = await admin.api.permissions.list(app);
    expect(all.map(({ status }) => status)).toStrictEqual([
      "requested",
      "requested",
    ]);
  });

  it("stop working at the next call once revoked, in stubs already handed out", async () => {
    const admin = await permissionApi("admin");
    const app = await newApp(admin.api);
    const authority = actingFor(app, admin.userId);
    const { id } = await admin.api.permissions.request(outlook(app));
    await admin.api.permissions.grant(id);

    // A running App or workflow keeps the env it was given.
    const held = await envOf(authority);
    await expect(callStub(held)).resolves.toBe(reached);

    const revoked = await admin.api.permissions.revoke(id);
    expect(revoked).toMatchObject({
      status: "revoked",
      revokedBy: admin.userId,
    });
    await expect(callStub(held)).resolves.toBe("permission.denied");
    // The next load or resume doesn't get it at all.
    await expect(envOf(authority)).resolves.toStrictEqual({});
    // And it can't be granted back to life.
    await expect(outcome(admin.api.permissions.grant(id))).resolves.toBe(
      "permission.not_requested"
    );
  });

  it("stop their own stubs once revoked, even when another permission covers the same", async () => {
    const admin = await permissionApi("admin");
    const app = await newApp(admin.api);
    const authority = actingFor(app, admin.userId);
    const grant = async (binding: string) => {
      const { id } = await admin.api.permissions.request({
        ...outlook(app),
        binding,
      });
      return await admin.api.permissions.grant(id);
    };
    const first = await grant("OUTLOOK");
    await grant("OUTLOOK_TOO");
    const held = await envOf(authority);

    await admin.api.permissions.revoke(first.id);
    await expect(
      Promise.all([callStub(held), callThrough(authority, "OUTLOOK_TOO")])
    ).resolves.toStrictEqual(["permission.denied", reached]);
  });

  it("belong to their subject alone: not another App, not an agent with the same ID", async () => {
    const admin = await permissionApi("admin");
    const app = await newApp(admin.api);
    const { id } = await admin.api.permissions.request(outlook(app));
    await admin.api.permissions.grant(id);
    const others: PermissionSubjectInput[] = [
      { type: "agent", agentId: app.appId },
      await newApp(admin.api),
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
              "mail.list",
              id
            )
          )
      )
    );
    expect(checks).toStrictEqual(["permission.denied", "permission.denied"]);
  });

  it("allow only their own actions, on their own resource", async () => {
    const admin = await permissionApi("admin");
    const app = await newApp(admin.api);
    const authority = actingFor(app, admin.userId);
    const finance = {
      type: "connection",
      connectionId: "connection-shared-mail",
      resource: "finance@acme.test",
    } as const;
    const { id } = await admin.api.permissions.request({
      subject: app,
      object: finance,
      actions: ["mail.list"],
      binding: "FINANCE_MAIL",
    });
    await admin.api.permissions.grant(id);

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
              "mail.list",
              id
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
    const app = await newApp(admin.api);
    const { id } = await admin.api.permissions.request(outlook(app));
    await admin.api.permissions.grant(id);
    const authority = actingFor(app, builder.userId);
    const held = await envOf(authority);

    await env.DB.prepare("DELETE FROM members WHERE user_id = ?")
      .bind(builder.userId)
      .run();
    await expect(callStub(held)).resolves.toBe("permission.person_inactive");
    await expect(outcome(envOf(authority))).resolves.toBe(
      "permission.person_inactive"
    );
  });

  it("build an env with a stub for each active grant, and nothing else", async () => {
    const admin = await permissionApi("admin");
    const app = await newApp(admin.api);
    const grant = async (request: PermissionRequest) => {
      const { id } = await admin.api.permissions.request(request);
      return await admin.api.permissions.grant(id);
    };
    await grant(outlook(app));
    await admin.api.permissions.request({ ...outlook(app), binding: "ASKED" });
    const gone = await grant({ ...outlook(app), binding: "GONE" });
    await admin.api.permissions.revoke(gone.id);
    const policies = await admin.api.knowledge.createCollection({
      name: `Policies ${unique()}`,
      access: "everyone",
    });
    await grant({
      subject: app,
      object: { type: "collection", collectionId: policies.id },
      actions: ["read"],
      binding: "POLICIES",
    });
    await grant({
      ...outlook(await newApp(admin.api)),
      binding: "SOMEONE_ELSES",
    });

    const bindings = await envOf(actingFor(app, admin.userId));
    expect(Object.keys(bindings)).toStrictEqual(["OUTLOOK", "POLICIES"]);
  });

  it("leave a name out of the env once the platform takes it, and keep the rest", async () => {
    const admin = await permissionApi("admin");
    const app = await newApp(admin.api);
    const grant = async (request: PermissionRequest) => {
      const { id } = await admin.api.permissions.request(request);
      return await admin.api.permissions.grant(id);
    };
    await grant(outlook(app));
    const taken = await grant({ ...outlook(app), binding: "LATER_TAKEN" });
    // A release that makes the name one of core's own, after it was granted.
    await env.DB.prepare("UPDATE permissions SET binding = 'DB' WHERE id = ?")
      .bind(taken.id)
      .run();

    const bindings = await envOf(actingFor(app, admin.userId));
    expect({
      names: Object.keys(bindings),
      outlook: await callStub(bindings),
    }).toStrictEqual({ names: ["OUTLOOK"], outlook: reached });
  });

  it("are refused when they would reach past a stub's names", async () => {
    const admin = await permissionApi("admin");
    const app = await newApp(admin.api);
    const requests: PermissionRequest[] = [
      { ...outlook(app), binding: "__proto__" },
      { ...outlook(app), binding: "constructor" },
      { ...outlook(app), binding: "outlook" },
      // Core's own bindings.
      { ...outlook(app), binding: "DB" },
      { ...outlook(app), binding: "CONNECT" },
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
        object: { type: "workflow", appId: app.appId, workflowId: "w" },
        actions: ["write"],
        binding: "W",
      },
    ];
    const refused = await Promise.all(
      requests.map(
        async (request) => await outcome(admin.api.permissions.request(request))
      )
    );
    expect(refused).toStrictEqual(requests.map(() => "permission.invalid"));
  });

  it("are refused for an App that isn't in the registry", async () => {
    const admin = await permissionApi("admin");
    const app = await newApp(admin.api);
    const missing = { type: "app" as const, appId: `app-${unique()}` };
    const workflowOf = (appId: string): PermissionRequest => ({
      subject: app,
      object: { type: "workflow", appId, workflowId: "invoices" },
      actions: ["start"],
      binding: "INVOICES",
    });
    const refused = await Promise.all(
      [outlook(missing), workflowOf(missing.appId)].map(
        async (request) => await outcome(admin.api.permissions.request(request))
      )
    );
    expect(refused).toStrictEqual(["permission.invalid", "permission.invalid"]);
    await expect(
      outcome(admin.api.permissions.request(workflowOf(app.appId)))
    ).resolves.toBe("ok");
  });

  it("can't take the name of any of core's own bindings", () => {
    // Test-only bindings aside, every name in core's env is the platform's.
    const testOnly = new Set([
      "CORE_MIGRATIONS",
      "KNOWLEDGE_MIGRATIONS",
      "CONNECT_DB",
      "CONNECT_MIGRATIONS",
    ]);
    const own = Object.keys(env).filter((name) => !testOnly.has(name));
    expect(
      own.filter((name) => bindingNameSchema.safeParse(name).success)
    ).toStrictEqual([]);
  });

  it("keep binding names unique while they're live", async () => {
    const admin = await permissionApi("admin");
    const app = await newApp(admin.api);
    const first = await admin.api.permissions.request(outlook(app));
    await expect(
      outcome(admin.api.permissions.request(outlook(app)))
    ).resolves.toBe("permission.conflict");
    await admin.api.permissions.revoke(first.id);
    await expect(
      outcome(admin.api.permissions.request(outlook(app)))
    ).resolves.toBe("ok");
  });

  it("keep their audit event when the audit queue is down, and send it later, once", async () => {
    const admin = await permissionApi("admin");
    const app = await newApp(admin.api);
    const { id } = await admin.api.permissions.request(outlook(app));

    const down = vi
      .spyOn(env.AUDIT_QUEUE, "send")
      .mockRejectedValue(new Error("Queue unavailable"));
    let granted: Permission;
    try {
      granted = await admin.api.permissions.grant(id);
    } finally {
      down.mockRestore();
    }

    const sent = await auditedDuring(runCron);
    const sentAgain = await auditedDuring(runCron);
    expect({
      status: granted.status,
      sent: sent.map(({ action, target }) => [action, target?.id]),
      sentAgain,
    }).toStrictEqual({
      status: "active",
      sent: [["permission.granted", id]],
      sentAgain: [],
    });
  });

  it("keep sending audit events past one that can't be sent or read", async () => {
    const admin = await permissionApi("admin");
    const app = await newApp(admin.api);
    const { id } = await admin.api.permissions.request(outlook(app));
    // A stored event that isn't JSON, older than anything else waiting.
    await env.DB.prepare(
      "INSERT INTO audit_outbox (id, event, created_at) VALUES (?, ?, 0)"
    )
      .bind(crypto.randomUUID(), "not an event")
      .run();
    const down = vi
      .spyOn(env.AUDIT_QUEUE, "send")
      .mockRejectedValue(new Error("Queue unavailable"));
    try {
      await admin.api.permissions.grant(id);
    } finally {
      down.mockRestore();
    }

    const send = vi.spyOn(env.AUDIT_QUEUE, "send");
    try {
      // The queue refuses the oldest one once: the rest still go.
      send.mockRejectedValueOnce(new Error("Queue unavailable"));
      await runCron();
      const first = send.mock.calls.slice(1).map(([body]) => body);
      send.mockClear();
      await runCron();
      const second = send.mock.calls.map(([body]) => body);
      const waiting = await env.DB.prepare(
        "SELECT count(*) AS waiting FROM audit_outbox"
      ).first("waiting");
      expect({
        first: first.map((body) => auditEventSchema.parse(body).action),
        second,
        waiting,
      }).toStrictEqual({
        first: ["permission.granted"],
        // Sent as it is, for the queue's consumer to dead-letter.
        second: ["not an event"],
        waiting: 0,
      });
    } finally {
      send.mockRestore();
    }
  });

  it("are audited when requested, granted and revoked, by who did it", async () => {
    const admin = await permissionApi("admin");
    const builder = await permissionApi("builder");
    const app = await newApp(admin.api);
    let id = "";
    const events = await auditedDuring(async () => {
      ({ id } = await builder.api.permissions.request(outlook(app)));
      await admin.api.permissions.grant(id);
      await admin.api.permissions.revoke(id);
      // Revoking again changes nothing, so it records nothing.
      await admin.api.permissions.revoke(id);
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
    const admin = await permissionApi("admin");
    const authority = actingFor(await newApp(admin.api), "user-anna");
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
