import type { AuditDetailValue, AuditEntry } from "@grasp-os/shared/audit";
import { actorOf } from "@grasp-os/shared/audit";
import { permissionIdSchema } from "@grasp-os/shared/ids";
import type { PermissionId } from "@grasp-os/shared/ids";
import { errorFields, log } from "@grasp-os/shared/log";
import {
  permissionErrors,
  permissionObjectSchema,
  permissionRequestSchema,
  permissionSubjectSchema,
} from "@grasp-os/shared/permissions";
import type {
  Authority,
  Permission,
  PermissionObject,
  PermissionSubject,
} from "@grasp-os/shared/permissions";
import { canBuild, isAdmin, roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { z } from "zod";

import { outboxed, outboxedIfChanged, auditedBatch } from "./audit-outbox.ts";
import { memberRole } from "./auth/identity.ts";
import { approvals, apps, permissions } from "./db/core/schema.ts";
import { isUniqueViolation } from "./db/d1.ts";
import { collections } from "./db/knowledge/schema.ts";
import { appHost } from "./durable-objects.ts";

// Permission records and the one check every server path runs. A person
// asks for a permission (it allows nothing yet), an admin other than them
// grants it by approving the request (approvals.ts), and an admin can
// revoke it at any time. Checks read the records on every call, so a
// revoke applies to the next call. Every change is audited.
//
// Granting is one step, from requested to active, taken only in the
// statement that approves the request's approval.

type Row = typeof permissions.$inferSelect;

const stringListSchema = z.array(z.string());

/** A stored mask: a connection permission's masked fields, if any. */
const maskOf = (row: Pick<Row, "mask">): string[] =>
  row.mask === null ? [] : stringListSchema.parse(JSON.parse(row.mask));

/** How a subject is stored. */
const subjectColumns = (subject: PermissionSubject) =>
  subject.type === "app"
    ? { subjectType: subject.type, subjectId: subject.appId }
    : { subjectType: subject.type, subjectId: subject.agentId };

/** How an object is stored (see the `permissions` table). */
const objectColumns = (object: PermissionObject) => {
  switch (object.type) {
    case "connection": {
      return {
        objectType: object.type,
        objectId: object.connectionId,
        resource: object.resource ?? null,
        mask: object.mask === undefined ? null : JSON.stringify(object.mask),
      };
    }
    case "collection": {
      return {
        objectType: object.type,
        objectId: object.collectionId,
        resource: null,
        mask: null,
      };
    }
    case "workflow": {
      return {
        objectType: object.type,
        objectId: object.appId,
        resource: object.workflowId,
        mask: null,
      };
    }
    default: {
      return object satisfies never;
    }
  }
};

/** A stored object back in its API shape; anything unexpected fails. */
export const objectOf = (row: Row): PermissionObject => {
  const resource = row.resource ?? undefined;
  switch (row.objectType) {
    case "connection": {
      const mask = maskOf(row);
      return permissionObjectSchema.parse({
        type: row.objectType,
        connectionId: row.objectId,
        ...(resource === undefined ? {} : { resource }),
        ...(mask.length === 0 ? {} : { mask }),
      });
    }
    case "collection": {
      return permissionObjectSchema.parse({
        type: row.objectType,
        collectionId: row.objectId,
      });
    }
    case "workflow": {
      return permissionObjectSchema.parse({
        type: row.objectType,
        appId: row.objectId,
        workflowId: resource,
      });
    }
    default: {
      throw new Error(`Unknown permission object ${String(row.objectType)}`);
    }
  }
};

const subjectOf = (row: Row): PermissionSubject =>
  permissionSubjectSchema.parse(
    row.subjectType === "app"
      ? { type: row.subjectType, appId: row.subjectId }
      : { type: row.subjectType, agentId: row.subjectId }
  );

export const toPermission = (row: Row): Permission => ({
  id: permissionIdSchema.parse(row.id),
  subject: subjectOf(row),
  object: objectOf(row),
  actions: stringListSchema.parse(JSON.parse(row.actions)),
  binding: row.binding,
  status: row.status,
  requestedBy: row.requestedBy,
  requestedAt: row.requestedAt.toISOString(),
  grantedBy: row.grantedBy,
  grantedAt: row.grantedAt?.toISOString() ?? null,
  revokedBy: row.revokedBy,
  revokedAt: row.revokedAt?.toISOString() ?? null,
});

/** Rows of `subject`, as a condition. */
const ofSubject = (subject: PermissionSubject): SQL | undefined => {
  const { subjectType, subjectId } = subjectColumns(subject);
  return and(
    eq(permissions.subjectType, subjectType),
    eq(permissions.subjectId, subjectId)
  );
};

/** What the audit log records of a permission: identifiers only. */
const auditDetail = ({
  subject,
  object,
  actions,
  binding,
}: Permission): Record<string, AuditDetailValue> => {
  // The object's IDs by name: connectionId and resource, collectionId, or
  // appId and workflowId; a connection's masked fields as one
  // identifier-sized value, as the actions are.
  const { type: objectType, ...objectIds } = object;
  const { subjectType, subjectId } = subjectColumns(subject);
  const { mask, ...ids } = { mask: undefined, ...objectIds };
  return {
    subjectType,
    subjectId,
    objectType,
    ...ids,
    ...(mask === undefined ? {} : { mask: mask.join(" ") }),
    actions: actions.join(" "),
    binding,
  };
};

/**
 * The audit entry of a change to `permission` by `by`, with `extra` detail
 * such as the approval it went through.
 */
export const changeEntry = (
  by: Identity,
  action: `permission.${
    | "requested"
    | "granted"
    | "revoked"
    | "declined"
    | "withdrawn"}`,
  permission: Permission,
  extra: Record<string, AuditDetailValue> = {}
): AuditEntry => ({
  actor: actorOf(by),
  action,
  target: { type: "permission", id: permission.id },
  detail: { ...auditDetail(permission), ...extra },
});

/** Refuses anyone but an admin. */
export const requireAdmin = (by: Identity): void => {
  if (!isAdmin(by.role)) {
    throw roleErrors.create("role.forbidden");
  }
};

/** Admins, and builders who build the Apps that need permissions. */
const requireBuilder = (by: Identity): void => {
  if (!canBuild(by.role)) {
    throw roleErrors.create("role.forbidden");
  }
};

export const parseId = (id: unknown): PermissionId => {
  const parsed = permissionIdSchema.safeParse(id);
  if (!parsed.success) {
    throw permissionErrors.create("permission.not_found");
  }
  return parsed.data;
};

/**
 * An App's server code gets its env when it starts: restarting it after a
 * grant or revoke gives it an env as the records are now. A revoked stub
 * it still holds is refused anyway, on its next call. Best effort: the
 * change stands if the App can't be reached.
 */
export const restartApp = async (
  env: Env,
  subject: PermissionSubject
): Promise<void> => {
  if (subject.type !== "app") {
    return;
  }
  try {
    await appHost(env, subject.appId).restart("Its permissions changed.");
  } catch (error) {
    log.error("app.restart_failed", {
      appId: subject.appId,
      ...errorFields(error),
    });
  }
};

export const findRow = async (env: Env, id: string): Promise<Row | undefined> =>
  await drizzle(env.DB)
    .select()
    .from(permissions)
    .where(eq(permissions.id, id))
    .get();

/**
 * The Apps a permission names, its subject and a workflow's App, must be in
 * the registry: one query for both. Apps are never deleted, so one that
 * exists now still does when the permission is stored.
 */
const requireApps = async (
  env: Env,
  subject: PermissionSubject,
  object: PermissionObject
): Promise<void> => {
  const named = new Map<string, string>();
  if (subject.type === "app") {
    named.set("subject.appId", subject.appId);
  }
  if (object.type === "workflow") {
    named.set("object.appId", object.appId);
  }
  if (named.size === 0) {
    return;
  }
  const found = await drizzle(env.DB)
    .select({ id: apps.id })
    .from(apps)
    .where(inArray(apps.id, [...new Set(named.values())]));
  const existing = new Set(found.map(({ id }) => id));
  const missing = [...named].filter(([, appId]) => !existing.has(appId));
  if (missing.length > 0) {
    throw permissionErrors.create("permission.invalid", {
      issues: missing.map(([path]) => `${path}: There's no such App.`),
    });
  }
};

/**
 * A collection a permission names must exist, and not be someone's
 * personal collection: Apps and agents never read those (see
 * knowledge/access.ts), so nobody can be asked to grant one.
 */
export const requireCollection = async (
  env: Env,
  object: PermissionObject
): Promise<void> => {
  if (object.type !== "collection") {
    return;
  }
  const found = await drizzle(env.KNOWLEDGE)
    .select({ access: collections.access })
    .from(collections)
    .where(eq(collections.id, object.collectionId))
    .get();
  if (!found) {
    throw permissionErrors.create("permission.invalid", {
      issues: ["object.collectionId: There's no such collection."],
    });
  }
  if (found.access === "me") {
    throw permissionErrors.create("permission.invalid", {
      issues: [
        "object.collectionId: A personal collection can't be given to an App or agent.",
      ],
    });
  }
};

/**
 * Opens the approval that grants the requested permission `id`, for an
 * admin to decide, unless it has one pending already or isn't requested
 * (anymore). The one way such an approval is made: in the batch that
 * requests the permission, and before granting one requested before
 * approvals existed.
 */
export const openPermissionApproval = (
  db: DrizzleD1Database,
  id: string,
  approval: string = crypto.randomUUID()
) =>
  db
    .insert(approvals)
    .select(
      sql`SELECT ${approval}, 'permission', ${permissions.id},
          NULL, NULL, NULL, NULL, NULL, 'admins', 'pending',
          ${permissions.requestedBy}, ${permissions.requestedAt}, NULL, NULL, 0,
          NULL, NULL
        FROM ${permissions}
        WHERE ${permissions.id} = ${id} AND ${permissions.status} = 'requested'`
    )
    .onConflictDoNothing();

/**
 * Asks for a permission for an App or agent. It allows nothing until an
 * admin other than the requester approves it (approvals.ts).
 */
export const requestPermission = async (
  env: Env,
  by: Identity,
  input: unknown
): Promise<Permission> => {
  requireBuilder(by);
  if (by.staff) {
    // Grasp staff neither ask for nor decide a client's approvals.
    throw roleErrors.create("role.forbidden");
  }
  const { subject, object, actions, binding } = permissionErrors.parse(
    "permission.invalid",
    permissionRequestSchema,
    input
  );
  await requireApps(env, subject, object);
  await requireCollection(env, object);
  const row: Row = {
    id: crypto.randomUUID(),
    ...subjectColumns(subject),
    ...objectColumns(object),
    actions: JSON.stringify(actions),
    binding,
    status: "requested",
    requestedBy: by.userId,
    requestedAt: new Date(),
    grantedBy: null,
    grantedAt: null,
    revokedBy: null,
    revokedAt: null,
  };
  const permission = toPermission(row);
  const approval = crypto.randomUUID();
  const db = drizzle(env.DB);
  try {
    await auditedBatch(env, db, [
      db.insert(permissions).values(row),
      openPermissionApproval(db, row.id, approval),
      outboxed(
        db,
        changeEntry(by, "permission.requested", permission, { approval })
      ),
    ]);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw permissionErrors.create("permission.conflict", { binding });
    }
    throw error;
  }
  return permission;
};

