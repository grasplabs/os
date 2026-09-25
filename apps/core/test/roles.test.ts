import type { Role } from "@grasp-os/shared";
import { authErrors } from "@grasp-os/shared/errors";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { mockIdp } from "./idp.ts";
import {
  auditedDuring,
  callAuth,
  openRpc,
  signIn,
  signedIn,
  signedInWithRole,
  whoami,
} from "./sign-in.ts";

const idp = mockIdp();

const signedInAs = async (role: Role) => await signedInWithRole(idp, role);

const membersSchema = z.object({
  members: z.array(z.object({ id: z.string(), userId: z.string() })),
});

/** The membership id Better Auth's member routes take, for `userId`. */
const memberIdOf = async (adminSession: string, userId: string) => {
  const response = await callAuth("/organization/list-members", adminSession);
  const { members } = membersSchema.parse(await response.json());
  const member = members.find((candidate) => candidate.userId === userId);
  if (!member) {
    throw new Error("Not a member");
  }
  return member.id;
};

describe("roles and teams", () => {
  it("are read on every call, so changes apply without reconnecting", async () => {
    const admin = await signedInAs("admin");
    const person = await signedInAs("user");
    const { core } = await openRpc(person.session);
    using session = core.authenticate();
    await expect(session.whoami()).resolves.toMatchObject({
      role: "user",
      teams: [],
    });

    const memberId = await memberIdOf(admin.session, person.userId);
    const promoted = await callAuth(
      "/organization/update-member-role",
      admin.session,
      { memberId, role: "builder" }
    );
    expect(promoted.status).toBe(200);
    const created = await callAuth("/organization/create-team", admin.session, {
      name: "Finance",
    });
    const team = z.object({ id: z.string() }).parse(await created.json());
    const added = await callAuth(
      "/organization/add-team-member",
      admin.session,
      { teamId: team.id, userId: person.userId }
    );
    expect(added.status).toBe(200);

    await expect(session.whoami()).resolves.toMatchObject({
      role: "builder",
      teams: [{ id: team.id, name: "Finance" }],
    });
  });

  it("can't be raised by anyone but an admin, not even their own", async () => {
    const admin = await signedInAs("admin");
    for (const role of ["user", "builder"] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one person at a time
      const person = await signedInAs(role);
      // oxlint-disable-next-line no-await-in-loop -- one person at a time
      const memberId = await memberIdOf(admin.session, person.userId);
      // oxlint-disable-next-line no-await-in-loop -- one person at a time
      const raised = await callAuth(
        "/organization/update-member-role",
        person.session,
        { memberId, role: "admin" }
      );
      expect(raised.status).toBe(403);
      // oxlint-disable-next-line no-await-in-loop -- one person at a time
      const team = await callAuth("/organization/create-team", person.session, {
        name: `${role}'s own team`,
      });
      expect(team.status).toBe(403);
      // oxlint-disable-next-line no-await-in-loop -- one person at a time
      await expect(whoami(person.session)).resolves.toMatchObject({ role });
    }
  });

  it("are only ever one of Grasp's roles", async () => {
    const admin = await signedInAs("admin");
    const person = await signedInAs("user");
    const memberId = await memberIdOf(admin.session, person.userId);
    const refused = await Promise.all(
      ["owner", "member", "admin,builder", ["admin", "user"]].map(
        async (role) =>
          await callAuth("/organization/update-member-role", admin.session, {
            memberId,
            role,
          })
      )
    );
    expect(refused.map((response) => response.status)).toStrictEqual([
      400, 400, 400, 400,
    ]);
    await expect(whoami(person.session)).resolves.toMatchObject({
      role: "user",
    });
  });

  it("give no access with a role that isn't ours", async () => {
    const person = await signedInAs("user");
    await env.DB.prepare("UPDATE members SET role = 'owner' WHERE user_id = ?")
      .bind(person.userId)
      .run();
    const owner = await whoami(person.session).catch((error: unknown) => error);
    expect(authErrors.codeOf(owner)).toBe("auth.unauthenticated");
  });

  it("are given back when creating the membership failed, on the next sign-in", async () => {
    const person = await signedInAs("user");
    // As if the membership was never written on the first sign-in.
    await env.DB.prepare("DELETE FROM members WHERE user_id = ?")
      .bind(person.userId)
      .run();
    const lost = await whoami(person.session).catch((error: unknown) => error);
    expect(authErrors.codeOf(lost)).toBe("auth.unauthenticated");

    const again = await signedIn(idp, "microsoft", person.person);
    await expect(whoami(again)).resolves.toMatchObject({ role: "user" });
  });
});

