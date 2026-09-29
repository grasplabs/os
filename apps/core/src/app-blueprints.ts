import {
  appErrors,
  appVersionSchema,
  fromBlueprintSchema,
} from "@grasp-os/shared/apps";
import type {
  App,
  AppBlueprintsApi,
  Blueprint,
  CreatedFromBlueprint,
  FromBlueprint,
} from "@grasp-os/shared/apps";
import type { AuditEntry } from "@grasp-os/shared/audit";
import { isExpectedError } from "@grasp-os/shared/errors";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import { errorFields, log } from "@grasp-os/shared/log";
import { requireBuilder, roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { RpcTarget } from "capnweb";
import { and, asc, desc, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import type { BuiltinBlueprint } from "#blueprints";

import { stillOpenTo } from "./app-access.ts";
import { exportsIn } from "./app-exports.ts";
import {
  appFor,
  appsListedFor,
  changeEntry,
  findVersion,
  storeTree,
  toApp,
  toVersion,
  versionFiles,
  versionTree,
  workflowsIn,
} from "./apps.ts";
import type { AppRow, VersionRow } from "./apps.ts";
import {
  auditedBatch,
  outboxed,
  outboxedIfChanged,
  outboxedWhere,
} from "./audit-outbox.ts";
import { builtinAppId, builtinOwner } from "./builtin-app-id.ts";
import {
  appBlueprints,
  apps,
  appVersions,
  permissions,
} from "./db/core/schema.ts";
import { inList } from "./db/d1.ts";
import { appMemoryPath } from "./knowledge/memory-files.ts";
import {
  blueprintRequests,
  declaredRequests,
  toPermission,
} from "./permissions.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";

// Blueprints. A builder of an App marks one of its versions as a
// blueprint; whoever has a role in the App (app-access.ts) and builds
// (an admin or builder in the organization) creates an App of their own
// from it. The new App is theirs. Its first version is the blueprint's
// code, but for its AGENTS.md, and it asks for what the blueprint's App
// was given or asked for, each request waiting for an admin
// (permissions.ts), but for someone else's personal connections, which
// only their owner's calls could use, and connections connect doesn't
// know: those are left out, and recorded. Nothing else comes with it:
// none of the App's data (its storage, its workflows' state, its runs),
// settings (parameter values), members or error log. A version never
// changes, so neither does a blueprint's code.
//
// The copy doesn't inherit what its source may have read
// (app-provenance.ts): it has no sources until an admin grants its
// requests, so whoever it is shared with meanwhile passes the check. So
// its AGENTS.md, which the source's agents write from what they read, is
// not copied but a stub naming the blueprint, for the copy's builders and
// agents to write their own. Every other file a builder stored in the
// code is copied as it is, taken to hold no data: builders must not put
// data into code.
//
// Marking, unmarking and creating are audited, each in the same batch as
// its change. Grasp staff neither mark, unmark nor create from blueprints:
// which Apps get copied is the client's decision, and creating asks for
// permissions, which staff never do for a client.

type Row = typeof appBlueprints.$inferSelect;

/** A copy's AGENTS.md in place of its blueprint's (see above). */
const copiedMemory = (name: string, version: number): string =>
  `Created from the blueprint of ${name}, version ${version}. Write what this App does here.\n`;

/**
 * Refuses Grasp staff: which of a client's Apps others copy, and copying
 * one (which asks for permissions), is the client's to decide.
 */
const requireNotStaff = (by: Identity): void => {
  if (by.staff) {
    throw roleErrors.create("role.forbidden");
  }
};

const toBlueprint = (row: Row, app: App): Blueprint => ({
  app: app.id,
  name: app.name,
  description: app.description,
  version: row.version,
  markedBy: row.markedBy,
  markedAt: row.markedAt.toISOString(),
});

/** The blueprint row of `app` at `version`, if it is marked. */
const blueprintRow = async (
  env: Env,
  app: AppId,
  version: number
): Promise<Row | undefined> =>
  await drizzle(env.DB)
    .select()
    .from(appBlueprints)
    .where(
      and(eq(appBlueprints.appId, app), eq(appBlueprints.version, version))
    )
    .get();

/** The blueprints of the Apps `by` has a role in, newest first. */
export const listBlueprints = async (
  env: Env,
  by: Identity
): Promise<Blueprint[]> => {
  const rows = await drizzle(env.DB)
    .select({ blueprint: appBlueprints, app: apps })
    .from(appBlueprints)
    .innerJoin(apps, eq(apps.id, appBlueprints.appId))
    .where(appsListedFor(env, by))
    .orderBy(
      desc(appBlueprints.markedAt),
      asc(appBlueprints.appId),
      desc(appBlueprints.version)
    );
  return rows.map(({ blueprint, app }) => toBlueprint(blueprint, toApp(app)));
};

/** Marks a version as a blueprint; marking it again changes nothing. */
export const markBlueprint = async (
  env: Env,
  by: Identity,
  app: unknown,
  version: unknown
): Promise<Blueprint> => {
  const found = await appFor(env, by, app, "builder");
  requireNotStaff(by);
  const { version: number } = await findVersion(env, found.id, version);
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [
    db
      .insert(appBlueprints)
      .values({
        appId: found.id,
        version: number,
        markedBy: by.userId,
        markedAt: new Date(),
      })
      .onConflictDoNothing(),
    outboxedIfChanged(
      db,
      changeEntry(by, "app.blueprint.marked", found.id, { version: number })
    ),
  ]);
  const row = await blueprintRow(env, found.id, number);
  // Unmarked since the batch above.
  if (!row) {
    throw appErrors.create("app.conflict");
  }
  return toBlueprint(row, found);
};

/**
 * Stops offering a version as a blueprint. Apps already created from it
 * stay as they are.
 */
export const unmarkBlueprint = async (
  env: Env,
  by: Identity,
  app: unknown,
  version: unknown
): Promise<void> => {
  const found = await appFor(env, by, app, "builder");
  requireNotStaff(by);
  const number = appErrors.parse("app.invalid", appVersionSchema, version);
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [
    db
      .delete(appBlueprints)
      .where(
        and(
          eq(appBlueprints.appId, found.id),
          eq(appBlueprints.version, number)
        )
      ),
    outboxedIfChanged(
      db,
      changeEntry(by, "app.blueprint.unmarked", found.id, { version: number })
    ),
  ]);
};

