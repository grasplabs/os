import { authErrors } from "@grasp-os/shared/errors";
import { teamNameMaxLength } from "@grasp-os/shared/members";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { allEvents } from "./audit-events.ts";
import { runCron, waitingInOutbox, whileLogDown } from "./cron.ts";
import { mockIdp } from "./idp.ts";
import { racingDb } from "./racing-db.ts";
import {
  auditedDuring,
  callAuth,
  openRpc,
  outcome,
  signedIn,
  signedInApi,
  signedInWithRole,
  staffPerson,
  unique,
  whoami,
} from "./sign-in.ts";

// Roles and teams, from what can go wrong: someone raising their own role
// or putting themselves in a team; a team change nobody can trace; someone
// removed still reaching things through a team; an admin who was demoted
// or removed a moment ago still changing teams; two teams nobody can tell
// apart; and Better Auth serving a route that changes any of it.

const idp = mockIdp();

/** A team name no other test's team has: names are unique. */
const finance = () => `Finance ${unique()}`;

const signedInAs = async (role: Role) => await signedInWithRole(idp, role);

/** The teams `userId` is in, as the database has them. */
const teamsOf = async (userId: string): Promise<string[]> => {
  const { results } = await env.DB.prepare(
    "SELECT team_id AS teamId FROM team_members WHERE user_id = ?"
  )
    .bind(userId)
    .all<{ teamId: string }>();
  return results.map(({ teamId }) => teamId);
};

/** How many teams there are. */
const teamCount = async (): Promise<number | undefined> => {
  const row = await env.DB.prepare(
    "SELECT count(*) AS teams FROM teams"
  ).first<{ teams: number }>();
  return row?.teams;
};

/** The name of the team `teamId`, or `undefined` when there is none. */
const teamName = async (teamId: string): Promise<string | undefined> => {
  const row = await env.DB.prepare("SELECT name FROM teams WHERE id = ?")
    .bind(teamId)
    .first<{ name: string }>();
  return row?.name;
};

