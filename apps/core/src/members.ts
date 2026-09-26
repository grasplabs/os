import type { AuditEntry } from "@grasp-os/shared/audit";
import { actorOf } from "@grasp-os/shared/audit";
import { disconnectPersonalMaxOwners } from "@grasp-os/shared/connect";
import type { CodedError } from "@grasp-os/shared/errors";
import { identifierSchema } from "@grasp-os/shared/ids";
import { errorFields, log } from "@grasp-os/shared/log";
import { memberErrors } from "@grasp-os/shared/members";
import type { Member, MembersApi } from "@grasp-os/shared/members";
import { isAdmin, roleErrors, roleSchema } from "@grasp-os/shared/roles";
import type { Role } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { RpcTarget } from "capnweb";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { auditedBatch, outboxedIfChanged } from "./audit-outbox.ts";
import {
  activeAdminExists,
  activeMember,
  currentMembership,
  isRemoved,
  notRemoved,
  organizationId,
} from "./auth/auth.ts";
import { personOf } from "./connections.ts";
import {
  memberRemovals,
  members,
  sessions,
  teamMembers,
  users,
} from "./db/core/schema.ts";
import { inList } from "./db/d1.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";

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
// making it still to be one. Better Auth's member routes are off
// (`routes.ts`), since they read, then write.

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
    .where(
      and(
        eq(members.organizationId, organizationId),
        notRemoved(members.userId)
      )
    )
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
 * memberships and every session they have, with the audit event, in one
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
        sql`SELECT ${organizationId}, ${userId}, ${Date.now()}, NULL
          WHERE ${activeMember(userId)} AND ${isActiveAdmin(by.userId)}`
      )
      .onConflictDoNothing()
      .returning({ userId: memberRemovals.userId }),
    outboxedIfChanged(db, memberEntry(by, "member.removed", memberId, userId)),
    db.delete(teamMembers).where(and(eq(teamMembers.userId, userId), removed)),
    db
      .delete(members)
      .where(
        and(
          eq(members.organizationId, organizationId),
          eq(members.userId, userId),
          removed
        )
      ),
    db.delete(sessions).where(and(eq(sessions.userId, userId), removed)),
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
        eq(memberRemovals.organizationId, organizationId),
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

/** Most `disconnectPersonal` batches the cron trigger has in flight at once. */
const disconnectBatchesAtOnce = 4;

/**
 * Disconnects what is still connected for removed people: everyone whose
 * disconnect hasn't completed yet, however long ago they were removed and
 * however many there are. A completed one needs nothing more: the removal
 * deleted the person's sessions, and an OAuth callback without a session
 * burns its flow, so no flow of theirs can finish into a connection
 * afterwards. When nobody is pending, it doesn't call connect at all. The
 * cron trigger calls it.
 */
export const retryDisconnects = async (env: Env): Promise<void> => {
  const pending = await drizzle(env.DB)
    .select({ userId: memberRemovals.userId })
    .from(memberRemovals)
    .where(
      and(
        eq(memberRemovals.organizationId, organizationId),
        isNull(memberRemovals.disconnectedAt)
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
 * A signed-in admin's `members`. Every call checks the session (and the
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
}
