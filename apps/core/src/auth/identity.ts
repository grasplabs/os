import { roleSchema } from "@grasp-os/shared";
import type { Role } from "@grasp-os/shared";
import type { Identity } from "@grasp-os/shared/rpc";
import { and, eq, notExists } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import {
  accounts,
  memberRemovals,
  members,
  teamMembers,
  teams,
} from "../db/core/schema.ts";
import { authFor, organizationId } from "./auth.ts";
import { providerIds, signInConfig, staffWindowOpen } from "./config.ts";

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
    .where(
      and(
        eq(members.organizationId, organizationId),
        eq(members.userId, userId),
        notExists(
          db
            .select()
            .from(memberRemovals)
            .where(
              and(
                eq(memberRemovals.organizationId, organizationId),
                eq(memberRemovals.userId, userId)
              )
            )
        )
      )
    );
  const role = roleSchema.safeParse(membership?.role);
  return role.success ? role.data : undefined;
};

/** The teams of the organization a person is in, read now, by name. */
export const teamsOf = async (
  database: D1Database,
  userId: string
): Promise<Identity["teams"]> =>
  await drizzle(database)
    .select({ id: teams.id, name: teams.name })
    .from(teamMembers)
    .innerJoin(teams, eq(teams.id, teamMembers.teamId))
    .where(
      and(
        eq(teamMembers.userId, userId),
        eq(teams.organizationId, organizationId)
      )
    )
    .orderBy(teams.name);

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

  const db = drizzle(env.DB);
  if (session.staff) {
    if (!(config.staff && staffWindowOpen(config, Date.now()))) {
      return undefined;
    }
    // Still on the staff list the console keeps, not only when signing in.
    const [account] = await db
      .select({ oid: accounts.oid })
      .from(accounts)
      .where(
        and(
          eq(accounts.userId, user.id),
          eq(accounts.providerId, providerIds.staff)
        )
      );
    const listed = config.staff.oids.some(
      (oid) => oid.toLowerCase() === account?.oid?.toLowerCase()
    );
    return listed
      ? { ...person, role: config.staff.role, teams: [], staff: true }
      : undefined;
  }

  const role = await memberRole(env.DB, user.id);
  if (!role) {
    return undefined;
  }
  const memberOf = await teamsOf(env.DB, user.id);
  return { ...person, role, teams: memberOf, staff: false };
};