describe("roles and teams", () => {
  it("are read on every call, so changes apply without reconnecting", async () => {
    const admin = await signedInApi(idp, "admin");
    const person = await signedInAs("user");
    const { core } = await openRpc(person.session);
    using session = core.authenticate();
    await expect(session.whoami()).resolves.toMatchObject({
      role: "user",
      teams: [],
    });

    await admin.api.members.setRole(person.userId, "builder");
    const name = finance();
    // Kept trimmed, and with single spaces.
    const team = await admin.api.members.createTeam(
      `  ${name.replace(" ", " \u00A0 ")} `
    );
    await admin.api.members.addTeamMember(team.id, person.userId);
    await expect(session.whoami()).resolves.toMatchObject({
      role: "builder",
      teams: [{ id: team.id, name }],
    });

    await admin.api.members.renameTeam(team.id, `${name} and legal`);
    await expect(session.whoami()).resolves.toMatchObject({
      teams: [{ id: team.id, name: `${name} and legal` }],
    });

    await admin.api.members.removeTeamMember(team.id, person.userId);
    await expect(session.whoami()).resolves.toMatchObject({ teams: [] });
  });

  it("can't be changed by anyone but an admin, not even their own, and a refused change isn't audited", async () => {
    const admin = await signedInApi(idp, "admin");
    const name = finance();
    const team = await admin.api.members.createTeam(name);
    const staff = await signedIn(idp, "grasp-staff", staffPerson());
    const { userId: staffId } = await whoami(staff);
    const people = [
      await signedInAs("user"),
      await signedInAs("builder"),
      // Grasp staff, even with the admin role: teams are the client's.
      { session: staff, userId: staffId },
    ];
    const audited = await auditedDuring(async () => {
      for (const person of people) {
        // oxlint-disable-next-line no-await-in-loop -- one person at a time
        const { core } = await openRpc(person.session);
        const { members } = core.authenticate();
        // oxlint-disable-next-line no-await-in-loop -- one person at a time
        const refused = await Promise.all([
          outcome(members.setRole(person.userId, "admin")),
          outcome(members.createTeam(finance())),
          outcome(members.renameTeam(team.id, finance())),
          outcome(members.addTeamMember(team.id, person.userId)),
          outcome(members.removeTeamMember(team.id, admin.userId)),
          outcome(members.deleteTeam(team.id)),
        ]);
        expect(refused).toStrictEqual(refused.map(() => "role.forbidden"));
        // oxlint-disable-next-line no-await-in-loop -- one person at a time
        await expect(teamsOf(person.userId)).resolves.toStrictEqual([]);
      }
    });
    expect(audited).toStrictEqual([]);
    await expect(teamName(team.id)).resolves.toBe(name);
    const [user, builder] = people;
    await expect(whoami(user?.session)).resolves.toMatchObject({
      role: "user",
    });
    await expect(whoami(builder?.session)).resolves.toMatchObject({
      role: "builder",
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

describe("a removed member", () => {
  it("holds even when the membership row outlives it", async () => {
    const admin = await signedInApi(idp, "admin");
    // As if deleting the membership failed after the removal was recorded.
    await env.DB.prepare(
      "INSERT INTO member_removals (user_id, removed_at) VALUES (?, ?)"
    )
      .bind(admin.userId, Date.now())
      .run();

    const refusal = await whoami(admin.session).catch(
      (error: unknown) => error
    );
    expect(authErrors.codeOf(refusal)).toBe("auth.unauthenticated");
    // Nor on the connection they had open.
    await expect(
      outcome(admin.api.members.createTeam(finance()))
    ).resolves.toBe("auth.unauthenticated");
  });

  it("leaves every team, and can't be put in one again", async () => {
    const admin = await signedInApi(idp, "admin");
    const person = await signedInAs("user");
    const team = await admin.api.members.createTeam(finance());
    await admin.api.members.addTeamMember(team.id, person.userId);
    await expect(teamsOf(person.userId)).resolves.toStrictEqual([team.id]);

    await admin.api.members.remove(person.userId);
    await expect(teamsOf(person.userId)).resolves.toStrictEqual([]);
    await expect(
      outcome(admin.api.members.addTeamMember(team.id, person.userId))
    ).resolves.toBe("member.not_found");
    await expect(teamsOf(person.userId)).resolves.toStrictEqual([]);
  });
});

describe("team changes", () => {
  it("are audited with who made them, and identifiers only", async () => {
    const admin = await signedInApi(idp, "admin");
    const person = await signedInAs("user");
    const { members } = admin.api;
    let teamId = "";
    const audited = await auditedDuring(async () => {
      ({ id: teamId } = await members.createTeam(finance()));
      await members.addTeamMember(teamId, person.userId);
      // Already in it: nothing changes, so nothing is recorded.
      await members.addTeamMember(teamId, person.userId);
      await members.removeTeamMember(teamId, person.userId);
      // No longer in it: the same.
      await members.removeTeamMember(teamId, person.userId);
      const renamed = finance();
      await members.renameTeam(teamId, renamed);
      // The name it has: nothing changes, so nothing is recorded.
      await members.renameTeam(teamId, ` ${renamed} `);
      // Its own name in another case is a change, and no other team's name.
      await members.renameTeam(teamId, renamed.toUpperCase());
      await members.deleteTeam(teamId);
    });

    const actor = { type: "person", userId: admin.userId };
    const team = { type: "team", id: teamId };
    const events = audited.map(({ actor: by, action, target, detail }) => ({
      actor: by,
      action,
      target,
      detail,
    }));
    expect(events).toStrictEqual([
      { actor, action: "team.created", target: team, detail: {} },
      {
        actor,
        action: "team.member.added",
        target: team,
        detail: { userId: person.userId },
      },
      {
        actor,
        action: "team.member.removed",
        target: team,
        detail: { userId: person.userId },
      },
      { actor, action: "team.updated", target: team, detail: {} },
      { actor, action: "team.updated", target: team, detail: {} },
      { actor, action: "team.deleted", target: team, detail: {} },
    ]);
    expect(JSON.stringify(audited).toLowerCase()).not.toContain("finance");
  });

  it("keep their audit event when the audit log is down, and append it later", async () => {
    const admin = await signedInApi(idp, "admin");
    const teamId = await whileLogDown(async () => {
      const { id } = await admin.api.members.createTeam(finance());
      // It waits in the outbox while the log is down.
      await expect(waitingInOutbox(env.DB, "team.created", id)).resolves.toBe(
        1
      );
      return id;
    });

    await runCron();
    const sent = await allEvents();
    expect(
      sent.filter(
        ({ action, target }) =>
          action === "team.created" && target?.id === teamId
      )
    ).toHaveLength(1);
  });

  it("are refused, and not audited, for a team, a person or a name there can't be", async () => {
    const admin = await signedInApi(idp, "admin");
    const { members } = admin.api;
    const team = await members.createTeam("x".repeat(teamNameMaxLength));
    const taken = finance();
    const other = await members.createTeam(taken);
    const gone = await signedInAs("user");
    await members.remove(gone.userId);

    let refused: string[] = [];
    const audited = await auditedDuring(async () => {
      refused = await Promise.all([
        outcome(members.createTeam("")),
        outcome(members.createTeam("   ")),
        outcome(members.createTeam("x".repeat(teamNameMaxLength + 1))),
        outcome(members.renameTeam(team.id, " ")),
        // A line break, a text-direction override, a zero-width space.
        outcome(members.createTeam("Fin\nance")),
        outcome(members.createTeam(`\u202E${finance()}`)),
        outcome(members.renameTeam(team.id, `Fin\u200Bance ${unique()}`)),
        // A name another team has, whatever its case or spacing.
        outcome(members.createTeam(` ${taken.toUpperCase()} `)),
        outcome(members.renameTeam(team.id, taken.toLowerCase())),
        outcome(members.renameTeam("no-such-team", finance())),
        outcome(members.deleteTeam("no-such-team")),
        outcome(members.addTeamMember("no-such-team", admin.userId)),
        outcome(members.addTeamMember(team.id, "no-such-person")),
        outcome(members.removeTeamMember("no-such-team", admin.userId)),
        // Nobody who isn't a member, to take out as to put in.
        outcome(members.removeTeamMember(team.id, "no-such-person")),
        outcome(members.removeTeamMember(team.id, gone.userId)),
        outcome(members.addTeamMember(team.id, gone.userId)),
      ]);
    });
    expect(refused).toStrictEqual([
      "member.team_name_invalid",
      "member.team_name_invalid",
      "member.team_name_invalid",
      "member.team_name_invalid",
      "member.team_name_invalid",
      "member.team_name_invalid",
      "member.team_name_invalid",
      "member.team_name_taken",
      "member.team_name_taken",
      "member.team_not_found",
      "member.team_not_found",
      "member.team_not_found",
      "member.not_found",
      "member.team_not_found",
      "member.not_found",
      "member.not_found",
      "member.not_found",
    ]);
    expect(audited).toStrictEqual([]);
    await expect(teamName(other.id)).resolves.toBe(taken);
    await expect(teamName(team.id)).resolves.toHaveLength(teamNameMaxLength);
    await expect(teamsOf("no-such-person")).resolves.toStrictEqual([]);
  });

  it("take everyone out of a team that is deleted, as one audited change", async () => {
    const admin = await signedInApi(idp, "admin");
    const person = await signedInAs("user");
    const name = finance();
    const team = await admin.api.members.createTeam(name);
    await admin.api.members.addTeamMember(team.id, person.userId);
    await admin.api.members.addTeamMember(team.id, admin.userId);

    const audited = await auditedDuring(async () => {
      await admin.api.members.deleteTeam(team.id);
    });
    expect(
      audited.map(({ action, target }) => [action, target?.id])
    ).toStrictEqual([["team.deleted", team.id]]);
    await expect(whoami(person.session)).resolves.toMatchObject({ teams: [] });
    await expect(teamsOf(person.userId)).resolves.toStrictEqual([]);
    // Its name is free again.
    await expect(outcome(admin.api.members.createTeam(name))).resolves.toBe(
      "ok"
    );
  });

  it("make one team when two admins give a team the same name at once", async () => {
    const [first, second] = await Promise.all([
      signedInApi(idp, "admin"),
      signedInApi(idp, "admin"),
    ]);
    const name = finance();
    const made = await Promise.all([
      outcome(first.api.members.createTeam(name)),
      outcome(second.api.members.createTeam(name.toLowerCase())),
    ]);
    expect(made.toSorted()).toStrictEqual(["member.team_name_taken", "ok"]);
  });

  it("change nothing once the admin making them is demoted or removed, even mid-change", async () => {
    const owner = await signedInApi(idp, "admin");
    const person = await signedInAs("user");
    const inTeam = await signedInAs("user");
    const name = finance();
    const team = await owner.api.members.createTeam(name);
    await owner.api.members.addTeamMember(team.id, inTeam.userId);

    type Members = typeof owner.api.members;
    const changes: ((members: Members) => Promise<unknown>)[] = [
      async (members) => await members.createTeam(finance()),
      async (members) => {
        await members.renameTeam(team.id, finance());
      },
      async (members) => {
        await members.addTeamMember(team.id, person.userId);
      },
      async (members) => {
        await members.removeTeamMember(team.id, inTeam.userId);
      },
      async (members) => {
        await members.deleteTeam(team.id);
      },
    ];
    // What another admin does to them after their session and role were
    // checked, just before the change's batch lands: demotes them, or
    // removes them (the removal's marker is what counts).
    const stops = [
      "UPDATE members SET role = 'user' WHERE user_id = ?",
      "INSERT OR IGNORE INTO member_removals (user_id, removed_at) VALUES (?, 1)",
    ];
    const before = await teamCount();
    const cases = stops.flatMap((stop) =>
      changes.map((change) => ({ stop, change }))
    );
    for (const { stop, change } of cases) {
      // oxlint-disable-next-line no-await-in-loop -- one admin at a time
      const admin = await signedInAs("admin");
      const DB = racingDb(async (db) => {
        await db.prepare(stop).bind(admin.userId).run();
      });
      // oxlint-disable-next-line no-await-in-loop -- one admin at a time
      const { core } = await openRpc(admin.session, {
        coreEnv: { ...env, DB },
      });
      let refused = "";
      // oxlint-disable-next-line no-await-in-loop -- one admin at a time
      const audited = await auditedDuring(async () => {
        refused = await outcome(change(core.authenticate().members));
      });
      expect(refused).toBe("role.forbidden");
      expect(audited).toStrictEqual([]);
    }
    await expect(teamCount()).resolves.toBe(before);
    await expect(teamName(team.id)).resolves.toBe(name);
    await expect(teamsOf(person.userId)).resolves.toStrictEqual([]);
    await expect(teamsOf(inTeam.userId)).resolves.toStrictEqual([team.id]);
  });
});

describe("Better Auth routes", () => {
  it("only serves the ones core chose, and none that changes a member, a role or a team", async () => {
    const admin = await signedInApi(idp, "admin");
    const person = await signedInAs("user");
    const name = finance();
    const team = await admin.api.members.createTeam(name);
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
      [
        "/organization/update-member-role",
        { memberId: person.userId, role: "admin" },
      ],
      [
        "/organization/remove-member",
        { memberIdOrEmail: String(person.person.email) },
      ],
      ["/organization/get-full-organization"],
      ["/organization/list-members"],
      ["/organization/list-teams"],
      ["/organization/list-team-members"],
      ["/organization/create-team", { name: "Mine" }],
      ["/organization/update-team", { teamId: team.id, data: { name: "x" } }],
      ["/organization/remove-team", { teamId: team.id }],
      [
        "/organization/add-team-member",
        { teamId: team.id, userId: person.userId },
      ],
      [
        "/organization/remove-team-member",
        { teamId: team.id, userId: admin.userId },
      ],
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
    // As the user themselves too: nothing raised their role.
    const raised = await callAuth(
      "/organization/update-member-role",
      person.session,
      { memberId: person.userId, role: "admin" }
    );
    expect(raised.status).toBe(404);
    await expect(whoami(person.session)).resolves.toMatchObject({
      role: "user",
      teams: [],
    });
    await expect(teamName(team.id)).resolves.toBe(name);
  });
});
