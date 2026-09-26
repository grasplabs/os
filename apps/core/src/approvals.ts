import {
  approvalErrors,
  approveOptionsSchema,
} from "@grasp-os/shared/approvals";
import type { Approval } from "@grasp-os/shared/approvals";
import type { AuditEntry } from "@grasp-os/shared/audit";
import type { CodedError } from "@grasp-os/shared/errors";
import { identifierSchema } from "@grasp-os/shared/ids";
import type { Permission } from "@grasp-os/shared/permissions";
import { permissionErrors } from "@grasp-os/shared/permissions";
import type { Role } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { and, asc, eq, ne, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";

import { requireBuilder } from "./apps.ts";
import { auditedBatch, outboxedIfChanged } from "./audit-outbox.ts";
import { actorOf } from "./audit.ts";
import { activeAdminExists, notRemoved, organizationId } from "./auth/auth.ts";
import {
  approvals,
  apps,
  members,
  permissions,
  workflowParamValues,
} from "./db/core/schema.ts";
import { inList } from "./db/d1.ts";
import {
  changeEntry,
  findRow,
  objectOf,
  openPermissionApproval,
  parseId,
  requireAdmin,
  requireCollection,
  restartApp,
  toPermission,
} from "./permissions.ts";

// Approvals: the changes nobody makes alone (threat model R4, R8, PM1,
// WF5). Granting a permission needs an admin; changing a sensitive workflow
// value needs an admin or a builder. Either way, never the person who
// asked, and never Grasp staff.
//
// - Deciding is one conditional update that moves the approval from
//   `pending` once, and holds only while the decider may decide it: an
//   active member with the role its approvers name, not its requester (the
//   break-glass exception below), with a requester who is still an active
//   admin or builder, and with what it changes still there. The change it
//   approves (the permission made active, the value set) and its audit
//   event are in the same batch, each only if that update changed the
//   row, so two approvers racing, a replay, or an approval after a
//   decline or a withdrawal changes nothing.
// - Break-glass: a deployment with exactly one active admin can't have a
//   second person grant a permission, so that admin may approve their own
//   permission request, but only when they ask for it explicitly, only
//   while no other active admin exists (checked in the same update), and
//   audited with `breakGlass: true`. Sensitive values have no break-glass:
//   a builder is a second person too.
// - Who decided comes from the session, never from the request.

type ApprovalRow = typeof approvals.$inferSelect;
type PermissionRow = typeof permissions.$inferSelect;

/** How a pending approval ends. */
type Verdict = "approved" | "declined" | "withdrawn";

/** The most pending approvals one list returns, oldest first. */
const maxListed = 200;

/** The roles that may ask for approvals, and approve sensitive values. */
const buildRoles: readonly Role[] = ["admin", "builder"];

/** That `userId` is an active member with one of `roles`, as SQL. */
const memberWithRole = (
  userId: string | SQLiteColumn,
  roles: readonly Role[]
): SQL => sql`EXISTS (
  SELECT 1 FROM ${members}
  WHERE ${members.organizationId} = ${organizationId}
    AND ${members.userId} = ${userId}
    AND ${inList(members.role, roles)}
    AND ${notRemoved(userId)}
)`;

/** That `userId` may decide the approval its approvers name, now. */
const isApprover = (userId: string): SQL => sql`CASE ${approvals.approvers}
  WHEN 'admins' THEN ${memberWithRole(userId, ["admin"])}
  WHEN 'builders' THEN ${memberWithRole(userId, buildRoles)}
  ELSE 0 END`;

/**
 * That the approval's requester may still ask for it: an active admin or
 * builder. Someone who left, or lost the role, has no request to approve.
 */
const requesterActive = (): SQL =>
  memberWithRole(approvals.requestedBy, buildRoles);

/** An App that exists, by the ID `id` holds. */
const appExists = (id: SQLiteColumn): SQL =>
  sql`EXISTS (SELECT 1 FROM ${apps} WHERE ${apps.id} = ${id})`;

/**
 * That what the approval changes is still there: a permission still
 * requested, with the Apps it names; a parameter's App.
 */
const changeLive = (): SQL => sql`CASE ${approvals.kind}
  WHEN 'permission' THEN EXISTS (
    SELECT 1 FROM ${permissions}
    WHERE ${permissions.id} = ${approvals.permissionId}
      AND ${permissions.status} = 'requested'
      AND (${permissions.subjectType} <> 'app' OR ${appExists(permissions.subjectId)})
      AND (${permissions.objectType} <> 'workflow' OR ${appExists(permissions.objectId)})
  )
  WHEN 'param' THEN ${appExists(approvals.appId)}
  ELSE 0 END`;

/**
 * Nobody approves their own request. With `breakGlass`, the only admin may
 * approve their own permission request: `isApprover` already requires them
 * to be an admin, and this that no other active admin exists.
 */
const notOwn = (userId: string, breakGlass: boolean): SQL =>
  or(
    ne(approvals.requestedBy, userId),
    breakGlass
      ? and(
          eq(approvals.kind, "permission"),
          sql`NOT ${activeAdminExists(userId)}`
        )
      : undefined
  ) ?? sql`0`;

/** Who may end a pending approval with `verdict`, as SQL on its row. */
const mayDecide = (
  userId: string,
  verdict: Verdict,
  breakGlass: boolean
): SQL => {
  const pending = eq(approvals.status, "pending");
  switch (verdict) {
    case "approved": {
      return (
        and(
          pending,
          isApprover(userId),
          requesterActive(),
          changeLive(),
          notOwn(userId, breakGlass)
        ) ?? sql`0`
      );
    }
    case "declined": {
      // A stale request can still be turned down.
      return and(pending, isApprover(userId)) ?? sql`0`;
    }
    case "withdrawn": {
      return and(pending, eq(approvals.requestedBy, userId)) ?? sql`0`;
    }
    default: {
      return verdict satisfies never;
    }
  }
};

/** A stored approval in its API shape; a damaged row fails. */
export const toApproval = (row: ApprovalRow): Approval => {
  const fields = {
    id: row.id,
    status: row.status,
    approvers: row.approvers,
    requestedBy: row.requestedBy,
    requestedAt: row.requestedAt.toISOString(),
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    breakGlass: row.breakGlass,
  };
  if (row.kind === "permission" && row.permissionId !== null) {
    return { ...fields, kind: row.kind, permission: row.permissionId };
  }
  if (
    row.kind === "param" &&
    row.appId !== null &&
    row.workflowId !== null &&
    row.param !== null &&
    row.value !== null
  ) {
    return {
      ...fields,
      kind: row.kind,
      app: row.appId,
      workflow: row.workflowId,
      param: row.param,
      from: row.previous,
      to: row.value,
    };
  }
  throw new Error(`Approval ${row.id} is damaged`);
};

/** The approval `id` names, which must exist. */
const findApproval = async (env: Env, id: unknown): Promise<ApprovalRow> => {
  const parsed = identifierSchema.safeParse(id);
  const row = parsed.success
    ? await drizzle(env.DB)
        .select()
        .from(approvals)
        .where(eq(approvals.id, parsed.data))
        .get()
    : undefined;
  if (!row) {
    throw approvalErrors.create("approval.not_found");
  }
  return row;
};

/**
 * Why `by` may not end the approval with `verdict` now, if they may not:
 * the same conditions as `mayDecide`, read now, one by one, so the refusal
 * says which.
 */
const refusal = async (
  env: Env,
  by: Identity,
  row: ApprovalRow,
  verdict: Verdict,
  breakGlass: boolean
): Promise<CodedError | undefined> => {
  if (by.staff && verdict !== "withdrawn") {
    // Grasp staff never decide a client's approvals.
    return approvalErrors.create("approval.forbidden");
  }
  const now = await drizzle(env.DB)
    .select({
      status: approvals.status,
      approver: sql<number>`${isApprover(by.userId)}`,
      requesterActive: sql<number>`${requesterActive()}`,
      live: sql<number>`${changeLive()}`,
      otherAdmin: sql<number>`${activeAdminExists(by.userId)}`,
    })
    .from(approvals)
    .where(eq(approvals.id, row.id))
    .get();
  const own = row.requestedBy === by.userId;
  if (now?.status !== "pending") {
    return approvalErrors.create("approval.closed");
  }
  if (verdict === "withdrawn") {
    return own ? undefined : approvalErrors.create("approval.forbidden");
  }
  if (!now.approver) {
    return approvalErrors.create("approval.forbidden");
  }
  if (verdict === "declined") {
    return undefined;
  }
  if (own && !(breakGlass && row.kind === "permission")) {
    return approvalErrors.create("approval.self");
  }
  if (own && now.otherAdmin) {
    return approvalErrors.create("approval.break_glass_refused");
  }
  if (!(now.requesterActive && now.live)) {
    return approvalErrors.create("approval.stale");
  }
  return undefined;
};

/** The audit entry of `by` ending the approval with `verdict`. */
const decisionEntry = (
  by: Identity,
  row: ApprovalRow,
  verdict: Verdict,
  breakGlass: boolean,
  permission: Permission | undefined
): AuditEntry => {
  const approval = row.id;
  if (permission) {
    return verdict === "approved"
      ? changeEntry(by, "permission.granted", permission, {
          approval,
          requestedBy: row.requestedBy,
          breakGlass,
        })
      : changeEntry(by, `permission.${verdict}`, permission, { approval });
  }
  // Names the parameter, never its values (R16).
  return {
    actor: actorOf(by),
    action: `workflow.param.${verdict}`,
    target: { type: "app", id: row.appId ?? "" },
    detail: {
      workflow: row.workflowId,
      param: row.param,
      approval,
      requestedBy: row.requestedBy,
    },
  };
};

/**
 * The change an approval makes when it ends with `verdict`, as statements
 * that run only if `decided` holds: that this very decision was stored.
 */
const changesOf = (
  db: DrizzleD1Database,
  by: Identity,
  row: ApprovalRow,
  verdict: Verdict,
  at: Date,
  decided: SQL
) => {
  if (row.kind === "param") {
    if (verdict !== "approved") {
      return [];
    }
    return [
      db
        .insert(workflowParamValues)
        .select(
          sql`SELECT ${approvals.appId}, ${approvals.workflowId}, ${approvals.param},
              ${approvals.value}, ${approvals.requestedBy}, ${at.getTime()}, ${approvals.id}
            FROM ${approvals} WHERE ${approvals.id} = ${row.id} AND ${decided}`
        )
        .onConflictDoUpdate({
          target: [
            workflowParamValues.appId,
            workflowParamValues.workflowId,
            workflowParamValues.param,
          ],
          set: {
            value: sql`excluded.value`,
            setBy: sql`excluded.set_by`,
            setAt: sql`excluded.set_at`,
            approvalId: sql`excluded.approval_id`,
          },
        }),
    ];
  }
  const requested = and(
    eq(permissions.id, row.permissionId ?? ""),
    eq(permissions.status, "requested"),
    decided
  );
  return [
    verdict === "approved"
      ? db
          .update(permissions)
          .set({ status: "active", grantedBy: by.userId, grantedAt: at })
          .where(requested)
      : db
          .update(permissions)
          .set({ status: "revoked", revokedBy: by.userId, revokedAt: at })
          .where(requested),
  ];
};

/** The permission a permission approval grants. */
const permissionOf = async (
  env: Env,
  row: ApprovalRow
): Promise<PermissionRow | undefined> =>
  row.kind === "permission" && row.permissionId !== null
    ? await findRow(env, row.permissionId)
    : undefined;

/**
 * Ends a pending approval with `verdict` for `by`, if they may, once, and
 * makes its change in the same batch. Refused with why otherwise.
 */
const decide = async (
  env: Env,
  by: Identity,
  row: ApprovalRow,
  verdict: Verdict,
  breakGlass: boolean
): Promise<ApprovalRow> => {
  const permissionRow = await permissionOf(env, row);
  if (permissionRow && verdict === "approved") {
    // No grant ever names a missing or personal collection, however old
    // its request.
    await requireCollection(env, objectOf(permissionRow));
  }
  const refused = await refusal(env, by, row, verdict, breakGlass);
  if (refused) {
    throw refused;
  }
  const at = new Date();
  const ownApproval = verdict === "approved" && row.requestedBy === by.userId;
  const decided = sql`EXISTS (
    SELECT 1 FROM ${approvals}
    WHERE ${approvals.id} = ${row.id}
      AND ${approvals.status} = ${verdict}
      AND ${approvals.decidedBy} = ${by.userId}
      AND ${approvals.decidedAt} = ${at.getTime()}
  )`;
  const db = drizzle(env.DB);
  const [[changed]] = await auditedBatch(env, db, [
    db
      .update(approvals)
      .set({
        status: verdict,
        decidedBy: by.userId,
        decidedAt: at,
        breakGlass: ownApproval,
      })
      .where(
        and(eq(approvals.id, row.id), mayDecide(by.userId, verdict, breakGlass))
      )
      .returning(),
    outboxedIfChanged(
      db,
      decisionEntry(
        by,
        row,
        verdict,
        ownApproval,
        permissionRow && toPermission(permissionRow)
      )
    ),
    ...changesOf(db, by, row, verdict, at, decided),
  ]);
  if (!changed) {
    // Something changed since it was checked above: say what.
    throw (
      (await refusal(env, by, row, verdict, breakGlass)) ??
      approvalErrors.create("approval.closed")
    );
  }
  if (permissionRow && verdict === "approved") {
    await restartApp(env, toPermission(permissionRow).subject);
  }
  return changed;
};

const breakGlassOf = (options: unknown): boolean =>
  approvalErrors.parse(
    "approval.invalid",
    approveOptionsSchema.optional(),
    options
  )?.breakGlass === true;

/** Pending approvals, oldest first. For admins and builders. */
export const listApprovals = async (
  env: Env,
  by: Identity
): Promise<Approval[]> => {
  requireBuilder(by);
  const rows = await drizzle(env.DB)
    .select()
    .from(approvals)
    .where(eq(approvals.status, "pending"))
    .orderBy(asc(approvals.requestedAt), asc(approvals.id))
    .limit(maxListed);
  return rows.map(toApproval);
};

/** Approves an approval, and so makes its change. */
export const approve = async (
  env: Env,
  by: Identity,
  id: unknown,
  options?: unknown
): Promise<Approval> => {
  const breakGlass = breakGlassOf(options);
  const row = await findApproval(env, id);
  return toApproval(await decide(env, by, row, "approved", breakGlass));
};

/** Rejects an approval: its change is never made. */
export const decline = async (
  env: Env,
  by: Identity,
  id: unknown
): Promise<Approval> =>
  toApproval(
    await decide(env, by, await findApproval(env, id), "declined", false)
  );

/** Withdraws one's own request. */
export const withdraw = async (
  env: Env,
  by: Identity,
  id: unknown
): Promise<Approval> =>
  toApproval(
    await decide(env, by, await findApproval(env, id), "withdrawn", false)
  );

/**
 * Grants a requested permission, by approving its approval (`approve`):
 * never by the admin who asked, unless they are the only admin and ask for
 * break-glass.
 */
export const grantPermission = async (
  env: Env,
  by: Identity,
  id: unknown,
  options?: unknown
): Promise<Permission> => {
  requireAdmin(by);
  const breakGlass = breakGlassOf(options);
  const found = await findRow(env, parseId(id));
  if (!found) {
    throw permissionErrors.create("permission.not_found");
  }
  const db = drizzle(env.DB);
  // A permission requested before approvals existed has none yet.
  await openPermissionApproval(db, found.id);
  const pending = await db
    .select()
    .from(approvals)
    .where(
      and(eq(approvals.permissionId, found.id), eq(approvals.status, "pending"))
    )
    .get();
  if (!pending) {
    throw permissionErrors.create("permission.not_requested");
  }
  await decide(env, by, pending, "approved", breakGlass);
  return toPermission((await findRow(env, found.id)) ?? found);
};
