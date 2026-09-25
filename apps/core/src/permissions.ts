import type { AuditActor, AuditDetailValue } from "@grasp-os/shared/audit";
import { permissionIdSchema } from "@grasp-os/shared/ids";
import type { PermissionId } from "@grasp-os/shared/ids";
import {
  permissionErrors,
  permissionIdInputSchema,
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
import type { Identity } from "@grasp-os/shared/rpc";
import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { audit } from "./audit.ts";
import { memberRole } from "./auth/identity.ts";
import { permissions } from "./db/core/schema.ts";

// Permission records and the one check every server path runs. A person
// asks for a permission (it allows nothing yet), an admin grants it, and an
// admin can revoke it at any time. Checks read the records on every call,
// so a revoke applies to the next call. Every change is audited.
//
// Granting is one step, from requested to active, taken only by
// `grantPermission`: an approval step goes in front of that step without
// changing the records or the check.

type Row = typeof permissions.$inferSelect;

const actionsSchema = z.array(z.string());

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
      };
    }
    case "collection": {
      return {
        objectType: object.type,
        objectId: object.collectionId,
        resource: null,
      };
    }
    case "workflow": {
      return {
        objectType: object.type,
        objectId: object.appId,
        resource: object.workflowId,
      };
    }
    default: {
      return object satisfies never;
    }
  }
};