describe("removing a member", () => {
  it("ends their access, and signing in again doesn't bring it back", async () => {
    const admin = await signedInAs("admin");
    const person = await signedInAs("user");
    const memberIdOrEmail = await memberIdOf(admin.session, person.userId);
    const removed = await callAuth(
      "/organization/remove-member",
      admin.session,
      { memberIdOrEmail }
    );
    expect(removed.status).toBe(200);

    const refusal = await whoami(person.session).catch(
      (error: unknown) => error
    );
    expect(authErrors.codeOf(refusal)).toBe("auth.unauthenticated");
    const again = await signIn(idp, "microsoft", person.person);
    expect(again.session).toBeUndefined();
  });

  it("holds even when the membership row outlives it", async () => {
    const admin = await signedInAs("admin");
    // As if deleting the membership failed after the removal was recorded.
    await env.DB.prepare(
      "INSERT INTO member_removals (organization_id, user_id, removed_at) VALUES ('organization', ?, ?)"
    )
      .bind(admin.userId, Date.now())
      .run();

    const refusal = await whoami(admin.session).catch(
      (error: unknown) => error
    );
    expect(authErrors.codeOf(refusal)).toBe("auth.unauthenticated");
    const team = await callAuth("/organization/create-team", admin.session, {
      name: "Still here",
    });
    expect(team.status).toBe(403);
  });

  it("is for admins only", async () => {
    const admin = await signedInAs("admin");
    const person = await signedInAs("user");
    const other = await signedInAs("builder");
    const memberIdOrEmail = await memberIdOf(admin.session, other.userId);
    const refused = await callAuth(
      "/organization/remove-member",
      person.session,
      { memberIdOrEmail }
    );
    expect(refused.ok).toBeFalsy();
    await expect(whoami(other.session)).resolves.toMatchObject({
      role: "builder",
    });
  });
});

describe("member and team changes", () => {
  it("are audited with who made them, and identifiers only", async () => {
    const admin = await signedInAs("admin");
    const person = await signedInAs("user");
    const memberId = await memberIdOf(admin.session, person.userId);
    let teamId = "";
    const audited = await auditedDuring(async () => {
      await callAuth("/organization/update-member-role", admin.session, {
        memberId,
        role: "builder",
      });
      const created = await callAuth(
        "/organization/create-team",
        admin.session,
        { name: "Finance" }
      );
      ({ id: teamId } = z
        .object({ id: z.string() })
        .parse(await created.json()));
      await callAuth("/organization/add-team-member", admin.session, {
        teamId,
        userId: person.userId,
      });
      await callAuth("/organization/remove-team-member", admin.session, {
        teamId,
        userId: person.userId,
      });
      await callAuth("/organization/update-team", admin.session, {
        teamId,
        data: { name: "Finance and legal" },
      });
      await callAuth("/organization/remove-team", admin.session, { teamId });
      await callAuth("/organization/remove-member", admin.session, {
        memberIdOrEmail: memberId,
      });
    });

    const actor = { type: "person", userId: admin.userId };
    expect(audited).toStrictEqual([
      expect.objectContaining({
        actor,
        action: "member.role.updated",
        target: { type: "member", id: memberId },
        detail: { previousRole: "user", role: "builder" },
      }),
      expect.objectContaining({
        actor,
        action: "team.created",
        target: { type: "team", id: teamId },
      }),
      expect.objectContaining({
        actor,
        action: "team.member.added",
        target: { type: "team", id: teamId },
        detail: { userId: person.userId },
      }),
      expect.objectContaining({
        actor,
        action: "team.member.removed",
        target: { type: "team", id: teamId },
        detail: { userId: person.userId },
      }),
      expect.objectContaining({
        actor,
        action: "team.updated",
        target: { type: "team", id: teamId },
      }),
      expect.objectContaining({
        actor,
        action: "team.deleted",
        target: { type: "team", id: teamId },
      }),
      expect.objectContaining({
        actor,
        action: "member.removed",
        target: { type: "member", id: memberId },
        detail: { userId: person.userId },
      }),
    ]);
  });

  it("aren't audited when refused", async () => {
    const person = await signedInAs("user");
    const audited = await auditedDuring(async () => {
      await callAuth("/organization/create-team", person.session, {
        name: "Mine",
      });
    });
    expect(audited).toStrictEqual([]);
  });
});

describe("Better Auth routes", () => {
  it("only serves the ones core chose", async () => {
    const admin = await signedInAs("admin");
    const routes: [path: string, body?: unknown][] = [
      ["/sign-up/email", { email: "x@acme.test", password: "p", name: "x" }],
      ["/sign-in/email", { email: "x@acme.test", password: "p" }],
      ["/sign-in/social", { provider: "google" }],
      ["/sso/register", { providerId: "evil", issuer: "https://evil.example" }],
      ["/sso/providers"],
      ["/organization/create", { name: "Mine", slug: "mine" }],
      [
        "/organization/invite-member",
        { email: "x@evil.example", role: "admin" },
      ],
      ["/organization/leave", { organizationId: "organization" }],
      ["/organization/delete", { organizationId: "organization" }],
      ["/update-user", { name: "Someone else" }],
      ["/change-email", { newEmail: "x@evil.example" }],
      ["/delete-user", {}],
      ["/error"],
    ];
    const responses = await Promise.all(
      routes.map(
        async ([path, body]) => await callAuth(path, admin.session, body)
      )
    );
    expect(responses.map((response) => response.status)).toStrictEqual(
      routes.map(() => 404)
    );
  });
});
