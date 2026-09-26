import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { outlook } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import {
  auditedDuring,
  onlyAdmins,
  openRpc,
  outcome,
  signedIn,
  signedInApi,
  staffPerson,
  unique,
} from "./sign-in.ts";

// Nobody grants a permission alone (threat model R4, R8, PM1, WF5): a
// request does nothing until an admin other than the person who asked
// approves it, and the approval and the grant are one change. These tests
// try to get a request granted any other way.

const idp = mockIdp();

const personApi = async (role: Role) => await signedInApi(idp, role);
type Person = Awaited<ReturnType<typeof personApi>>;

/** A new App, and a request by `requester` to give it Outlook. */
const requested = async (requester: Person, owner: Person = requester) => {
  const { id: app } = await owner.api.apps.create({ name: `App ${unique()}` });
  const permission = await requester.api.permissions.request(outlook(app));
  const pending = await requester.api.approvals.list();
  const approval = pending.find(
    (waiting) =>
      waiting.kind === "permission" && waiting.permission === permission.id
  );
  if (!approval) {
    throw new Error("The request has no pending approval");
  }
  return { app, permission, approval };
};

/** The permission's status, as an admin lists it. */
const statusOf = async (admin: Person, app: string, id: string) => {
  const all = await admin.api.permissions.list({ type: "app", appId: app });
  return all.find((permission) => permission.id === id)?.status;
};