/** A stored object back in its API shape; anything unexpected fails. */
const objectOf = (row: Row): PermissionObject => {
  const resource = row.resource ?? undefined;
  switch (row.objectType) {
    case "connection": {
      return permissionObjectSchema.parse({
        type: row.objectType,
        connectionId: row.objectId,
        ...(resource === undefined ? {} : { resource }),
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

const iso = (date: Date | null): string | null => date?.toISOString() ?? null;

const toPermission = (row: Row): Permission => ({
  id: permissionIdSchema.parse(row.id),
  subject: subjectOf(row),
  object: objectOf(row),
  actions: actionsSchema.parse(JSON.parse(row.actions)),
  binding: row.binding,
  status: row.status,
  requestedBy: row.requestedBy,
  requestedAt: row.requestedAt.toISOString(),
  grantedBy: row.grantedBy,
  grantedAt: iso(row.grantedAt),
  revokedBy: row.revokedBy,
  revokedAt: iso(row.revokedAt),
});

/** Rows of `subject`, as a condition. */
const ofSubject = (subject: PermissionSubject): SQL | undefined => {
  const { subjectType, subjectId } = subjectColumns(subject);
  return and(
    eq(permissions.subjectType, subjectType),
    eq(permissions.subjectId, subjectId)
  );
};

const actorOf = ({ userId, staff }: Identity): AuditActor =>
  staff ? { type: "staff", userId } : { type: "person", userId };

/** What the audit log records of a permission: identifiers only. */
const auditDetail = ({
  subject,
  object,
  actions,
  binding,
}: Permission): Record<string, AuditDetailValue> => {
  // The object's IDs by name: connectionId and resource, collectionId, or
  // appId and workflowId.
  const { type: objectType, ...objectIds } = object;
  const { subjectType, subjectId } = subjectColumns(subject);
  return {
    subjectType,
    subjectId,
    objectType,
    ...objectIds,
    actions: actions.join(" "),
    binding,
  };
};

const recordChange = async (
  env: Env,
  by: Identity,
  action: "permission.requested" | "permission.granted" | "permission.revoked",
  permission: Permission
): Promise<void> => {
  await audit(env).log({
    actor: actorOf(by),
    action,
    target: { type: "permission", id: permission.id },
    detail: auditDetail(permission),
  });
};

const requireAdmin = (by: Identity): void => {
  if (by.role !== "admin") {
    throw permissionErrors.create("permission.forbidden");
  }
};

/** Admins, and builders who build the Apps that need permissions. */
const requireBuilder = (by: Identity): void => {
  if (by.role === "user") {
    throw permissionErrors.create("permission.forbidden");
  }
};

const parseId = (id: unknown): PermissionId => {
  const parsed = permissionIdInputSchema.safeParse(id);
  if (!parsed.success) {
    throw permissionErrors.create("permission.not_found");
  }
  return parsed.data;
};

/** Whether D1 refused a write for a unique index, however it was wrapped. */
const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Error &&
  (error.message.includes("UNIQUE constraint failed") ||
    isUniqueViolation(error.cause));

const findRow = async (env: Env, id: PermissionId): Promise<Row | undefined> =>
  await drizzle(env.DB)
    .select()
    .from(permissions)
    .where(eq(permissions.id, id))
    .get();

/**
 * Asks for a permission for an App or agent. It allows nothing until an
 * admin grants it.
 */
export const requestPermission = async (
  env: Env,
  by: Identity,
  input: unknown
): Promise<Permission> => {
  requireBuilder(by);
  const parsed = permissionRequestSchema.safeParse(input);
  if (!parsed.success) {
    throw permissionErrors.create("permission.invalid", {
      issues: parsed.error.issues.map(
        ({ path, message }) => `${path.map(String).join(".")}: ${message}`
      ),
    });
  }
  const { subject, object, actions, binding } = parsed.data;
  let row: Row;
  try {
    row = await drizzle(env.DB)
      .insert(permissions)
      .values({
        id: crypto.randomUUID(),
        ...subjectColumns(subject),
        ...objectColumns(object),
        actions: JSON.stringify(actions),
        binding,
        status: "requested",
        requestedBy: by.userId,
        requestedAt: new Date(),
      })
      .returning()
      .get();
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw permissionErrors.create("permission.conflict", { binding });
    }
    throw error;
  }
  const permission = toPermission(row);
  await recordChange(env, by, "permission.requested", permission);
  return permission;
};

/** Grants a requested permission: from now on, it allows its actions. */
export const grantPermission = async (
  env: Env,
  by: Identity,
  id: unknown
): Promise<Permission> => {
  requireAdmin(by);
  const permissionId = parseId(id);
  // One conditional update, so a grant can't race a revoke back to life.
  const [row] = await drizzle(env.DB)
    .update(permissions)
    .set({ status: "active", grantedBy: by.userId, grantedAt: new Date() })
    .where(
      and(eq(permissions.id, permissionId), eq(permissions.status, "requested"))
    )
    .returning();
  if (!row) {
    throw (await findRow(env, permissionId))
      ? permissionErrors.create("permission.not_requested")
      : permissionErrors.create("permission.not_found");
  }
  const permission = toPermission(row);
  await recordChange(env, by, "permission.granted", permission);
  return permission;
};

/**
 * Revokes a permission, requested or active: the next call that needs it
 * is refused. Revoking one that is already revoked changes nothing.
 */
export const revokePermission = async (
  env: Env,
  by: Identity,
  id: unknown
): Promise<Permission> => {
  requireAdmin(by);
  const permissionId = parseId(id);
  const [row] = await drizzle(env.DB)
    .update(permissions)
    .set({ status: "revoked", revokedBy: by.userId, revokedAt: new Date() })
    .where(
      and(
        eq(permissions.id, permissionId),
        inArray(permissions.status, ["requested", "active"])
      )
    )
    .returning();
  if (!row) {
    const revoked = await findRow(env, permissionId);
    if (!revoked) {
      throw permissionErrors.create("permission.not_found");
    }
    return toPermission(revoked);
  }
  const permission = toPermission(row);
  await recordChange(env, by, "permission.revoked", permission);
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
    const parsed = permissionSubjectSchema.safeParse(subject);
    if (!parsed.success) {
      throw permissionErrors.create("permission.invalid");
    }
    filter = ofSubject(parsed.data);
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
const requireActivePerson = async (
  env: Env,
  authority: Authority
): Promise<void> => {
  if (!(await memberRole(env.DB, authority.onBehalfOf))) {
    throw permissionErrors.create("permission.person_inactive");
  }
};

/** The active permissions of the App or agent `authority` names. */
export const grantedPermissions = async (
  env: Env,
  authority: Authority
): Promise<Permission[]> => {
  await requireActivePerson(env, authority);
  const rows = await drizzle(env.DB)
    .select()
    .from(permissions)
    .where(and(ofSubject(authority.subject), eq(permissions.status, "active")))
    .orderBy(asc(permissions.requestedAt), asc(permissions.id));
  return rows.map(toPermission);
};

/**
 * The permission check. Every server path that lets an App or agent touch a
 * connection, a collection or a workflow calls it first, on every call:
 * the person it acts for is still here, and an active permission of that
 * exact subject covers the object and allows the action. A permission for
 * a whole connection covers each resource in it; one for a resource covers
 * only that resource. Returns the permission that allows it, and throws
 * `permission.denied` or `permission.person_inactive` otherwise.
 */
export const authorize = async (
  env: Env,
  authority: Authority,
  object: PermissionObject,
  action: string
): Promise<PermissionId> => {
  await requireActivePerson(env, authority);
  const { objectType, objectId, resource } = objectColumns(object);
  const rows = await drizzle(env.DB)
    .select({ id: permissions.id, actions: permissions.actions })
    .from(permissions)
    .where(
      and(
        ofSubject(authority.subject),
        eq(permissions.status, "active"),
        eq(permissions.objectType, objectType),
        eq(permissions.objectId, objectId),
        resource === null
          ? isNull(permissions.resource)
          : or(isNull(permissions.resource), eq(permissions.resource, resource))
      )
    );
  const allowing = rows.find((row) =>
    actionsSchema.parse(JSON.parse(row.actions)).includes(action)
  );
  if (!allowing) {
    throw permissionErrors.create("permission.denied", { action });
  }
  return permissionIdSchema.parse(allowing.id);
};