/** How long a copy may stay pending before the cron trigger deletes it. */
const pendingMaxMs = 60 * 60 * 1000;

/** Most leftover pending copies one cron run deletes. */
const sweepsPerRun = 20;

/**
 * Deletes pending copies, and only while they are pending, with the audit
 * entry of each: their permission requests, their version and their row.
 * A pending copy was never usable, so nothing else refers to it. Its tree
 * stays in R2, named by nothing, as a refused commit's does.
 */
const discardPending = async (
  env: Env,
  copies: readonly { id: AppId; entry: AuditEntry }[]
): Promise<void> => {
  if (copies.length === 0) {
    return;
  }
  const db = drizzle(env.DB);
  const ids = copies.map(({ id }) => id);
  const pending = and(inList(apps.id, ids), isNotNull(apps.pendingSince));
  const pendingIds = db.select({ id: apps.id }).from(apps).where(pending);
  const [first, ...rest] = copies.map(({ entry }) => outboxed(db, entry));
  if (first === undefined) {
    return;
  }
  await auditedBatch(env, db, [
    first,
    ...rest,
    db
      .delete(permissions)
      .where(
        and(
          eq(permissions.subjectType, "app"),
          inArray(permissions.subjectId, pendingIds)
        )
      ),
    db.delete(appVersions).where(inArray(appVersions.appId, pendingIds)),
    db.delete(apps).where(pending),
  ]);
};

/**
 * After a copy committed, pending: activates it only if `by` may still
 * open the source App (`appFor`, with what it read, which the batch's
 * guard can't express). Otherwise, whatever went wrong, even an error
 * with no code, it tries to delete the copy, audited as
 * `app.blueprint.revoked`, and refuses as the check did. If even that
 * fails, the copy stays pending: inert, and deleted by the cron trigger
 * (`sweepPendingCopies`). It fails closed.
 */