/**
 * Revokes a permission, requested or active: the next call that needs it
 * is refused, and a request waiting for approval is declined with it.
 * Revoking one that is already revoked changes nothing.
 */
export const revokePermission = async (
  env: Env,
  by: Identity,
  id: unknown
): Promise<Permission> => {
  requireAdmin(by);
  const found = await findRow(env, parseId(id));
  if (!found) {
    throw permissionErrors.create("permission.not_found");
  }
  const db = drizzle(env.DB);
  const [[revoked]] = await auditedBatch(env, db, [
    db
      .update(permissions)
      .set({ status: "revoked", revokedBy: by.userId, revokedAt: new Date() })
      .where(
        and(
          eq(permissions.id, found.id),
          inArray(permissions.status, ["requested", "active"])
        )
      )
      .returning(),
    outboxedIfChanged(
      db,
      changeEntry(by, "permission.revoked", toPermission(found))
    ),
    db
      .update(approvals)
      .set({ status: "declined", decidedBy: by.userId, decidedAt: new Date() })
      .where(
        and(
          eq(approvals.permissionId, found.id),
          eq(approvals.status, "pending")
        )
      ),
  ]);
  if (!revoked) {
    // Already revoked: nothing changed, and nothing is recorded.
    return toPermission((await findRow(env, found.id)) ?? found);
  }
  const permission = toPermission(revoked);
  await restartApp(env, permission.subject);
  return permission;
};

