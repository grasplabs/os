import { appErrors } from "@grasp-os/shared/apps";
import type { App, AppRole } from "@grasp-os/shared/apps";
import { appIdSchema } from "@grasp-os/shared/ids";
import { canBuild, isAdmin, roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { and, eq, exists, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { sourcesOf, unreadableBy } from "./app-provenance.ts";
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
// Someone an App is shared with is refused too, with `app.unreadable`,
// while it has read data they can't read where it comes from
// (app-provenance.ts).
//
// Roles are read from the database on every call, like the session and
// the person's role and teams (auth/identity.ts), so unsharing, a team
// change or a new role in the organization applies to the next call.
// Grasp staff, who are admins while their window is open, manage Apps as
// admins do, but never share one (app-members.ts): whom a client's data
// reaches is the client's decision.

/** Who asks, as far as their role in an App goes. */
export type Person = Pick<Identity, "userId" | "role" | "teams">;

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
const ceilingOf = (by: Person): AppRole =>
  canBuild(by.role) ? "builder" : "user";

/**
 * `by`'s role in `app`, and whether it comes from whom the App is shared
 * with (`shared`), rather than from being an admin or its owner; undefined
 * when they have none.
 */
const appRole = async (
  env: Env,
  by: Person,
  app: App
): Promise<{ role: AppRole; shared: boolean } | undefined> => {
  if (isAdmin(by.role)) {
    return { role: "builder", shared: false };
  }
  if (app.owner === by.userId) {
    return { role: ceilingOf(by), shared: false };
  }
  const rows = await drizzle(env.DB)
    .select({ role: appMembers.role })
    .from(appMembers)
    .where(and(eq(appMembers.appId, app.id), rowsOf(by)));
  if (rows.length === 0) {
    return undefined;
  }
  const builds = rows.some(({ role }) => role === "builder");
  return { role: builds ? ceilingOf(by) : "user", shared: true };
};

/**
 * Refuses `by` unless they have `needed` or more in `app`: an App they
 * have no role in with `app.not_found`, as one that isn't there, and too
 * low a role with `role.forbidden`. Someone it is shared with is also
 * refused, with `app.unreadable`, while the App has read data they can't
 * read where it comes from (app-provenance.ts). Returns their role.
 */
export const requireAppRole = async (
  env: Env,
  by: Person,
  app: App,
  needed: AppRole
): Promise<AppRole> => {
  const found = await appRole(env, by, app);
  if (found === undefined) {
    throw appErrors.create("app.not_found");
  }
  const { role, shared } = found;
  if (needed === "builder" && role !== "builder") {
    throw roleErrors.create("role.forbidden");
  }
  if (shared) {
    const unreadable = unreadableBy(await sourcesOf(env, app.id), {
      userId: by.userId,
      teamIds: by.teams.map(({ id }) => id),
    });
    if (unreadable.length > 0) {
      throw appErrors.create("app.unreadable");
    }
  }
  return role;
};

/**
 * Of the Apps `ids`, those `by` may open now as far as what each App read
 * goes (app-provenance.ts): every one for an admin, their own, and any
 * other only while they can read everything it read. That they have a
 * role in each is for the caller to have checked (`appsOpenTo`). For
 * listing what belongs to many Apps at once, as `requireAppRole` decides
 * for one.
 */
export const appsReadableBy = async (
  env: Env,
  by: Person,
  ids: readonly string[]
): Promise<Set<string>> => {
  if (isAdmin(by.role) || ids.length === 0) {
    return new Set(ids);
  }
  const rows = await drizzle(env.DB)
    .select({ id: apps.id, owner: apps.ownerId })
    .from(apps)
    .where(inList(apps.id, ids));
  const reader = {
    userId: by.userId,
    teamIds: by.teams.map(({ id }) => id),
  };
  const readable = await Promise.all(
    rows.map(async ({ id, owner }) => {
      if (owner === by.userId) {
        return [id];
      }
      const sources = await sourcesOf(env, appIdSchema.parse(id));
      return unreadableBy(sources, reader).length === 0 ? [id] : [];
    })
  );
  return new Set(readable.flat());
};

/**
 * The Apps `by` has a role in, as a condition on `apps`: every App for an
 * admin (undefined), otherwise their own and those shared with them. One
 * shared with them that has read data they can't read is listed, and
 * refused when they open it, with why.
 */
export const appsOpenTo = (env: Env, by: Person): SQL | undefined => {
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
