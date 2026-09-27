import {
  appErrors,
  appMemberRefSchema,
  newAppMemberSchema,
} from "@grasp-os/shared/apps";
import type {
  App,
  AppMember,
  AppMemberRef,
  AppMembersApi,
  NewAppMember,
} from "@grasp-os/shared/apps";
import { actorOf } from "@grasp-os/shared/audit";
import type { AuditEntry } from "@grasp-os/shared/audit";
import { canBuild, roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { RpcTarget } from "capnweb";
import { and, asc, eq, ne } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { appFor } from "./apps.ts";
import { auditedBatch, outboxedIfChanged } from "./audit-outbox.ts";
import { organizationId } from "./auth/auth.ts";
import { memberRole } from "./auth/identity.ts";
import { appMembers, teams, users } from "./db/core/schema.ts";
import { restartApp } from "./permissions.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";

// Sharing an App: whom it is open to besides its owner and the admins,
// and in which role (app-access.ts). Its builders share it with people and
// teams of the organization, change their role and unshare it; everyone
// with a role in it sees whom it is shared with. Every change is audited,
// in the same batch as the change, with who made it. Grasp staff never
// share an App: whom a client's data reaches is the client's decision.

type Row = typeof appMembers.$inferSelect;

const toMember = (row: Row, name: string | null): AppMember => ({
  type: row.memberType,
  id: row.memberId,
  name,
  role: row.role,
  addedBy: row.addedBy,
  addedAt: row.addedAt.toISOString(),
});

/** The rows of `app` that are `member`. */
const rowOf = (app: App, member: AppMemberRef) =>
  and(
    eq(appMembers.appId, app.id),
    eq(appMembers.memberType, member.type),
    eq(appMembers.memberId, member.id)
  );

/**
 * The member rows `where` picks, each with the name of its person or
 * team, in the order they were shared or last changed.
 */
const namedMembers = async (
  env: Env,
  where: SQL | undefined
): Promise<AppMember[]> => {
  const rows = await drizzle(env.DB)
    .select({ row: appMembers, person: users.name, team: teams.name })
    .from(appMembers)
    .leftJoin(
      users,
      and(
        eq(appMembers.memberType, "person"),
        eq(users.id, appMembers.memberId)
      )
    )
    .leftJoin(
      teams,
      and(eq(appMembers.memberType, "team"), eq(teams.id, appMembers.memberId))
    )
    .where(where)
    .orderBy(
      asc(appMembers.addedAt),
      asc(appMembers.memberType),
      asc(appMembers.memberId)
    );
  return rows.map(({ row, person, team }) => toMember(row, person ?? team));
};

const invalid = (issue: string) =>
  appErrors.create("app.member_invalid", { issues: [issue] });

/**
 * The audit entry of a change by `by` to whom `app` is shared with. The
 * role is the one they have now, or had until unshared.
 */
const memberEntry = (
  by: Identity,
  action: "app.member.added" | "app.member.removed",
  app: App,
  member: AppMemberRef & { role: string }
): AuditEntry => ({
  actor: actorOf(by),
  action,
  target: { type: "app", id: app.id },
  detail: { memberType: member.type, member: member.id, role: member.role },
});

/** Refuses Grasp staff: they never decide whom a client's App reaches. */
const requireNotStaff = (by: Identity): void => {
  if (by.staff) {
    throw roleErrors.create("role.forbidden");
  }
};

/**
 * Refuses sharing `app` with `member` in their role: only with someone in
 * the organization now, or one of its teams; never with its owner, who
 * always builds it; and as a builder only with someone whose role in the
 * organization builds Apps. A team can be made builders whatever its
 * people's roles: each builds only if their own role allows it.
 */
const requireSharable = async (
  env: Env,
  app: App,
  member: NewAppMember
): Promise<void> => {
  if (member.type === "team") {
    const team = await drizzle(env.DB)
      .select({ id: teams.id })
      .from(teams)
      .where(
        and(eq(teams.id, member.id), eq(teams.organizationId, organizationId))
      )
      .get();
    if (!team) {
      throw invalid("id: There's no such team.");
    }
    return;
  }
  if (member.id === app.owner) {
    throw invalid("id: They own the App, and always build it.");
  }
  const role = await memberRole(env.DB, member.id);
  if (role === undefined) {
    throw invalid("id: There's no such member of the organization.");
  }
  if (member.role === "builder" && !canBuild(role)) {
    throw invalid(
      "role: Only the organization's admins and builders build Apps."
    );
  }
};

/** Whom an App is shared with, in the order they were shared or changed. */
export const listMembers = async (
  env: Env,
  by: Identity,
  app: unknown
): Promise<AppMember[]> => {
  const { id } = await appFor(env, by, app, "user");
  return await namedMembers(env, eq(appMembers.appId, id));
};

/**
 * Shares an App with a person or team, or gives someone it is shared with
 * another role. Sharing again in the same role changes and records
 * nothing.
 */
export const addMember = async (
  env: Env,
  by: Identity,
  app: unknown,
  input: unknown
): Promise<AppMember> => {
  const found = await appFor(env, by, app, "builder");
  requireNotStaff(by);
  const member = appErrors.parse("app.invalid", newAppMemberSchema, input);
  await requireSharable(env, found, member);
  const db = drizzle(env.DB);
  const row: Row = {
    appId: found.id,
    memberType: member.type,
    memberId: member.id,
    role: member.role,
    addedBy: by.userId,
    addedAt: new Date(),
  };
  await auditedBatch(env, db, [
    db
      .insert(appMembers)
      .values(row)
      .onConflictDoUpdate({
        target: [appMembers.appId, appMembers.memberType, appMembers.memberId],
        set: { role: row.role, addedBy: row.addedBy, addedAt: row.addedAt },
        setWhere: ne(appMembers.role, row.role),
      }),
    outboxedIfChanged(db, memberEntry(by, "app.member.added", found, member)),
  ]);
  const [added] = await namedMembers(env, rowOf(found, member));
  // Unshared since the batch above: nothing of it stands.
  if (!added) {
    throw appErrors.create("app.conflict");
  }
  return added;
};

/**
 * Stops sharing an App with a person or team. Their next call is refused;
 * the App's server code restarts, so it keeps none of their screens'
 * subscriptions either. Unsharing with someone it isn't shared with
 * changes and records nothing.
 */
export const removeMember = async (
  env: Env,
  by: Identity,
  app: unknown,
  input: unknown
): Promise<void> => {
  const found = await appFor(env, by, app, "builder");
  requireNotStaff(by);
  const member = appErrors.parse("app.invalid", appMemberRefSchema, input);
  const db = drizzle(env.DB);
  const before = await db
    .select({ role: appMembers.role })
    .from(appMembers)
    .where(rowOf(found, member))
    .get();
  if (!before) {
    return;
  }
  // Only in the role read above, so the event records the role it ended.
  const [[removed]] = await auditedBatch(env, db, [
    db
      .delete(appMembers)
      .where(and(rowOf(found, member), eq(appMembers.role, before.role)))
      .returning(),
    outboxedIfChanged(
      db,
      memberEntry(by, "app.member.removed", found, {
        ...member,
        role: before.role,
      })
    ),
  ]);
  if (removed) {
    await restartApp(env, { type: "app", appId: found.id });
    return;
  }
  const kept = await db
    .select({ role: appMembers.role })
    .from(appMembers)
    .where(rowOf(found, member))
    .get();
  // Their role changed meanwhile; unshared meanwhile is what was asked.
  if (kept) {
    throw appErrors.create("app.conflict");
  }
};

/** A signed-in person's `apps.members`. */
export class AppMembersRpc extends RpcTarget implements AppMembersApi {
  readonly #env: Env;
  readonly #check: SessionCheck;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
  }

  async list(app: string): Promise<AppMember[]> {
    return await withPerson(
      this.#check,
      async (by) => await listMembers(this.#env, by, app)
    );
  }

  async add(app: string, member: NewAppMember): Promise<AppMember> {
    return await withPerson(
      this.#check,
      async (by) => await addMember(this.#env, by, app, member)
    );
  }

  async remove(app: string, member: AppMemberRef): Promise<void> {
    await withPerson(this.#check, async (by) => {
      await removeMember(this.#env, by, app, member);
    });
  }
}