/** Every permission, or those of one App or agent, oldest first. */
export const listPermissions = async (
  env: Env,
  by: Identity,
  subject?: unknown
): Promise<Permission[]> => {
  requireBuilder(by);
  let filter: SQL | undefined;
  if (subject !== undefined) {
    filter = ofSubject(
      permissionErrors.parse(
        "permission.invalid",
        permissionSubjectSchema,
        subject
      )
    );
  }
  const rows = await drizzle(env.DB)
    .select()
    .from(permissions)
    .where(filter)
    .orderBy(asc(permissions.requestedAt), asc(permissions.id));
  return rows.map(toPermission);
};

/**
 * The person an App or agent acts for must still be in the organization:
 * nothing works for someone who has left or was removed.
 */
export const requireActivePerson = async (
  env: Env,
  authority: Authority
): Promise<void> => {
  if (!(await memberRole(env.DB, authority.onBehalfOf))) {
    throw permissionErrors.create("permission.person_inactive");
  }
};

/**
 * The active permissions of an App or agent, whoever it acts for. Only for
 * building an env whose stubs check the person on every call.
 */
export const activePermissions = async (
  env: Env,
  subject: PermissionSubject
): Promise<Permission[]> => {
  const rows = await drizzle(env.DB)
    .select()
    .from(permissions)
    .where(and(ofSubject(subject), eq(permissions.status, "active")))
    .orderBy(asc(permissions.requestedAt), asc(permissions.id));
  return rows.map(toPermission);
};