const activateCopy = async (
  env: Env,
  by: Identity,
  source: AppId,
  copy: AppId
): Promise<void> => {
  try {
    await appFor(env, by, source, "user");
  } catch (error) {
    const reason =
      appErrors.codeOf(error) ?? roleErrors.codeOf(error) ?? "check_failed";
    try {
      await discardPending(env, [
        {
          id: copy,
          entry: changeEntry(by, "app.blueprint.revoked", copy, {
            fromApp: source,
            reason,
          }),
        },
      ]);
    } catch (discardError) {
      log.error("app.copy_discard_failed", {
        appId: copy,
        ...errorFields(discardError),
      });
    }
    throw error;
  }
  await drizzle(env.DB)
    .update(apps)
    .set({ pendingSince: null })
    .where(and(eq(apps.id, copy), isNotNull(apps.pendingSince)));
};

/**
 * Deletes copies left pending longer than `pendingMaxMs` (their creation
 * stopped between its batch and its activation), the oldest first and at
 * most `sweepsPerRun` a run, audited. The cron trigger runs it every
 * minute.
 */
export const sweepPendingCopies = async (env: Env): Promise<void> => {
  const stale = await drizzle(env.DB)
    .select({ id: apps.id, blueprint: apps.blueprint })
    .from(apps)
    .where(lt(apps.pendingSince, new Date(Date.now() - pendingMaxMs)))
    .orderBy(asc(apps.pendingSince), asc(apps.id))
    .limit(sweepsPerRun);
  await discardPending(
    env,
    stale.map(({ id, blueprint }) => ({
      id: appIdSchema.parse(id),
      entry: {
        actor: { type: "system" },
        action: "app.blueprint.revoked",
        target: { type: "app", id },
        detail: { blueprint, reason: "pending_expired" },
      },
    }))
  );
};

/**
 * Whether version `number` of the blueprint's App `source` is one an admin
 * approved (`madeCurrent`): a built-in's release, one approved (1), or
 * one from before approvals (null) that is current in its App. A copy's
 * first version is approved only then, so a blueprint of code no admin
 * approved doesn't pass as approved in its copies.
 */
const approvedSource = async (
  env: Env,
  source: { id: AppId; owner: string; currentVersion: number | null },
  number: number
): Promise<boolean> => {
  if (source.owner === builtinOwner) {
    return true;
  }
  const { approved } = await findVersion(env, source.id, number);
  return (
    approved === 1 || (approved === null && source.currentVersion === number)
  );
};

/**
 * Of the Apps `named`, those `by` may open, as `appFor` decides for each
 * (a role in it, and able to read what it read): the Apps whose workflows
 * and exports they could ask for themselves.
 */
const openedBy = async (
  env: Env,
  by: Identity,
  named: readonly AppId[]
): Promise<Set<string>> => {
  const opened = await Promise.all(
    named.map(async (app) => {
      try {
        await appFor(env, by, app, "user");
        return [app];
      } catch (error) {
        if (isExpectedError(error)) {
          return [];
        }
        throw error;
      }
    })
  );
  return new Set(opened.flat());
};

/**
 * Creates an App of `by`'s own from the blueprint of App `app` at
 * `version`: the code at that version as its first version (its AGENTS.md
 * a stub), and requests for what that App was given or asked for. All of
 * it lands in one batch, or none of it (the version's files, stored
 * first, are only named once it lands), and only while the version is
 * still a blueprint and `by` still has a role in its App. It lands pending, found by nothing, and is
 * activated only once `by` passes the source App's check again, what it
 * read included (`activateCopy`).
 */
