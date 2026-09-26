import type { AuditEntry } from "@grasp-os/shared/audit";
import { identifierSchema } from "@grasp-os/shared/ids";
import { errorFields, log } from "@grasp-os/shared/log";
import { memberErrors } from "@grasp-os/shared/members";
import type { Member, MembersApi } from "@grasp-os/shared/members";
import { isAdmin, roleErrors, roleSchema } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { RpcTarget } from "capnweb";
import { and, asc, eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { auditedBatch, outboxed, outboxedIfChanged } from "./audit-outbox.ts";
import { actorOf } from "./audit.ts";
import { isRemoved, notRemoved, organizationId } from "./auth/auth.ts";
import { personOf } from "./connections.ts";
import {
  memberRemovals,
  members,
  sessions,
  teamMembers,
  users,
} from "./db/core/schema.ts";
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

/** Refuses anyone but a member who is an admin. */
const requireAdmin = (by: Identity): void => {
  if (by.staff || !isAdmin(by.role)) {
    throw roleErrors.create("role.forbidden");
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
    throw memberErrors.create("member.not_found");
  }
  if (parsed.data === by.userId) {
    throw memberErrors.create("member.self");
  }
  return parsed.data;
};

/** The current membership of `userId`, read now. */
const membershipOf = async (
  env: Env,
  userId: string
): Promise<{ id: string } | undefined> => {
  const [membership] = await drizzle(env.DB)
    .select({ id: members.id })
    .from(members)
    .where(
      and(
        eq(members.organizationId, organizationId),
        eq(members.userId, userId),
        notRemoved(userId)
      )
    );
  return membership;
};

/** That `userId` is an admin of the organization now, as a SQL condition. */
const isActiveAdmin = (userId: string): SQL => sql`EXISTS (
  SELECT 1 FROM ${members}
  WHERE ${members.organizationId} = ${organizationId}
    AND ${members.userId} = ${userId}
    AND ${members.role} = 'admin'
    AND ${notRemoved(userId)}
)`;

/** That `userId` is a member now, as a SQL condition. */
const isActiveMember = (userId: string): SQL => sql`EXISTS (
  SELECT 1 FROM ${members}
  WHERE ${members.organizationId} = ${organizationId}
    AND ${members.userId} = ${userId}
    AND ${notRemoved(userId)}
)`;

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
export const listMembers = async (
  env: Env,
  by: Identity
): Promise<Member[]> => {
  requireAdmin(by);
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
 * still is one, checked in the same statement: of two admins removing each
 * other at once, only the first removal happens, so the organization keeps
 * an admin. Everything after it runs only once the marker is there.
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
        sql`SELECT ${organizationId}, ${userId}, ${Date.now()}
          WHERE ${isActiveMember(userId)} AND ${isActiveAdmin(by.userId)}`
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
 * Disconnects the personal connections of someone removed, in connect,
 * which revokes each grant at its provider where it can and deletes the
 * tokens. Their connections take no calls for them anyway (they are no
 * longer a member); this takes the tokens out of the vault.
 */
const disconnectPersonal = async (
  env: Env,
  by: Identity,
  userId: string
): Promise<number> => {
  try {
    const { disconnected } = await env.CONNECT.disconnectPersonal({
      person: await personOf(env, by),
      ownerUserId: userId,
    });
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
 * failed is finished by trying again.
 */
export const removeMember = async (
  env: Env,
  by: Identity,
  userId: unknown
): Promise<{ connectionsDisconnected: number }> => {
  requireAdmin(by);
  const target = targetOf(by, userId);
  const membership = await membershipOf(env, target);
  if (membership) {
    const removedNow = await recordRemoval(env, by, target, membership.id);
    // Someone else's removal of them may have landed first; otherwise the
    // admin stopped being one since their session was checked.
    if (!(removedNow || (await isRemoved(env, target)))) {
      throw roleErrors.create("role.forbidden");
    }
  } else if (!(await isRemoved(env, target))) {
    throw memberErrors.create("member.not_found");
  }
  return {
    connectionsDisconnected: await disconnectPersonal(env, by, target),
  };
};

/**
 * Ends every session of the member `userId`: their next call fails and
 * its connection closes. They stay a member and may sign in again.
 */
export const revokeMemberSessions = async (
  env: Env,
  by: Identity,
  userId: unknown
): Promise<void> => {
  requireAdmin(by);
  const target = targetOf(by, userId);
  const membership = await membershipOf(env, target);
  if (!membership) {
    throw memberErrors.create("member.not_found");
  }
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [
    db.delete(sessions).where(eq(sessions.userId, target)),
    outboxed(
      db,
      memberEntry(by, "member.sessions.revoked", membership.id, target)
    ),
  ]);
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
}
