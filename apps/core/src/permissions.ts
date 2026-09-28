import { appErrors } from "@grasp-os/shared/apps";
import type { AppRole } from "@grasp-os/shared/apps";
import type {
  AuditActor,
  AuditDetailValue,
  AuditEntry,
} from "@grasp-os/shared/audit";
import { actorOf, createAuditEvent } from "@grasp-os/shared/audit";
import { permissionIdSchema } from "@grasp-os/shared/ids";
import type { AppId, PermissionId } from "@grasp-os/shared/ids";
import { playbookCollectionId } from "@grasp-os/shared/knowledge";
import { errorFields, log } from "@grasp-os/shared/log";
import {
  grantReviewSchema,
  permissionErrors,
  permissionObjectSchema,
  permissionRequestSchema,
  permissionSubjectSchema,
} from "@grasp-os/shared/permissions";
import type {
  Authority,
  DeclaredPermission,
  Permission,
  PermissionObject,
  PermissionSubject,
} from "@grasp-os/shared/permissions";
import {
  isAdmin,
  requireAdmin,
  requireBuilder,
  roleErrors,
} from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { and, asc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import {
  auditedBatch,
  outboxed,
  outboxedEventWhere,
  outboxedIfChanged,
  storedEvent,
} from "./audit-outbox.ts";
import { activeMember } from "./auth/auth.ts";
import { memberRole } from "./auth/identity.ts";
import { builtinOwner } from "./builtin-app-id.ts";
import { connectionOwnersOf } from "./connections.ts";
import {
  apps,
  appVersions,
  auditOutbox,
  permissions,
} from "./db/core/schema.ts";
import { isUniqueViolation } from "./db/d1.ts";
import { collections } from "./db/knowledge/schema.ts";
import { appHost } from "./durable-objects.ts";
import { featureEnabled } from "./features.ts";

// Permission records and the one check every server path runs. A person
// asks for a permission (it allows nothing yet), an admin grants it, their
// own request included, and an admin can revoke it at any time. Grasp
// staff do neither: a client's permissions are the client's to decide.
// Checks read the records on every call, so a revoke applies to the next
// call. Every change is audited with who made it and the permission's
// subject, object, actions and binding.
//
// Granting is one conditional update, from requested to active, in the
// same batch as its audit event.

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
const objectOf = (row: Row): PermissionObject => {
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

type PermissionAction = `permission.${"requested" | "granted" | "revoked"}`;

/**
 * The audit entry of a change to `permission` by `actor`, with `extra`
 * detail such as who asked for it.
 */
const permissionEntry = (
  actor: AuditActor,
  action: PermissionAction,
  permission: Permission,
  extra: Record<string, AuditDetailValue> = {}
): AuditEntry => ({
  actor,
  action,
  target: { type: "permission", id: permission.id },
  detail: { ...auditDetail(permission), ...extra },
});

/** The audit entry of a change to `permission` by the person `by`. */
const changeEntry = (
  by: Identity,
  action: PermissionAction,
  permission: Permission,
  extra: Record<string, AuditDetailValue> = {}
): AuditEntry => permissionEntry(actorOf(by), action, permission, extra);

/**
 * Refuses anyone but one of the organization's own admins: who may grant
 * and revoke. Grasp staff are admins, but never decide a client's
 * permissions.
 */
const requireMemberAdmin = (by: Identity): void => {
  requireAdmin(by);
  if (by.staff) {
    throw roleErrors.create("role.forbidden");
  }
};

/**
 * That `by` is still an active admin of the organization, as SQL: part of
 * the very update that grants or revokes, so an admin demoted or removed
 * after their session was checked changes nothing.
 */
const stillAdmin = (by: Identity): SQL => activeMember(by.userId, ["admin"]);

/**
 * After a grant or revoke changed nothing: refuses with `role.forbidden`
 * if that was because `by` is no longer an active admin.
 */
const requireStillAdmin = async (env: Env, by: Identity): Promise<void> => {
  const row = await drizzle(env.DB).get<{ admin: number }>(
    sql`SELECT ${stillAdmin(by)} AS admin`
  );
  if (row.admin === 0) {
    throw roleErrors.create("role.forbidden");
  }
};

const parseId = (id: unknown): PermissionId => {
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
const restartApp = async (
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

const findRow = async (env: Env, id: string): Promise<Row | undefined> =>
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
 * A collection a permission names must exist (but for the Playbook, see
 * below), and not be someone's personal collection: Apps and agents never read those (see
 * knowledge/access.ts), so nobody can be asked to grant one.
 *
 * Nor is an App given the Apps collection (knowledge/apps-collection.ts).
 * It is open to everyone as a collection, but Knowledge shows each entry
 * only to whoever may open its App, and provenance (app-provenance.ts)
 * judges a collection by the collection's access alone. So an App that
 * read it could hold another App's AGENTS.md, and be shared with someone
 * who may not open that App, and both provenance checks would pass. An
 * agent acts for its person, who may read what they find there, and keeps
 * nothing to share: it may be given it.
 */
const requireCollection = async (
  env: Env,
  subject: PermissionSubject,
  object: PermissionObject
): Promise<void> => {
  if (object.type !== "collection") {
    return;
  }
  const found = await drizzle(env.KNOWLEDGE)
    .select({ access: collections.access, source: collections.source })
    .from(collections)
    .where(eq(collections.id, object.collectionId))
    .get();
  // The Playbook is set up by the first admin who saves a record into it
  // (knowledge/playbook.ts), so while its flag is on it can be asked for
  // and granted before then: an App's first save is what sets it up. It
  // is open to everyone and not an App's collection, as the checks below
  // require.
  const playbookNotYet =
    !found &&
    object.collectionId === playbookCollectionId &&
    featureEnabled(env, "playbook");
  if (playbookNotYet) {
    return;
  }
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
  if (found.source === "apps" && subject.type === "app") {
    throw permissionErrors.create("permission.invalid", {
      issues: [
        "object.collectionId: The Apps collection can't be given to an App.",
      ],
    });
  }
};

/**
 * Asks for a permission for an App or agent. It allows nothing until an
 * admin grants it. For an App, only its builders ask, and a workflow of
 * another App only someone with a role in that App: `requireAppRole`
 * refuses anyone else, before anything says whether the App exists
 * (`appFor` in apps.ts, passed in because apps.ts depends on this module,
 * through workflow code and its bindings).
 */
export const requestPermission = async (
  env: Env,
  by: Identity,
  input: unknown,
  requireAppRole: (app: AppId, role: AppRole) => Promise<unknown>
): Promise<Permission> => {
  requireBuilder(by);
  if (by.staff) {
    // Grasp staff neither ask for nor decide a client's permissions.
    throw roleErrors.create("role.forbidden");
  }
  const { subject, object, actions, binding } = permissionErrors.parse(
    "permission.invalid",
    permissionRequestSchema,
    input
  );
  if (subject.type === "app") {
    await requireAppRole(subject.appId, "builder");
  }
  const ownWorkflow =
    subject.type === "app" &&
    object.type === "workflow" &&
    object.appId === subject.appId;
  if (object.type === "workflow" && !ownWorkflow) {
    await requireAppRole(object.appId, "user");
  }
  await requireApps(env, subject, object);
  await requireCollection(env, subject, object);
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
  const db = drizzle(env.DB);
  try {
    await auditedBatch(env, db, [
      db.insert(permissions).values(row),
      outboxed(db, changeEntry(by, "permission.requested", permission)),
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
 * What makes two permissions the same grant: all but who and when, with
 * the actions in any order.
 */
const grantKey = (
  row: Pick<
    Row,
    "objectType" | "objectId" | "resource" | "mask" | "actions" | "binding"
  >
): string =>
  JSON.stringify([
    row.objectType,
    row.objectId,
    row.resource,
    row.mask,
    stringListSchema.parse(JSON.parse(row.actions)).toSorted(),
    row.binding,
  ]);

/**
 * The statements that make the requests of the built-in App `app` what
 * its release declares (`declared`, from its `blueprint.json`), for the
 * install's batch (app-blueprints.ts), with their audit entries by the
 * system: a request, by `owner`, for each declared permission it doesn't
 * have live (requested or active) yet, and a revoke of each it has live
 * that the release no longer declares. A declared permission with only a
 * revoked row (revoked before admins were refused that, or in the
 * database) gets a new request, and the revoked row stays as history. The
 * release's fingerprint covers the declarations (builtins.ts), so the
 * first install of a release restores them. The revokes come first, so a declaration
 * changed under the same binding name takes its place. A built-in never
 * runs, so its requests only say what an App created from it asks for
 * (`blueprintRequests`), each waiting for an admin there. Two installs
 * at once both insert the same binding, and the second batch is refused
 * by its unique index, writing nothing.
 */
export const declaredRequests = async (
  env: Env,
  owner: string,
  app: AppId,
  declared: readonly DeclaredPermission[]
): Promise<BatchItem<"sqlite">[]> => {
  const subject: PermissionSubject = { type: "app", appId: app };
  const db = drizzle(env.DB);
  const live = await db
    .select()
    .from(permissions)
    .where(
      and(
        ofSubject(subject),
        inArray(permissions.status, ["requested", "active"])
      )
    );
  const requestedAt = new Date();
  const wanted = declared.map(({ object, actions, binding }): Row => ({
    id: crypto.randomUUID(),
    ...subjectColumns(subject),
    ...objectColumns(object),
    actions: JSON.stringify(actions),
    binding,
    status: "requested",
    requestedBy: owner,
    requestedAt,
    grantedBy: null,
    grantedAt: null,
    revokedBy: null,
    revokedAt: null,
  }));
  const liveKeys = new Set(live.map(grantKey));
  const wantedKeys = new Set(wanted.map(grantKey));
  const system = { type: "system" } as const;
  const revokes = live.flatMap((row) =>
    wantedKeys.has(grantKey(row))
      ? []
      : [
          db
            .update(permissions)
            .set({
              status: "revoked",
              revokedBy: owner,
              revokedAt: requestedAt,
            })
            .where(
              and(
                eq(permissions.id, row.id),
                inArray(permissions.status, ["requested", "active"])
              )
            ),
          outboxedIfChanged(
            db,
            permissionEntry(system, "permission.revoked", toPermission(row))
          ),
        ]
  );
  const requests = wanted.flatMap((row) =>
    liveKeys.has(grantKey(row))
      ? []
      : [
          db.insert(permissions).values(row),
          outboxed(
            db,
            permissionEntry(system, "permission.requested", toPermission(row))
          ),
        ]
  );
  return [...revokes, ...requests];
};

/** A connection a blueprint's App was given that a copy doesn't ask for. */
export interface DroppedConnection {
  connectionId: string;
  binding: string;
}

/**
 * Requests for `app` of what `from` was given or asked for (its
 * permissions that aren't revoked), made by `by` as `app` is created from
 * a blueprint of `from` (app-blueprints.ts): the rows and their audit
 * entries, for the batch that creates `app`. Like any request, each allows
 * nothing until an admin grants it. A workflow of `from` itself becomes
 * the same workflow of `app`. Someone else's personal connection is left
 * out (`dropped`), as only its owner's calls could use it and a copy is
 * `by`'s own App, and so is one connect doesn't know.
 */
export const blueprintRequests = async (
  env: Env,
  by: Identity,
  from: AppId,
  app: AppId
): Promise<{
  rows: Row[];
  entries: AuditEntry[];
  dropped: DroppedConnection[];
}> => {
  const found = await drizzle(env.DB)
    .select()
    .from(permissions)
    .where(
      and(
        ofSubject({ type: "app", appId: from }),
        inArray(permissions.status, ["requested", "active"])
      )
    )
    .orderBy(asc(permissions.requestedAt), asc(permissions.id));
  const connectionIds = [
    ...new Set(
      found.flatMap(({ objectType, objectId }) =>
        objectType === "connection" ? [objectId] : []
      )
    ),
  ];
  const owners =
    connectionIds.length === 0
      ? []
      : await connectionOwnersOf(env, connectionIds);
  // Kept: shared connections and `by`'s own. Connect knows the rest as
  // someone else's, or not at all.
  const kept = new Set(
    owners.flatMap(({ id, ownerUserId }) =>
      ownerUserId === null || ownerUserId === by.userId ? [id] : []
    )
  );
  const isOthers = (row: Row): boolean =>
    row.objectType === "connection" && !kept.has(row.objectId);
  const requestedAt = new Date();
  const rows = found
    .filter((row) => !isOthers(row))
    .map((row): Row => ({
      ...row,
      id: crypto.randomUUID(),
      ...subjectColumns({ type: "app", appId: app }),
      objectId:
        row.objectType === "workflow" && row.objectId === from
          ? app
          : row.objectId,
      status: "requested",
      requestedBy: by.userId,
      requestedAt,
      grantedBy: null,
      grantedAt: null,
      revokedBy: null,
      revokedAt: null,
    }));
  return {
    rows,
    entries: rows.map((row) =>
      changeEntry(by, "permission.requested", toPermission(row), {
        blueprint: from,
      })
    ),
    dropped: found
      .filter(isOthers)
      .map(({ objectId, binding }) => ({ connectionId: objectId, binding })),
  };
};

/**
 * Refuses a grant or revoke of a built-in blueprint's own permission (its
 * App is owned by `builtinOwner`). A built-in never runs: its requests are
 * what its copies ask for, which only the release changes
 * (`declaredRequests`). Granting one would do nothing, and revoking one
 * would stop copies asking for it until a release declared it again. An
 * App's owner never changes, so reading it first is enough.
 */
const requireNotBuiltin = async (env: Env, row: Row): Promise<void> => {
  if (row.subjectType !== "app") {
    return;
  }
  const app = await drizzle(env.DB)
    .select({ ownerId: apps.ownerId })
    .from(apps)
    .where(eq(apps.id, row.subjectId))
    .get();
  if (app?.ownerId === builtinOwner) {
    throw permissionErrors.create("permission.builtin");
  }
};

/**
 * Grants a requested permission, the admin's own request included. Only
 * from requested: an active or revoked one is refused, so a revoke is for
 * good. Audited with who asked for it.
 *
 * `reviewed` names the version of the App the admin reviewed: the one
 * current as they decided (null for an agent's permission, or an App with
 * none current). The grant lands only while it still is, and approves it
 * (`madeCurrent`); otherwise it is refused with `app.conflict` and changes
 * nothing, so a builder can't swap the code while the admin looks.
 */
export const grantPermission = async (
  env: Env,
  by: Identity,
  id: unknown,
  reviewed: unknown
): Promise<Permission> => {
  requireMemberAdmin(by);
  const { version } = permissionErrors.parse(
    "permission.invalid",
    grantReviewSchema,
    reviewed
  );
  const found = await findRow(env, parseId(id));
  if (!found) {
    throw permissionErrors.create("permission.not_found");
  }
  await requireNotBuiltin(env, found);
  // No grant ever names a missing or personal collection, nor gives an App
  // the Apps collection, however old its request.
  await requireCollection(env, subjectOf(found), objectOf(found));
  const db = drizzle(env.DB);
  const event = createAuditEvent(
    changeEntry(by, "permission.granted", toPermission(found), {
      requestedBy: found.requestedBy,
    }),
    "core"
  );
  const isApp = found.subjectType === "app";
  // The version reviewed is still the one current (an agent has none).
  const stillReviewed = isApp
    ? sql`(SELECT ${apps.currentVersion} FROM ${apps} WHERE ${apps.id} = ${found.subjectId}) IS ${version}`
    : sql`${version} IS NULL`;
  const [[granted]] = await auditedBatch(env, db, [
    db
      .update(permissions)
      .set({ status: "active", grantedBy: by.userId, grantedAt: new Date() })
      .where(
        and(
          eq(permissions.id, found.id),
          eq(permissions.status, "requested"),
          stillAdmin(by),
          stillReviewed
        )
      )
      .returning(),
    outboxedEventWhere(db, event, sql`changes() > 0`),
    // An admin granting an App's permission approves the version they
    // reviewed (`madeCurrent`), as they would by making it current.
    db
      .update(appVersions)
      .set({ approved: 1 })
      .where(
        and(
          eq(appVersions.appId, found.subjectId),
          eq(appVersions.version, version ?? 0),
          eq(appVersions.approved, 0),
          isApp ? storedEvent(event.id) : sql`0`,
          stillReviewed
        )
      ),
  ]);
  if (!granted) {
    await requireStillAdmin(env, by);
    // Still requested: then the version reviewed is no longer current.
    const now = await findRow(env, found.id);
    if (now?.status === "requested") {
      throw appErrors.create("app.conflict");
    }
    throw permissionErrors.create("permission.not_requested");
  }
  const permission = toPermission(granted);
  await restartApp(env, permission.subject);
  return permission;
};

/** A stored JSON list of strings, joined by spaces, as SQL. */
const joined = (list: SQL | typeof permissions.actions): SQL =>
  sql`(SELECT group_concat(value, ' ') FROM json_each(${list}))`;

/**
 * The ID of the audit event one statement stores for the permission row,
 * as SQL: a random UUID (`fresh`, one per statement) whose last part is
 * the permission's own ID's, so each row's event has its own ID, and every
 * statement's are new. A UUID still: the version and variant are `fresh`'s,
 * and a permission's ID is a UUID too.
 */
const eventIdSql = (fresh: string): SQL =>
  sql`${fresh.slice(0, 24)} || lower(substr(${permissions.id}, 25, 12))`;

/**
 * What `auditDetail` records of a permission row, as SQL: its IDs by name
 * (connectionId, resource and mask; collectionId; appId and workflowId),
 * its actions and its binding.
 */
const auditDetailSql = sql`json_patch(
  json_object('subjectType', ${permissions.subjectType}, 'subjectId', ${permissions.subjectId}, 'objectType', ${permissions.objectType}),
  CASE ${permissions.objectType}
    WHEN 'connection' THEN json_patch(
      json_object('connectionId', ${permissions.objectId}),
      json_patch(
        CASE WHEN ${permissions.resource} IS NULL THEN '{}' ELSE json_object('resource', ${permissions.resource}) END,
        CASE WHEN ${permissions.mask} IS NULL THEN '{}' ELSE json_object('mask', ${joined(sql`${permissions.mask}`)}) END
      )
    )
    WHEN 'collection' THEN json_object('collectionId', ${permissions.objectId})
    ELSE json_object('appId', ${permissions.objectId}, 'workflowId', ${permissions.resource})
  END
)`;

/**
 * That `by` could grant a permission as the batch runs, as SQL: an admin
 * of the organization, not Grasp staff, still an admin then.
 */
const canGrantSql = (by: Identity): SQL =>
  isAdmin(by.role) && !by.staff ? stillAdmin(by) : sql`0`;

/**
 * That a permission lets an App change things for the person using it,
 * as SQL on its row: any on a connection (core can't tell a connector's
 * writes from its reads; connect knows), or with an action other than
 * `read`, such as writing a collection or starting a workflow.
 */
const changesThingsSql = or(
  eq(permissions.objectType, "connection"),
  sql`EXISTS (SELECT 1 FROM json_each(${permissions.actions}) WHERE value <> 'read')`
);

/** `changesThingsSql` for one action of a permission on `object`. */
const changesThings = (object: PermissionObject, action: string): boolean =>
  object.type === "connection" || action !== "read";

/**
 * That `version` of `app` is one no admin approved (`madeCurrent`), as
 * SQL. A version from before approvals (null) counts as approved.
 */
const unapprovedSql = (app: string, version: number): SQL =>
  sql`EXISTS (SELECT 1 FROM ${appVersions} WHERE ${appVersions.appId} = ${app} AND ${appVersions.version} = ${version} AND ${appVersions.approved} = 0)`;

/**
 * Refuses with `permission.denied` code of `version` of `app` that no admin
 * approved, while the App holds a permission that changes things, as
 * `authorize` does: for a run on it calling its App's server methods
 * (workflows/host.ts), which run the current version as the run's person
 * and can't be told apart by what they change. An App with no such
 * permission changes nothing for the person but its own data.
 */
export const requireApprovedVersion = async (
  env: Env,
  app: AppId,
  version: number
): Promise<void> => {
  const changing = and(
    ofSubject({ type: "app", appId: app }),
    eq(permissions.status, "active"),
    changesThingsSql
  );
  const row = await drizzle(env.DB).get<{ unapproved: number }>(
    sql`SELECT (${unapprovedSql(app, version)} AND EXISTS (SELECT 1 FROM ${permissions} WHERE ${changing})) AS unapproved`
  );
  if (row.unapproved !== 0) {
    throw permissionErrors.create("permission.denied", { action: "call" });
  }
};

/** A version of an App becoming current (`madeCurrent`). */
export interface MadeCurrent {
  app: AppId;
  version: number;
  /** The version it replaces. */
  previous: number | null;
  /** That the batch did make it current, as SQL (apps.ts). */
  changed: SQL;
  /**
   * Whether the App's permissions stay as they are, whoever makes it
   * current: only for an App's first version copied from a blueprint,
   * made current for the first time, which was approved as it was created.
   */
  keep: boolean;
}

/**
 * The statements, for the batch that makes a version the current version
 * of an App (apps.ts), for its approval and the App's permissions, each
 * only if the batch did make it current (`changed`). An admin grants a
 * permission trusting the code that will use it, and an App's code runs
 * as whoever uses it, so a builder's next version could otherwise write
 * the Playbook, say, as the next admin who opens it.
 *
 * The version is approved (`app_versions.approved`, which `authorize`
 * reads) if `by` could grant the permissions themselves (`canGrantSql`),
 * and unapproved otherwise. And unless `by` could, or the permissions are
 * kept (`keep`), each of the App's permissions active when the batch runs
 * that lets it change things for the person using it (`changesThingsSql`)
 * is asked for again: first an audit event for each
 * (`permission.requested`, by `by`, with the version, the one it replaced
 * and who had granted it), then the update, back to requested, asked for
 * by `by`, keeping who granted it and when. Both select their rows with the same condition when the batch
 * runs, nothing read before it, so a grant made just before is asked for
 * again too. Reading only is kept: the code reads what the person may.
 * Core's database has no full-text index, so nothing in the batch moves
 * `changes()` under them.
 */
export const madeCurrent = (
  env: Env,
  by: Identity,
  { app, version, previous, changed, keep }: MadeCurrent
): BatchItem<"sqlite">[] => {
  const db = drizzle(env.DB);
  const approval = db
    .update(appVersions)
    .set({
      approved: keep ? 1 : sql`CASE WHEN ${canGrantSql(by)} THEN 1 ELSE 0 END`,
    })
    .where(
      and(eq(appVersions.appId, app), eq(appVersions.version, version), changed)
    );
  if (keep) {
    return [approval];
  }
  const requestedAgain = and(
    ofSubject({ type: "app", appId: app }),
    eq(permissions.status, "active"),
    changesThingsSql,
    changed,
    sql`NOT ${canGrantSql(by)}`
  );
  const now = new Date();
  const eventId = eventIdSql(crypto.randomUUID());
  const event = sql`json_object(
    'id', ${eventId},
    'at', ${now.toISOString()},
    'source', 'core',
    'actor', json(${JSON.stringify(actorOf(by))}),
    'action', 'permission.requested',
    'target', json_object('type', 'permission', 'id', ${permissions.id}),
    'provenance', json('[]'),
    'detail', json_set(
      ${auditDetailSql},
      '$.actions', ${joined(permissions.actions)},
      '$.binding', ${permissions.binding},
      '$.version', ${version},
      '$.previous', ${previous},
      '$.grantedBy', ${permissions.grantedBy}
    )
  )`;
  return [
    approval,
    db
      .insert(auditOutbox)
      .select(
        sql`SELECT ${eventId}, ${event}, ${now.getTime()} FROM ${permissions} WHERE ${requestedAgain}`
      ),
    db
      .update(permissions)
      // Who granted it, and when, stay: a request with them is one asked
      // for again (`Permission.grantedBy`). Only the status allows.
      .set({ status: "requested", requestedBy: by.userId, requestedAt: now })
      .where(requestedAgain),
  ];
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
  requireMemberAdmin(by);
  const found = await findRow(env, parseId(id));
  if (!found) {
    throw permissionErrors.create("permission.not_found");
  }
  await requireNotBuiltin(env, found);
  const db = drizzle(env.DB);
  const [[revoked]] = await auditedBatch(env, db, [
    db
      .update(permissions)
      .set({ status: "revoked", revokedBy: by.userId, revokedAt: new Date() })
      .where(
        and(
          eq(permissions.id, found.id),
          inArray(permissions.status, ["requested", "active"]),
          stillAdmin(by)
        )
      )
      .returning(),
    outboxedIfChanged(
      db,
      changeEntry(by, "permission.revoked", toPermission(found))
    ),
  ]);
  if (!revoked) {
    await requireStillAdmin(env, by);
    // Already revoked: nothing changed, and nothing is recorded.
    return toPermission((await findRow(env, found.id)) ?? found);
  }
  const permission = toPermission(revoked);
  await restartApp(env, permission.subject);
  return permission;
};

/**
 * Every permission, or those of one App or agent, oldest first. With
 * `openApps` (a condition on `apps`: the Apps the person has a role in, as
 * `appsListedFor` in apps.ts says), one that names an App, as its subject
 * or as a workflow's, only if that App is one of them.
 */
export const listPermissions = async (
  env: Env,
  by: Identity,
  subject?: unknown,
  openApps?: SQL
): Promise<Permission[]> => {
  requireBuilder(by);
  const db = drizzle(env.DB);
  const open = db.select({ id: apps.id }).from(apps).where(openApps);
  // Both Apps a permission names, its subject and a workflow's, must be
  // open to the person: an agent's permission for a hidden App's workflow
  // would name that App otherwise.
  const ofOpenApp =
    openApps === undefined
      ? undefined
      : and(
          or(
            ne(permissions.subjectType, "app"),
            inArray(permissions.subjectId, open)
          ),
          or(
            ne(permissions.objectType, "workflow"),
            inArray(permissions.objectId, open)
          )
        );
  const ofOne =
    subject === undefined
      ? undefined
      : ofSubject(
          permissionErrors.parse(
            "permission.invalid",
            permissionSubjectSchema,
            subject
          )
        );
  const rows = await db
    .select()
    .from(permissions)
    .where(and(ofOne, ofOpenApp))
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
 * one for a resource covers only that resource. For an App's code, an
 * action that changes things (on a connection, or other than `read`) also
 * needs the version it runs to be one an admin approved (`madeCurrent`).
 * Throws `permission.denied`
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
  const { subject, appVersion } = authority;
  // An App's code changes things only from a version an admin approved
  // (`madeCurrent`): a run keeps the version it started on, which may be
  // one made current since without, its permissions granted again for
  // another.
  const unapproved =
    subject.type === "app" &&
    appVersion !== undefined &&
    changesThings(object, action)
      ? sql`NOT ${unapprovedSql(subject.appId, appVersion)}`
      : undefined;
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
          : or(
              isNull(permissions.resource),
              eq(permissions.resource, resource)
            ),
        unapproved
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
