import type { AgentProposer } from "@grasp-os/shared/apps";
import type { AuditActor } from "@grasp-os/shared/audit";
import { staffWindowOpen } from "@grasp-os/shared/deployment-config";
import { roleSchema } from "@grasp-os/shared/roles";
import type { Role } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { accounts, members, teamMembers, teams } from "../db/core/schema.ts";
import { authFor, currentMembership } from "./auth.ts";
import { providerIds, signInConfig } from "./config.ts";

/**
 * A person's role in the organization, read now. `undefined` when they have
 * no membership, a removed one, or a role that isn't exactly one of ours:
 * no access.
 */
export const memberRole = async (
  database: D1Database,
  userId: string
): Promise<Role | undefined> => {
  const db = drizzle(database);
  const [membership] = await db
    .select({ role: members.role })
    .from(members)
    .where(currentMembership(userId));
  const role = roleSchema.safeParse(membership?.role);
  return role.success ? role.data : undefined;
};

/** The teams a person is in, read now, by name. */
export const teamsOf = async (
  database: D1Database,
  userId: string
): Promise<Identity["teams"]> =>
  await drizzle(database)
    .select({ id: teams.id, name: teams.name })
    .from(teamMembers)
    .innerJoin(teams, eq(teams.id, teamMembers.teamId))
    .where(eq(teamMembers.userId, userId))
    .orderBy(teams.name);

/**
 * A member of the organization, as the checks on what they may do see
 * them: an {@link Identity} without its session.
 */
export type Member = Pick<Identity, "userId" | "role" | "teams" | "staff">;

/**
 * Who acts: a member, or the chat's agent acting for one (agent-builds.ts)
 * with their role and rights, as `actor`, the audit log's name for it.
 */
export type Acting = Member & {
  actor?: AuditActor;
  /** The chat's agent acting, as what it writes records it. */
  via?: AgentProposer;
};

/**
 * A member's role and teams, read now; `undefined` once they have no
 * current membership. What `identify` finds of a signed-in member, for
 * whoever acts on a member's behalf without their session (an agent).
 */
export const memberOf = async (
  database: D1Database,
  userId: string
): Promise<Member | undefined> => {
  const [role, memberTeams] = await Promise.all([
    memberRole(database, userId),
    teamsOf(database, userId),
  ]);
  return role === undefined
    ? undefined
    : { userId, role, teams: memberTeams, staff: false };
};

/**
 * A Grasp staff member's role now, from the sign-in config: `undefined`
 * once the staff window has closed, or they are no longer on the staff
 * list the console keeps (checked now, not only when they signed in).
 */
export const staffRole = async (
  env: Env,
  userId: string
): Promise<Role | undefined> => {
  const config = signInConfig(env);
  if (!(config?.staff && staffWindowOpen(config, Date.now()))) {
    return undefined;
  }
  const [account] = await drizzle(env.DB)
    .select({ oid: accounts.oid })
    .from(accounts)
    .where(
      and(
        eq(accounts.userId, userId),
        eq(accounts.providerId, providerIds.staff)
      )
    );
  const listed = config.staff.oids.some(
    (oid) => oid.toLowerCase() === account?.oid?.toLowerCase()
  );
  return listed ? config.staff.role : undefined;
};

/**
 * Who a request comes from: the person behind its session cookie, with their
 * role and teams read now, from the database. Called on every request and
 * RPC call that needs a person, so a revoked or expired session, a changed
 * role, a removal or a closed staff window takes effect on the next one.
 * `undefined` means nobody is signed in.
 */
export const identify = async (
  env: Env,
  headers: Headers
): Promise<Identity | undefined> => {
  const config = signInConfig(env);
  const auth = authFor(env, config);
  if (!(auth && config)) {
    return undefined;
  }
  const found = await auth.api.getSession({ headers });
  if (!found) {
    return undefined;
  }
  const { session, user } = found;
  const person = {
    userId: user.id,
    email: user.email,
    name: user.name,
    expiresAt: session.expiresAt.toISOString(),
  };

  if (session.staff) {
    const role = await staffRole(env, user.id);
    return role === undefined
      ? undefined
      : { ...person, role, teams: [], staff: true };
  }

  const member = await memberOf(env.DB, user.id);
  if (member === undefined) {
    return undefined;
  }
  return { ...person, ...member, staff: false };
};
