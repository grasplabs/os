import type { AuditEntry } from "@grasp-os/shared/audit";
import { actorOf } from "@grasp-os/shared/audit";
import {
  disconnectPersonalMaxOwners,
  oauthFlowLifetimeMs,
} from "@grasp-os/shared/connect";
import type { CodedError } from "@grasp-os/shared/errors";
import { identifierSchema } from "@grasp-os/shared/ids";
import { errorFields, log } from "@grasp-os/shared/log";
import { memberErrors, teamNameMaxLength } from "@grasp-os/shared/members";
import type { Member, MembersApi } from "@grasp-os/shared/members";
import { isAdmin, roleErrors, roleSchema } from "@grasp-os/shared/roles";
import type { Role } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { RpcTarget } from "capnweb";
import { and, asc, eq, gt, isNull, ne, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { auditedBatch, outboxedIfChanged } from "./audit-outbox.ts";
import {
  activeAdminExists,
  activeMember,
  currentMembership,
  isRemoved,
  notRemoved,
} from "./auth/auth.ts";
import { personOf } from "./connections.ts";
import {
  appMembers,
  memberRemovals,
  members,
  notifications,
  sessions,
  teamMembers,
  teams,
  users,
} from "./db/core/schema.ts";
import { inList } from "./db/d1.ts";
import { collectionTeams } from "./db/knowledge/schema.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";

// Members, roles and teams are core's own tables, changed only here, by
// the client's admins, each change in one batch with its audit event.
//
// Offboarding (threat model ID4): an admin removes someone from the
// organization, or ends their sessions. Sessions are rows Better Auth reads
// on every request, and every `/rpc` call reads the session again
// (`identify`), so deleting them fails the person's next call and closes
// the connection it came over. A removal also records the removal marker,
// which keeps them out of every sign-in after (`ensureMember`), and makes
// whatever still acts for them (App and agent stubs, and so workflow runs,
// decision Q10) fail with `permission.person_inactive`, since each call
// checks the person is still a member.
//
// Only the client's own admins offboard: Grasp staff are no members, and
// who works for the client is the client's decision.
//
// The organization always keeps an admin: every change of a membership or
// a role is one conditional statement here that also requires the admin
// making it still to be one. Team changes require the same, in the same
// statement, so an admin demoted or removed a moment ago changes nothing.

/** Logs a refusal, IDs only, and hands back the error to throw. */
const refusal = (by: Identity, error: CodedError): CodedError => {
  log.warn("member.refused", { actor: by.userId, reason: error.code });
  return error;
};

/**
 * Refuses anyone but a member who is an admin: `requireAdmin`
 * (@grasp-os/shared/roles), but also refusing Grasp staff, and logged.
 */
const requireMemberAdmin = (by: Identity): void => {
  if (by.staff || !isAdmin(by.role)) {
    throw refusal(by, roleErrors.create("role.forbidden"));
  }
};

/**
 * The person an admin names, as the client sent it: never the admin
 * themselves, so nobody locks themselves out, and so every removal leaves
 * the admin who made it, keeping the organization from losing its last
 * admin.
 */
const targetOf = (by: Identity, userId: unknown): string => {
  const parsed = identifierSchema.safeParse(userId);
  if (!parsed.success) {
    throw refusal(by, memberErrors.create("member.not_found"));
  }
  if (parsed.data === by.userId) {
    throw refusal(by, memberErrors.create("member.self"));
  }
  return parsed.data;
};

/** The current membership of `userId`, read now. */
const membershipOf = async (
  env: Env,
  userId: string
): Promise<{ id: string; role: string } | undefined> => {
  const [membership] = await drizzle(env.DB)
    .select({ id: members.id, role: members.role })
    .from(members)
    .where(currentMembership(userId));
  return membership;
};

/** That `userId` is an admin of the organization now, as a SQL condition. */
const isActiveAdmin = (userId: string): SQL => activeMember(userId, ["admin"]);

/** Whether `userId` is an admin of the organization now. */
const stillAdmin = async (env: Env, userId: string): Promise<boolean> => {
  const row = await drizzle(env.DB).get<{ admin: number }>(
    sql`SELECT ${isActiveAdmin(userId)} AS admin`
  );
  return row.admin === 1;
};

const memberEntry = (
  by: Identity,
  action: "member.removed" | "member.sessions.revoked",
  memberId: string,
  userId: string
): AuditEntry => ({
  actor: actorOf(by),
  action,
  target: { type: "member", id: memberId },
  detail: { userId },
});

/** The organization's members, by name. For admins. */
const listMembers = async (env: Env, by: Identity): Promise<Member[]> => {
  requireMemberAdmin(by);
  const rows = await drizzle(env.DB)
    .select({
      userId: members.userId,
      name: users.name,
      email: users.email,
      role: members.role,
      joinedAt: members.createdAt,
    })
    .from(members)
    .innerJoin(users, eq(users.id, members.userId))
    .where(notRemoved(members.userId))
    .orderBy(asc(users.name), asc(users.id));
  return rows.flatMap(({ role, joinedAt, ...member }) => {
    // A role that isn't ours gives no access, so it isn't listed as one.
    const parsed = roleSchema.safeParse(role);
    return parsed.success
      ? [{ ...member, role: parsed.data, joinedAt: joinedAt.toISOString() }]
      : [];
  });
};

/**
 * Records that `userId` is removed and deletes their membership, their team
 * memberships, every session and notification they have, with the audit
 * event, in one
 * batch. The marker goes in only while they are a member and the admin
 * still is one, checked in the same statement, so a removal racing any
 * other change of membership or role (see `setMemberRole`) never leaves
 * the organization without an admin: the admin making it is never the one
 * removed. Everything after it runs only once the marker is there.
 * Returns whether this call removed them.
 */
const recordRemoval = async (
  env: Env,
  by: Identity,
  userId: string,
  memberId: string
): Promise<boolean> => {
  const db = drizzle(env.DB);
  const removed = sql`NOT ${notRemoved(userId)}`;
  const [inserted] = await auditedBatch(env, db, [
    db
      .insert(memberRemovals)
      .select(
        sql`SELECT ${userId}, ${Date.now()}, NULL
          WHERE ${activeMember(userId)} AND ${isActiveAdmin(by.userId)}`
      )
      .onConflictDoNothing()
      .returning({ userId: memberRemovals.userId }),
    outboxedIfChanged(db, memberEntry(by, "member.removed", memberId, userId)),
    db.delete(teamMembers).where(and(eq(teamMembers.userId, userId), removed)),
    db.delete(members).where(and(eq(members.userId, userId), removed)),
    db.delete(sessions).where(and(eq(sessions.userId, userId), removed)),
    db
      .delete(notifications)
      .where(and(eq(notifications.personId, userId), removed)),
  ]);
  return inserted.length > 0;
};

/**
 * Records that connect completed disconnecting `userIds`, so the cron
 * trigger stops retrying them once a flow can no longer finish
 * (`retryDisconnects`).
 */
const markDisconnected = async (
  env: Env,
  userIds: readonly string[]
): Promise<void> => {
  await drizzle(env.DB)
    .update(memberRemovals)
    .set({ disconnectedAt: new Date() })
    .where(
      and(
        inList(memberRemovals.userId, userIds),
        isNull(memberRemovals.disconnectedAt)
      )
    );
};

/**
 * Disconnects the personal connections of someone removed, in connect,
 * which revokes each grant at its provider where it can, deletes the
 * tokens and spends their open OAuth flows. Their connections take no
 * calls for them anyway (they are no longer a member); this takes the
 * tokens out of the vault. What fails here, the cron trigger retries
 * (`retryDisconnects`).
 */
const disconnectPersonal = async (
  env: Env,
  by: Identity,
  userId: string
): Promise<number> => {
  try {
    const { disconnected } = await env.CONNECT.disconnectPersonal({
      person: await personOf(env, by),
      ownerUserIds: [userId],
    });
    await markDisconnected(env, [userId]);
    return disconnected;
  } catch (error) {
    log.error("member.disconnect_failed", errorFields(error));
    throw memberErrors.create("member.connections_pending");
  }
};

/**
 * Removes `userId` from the organization for good (see `recordRemoval`),
 * then disconnects their personal connections. Removing someone already
 * removed only does the second part again, so a removal whose disconnect
 * failed can also be finished by trying again.
 */
const removeMember = async (
  env: Env,
  by: Identity,
  userId: unknown
): Promise<{ connectionsDisconnected: number }> => {
  requireMemberAdmin(by);
  const target = targetOf(by, userId);
  const membership = await membershipOf(env, target);
  if (membership) {
    const removedNow = await recordRemoval(env, by, target, membership.id);
    // Someone else's removal of them may have landed first; otherwise the
    // admin stopped being one since their session was checked.
    if (!(removedNow || (await isRemoved(env, target)))) {
      throw refusal(by, roleErrors.create("role.forbidden"));
    }
  } else if (!(await isRemoved(env, target))) {
    throw refusal(by, memberErrors.create("member.not_found"));
  }
  return {
    connectionsDisconnected: await disconnectPersonal(env, by, target),
  };
};

/**
 * Ends every session of the member `userId`: their next call fails and
 * its connection closes. They stay a member and may sign in again. The
 * sessions go only while the admin still is one, checked in the same
 * statement as the delete.
 */
const revokeMemberSessions = async (
  env: Env,
  by: Identity,
  userId: unknown
): Promise<void> => {
  requireMemberAdmin(by);
  const target = targetOf(by, userId);
  const membership = await membershipOf(env, target);
  if (!membership) {
    throw refusal(by, memberErrors.create("member.not_found"));
  }
  const db = drizzle(env.DB);
  const [ended] = await auditedBatch(env, db, [
    db
      .delete(sessions)
      .where(and(eq(sessions.userId, target), isActiveAdmin(by.userId)))
      .returning({ id: sessions.id }),
    outboxedIfChanged(
      db,
      memberEntry(by, "member.sessions.revoked", membership.id, target)
    ),
  ]);
  // Nothing ended: they had no session, or the admin no longer is one.
  if (ended.length === 0 && !(await stillAdmin(env, by.userId))) {
    throw refusal(by, roleErrors.create("role.forbidden"));
  }
};

/**
 * Gives the member `userId` `role`, the admin themselves included. One
 * conditional update: it changes the role only while it still is the one
 * read here, so the event records the role it replaced, while the admin
 * still is one and, unless the new role is admin, while someone other than
 * `userId` is an admin too. Every change of membership or role goes through
 * a statement like it (`recordRemoval`), so however they race, the
 * organization keeps an admin. When another admin changed the role in
 * between, it changes nothing and says so: the admin sees the new role and
 * can try again.
 */
const setMemberRole = async (
  env: Env,
  by: Identity,
  userId: unknown,
  role: unknown
): Promise<void> => {
  requireMemberAdmin(by);
  const target = identifierSchema.safeParse(userId);
  const parsedRole = roleSchema.safeParse(role);
  if (!parsedRole.success) {
    throw refusal(by, memberErrors.create("member.role_invalid"));
  }
  const membership = target.success
    ? await membershipOf(env, target.data)
    : undefined;
  if (!(target.success && membership)) {
    throw refusal(by, memberErrors.create("member.not_found"));
  }
  const newRole = parsedRole.data;
  if (membership.role === newRole) {
    return;
  }
  const db = drizzle(env.DB);
  const keepsAnAdmin =
    newRole === "admin" ? sql`1` : activeAdminExists(target.data);
  const [[changed]] = await auditedBatch(env, db, [
    db
      .update(members)
      .set({ role: newRole })
      .where(
        and(
          currentMembership(target.data),
          eq(members.role, membership.role),
          isActiveAdmin(by.userId),
          keepsAnAdmin
        )
      )
      .returning({ id: members.id }),
    outboxedIfChanged(db, {
      actor: actorOf(by),
      action: "member.role.updated",
      target: { type: "member", id: membership.id },
      detail: {
        userId: target.data,
        previousRole: membership.role,
        role: newRole,
      },
    }),
  ]);
  if (changed) {
    return;
  }
  const now = await membershipOf(env, target.data);
  if (!now) {
    throw refusal(by, memberErrors.create("member.not_found"));
  }
  if (!(await stillAdmin(env, by.userId))) {
    throw refusal(by, roleErrors.create("role.forbidden"));
  }
  if (now.role !== membership.role) {
    throw refusal(by, memberErrors.create("member.role_changed"));
  }
  throw refusal(by, memberErrors.create("member.last_admin"));
};

/**
 * Control and format characters (bidirectional overrides and marks,
 * zero-width characters) and line separators: none belongs in a name, and
 * each can make one name read as another.
 */
const unreadable = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const spaces = /\s+/gu;

const teamNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(teamNameMaxLength)
  .refine((name) => !unreadable.test(name))
  .transform((name) => name.replaceAll(spaces, " "));

/**
 * A team's name as the client sent it, trimmed and with single spaces, and
 * the key that keeps names apart (`teams.name_key`): the name without case
 * or compatibility forms, so "Finance" and "finance" are one.
 */
const teamNameOf = (
  by: Identity,
  name: unknown
): { name: string; nameKey: string } => {
  const parsed = teamNameSchema.safeParse(name);
  if (!parsed.success) {
    throw refusal(by, memberErrors.create("member.team_name_invalid"));
  }
  return {
    name: parsed.data,
    nameKey: parsed.data.normalize("NFKC").toLowerCase(),
  };
};

/** A team's ID as the client sent it. */
const teamIdOf = (by: Identity, teamId: unknown): string => {
  const parsed = identifierSchema.safeParse(teamId);
  if (!parsed.success) {
    throw refusal(by, memberErrors.create("member.team_not_found"));
  }
  return parsed.data;
};

/** The person a team change names, as the client sent it. */
const teamPersonOf = (by: Identity, userId: unknown): string => {
  const parsed = identifierSchema.safeParse(userId);
  if (!parsed.success) {
    throw refusal(by, memberErrors.create("member.not_found"));
  }
  return parsed.data;
};

/** That the team `teamId` exists now, as a SQL condition. */
const teamExists = (teamId: string): SQL =>
  sql`EXISTS (SELECT 1 FROM ${teams} WHERE ${teams.id} = ${teamId})`;

/** That a team other than `teamId` has the name `nameKey` now, as a SQL condition. */
const nameTaken = (nameKey: string, teamId?: string): SQL => sql`EXISTS (
  SELECT 1 FROM ${teams}
  WHERE ${teams.nameKey} = ${nameKey}
    ${teamId === undefined ? sql`` : sql`AND ${teams.id} <> ${teamId}`}
)`;

/**
 * Refuses a team change that changed nothing, saying why: the admin no
 * longer is one, there's no such team, no such member, or another team has
 * the name. Returns when there was simply nothing to change: they were in
 * the team already, or not in it, or the team has that name already.
 */
const refuseTeamChange = async (
  env: Env,
  by: Identity,
  change: { teamId?: string; userId?: string; nameKey?: string }
): Promise<void> => {
  const { teamId, userId, nameKey } = change;
  const row = await drizzle(env.DB).get<{
    admin: number;
    team: number;
    member: number;
    taken: number;
  }>(sql`SELECT
    ${isActiveAdmin(by.userId)} AS admin,
    ${teamId === undefined ? sql`1` : teamExists(teamId)} AS team,
    ${userId === undefined ? sql`1` : activeMember(userId)} AS member,
    ${nameKey === undefined ? sql`0` : nameTaken(nameKey, teamId)} AS taken`);
  if (row.admin === 0) {
    throw refusal(by, roleErrors.create("role.forbidden"));
  }
  if (row.team === 0) {
    throw refusal(by, memberErrors.create("member.team_not_found"));
  }
  if (row.member === 0) {
    throw refusal(by, memberErrors.create("member.not_found"));
  }
  if (row.taken === 1) {
    throw refusal(by, memberErrors.create("member.team_name_taken"));
  }
};

/**
 * Makes a team, with nobody in it, while the admin still is one. A name
 * another team has is refused by the insert itself (`name_key` is unique),
 * so two admins naming a team the same at once make one team.
 */
const createTeam = async (
  env: Env,
  by: Identity,
  name: unknown
): Promise<{ id: string }> => {
  requireMemberAdmin(by);
  const team = teamNameOf(by, name);
  const id = crypto.randomUUID();
  const db = drizzle(env.DB);
  const [created] = await auditedBatch(env, db, [
    db
      .insert(teams)
      .select(
        sql`SELECT ${id}, ${team.name}, ${team.nameKey}, ${Date.now()}
          WHERE ${isActiveAdmin(by.userId)}`
      )
      .onConflictDoNothing()
      .returning({ id: teams.id }),
    outboxedIfChanged(db, {
      actor: actorOf(by),
      action: "team.created",
      target: { type: "team", id },
    }),
  ]);
  if (created.length === 0) {
    await refuseTeamChange(env, by, { nameKey: team.nameKey });
    // Neither refused: the other team of that name went in between.
    throw refusal(by, memberErrors.create("member.team_name_taken"));
  }
  return { id };
};

/**
 * Renames a team, while the admin still is one and no other team has the
 * name. Nothing changes, and nothing is recorded, when it has that name
 * already.
 */
const renameTeam = async (
  env: Env,
  by: Identity,
  teamId: unknown,
  name: unknown
): Promise<void> => {
  requireMemberAdmin(by);
  const id = teamIdOf(by, teamId);
  const team = teamNameOf(by, name);
  const db = drizzle(env.DB);
  const [renamed] = await auditedBatch(env, db, [
    db
      .update(teams)
      .set(team)
      .where(
        and(
          eq(teams.id, id),
          ne(teams.name, team.name),
          sql`NOT ${nameTaken(team.nameKey, id)}`,
          isActiveAdmin(by.userId)
        )
      )
      .returning({ id: teams.id }),
    outboxedIfChanged(db, {
      actor: actorOf(by),
      action: "team.updated",
      target: { type: "team", id },
    }),
  ]);
  if (renamed.length === 0) {
    await refuseTeamChange(env, by, { teamId: id, nameKey: team.nameKey });
  }
};

/**
 * Deletes a team while the admin still is one, and in the same batch
 * everything in this database that names it: who was in it, and every App
 * shared with it. Each of those goes only once the team is gone, so a
 * delete that was refused removes nothing. One event records it all.
 *
 * Collections that named it are in the Knowledge database, which no batch
 * here reaches: their rows go right after. If that fails it is logged and
 * the rows stay, reaching nobody: a collection opens to the teams a person
 * is in now (`teamsOf`, which reads `teams`), and a team's ID is never used
 * again. A decision waiting on the team's answer reaches nobody either
 * (`decisions.ts` asks only a team that exists), and times out.
 */
const deleteTeam = async (
  env: Env,
  by: Identity,
  teamId: unknown
): Promise<void> => {
  requireMemberAdmin(by);
  const id = teamIdOf(by, teamId);
  const db = drizzle(env.DB);
  const gone = sql`NOT ${teamExists(id)}`;
  const [deleted] = await auditedBatch(env, db, [
    db
      .delete(teams)
      .where(and(eq(teams.id, id), isActiveAdmin(by.userId)))
      .returning({ id: teams.id }),
    outboxedIfChanged(db, {
      actor: actorOf(by),
      action: "team.deleted",
      target: { type: "team", id },
    }),
    db.delete(teamMembers).where(and(eq(teamMembers.teamId, id), gone)),
    db
      .delete(appMembers)
      .where(
        and(
          eq(appMembers.memberType, "team"),
          eq(appMembers.memberId, id),
          gone
        )
      ),
  ]);
  if (deleted.length === 0) {
    await refuseTeamChange(env, by, { teamId: id });
    return;
  }
  try {
    await drizzle(env.KNOWLEDGE)
      .delete(collectionTeams)
      .where(eq(collectionTeams.teamId, id));
  } catch (error) {
    log.error("team.collections_kept", { teamId: id, ...errorFields(error) });
  }
};

const teamMemberEntry = (
  by: Identity,
  action: "team.member.added" | "team.member.removed",
  teamId: string,
  userId: string
): AuditEntry => ({
  actor: actorOf(by),
  action,
  target: { type: "team", id: teamId },
  detail: { userId },
});

/**
 * Puts a member in a team: only someone who is a member now (never someone
 * removed), in a team that exists, while the admin still is one, all
 * checked in the insert itself. Nothing changes, and nothing is recorded,
 * when they are in it already.
 */
const addTeamMember = async (
  env: Env,
  by: Identity,
  teamId: unknown,
  userId: unknown
): Promise<void> => {
  requireMemberAdmin(by);
  const id = teamIdOf(by, teamId);
  const target = teamPersonOf(by, userId);
  const db = drizzle(env.DB);
  const [added] = await auditedBatch(env, db, [
    db
      .insert(teamMembers)
      .select(
        sql`SELECT ${id}, ${target}, ${Date.now()}
          WHERE ${teamExists(id)}
            AND ${activeMember(target)}
            AND ${isActiveAdmin(by.userId)}`
      )
      .onConflictDoNothing()
      .returning({ userId: teamMembers.userId }),
    outboxedIfChanged(db, teamMemberEntry(by, "team.member.added", id, target)),
  ]);
  if (added.length === 0) {
    await refuseTeamChange(env, by, { teamId: id, userId: target });
  }
};

/**
 * Takes someone out of a team, while the admin still is one. Nothing
 * changes, and nothing is recorded, when they are a member but not in the
 * team; someone who isn't a member is refused, as when adding them.
 */
const removeTeamMember = async (
  env: Env,
  by: Identity,
  teamId: unknown,
  userId: unknown
): Promise<void> => {
  requireMemberAdmin(by);
  const id = teamIdOf(by, teamId);
  const target = teamPersonOf(by, userId);
  const db = drizzle(env.DB);
  const [taken] = await auditedBatch(env, db, [
    db
      .delete(teamMembers)
      .where(
        and(
          eq(teamMembers.teamId, id),
          eq(teamMembers.userId, target),
          isActiveAdmin(by.userId)
        )
      )
      .returning({ userId: teamMembers.userId }),
    outboxedIfChanged(
      db,
      teamMemberEntry(by, "team.member.removed", id, target)
    ),
  ]);
  if (taken.length === 0) {
    await refuseTeamChange(env, by, { teamId: id, userId: target });
  }
};

/** Most `disconnectPersonal` batches the cron trigger has in flight at once. */
const disconnectBatchesAtOnce = 4;

/**
 * Disconnects what is still connected for removed people: everyone whose
 * disconnect hasn't completed yet, however long ago they were removed and
 * however many there are, and everyone removed within the last OAuth flow
 * lifetime, completed or not. A flow the person took back before the
 * removal (taking it needs their session) can still finish into a
 * connection after their disconnect completed; the flow's lifetime bounds
 * that with room to spare. When nobody is pending, it doesn't call
 * connect at all. The cron trigger calls it.
 */
export const retryDisconnects = async (env: Env): Promise<void> => {
  const pending = await drizzle(env.DB)
    .select({ userId: memberRemovals.userId })
    .from(memberRemovals)
    .where(
      or(
        isNull(memberRemovals.disconnectedAt),
        gt(memberRemovals.removedAt, new Date(Date.now() - oauthFlowLifetimeMs))
      )
    )
    .orderBy(asc(memberRemovals.removedAt), asc(memberRemovals.userId));
  const batches: string[][] = [];
  for (
    let start = 0;
    start < pending.length;
    start += disconnectPersonalMaxOwners
  ) {
    batches.push(
      pending
        .slice(start, start + disconnectPersonalMaxOwners)
        .map(({ userId }) => userId)
    );
  }
  // Each batch on its own, so one that fails doesn't hold up the rest; it
  // is tried again on the next run. A few at a time, from one shared list,
  // so a long backlog doesn't send connect every batch at once.
  const queue = batches.values();
  const disconnectNext = async (): Promise<void> => {
    for (const ownerUserIds of queue) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- one batch at a time per lane
        await env.CONNECT.disconnectPersonal({ person: null, ownerUserIds });
        // oxlint-disable-next-line no-await-in-loop -- one batch at a time per lane
        await markDisconnected(env, ownerUserIds);
      } catch (error) {
        log.error("member.disconnect_failed", errorFields(error));
      }
    }
  };
  await Promise.all(
    Array.from({ length: disconnectBatchesAtOnce }, disconnectNext)
  );
};

