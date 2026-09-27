import { appErrors } from "@grasp-os/shared/apps";
import type { App, AppRole } from "@grasp-os/shared/apps";
import { canBuild, isAdmin, roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { and, eq, exists, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { apps, appMembers } from "./db/core/schema.ts";
import { inList } from "./db/d1.ts";

// Who may do what in an App (App roles). An App is open to:
//
// - the organization's admins, who manage every App, as builders;
// - its owner, the person who created it, as a builder;
// - the people and teams it is shared with (`app_members`), in the role
//   it is shared with them in; someone in several (as a person and
//   through a team) has the highest.
//
// The person's role in the organization caps their role in an App: only
// admins and builders build, so someone whose role there is `user` works
// in an App's screens at most, even their own App's or one shared with
// them as a builder. Everyone else has no role in the App, and it doesn't
// exist for them (`app.not_found`), just as an App that isn't there.
//
// Roles are read from the database on every call, like the session and
// the person's role and teams (auth/identity.ts), so unsharing, a team
// change or a new role in the organization applies to the next call.
// Grasp staff, who are admins while their window is open, manage Apps as
// admins do, but never share one (app-members.ts): whom a client's data
// reaches is the client's decision.

/** The member rows that are `by`'s: their own, or one of their teams'. */
const rowsOf = (by: Pick<Identity, "userId" | "teams">): SQL =>
  or(
    and(
      eq(appMembers.memberType, "person"),
      eq(appMembers.memberId, by.userId)
    ),
    by.teams.length === 0
      ? undefined
      : and(
          eq(appMembers.memberType, "team"),
          inList(
            appMembers.memberId,
            by.teams.map(({ id }) => id)
          )
        )
  ) ?? sql`0`;

/** The highest role `by`'s organization role lets them have in an App. */
const ceilingOf = (by: Identity): AppRole =>
  canBuild(by.role) ? "builder" : "user";

/** `by`'s role in `app`, or undefined when they have none. */
export const appRole = async (
  env: Env,
  by: Identity,
  app: App
): Promise<AppRole | undefined> => {
  if (isAdmin(by.role)) {
    return "builder";
  }
  if (app.owner === by.userId) {
    return ceilingOf(by);
  }
  const rows = await drizzle(env.DB)
    .select({ role: appMembers.role })
    .from(appMembers)
    .where(and(eq(appMembers.appId, app.id), rowsOf(by)));
  if (rows.length === 0) {
    return undefined;
  }
  return rows.some(({ role }) => role === "builder") ? ceilingOf(by) : "user";
};

/**
 * Refuses `by` unless they have `needed` or more in `app`: an App they
 * have no role in with `app.not_found`, as one that isn't there, and too
 * low a role with `role.forbidden`. Returns their role.
 */
export const requireAppRole = async (
  env: Env,
  by: Identity,
  app: App,
  needed: AppRole
): Promise<AppRole> => {
  const role = await appRole(env, by, app);
  if (role === undefined) {
    throw appErrors.create("app.not_found");
  }
  if (needed === "builder" && role !== "builder") {
    throw roleErrors.create("role.forbidden");
  }
  return role;
};

/**
 * The Apps `by` has a role in, as a condition on `apps`: every App for an
 * admin (undefined), otherwise their own and those shared with them.
 */
export const appsOpenTo = (env: Env, by: Identity): SQL | undefined => {
  if (isAdmin(by.role)) {
    return undefined;
  }
  const db = drizzle(env.DB);
  return or(
    eq(apps.ownerId, by.userId),
    exists(
      db
        .select({ one: sql`1` })
        .from(appMembers)
        .where(and(eq(appMembers.appId, apps.id), rowsOf(by)))
    )
  );
};