/** The active permissions of the App or agent `authority` names. */
export const grantedPermissions = async (
  env: Env,
  authority: Authority
): Promise<Permission[]> => {
  await requireActivePerson(env, authority);
  return await activePermissions(env, authority.subject);
};

/**
 * The permission check. Every server path that lets an App or agent touch a
 * connection, a collection or a workflow calls it first, on every call:
 * the person it acts for is still a member, and `permissionId` (the
 * permission the stub was built from) is active, of that exact subject,
 * covers the object and allows the action. Only that permission counts, so
 * revoking it stops its stubs even when another permission covers the same
 * thing. A permission for a whole connection covers each resource in it;
 * one for a resource covers only that resource. Throws `permission.denied`
 * or `permission.person_inactive` otherwise. Returns the fields that
 * permission masks in a connection's results (none for other objects).
 *
 * It doesn't intersect the grant with the person's own access (R5): connect
 * does that for personal connections, and the Knowledge queries for
 * collections.
 */
export const authorize = async (
  env: Env,
  authority: Authority,
  object: PermissionObject,
  action: string,
  permissionId: PermissionId
): Promise<{ mask: string[] }> => {
  await requireActivePerson(env, authority);
  const { objectType, objectId, resource } = objectColumns(object);
  const rows = await drizzle(env.DB)
    .select({
      id: permissions.id,
      actions: permissions.actions,
      mask: permissions.mask,
    })
    .from(permissions)
    .where(
      and(
        ofSubject(authority.subject),
        eq(permissions.status, "active"),
        eq(permissions.id, permissionId),
        eq(permissions.objectType, objectType),
        eq(permissions.objectId, objectId),
        resource === null
          ? isNull(permissions.resource)
          : or(isNull(permissions.resource), eq(permissions.resource, resource))
      )
    );
  const allowing = rows.find((row) =>
    stringListSchema.parse(JSON.parse(row.actions)).includes(action)
  );
  if (!allowing) {
    throw permissionErrors.create("permission.denied", { action });
  }
  return { mask: maskOf(allowing) };
};