/**
 * A signed-in admin's `members`, teams included. Every call checks the session (and the
 * `members` flag) first, then the caller's role.
 */
export class MembersRpc extends RpcTarget implements MembersApi {
  readonly #env: Env;
  readonly #check: SessionCheck;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
  }

  async list(): Promise<Member[]> {
    return await withPerson(
      this.#check,
      async (person) => await listMembers(this.#env, person)
    );
  }

  async remove(userId: string): Promise<{ connectionsDisconnected: number }> {
    return await withPerson(
      this.#check,
      async (person) => await removeMember(this.#env, person, userId)
    );
  }

  async revokeSessions(userId: string): Promise<void> {
    await withPerson(this.#check, async (person) => {
      await revokeMemberSessions(this.#env, person, userId);
    });
  }

  async setRole(userId: string, role: Role): Promise<void> {
    await withPerson(this.#check, async (person) => {
      await setMemberRole(this.#env, person, userId, role);
    });
  }

  async createTeam(name: string): Promise<{ id: string }> {
    return await withPerson(
      this.#check,
      async (person) => await createTeam(this.#env, person, name)
    );
  }

  async renameTeam(teamId: string, name: string): Promise<void> {
    await withPerson(this.#check, async (person) => {
      await renameTeam(this.#env, person, teamId, name);
    });
  }

  async deleteTeam(teamId: string): Promise<void> {
    await withPerson(this.#check, async (person) => {
      await deleteTeam(this.#env, person, teamId);
    });
  }

  async addTeamMember(teamId: string, userId: string): Promise<void> {
    await withPerson(this.#check, async (person) => {
      await addTeamMember(this.#env, person, teamId, userId);
    });
  }

  async removeTeamMember(teamId: string, userId: string): Promise<void> {
    await withPerson(this.#check, async (person) => {
      await removeTeamMember(this.#env, person, teamId, userId);
    });
  }
}
