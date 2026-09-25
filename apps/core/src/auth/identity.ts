import { roleSchema } from "@grasp-os/shared";
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
import type { AuthEnv } from "./config.ts";

/**
 * Who a request comes from: the person behind its session cookie, with their
 * role and teams read now, from the database. Called on every request and
 * RPC call that needs a person, so a revoked or expired session, a changed
 * role, a removal or a closed staff window takes effect on the next one.
 * `undefined` means nobody is signed in.
 */
export const identify = async (
  env: AuthEnv,
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

  const [membership] = await db
    .select({ role: members.role })
    .from(members)
    .where(
      and(
        eq(members.organizationId, organizationId),
        eq(members.userId, user.id),
        notExists(
          db
            .select()
            .from(memberRemovals)
            .where(
              and(
                eq(memberRemovals.organizationId, organizationId),
                eq(memberRemovals.userId, user.id)
              )
            )
        )
      )
    );
  // No membership, a removed one, or a role that isn't exactly one of ours:
  // no access.
  const role = roleSchema.safeParse(membership?.role);
  if (!role.success) {
    return undefined;
  }
  const memberOf = await db
    .select({ id: teams.id, name: teams.name })
    .from(teamMembers)
    .innerJoin(teams, eq(teams.id, teamMembers.teamId))
    .where(
      and(
        eq(teamMembers.userId, user.id),
        eq(teams.organizationId, organizationId)
      )
    )
    .orderBy(teams.name);
  return { ...person, role: role.data, teams: memberOf, staff: false };
};