describe("permission requests", () => {
  it("do nothing until an admin other than the requester approves, and the grant is audited", async () => {
    const builder = await personApi("builder");
    const admin = await personApi("admin");
    const { app, permission, approval } = await requested(builder);
    expect({
      status: permission.status,
      approval: {
        status: approval.status,
        approvers: approval.approvers,
        requestedBy: approval.requestedBy,
      },
    }).toStrictEqual({
      status: "requested",
      approval: {
        status: "pending",
        approvers: "admins",
        requestedBy: builder.userId,
      },
    });

    const events = await auditedDuring(async () => {
      await admin.api.approvals.approve(approval.id);
    });
    await expect(statusOf(admin, app, permission.id)).resolves.toBe("active");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actor: { type: "person", userId: admin.userId },
      action: "permission.granted",
      target: { type: "permission", id: permission.id },
      detail: {
        approval: approval.id,
        requestedBy: builder.userId,
        breakGlass: false,
      },
    });
    await expect(builder.api.approvals.list()).resolves.not.toContainEqual(
      expect.objectContaining({ id: approval.id })
    );
  });

  it("are never approved by the admin who asked while another admin exists", async () => {
    const admin = await personApi("admin");
    const other = await personApi("admin");
    const { app, permission, approval } = await requested(admin);
    const refused = {
      approve: await outcome(admin.api.approvals.approve(approval.id)),
      grant: await outcome(admin.api.permissions.grant(permission.id)),
      breakGlass: await outcome(
        admin.api.permissions.grant(permission.id, { breakGlass: true })
      ),
      approveBreakGlass: await outcome(
        admin.api.approvals.approve(approval.id, { breakGlass: true })
      ),
    };
    expect(refused).toStrictEqual({
      approve: "approval.self",
      grant: "approval.self",
      breakGlass: "approval.break_glass_refused",
      approveBreakGlass: "approval.break_glass_refused",
    });
    await expect(statusOf(admin, app, permission.id)).resolves.toBe(
      "requested"
    );

    const granted = await other.api.permissions.grant(permission.id);
    expect(granted).toMatchObject({
      status: "active",
      grantedBy: other.userId,
    });
  });

  it("are never approved by builders, users or Grasp staff", async () => {
    const builder = await personApi("builder");
    const admin = await personApi("admin");
    const user = await personApi("user");
    const { app, permission, approval } = await requested(admin);
    const staffSession = await signedIn(idp, "grasp-staff", staffPerson());
    const { core: staffCore } = await openRpc(staffSession);
    const staffApi = staffCore.authenticate();
    await expect(staffApi.whoami()).resolves.toMatchObject({
      role: "admin",
      staff: true,
    });

    expect({
      builder: [
        await outcome(builder.api.approvals.approve(approval.id)),
        await outcome(builder.api.permissions.grant(permission.id)),
        await outcome(builder.api.approvals.decline(approval.id)),
      ],
      user: [
        await outcome(user.api.approvals.approve(approval.id)),
        await outcome(user.api.permissions.grant(permission.id)),
        await outcome(user.api.approvals.list()),
      ],
      staff: [
        await outcome(staffApi.approvals.approve(approval.id)),
        await outcome(staffApi.permissions.grant(permission.id)),
        await outcome(
          staffApi.permissions.grant(permission.id, { breakGlass: true })
        ),
        await outcome(staffApi.approvals.decline(approval.id)),
      ],
    }).toStrictEqual({
      builder: ["approval.forbidden", "role.forbidden", "approval.forbidden"],
      user: ["approval.forbidden", "role.forbidden", "role.forbidden"],
      staff: [
        "approval.forbidden",
        "approval.forbidden",
        "approval.forbidden",
        "approval.forbidden",
      ],
    });
    await expect(statusOf(admin, app, permission.id)).resolves.toBe(
      "requested"
    );
  });

  it("are granted by the only admin's own approval only as audited break-glass", async () => {
    const admin = await personApi("admin");
    await onlyAdmins(admin.userId);
    const { app, permission, approval } = await requested(admin);
    const withoutBreakGlass = await outcome(
      admin.api.permissions.grant(permission.id)
    );
    const events = await auditedDuring(async () => {
      await admin.api.permissions.grant(permission.id, { breakGlass: true });
    });
    expect({
      withoutBreakGlass,
      status: await statusOf(admin, app, permission.id),
    }).toStrictEqual({ withoutBreakGlass: "approval.self", status: "active" });
    expect(events).toMatchObject([
      {
        actor: { type: "person", userId: admin.userId },
        action: "permission.granted",
        detail: {
          approval: approval.id,
          requestedBy: admin.userId,
          breakGlass: true,
        },
      },
    ]);

    // Once there is a second admin, break-glass is over.
    const second = await personApi("admin");
    const next = await requested(admin);
    await expect(
      outcome(
        admin.api.approvals.approve(next.approval.id, { breakGlass: true })
      )
    ).resolves.toBe("approval.break_glass_refused");
    await expect(
      second.api.approvals.approve(next.approval.id)
    ).resolves.toMatchObject({ status: "approved", breakGlass: false });
  });

  it("take one approval when two admins approve at once", async () => {
    const builder = await personApi("builder");
    const first = await personApi("admin");
    const second = await personApi("admin");
    const { app, permission, approval } = await requested(builder);
    let outcomes: string[] = [];
    const events = await auditedDuring(async () => {
      outcomes = await Promise.all([
        outcome(first.api.approvals.approve(approval.id)),
        outcome(second.api.approvals.approve(approval.id)),
      ]);
    });
    expect(outcomes.toSorted()).toStrictEqual(["approval.closed", "ok"]);
    expect(events.map(({ action }) => action)).toStrictEqual([
      "permission.granted",
    ]);
    const winner = outcomes[0] === "ok" ? first : second;
    const all = await first.api.permissions.list({ type: "app", appId: app });
    expect(all.find(({ id }) => id === permission.id)).toMatchObject({
      status: "active",
      grantedBy: winner.userId,
    });
  });

  it("can't be approved again, even after their permission was revoked", async () => {
    const builder = await personApi("builder");
    const admin = await personApi("admin");
    const other = await personApi("admin");
    const { app, permission, approval } = await requested(builder);
    await admin.api.approvals.approve(approval.id);
    await admin.api.permissions.revoke(permission.id);
    let replays: string[] = [];
    const events = await auditedDuring(async () => {
      replays = [
        await outcome(admin.api.approvals.approve(approval.id)),
        await outcome(other.api.approvals.approve(approval.id)),
        await outcome(other.api.permissions.grant(permission.id)),
      ];
    });
    expect({
      replays,
      events,
      status: await statusOf(admin, app, permission.id),
    }).toStrictEqual({
      replays: [
        "approval.closed",
        "approval.closed",
        "permission.not_requested",
      ],
      events: [],
      status: "revoked",
    });
  });

  it("can't be approved once declined, and a decline is audited", async () => {
    const builder = await personApi("builder");
    const admin = await personApi("admin");
    const other = await personApi("admin");
    const { app, permission, approval } = await requested(builder);
    const events = await auditedDuring(async () => {
      await expect(
        admin.api.approvals.decline(approval.id)
      ).resolves.toMatchObject({ status: "declined", decidedBy: admin.userId });
    });
    expect(events).toMatchObject([
      {
        action: "permission.declined",
        target: { type: "permission", id: permission.id },
        detail: { approval: approval.id },
      },
    ]);
    expect({
      approve: await outcome(other.api.approvals.approve(approval.id)),
      status: await statusOf(admin, app, permission.id),
    }).toStrictEqual({ approve: "approval.closed", status: "revoked" });
  });

  it("are withdrawn only by their requester, and never approved after", async () => {
    const builder = await personApi("builder");
    const admin = await personApi("admin");
    const { app, permission, approval } = await requested(builder);
    await expect(
      outcome(admin.api.approvals.withdraw(approval.id))
    ).resolves.toBe("approval.forbidden");
    const events = await auditedDuring(async () => {
      await builder.api.approvals.withdraw(approval.id);
    });
    expect(events).toMatchObject([
      {
        actor: { type: "person", userId: builder.userId },
        action: "permission.withdrawn",
      },
    ]);
    expect({
      approve: await outcome(admin.api.approvals.approve(approval.id)),
      status: await statusOf(admin, app, permission.id),
    }).toStrictEqual({ approve: "approval.closed", status: "revoked" });
  });

  it("can't be approved once the requester left or lost the role to ask", async () => {
    const admin = await personApi("admin");
    const leaver = await personApi("builder");
    const demoted = await personApi("builder");
    const left = await requested(leaver, admin);
    const downgraded = await requested(demoted, admin);
    await admin.api.members.remove(leaver.userId);
    await admin.api.members.setRole(demoted.userId, "user");

    expect([
      await outcome(admin.api.approvals.approve(left.approval.id)),
      await outcome(admin.api.permissions.grant(downgraded.permission.id)),
    ]).toStrictEqual(["approval.stale", "approval.stale"]);
    expect([
      await statusOf(admin, left.app, left.permission.id),
      await statusOf(admin, downgraded.app, downgraded.permission.id),
    ]).toStrictEqual(["requested", "requested"]);

    // A stale request can still be turned down, which frees its name.
    await admin.api.approvals.decline(left.approval.id);
    await expect(statusOf(admin, left.app, left.permission.id)).resolves.toBe(
      "revoked"
    );
  });

  it("can't be approved once their App is gone", async () => {
    const builder = await personApi("builder");
    const admin = await personApi("admin");
    const { approval, app } = await requested(builder);
    // Apps can't be deleted yet; the approval checks it all the same.
    await env.DB.prepare("DELETE FROM apps WHERE id = ?").bind(app).run();
    await expect(
      outcome(admin.api.approvals.approve(approval.id))
    ).resolves.toBe("approval.stale");
  });

  it("list what waits for admins, for admins and builders only", async () => {
    const builder = await personApi("builder");
    const admin = await personApi("admin");
    const { approval } = await requested(builder);
    const pending = await admin.api.approvals.list();
    expect(pending).toContainEqual(approval);
    expect(pending.every(({ status }) => status === "pending")).toBeTruthy();
    await admin.api.approvals.approve(approval.id);
    await expect(admin.api.approvals.list()).resolves.not.toContainEqual(
      expect.objectContaining({ id: approval.id })
    );
    await expect(
      outcome(admin.api.approvals.approve(crypto.randomUUID()))
    ).resolves.toBe("approval.not_found");
  });
});