export const createFromBlueprint = async (
  env: Env,
  by: Identity,
  app: unknown,
  version: unknown,
  input: unknown
): Promise<CreatedFromBlueprint> => {
  requireBuilder(by);
  requireNotStaff(by);
  const source = await appFor(env, by, app, "user");
  const number = appErrors.parse("app.invalid", appVersionSchema, version);
  if (!(await blueprintRow(env, source.id, number))) {
    throw appErrors.create("app.blueprint_not_found");
  }
  const { name, description } = appErrors.parse(
    "app.invalid",
    fromBlueprintSchema,
    input
  );
  const files = new Map(
    Object.entries(await versionFiles(env, source.id, number))
  );
  // Replaced, not added: the copy has as many files as the blueprint.
  if (files.has(appMemoryPath)) {
    files.set(appMemoryPath, copiedMemory(source.name, number));
  }
  const id = appIdSchema.parse(crypto.randomUUID());
  const tree = await versionTree(files);
  await storeTree(env, id, tree);

  const now = new Date();
  const appRow: AppRow = {
    id,
    name,
    description,
    ownerId: by.userId,
    blueprint: `${source.id}@${number}`,
    currentVersion: null,
    pendingVersion: null,
    workingRevision: null,
    pendingSince: now,
    createdAt: now,
  };
  const versionRow: VersionRow = {
    appId: id,
    version: 1,
    parent: null,
    tree: tree.tree,
    files: files.size,
    authorId: by.userId,
    message: `Created from the blueprint of ${source.name}, version ${number}.`,
    createdAt: now,
    // The blueprint's code, which its requests came with: approved
    // (`madeCurrent`) only when that version was, unlike a version its
    // builder commits; otherwise approved as any version is.
    approved: (await approvedSource(env, source, number)) ? 1 : null,
    workflows: workflowsIn(files),
    exports: exportsIn(files),
    proposedBy: null,
  };
  const requests = await blueprintRequests(
    env,
    by,
    source.id,
    id,
    async (named) => await openedBy(env, by, named)
  );
  const db = drizzle(env.DB);
  /** Whether a request names another App: a workflow or exports of it. */
  const namesOtherApp = (row: typeof permissions.$inferSelect): boolean =>
    (row.objectType === "workflow" || row.objectType === "app") &&
    row.objectId !== id;
  // The App, pending, only while the blueprint is still marked and `by`
  // still has a role in its App (`stillOpenTo`), selected from its row:
  // unmarked or unshared since they were read above, nothing is inserted,
  // the version's row can't name an App that isn't there, and the whole
  // batch is refused.
  // The insert names its columns, and drizzle refuses fields that aren't
  // the table's, by name and in order.
  const appFromBlueprint = db
    .select({
      id: sql<string>`${appRow.id}`.as("id"),
      name: sql<string>`${appRow.name}`.as("name"),
      description: sql<string>`${appRow.description}`.as("description"),
      ownerId: sql<string>`${appRow.ownerId}`.as("owner_id"),
      blueprint: sql<string | null>`${appRow.blueprint}`.as("blueprint"),
      currentVersion: sql<number | null>`${appRow.currentVersion}`.as(
        "current_version"
      ),
      pendingVersion: sql<number | null>`${appRow.pendingVersion}`.as(
        "pending_version"
      ),
      workingRevision: sql<string | null>`${appRow.workingRevision}`.as(
        "working_revision"
      ),
      createdAt: sql<Date>`${appRow.createdAt.getTime()}`.as("created_at"),
      pendingSince: sql<Date | null>`${now.getTime()}`.as("pending_since"),
    })
    .from(appBlueprints)
    .where(
      and(
        eq(appBlueprints.appId, source.id),
        eq(appBlueprints.version, number),
        stillOpenTo(by, source.id)
      )
    );
  const statements = [
    db.insert(apps).select(appFromBlueprint),
    outboxed(
      db,
      changeEntry(by, "app.created", id, {
        blueprint: appRow.blueprint,
        fromApp: source.id,
        fromVersion: number,
      })
    ),
    db.insert(appVersions).values(versionRow),
    outboxed(
      db,
      changeEntry(by, "app.committed", id, {
        version: 1,
        parent: null,
        tree: tree.tree,
        files: files.size,
      })
    ),
    // One statement each: D1 binds at most 100 values to one.
    ...requests.rows.map((row) => db.insert(permissions).values(row)),
    // A request naming another App only while `by` still has a role in
    // it as the batch runs: one they lost since `openedBy` read it is
    // taken out again, in the same batch, so the copy never names it.
    ...requests.rows
      .filter(namesOtherApp)
      .map((row) =>
        db
          .delete(permissions)
          .where(
            and(
              eq(permissions.id, row.id),
              sql`NOT ${stillOpenTo(by, appIdSchema.parse(row.objectId))}`
            )
          )
      ),
    // Each request's audit entry (`entries` are the rows', in order) if
    // its row stayed; one taken out is recorded as dropped instead.
    ...requests.rows.flatMap((row, index) => {
      const entry = requests.entries[index];
      if (entry === undefined) {
        return [];
      }
      if (!namesOtherApp(row)) {
        return [outboxed(db, entry)];
      }
      const kept = sql`EXISTS (SELECT 1 FROM ${permissions} WHERE ${permissions.id} = ${row.id})`;
      return [
        outboxedWhere(db, entry, kept),
        outboxedWhere(
          db,
          changeEntry(by, "app.blueprint.app_dropped", id, {
            objectType: row.objectType,
            binding: row.binding,
            fromApp: source.id,
          }),
          sql`NOT ${kept}`
        ),
      ];
    }),
    ...requests.dropped.map(({ connectionId, binding }) =>
      outboxed(
        db,
        changeEntry(by, "app.blueprint.connection_dropped", id, {
          connectionId,
          binding,
          fromApp: source.id,
        })
      )
    ),
    ...requests.droppedApps.map(({ type, binding }) =>
      outboxed(
        db,
        changeEntry(by, "app.blueprint.app_dropped", id, {
          objectType: type,
          binding,
          fromApp: source.id,
        })
      )
    ),
  ] as const;
  try {
    await auditedBatch(env, db, statements);
  } catch (error) {
    if (!(await blueprintRow(env, source.id, number))) {
      throw appErrors.create("app.blueprint_not_found");
    }
    // Refused, as for any call, when they lost their role in the App.
    await appFor(env, by, source.id, "user");
    throw error;
  }
  // The requests that stayed: those naming another App `by` lost their
  // role in as the batch ran were taken out, and are dropped too.
  const stayedRows = await db
    .select({ id: permissions.id })
    .from(permissions)
    .where(
      and(eq(permissions.subjectType, "app"), eq(permissions.subjectId, id))
    );
  const stayed = new Set(stayedRows.map((row) => row.id));
  await activateCopy(env, by, source.id, id);
  return {
    app: toApp(appRow),
    version: toVersion(versionRow),
    permissions: requests.rows
      .filter((row) => stayed.has(row.id))
      .map(toPermission),
    dropped: requests.dropped,
    droppedApps: [
      ...requests.droppedApps,
      ...requests.rows
        .filter((row) => !stayed.has(row.id))
        .map(({ objectType, binding }) => ({
          type: objectType === "app" ? ("app" as const) : ("workflow" as const),
          binding,
        })),
    ],
  };
};

