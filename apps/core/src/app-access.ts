import { appErrors } from "@grasp-os/shared/apps";
import type { App, AppRole } from "@grasp-os/shared/apps";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import { canBuild, isAdmin, roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { and, eq, exists, isNull, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { sourcesOf, sourcesOfApps, unreadableBy } from "./app-provenance.ts";
import { builtinOwner } from "./builtin-app-id.ts";
import { apps, appMembers, teamMembers } from "./db/core/schema.ts";
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
//
// The built-in blueprints' Apps (owned by `builtinOwner`, installed with
// each release, app-blueprints.ts) are the exception: every admin and
// builder has the `user` role in them, and nobody more, admins included,
// so everyone who builds finds them and creates Apps from them, and
// nobody changes, runs, shares or asks permissions for them. Users have
// no role in them.

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
  if (app.owner === builtinOwner) {
    return canBuild(by.role) ? { role: "user", shared: false } : undefined;
  }
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
 * for one: a few queries and connect calls, whatever the number of Apps.
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
  const own = rows.filter(({ owner }) => owner === by.userId);
  const shared = rows
    .filter(({ owner }) => owner !== by.userId)
    .map(({ id }) => appIdSchema.parse(id));
  // All the shared Apps' sources at once, each decided in memory.
  const sources = await sourcesOfApps(env, shared);
  return new Set([
    ...own.map(({ id }) => id),
    ...shared.filter((id) => {
      const of = sources.get(id);
      return of !== undefined && unreadableBy(of, reader).length === 0;
    }),
  ]);
};

/**
 * The Apps `by` has a role in, as a condition on `apps`: every App for an
 * admin (undefined), otherwise their own, those shared with them, and, if
 * they build, the built-ins. One shared with them that has read data they
 * can't read is listed, and refused when they open it, with why.
 */
export const appsOpenTo = (env: Env, by: Person): SQL | undefined => {
  if (isAdmin(by.role)) {
    return undefined;
  }
  const db = drizzle(env.DB);
  return or(
    eq(apps.ownerId, by.userId),
    canBuild(by.role) ? eq(apps.ownerId, builtinOwner) : undefined,
    exists(
      db
        .select({ one: sql`1` })
        .from(appMembers)
        .where(and(eq(appMembers.appId, apps.id), rowsOf(by)))
    )
  );
};

/**
 * The Apps `by` finds, as a condition on `apps`: those in use (never one
 * created from a blueprint that is still pending, app-blueprints.ts) that
 * they have a role in (`appsOpenTo`).
 */
export const appsFoundBy = (env: Env, by: Person): SQL => {
  const inUse = isNull(apps.pendingSince);
  return and(inUse, appsOpenTo(env, by)) ?? inUse;
};

/**
 * That `by` still has a role in `app` when the statement runs, as SQL: an
 * admin (as their session said), the App's owner, someone who builds for a
 * built-in, or someone it is shared with, as a person or through a team
 * they are in then. For guarding a
 * write that an earlier check allowed, so a role lost since stops it.
 * What the App read (`app.unreadable`) can't be decided in SQL, and isn't
 * part of it.
 */
export const stillOpenTo = (by: Person, app: AppId): SQL => {
  if (isAdmin(by.role)) {
    return sql`1`;
  }
  const owners = canBuild(by.role) ? [by.userId, builtinOwner] : [by.userId];
  return sql`(EXISTS (SELECT 1 FROM ${apps} WHERE ${apps.id} = ${app} AND ${inList(apps.ownerId, owners)}) OR EXISTS (SELECT 1 FROM ${appMembers} WHERE ${appMembers.appId} = ${app} AND ((${appMembers.memberType} = 'person' AND ${appMembers.memberId} = ${by.userId}) OR (${appMembers.memberType} = 'team' AND ${appMembers.memberId} IN (SELECT ${teamMembers.teamId} FROM ${teamMembers} WHERE ${teamMembers.userId} = ${by.userId})))))`;
};