/** An audit entry of the release's install: Grasp, with no person. */
const installEntry = (
  action: string,
  app: AppId,
  detail: AuditEntry["detail"]
): AuditEntry => ({
  actor: { type: "system" },
  action,
  target: { type: "app", id: app },
  detail,
});

/**
 * Makes the release's built-in blueprint the blueprint of an ordinary App,
 * owned by Grasp (`builtinOwner`) under a stable ID (`builtinAppId`), so
 * it is found, listed and created from as any blueprint is, by everyone
 * who builds, and changed by nobody but the install (app-access.ts): the App, if it
 * doesn't exist; its files as the App's next version, if its latest
 * version's differ; that version marked, and any other unmarked; its
 * name and description, if they changed; and its requests, as the release
 * declares them (`declaredRequests`). Each is audited, in the one batch
 * that writes it all, and only what differs from what's stored is
 * written, so installing it again writes nothing. The App never runs (it
 * has no current version, and nobody may make one current), so its
 * requests allow nothing: they are what an App created from it asks for,
 * each waiting for an admin there. Apps created from it earlier keep
 * their code and their permissions.
 *
 * Two installs at once both try the same version number, and the second
 * is refused by the version's primary key, writing nothing: the next
 * install compares again.
 */
export const installBuiltinBlueprint = async (
  env: Env,
  blueprint: BuiltinBlueprint
): Promise<void> => {
  const id = builtinAppId(blueprint.id);
  const { name, description } = appErrors.parse(
    "app.invalid",
    fromBlueprintSchema,
    { name: blueprint.name, description: blueprint.description }
  );
  const files = new Map(Object.entries(blueprint.files));
  const tree = await versionTree(files);
  const db = drizzle(env.DB);
  const [[app], [latest], marked] = await db.batch([
    db.select().from(apps).where(eq(apps.id, id)),
    db
      .select()
      .from(appVersions)
      .where(eq(appVersions.appId, id))
      .orderBy(desc(appVersions.version))
      .limit(1),
    db
      .select({ version: appBlueprints.version })
      .from(appBlueprints)
      .where(eq(appBlueprints.appId, id)),
  ]);
  const now = new Date();
  const parent = latest?.version ?? null;
  const changed = latest?.tree !== tree.tree;
  const version = changed ? (parent ?? 0) + 1 : (parent ?? 0);
  if (changed) {
    await storeTree(env, id, tree);
  }
  const created = app
    ? []
    : [
        db
          .insert(apps)
          .values({
            id,
            name,
            description,
            ownerId: builtinOwner,
            blueprint: null,
            currentVersion: null,
            pendingVersion: null,
            workingRevision: null,
            pendingSince: null,
            createdAt: now,
          })
          .onConflictDoNothing(),
        outboxedIfChanged(
          db,
          installEntry("app.created", id, { builtin: blueprint.id })
        ),
      ];
  const described =
    app && (app.name !== name || app.description !== description)
      ? [
          db
            .update(apps)
            .set({ name, description })
            .where(
              and(
                eq(apps.id, id),
                sql`(${apps.name} IS NOT ${name} OR ${apps.description} IS NOT ${description})`
              )
            ),
          outboxedIfChanged(
            db,
            installEntry("app.described", id, { name, description })
          ),
        ]
      : [];
  const committed = changed
    ? [
        db.insert(appVersions).values({
          appId: id,
          version,
          parent,
          tree: tree.tree,
          files: files.size,
          authorId: builtinOwner,
          message: "From the release",
          createdAt: now,
          approved: 1,
          workflows: workflowsIn(files),
          exports: exportsIn(files),
          proposedBy: null,
        }),
        outboxed(
          db,
          installEntry("app.committed", id, {
            version,
            parent,
            tree: tree.tree,
            files: files.size,
          })
        ),
      ]
    : [];
  const markedNow = marked.some((row) => row.version === version)
    ? []
    : [
        db
          .insert(appBlueprints)
          .values({
            appId: id,
            version,
            markedBy: builtinOwner,
            markedAt: now,
          })
          .onConflictDoNothing(),
        outboxedIfChanged(
          db,
          installEntry("app.blueprint.marked", id, { version })
        ),
      ];
  // Only the release's version is offered: one built-in, one blueprint.
  const unmarked = marked.flatMap((row) =>
    row.version === version
      ? []
      : [
          db
            .delete(appBlueprints)
            .where(
              and(
                eq(appBlueprints.appId, id),
                eq(appBlueprints.version, row.version)
              )
            ),
          outboxedIfChanged(
            db,
            installEntry("app.blueprint.unmarked", id, {
              version: row.version,
            })
          ),
        ]
  );
  const requested = await declaredRequests(
    env,
    builtinOwner,
    id,
    blueprint.permissions
  );
  const [first, ...rest] = [
    ...created,
    ...described,
    ...committed,
    ...markedNow,
    ...unmarked,
    ...requested,
  ];
  if (first !== undefined) {
    await auditedBatch(env, db, [first, ...rest]);
  }
};

/** A signed-in person's `apps.blueprints`. */
export class AppBlueprintsRpc extends RpcTarget implements AppBlueprintsApi {
  readonly #env: Env;
  readonly #check: SessionCheck;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
  }

  async list(): Promise<Blueprint[]> {
    return await withPerson(
      this.#check,
      async (by) => await listBlueprints(this.#env, by)
    );
  }

  async mark(app: string, version: number): Promise<Blueprint> {
    return await withPerson(
      this.#check,
      async (by) => await markBlueprint(this.#env, by, app, version)
    );
  }

  async unmark(app: string, version: number): Promise<void> {
    await withPerson(this.#check, async (by) => {
      await unmarkBlueprint(this.#env, by, app, version);
    });
  }

  async create(
    app: string,
    version: number,
    input: FromBlueprint
  ): Promise<CreatedFromBlueprint> {
    return await withPerson(
      this.#check,
      async (by) =>
        await createFromBlueprint(this.#env, by, app, version, input)
    );
  }
}
