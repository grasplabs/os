import { appErrors, fromBlueprintSchema } from "@grasp-os/shared/apps";
import type {
  AppBlueprintsApi,
  Blueprint,
  CreatedFromBlueprint,
  FromBlueprint,
} from "@grasp-os/shared/apps";
import type { AuditEntry } from "@grasp-os/shared/audit";
import { appIdSchema, blueprintIdSchema } from "@grasp-os/shared/ids";
import type { BlueprintId } from "@grasp-os/shared/ids";
import { canBuild, requireBuilder, roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { RpcTarget } from "capnweb";
import { and, asc, desc, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import type { BuiltinBlueprint } from "#blueprints";

import { appsFoundBy, stillOpenTo } from "./app-access.ts";
import { exportsIn } from "./app-exports.ts";
import { recordTypesIn } from "./app-records.ts";
import {
  appFor,
  blueprintFiles,
  changeEntry,
  findVersion,
  storeBlueprintTree,
  storeTree,
  toApp,
  toVersion,
  versionFiles,
  versionTree,
  workflowsIn,
} from "./apps.ts";
import type { AppRow, VersionRow } from "./apps.ts";
import { auditedBatch, outboxed, outboxedIfChanged } from "./audit-outbox.ts";
import type { Acting } from "./auth/identity.ts";
import {
  apps,
  appVersions,
  blueprints,
  permissions,
} from "./db/core/schema.ts";
import { ensureCollection } from "./knowledge/collections.ts";
import { appMemoryPath } from "./knowledge/memory-files.ts";
import { declarableOf, declaredRequests, toPermission } from "./permissions.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";

// Blueprints: code to create Apps from, each its own record. A builder of
// an App marks one of its versions as a blueprint, which whoever has a
// role in the App (app-access.ts) and builds (an admin or builder in the
// organization) creates an App of their own from. The release ships
// others, the built-ins (apps/core/blueprints/, builtins.ts), which
// everyone who builds creates from, and which only the install changes.
// Either way the new App is theirs, and nothing downstream knows where
// its blueprint came from. Its first version is the blueprint's code, but
// for its AGENTS.md, and it asks for what the blueprint declares, each
// request waiting for an admin: a built-in's `blueprint.json`, or what the
// App asked for or was given as the version was marked, of the kinds
// that name the same thing for whoever creates from it (`declarableOf` in
// permissions.ts). Its builders ask for the rest themselves. Nothing else
// comes with it: none of the App's data (its storage, its workflows'
// state, its runs), settings (parameter values), members or error log.
// A marked blueprint keeps its own copy of the version's files, which
// never change.
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
// Marking, unmarking, installing and creating are audited, each in the
// same batch as its change. Grasp staff neither mark, unmark nor create
// from blueprints: which Apps get copied is the client's decision, and
// creating asks for permissions, which staff never do for a client.

type Row = typeof blueprints.$inferSelect;

/**
 * The owner of the collections the built-ins declare: nobody's, open to
 * everyone, changed by admins only (`canWrite` in knowledge).
 */
const releaseOwner = "grasp";

/** A copy's AGENTS.md in place of its blueprint's (see above). */
const copiedMemory = (name: string): string =>
  `Created from the blueprint ${name}. Write what this App does here.\n`;

/**
 * Refuses Grasp staff: which of a client's Apps others copy, and copying
 * one (which asks for permissions), is the client's to decide.
 */
const requireNotStaff = (by: Pick<Acting, "staff">): void => {
  if (by.staff) {
    throw roleErrors.create("role.forbidden");
  }
};

const toBlueprint = (row: Row): Blueprint => ({
  id: blueprintIdSchema.parse(row.id),
  name: row.name,
  description: row.description,
  app: row.appId === null ? null : appIdSchema.parse(row.appId),
  version: row.version,
  markedBy: row.markedBy,
  markedAt: row.markedAt.toISOString(),
  permissions: row.permissions,
});

/** The blueprint `id`, if there is one. */
const blueprintRow = async (
  env: Env,
  id: BlueprintId
): Promise<Row | undefined> =>
  await drizzle(env.DB)
    .select()
    .from(blueprints)
    .where(eq(blueprints.id, id))
    .get();

/**
 * The blueprints `by` may see, newest first: those of the Apps they have
 * a role in, and, if they build, the built-ins.
 */
export const listBlueprints = async (
  env: Env,
  by: Acting
): Promise<Blueprint[]> => {
  const rows = await drizzle(env.DB)
    .select({ blueprint: blueprints })
    .from(blueprints)
    .leftJoin(apps, eq(apps.id, blueprints.appId))
    .where(
      or(
        canBuild(by.role) ? isNull(blueprints.appId) : undefined,
        and(isNotNull(blueprints.appId), appsFoundBy(env, by))
      )
    )
    .orderBy(desc(blueprints.markedAt), asc(blueprints.id));
  return rows.map(({ blueprint }) => toBlueprint(blueprint));
};

/**
 * Whether `version` of the App `app` is one an admin approved
 * (`madeCurrent`): approved (1), or from before approvals (null) and
 * current in its App. A copy's first version is approved only then, so a
 * blueprint of code no admin approved doesn't pass as approved in its
 * copies.
 */
const approvedVersion = (
  app: { currentVersion: number | null },
  { version, approved }: Pick<VersionRow, "version" | "approved">
): boolean =>
  approved === 1 || (approved === null && app.currentVersion === version);

/**
 * Marks a version as a blueprint: a copy of its files, its App's name and
 * description, and what its App asks for or was given that each App
 * created from it asks for too (`declarableOf`). Marking it again changes
 * nothing.
 */
export const markBlueprint = async (
  env: Env,
  by: Identity,
  app: unknown,
  version: unknown
): Promise<Blueprint> => {
  const found = await appFor(env, by, app, "builder");
  requireNotStaff(by);
  const row = await findVersion(env, found.id, version);
  const db = drizzle(env.DB);
  const marked = async () =>
    await db
      .select()
      .from(blueprints)
      .where(
        and(eq(blueprints.appId, found.id), eq(blueprints.version, row.version))
      )
      .get();
  const already = await marked();
  if (already) {
    return toBlueprint(already);
  }
  const id = blueprintIdSchema.parse(crypto.randomUUID());
  const tree = await versionTree(
    new Map(Object.entries(await versionFiles(env, found.id, row.version)))
  );
  await storeBlueprintTree(env, id, tree);
  await auditedBatch(env, db, [
    db
      .insert(blueprints)
      .values({
        id,
        name: found.name,
        description: found.description,
        tree: tree.tree,
        appId: found.id,
        version: row.version,
        approved: approvedVersion(found, row),
        permissions: await declarableOf(env, found.id),
        markedBy: by.userId,
        markedAt: new Date(),
      })
      .onConflictDoNothing(),
    outboxedIfChanged(
      db,
      changeEntry(by, "app.blueprint.marked", found.id, {
        version: row.version,
        blueprint: id,
      })
    ),
  ]);
  const stored = await marked();
  // Unmarked since the batch above.
  if (!stored) {
    throw appErrors.create("app.conflict");
  }
  return toBlueprint(stored);
};

/**
 * Stops offering a blueprint; unmarking one that isn't there changes
 * nothing. Apps already created from it stay as they are. A built-in has
 * no App to be a builder of: only the release changes it.
 */
export const unmarkBlueprint = async (
  env: Env,
  by: Identity,
  id: unknown
): Promise<void> => {
  const parsed = blueprintIdSchema.safeParse(id);
  const row = parsed.success ? await blueprintRow(env, parsed.data) : undefined;
  if (!row) {
    return;
  }
  if (row.appId === null) {
    throw roleErrors.create("role.forbidden");
  }
  const found = await appFor(env, by, row.appId, "builder");
  requireNotStaff(by);
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [
    db.delete(blueprints).where(eq(blueprints.id, row.id)),
    outboxedIfChanged(
      db,
      changeEntry(by, "app.blueprint.unmarked", found.id, {
        version: row.version,
        blueprint: row.id,
      })
    ),
  ]);
};

/**
 * Creates an App of `by`'s own from the blueprint `id`: its code as the
 * App's first version (its AGENTS.md a stub), and requests for what it
 * declares. All of it lands in one batch, or none of it (the files,
 * stored first, are only named once it lands), and only while the
 * blueprint is still there and, for a marked one, `by` still has a role
 * in its App.
 *
 * `by` passes that App's check once, before anything is read, what it
 * read included (`appFor`). The batch's guard repeats the role, not what
 * it read, which SQL can't express; nor does it need to: the copy holds
 * only code (its AGENTS.md a stub, above) and requests that wait for an
 * admin, declared as the version was marked, so an App that reads more
 * after the check adds nothing to the copy.
 */
export const createFromBlueprint = async (
  env: Env,
  by: Acting,
  id: unknown,
  input: unknown
): Promise<CreatedFromBlueprint> => {
  requireBuilder(by);
  requireNotStaff(by);
  const parsed = blueprintIdSchema.safeParse(id);
  const blueprint = parsed.success
    ? await blueprintRow(env, parsed.data)
    : undefined;
  if (!blueprint) {
    throw appErrors.create("app.blueprint_not_found");
  }
  const source =
    blueprint.appId === null
      ? undefined
      : await appFor(env, by, blueprint.appId, "user");
  const { name, description } = appErrors.parse(
    "app.invalid",
    fromBlueprintSchema,
    input
  );
  const files = await blueprintFiles(
    env,
    blueprintIdSchema.parse(blueprint.id),
    blueprint.tree
  );
  // Replaced, not added: the copy has as many files as the blueprint.
  if (files.has(appMemoryPath)) {
    files.set(appMemoryPath, copiedMemory(blueprint.name));
  }
  const app = appIdSchema.parse(crypto.randomUUID());
  const tree = await versionTree(files);
  await storeTree(env, app, tree);

  const now = new Date();
  const appRow: AppRow = {
    id: app,
    name,
    description,
    ownerId: by.userId,
    blueprint: blueprint.id,
    currentVersion: null,
    pendingVersion: null,
    createdAt: now,
  };
  const versionRow: VersionRow = {
    appId: app,
    version: 1,
    parent: null,
    tree: tree.tree,
    files: files.size,
    authorId: by.userId,
    message: `Created from the blueprint ${blueprint.name}.`,
    createdAt: now,
    // The blueprint's code, which its requests came with: approved
    // (`madeCurrent`) only when an admin approved it, unlike a version its
    // builder commits; otherwise approved as any version is.
    approved: blueprint.approved ? 1 : null,
    workflows: workflowsIn(files),
    exports: exportsIn(files),
    proposedBy: null,
    records: recordTypesIn(files),
  };
  const requests = declaredRequests(
    by,
    app,
    blueprint.permissions,
    blueprint.id
  );
  const db = drizzle(env.DB);
  // The App, only while the blueprint is still there and, for a marked
  // one, `by` still has a role in its App (`stillOpenTo`), selected from
  // its row: unmarked or unshared since they were read above, nothing is
  // inserted, the version's row can't name an App that isn't there, and
  // the whole batch is refused.
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
      createdAt: sql<Date>`${appRow.createdAt.getTime()}`.as("created_at"),
    })
    .from(blueprints)
    .where(
      and(
        eq(blueprints.id, blueprint.id),
        source ? stillOpenTo(by, source.id) : undefined
      )
    );
  const statements = [
    db.insert(apps).select(appFromBlueprint),
    outboxed(
      db,
      changeEntry(by, "app.created", app, {
        blueprint: blueprint.id,
        fromApp: blueprint.appId,
        fromVersion: blueprint.version,
      })
    ),
    db.insert(appVersions).values(versionRow),
    outboxed(
      db,
      changeEntry(by, "app.committed", app, {
        version: 1,
        parent: null,
        tree: tree.tree,
        files: files.size,
      })
    ),
    // One statement each: D1 binds at most 100 values to one.
    ...requests.rows.map((row) => db.insert(permissions).values(row)),
    ...requests.entries.map((entry) => outboxed(db, entry)),
  ] as const;
  try {
    await auditedBatch(env, db, statements);
  } catch (error) {
    if (!(await blueprintRow(env, blueprintIdSchema.parse(blueprint.id)))) {
      throw appErrors.create("app.blueprint_not_found");
    }
    if (source) {
      // Refused, as for any call, when they lost their role in the App.
      await appFor(env, by, source.id, "user");
    }
    throw error;
  }
  return {
    app: toApp(appRow),
    version: toVersion(versionRow),
    permissions: requests.rows.map(toPermission),
  };
};

/** An audit entry of the release's install: Grasp, with no person. */
const installEntry = (
  action: string,
  blueprint: string,
  detail: AuditEntry["detail"]
): AuditEntry => ({
  actor: { type: "system" },
  action,
  target: { type: "blueprint", id: blueprint },
  detail,
});

/**
 * Installs the release's built-in blueprint as a blueprint like any
 * other, under its folder's name, which never changes: created if it
 * isn't there, or changed if its name, description, code or what it
 * declares each App created from it asks for differ from what's stored,
 * in one audited batch, so installing it again writes nothing. The
 * collections it declares are created first, in Knowledge's database,
 * each only if it isn't there yet, and audited only then. Apps created
 * from it earlier keep their code and their permissions.
 *
 * Two installs at once write the same row: the second changes nothing,
 * and records nothing.
 */
export const installBuiltinBlueprint = async (
  env: Env,
  builtin: BuiltinBlueprint
): Promise<void> => {
  const id = blueprintIdSchema.parse(builtin.id);
  const { name, description } = appErrors.parse(
    "app.invalid",
    fromBlueprintSchema,
    { name: builtin.name, description: builtin.description }
  );
  const tree = await versionTree(new Map(Object.entries(builtin.files)));
  const declared = [...builtin.permissions];
  const stored = await blueprintRow(env, id);
  const differs =
    stored !== undefined &&
    (stored.name !== name ||
      stored.description !== description ||
      stored.tree !== tree.tree ||
      JSON.stringify(stored.permissions) !== JSON.stringify(declared));
  if (stored === undefined || stored.tree !== tree.tree) {
    await storeBlueprintTree(env, id, tree);
  }
  const now = new Date();
  const db = drizzle(env.DB);
  const created =
    stored === undefined
      ? [
          db
            .insert(blueprints)
            .values({
              id,
              name,
              description,
              tree: tree.tree,
              appId: null,
              version: null,
              approved: true,
              permissions: declared,
              markedBy: null,
              markedAt: now,
            })
            .onConflictDoNothing(),
          outboxedIfChanged(
            db,
            installEntry("blueprint.installed", id, { tree: tree.tree })
          ),
        ]
      : [];
  const changed = differs
    ? [
        db
          .update(blueprints)
          .set({
            name,
            description,
            tree: tree.tree,
            permissions: declared,
            markedAt: now,
          })
          .where(
            and(
              eq(blueprints.id, id),
              sql`(${blueprints.name} IS NOT ${name} OR ${blueprints.description} IS NOT ${description} OR ${blueprints.tree} IS NOT ${tree.tree} OR ${blueprints.permissions} IS NOT ${JSON.stringify(declared)})`
            )
          ),
        outboxedIfChanged(
          db,
          installEntry("blueprint.changed", id, { tree: tree.tree })
        ),
      ]
    : [];
  // The collections its copies ask for, before anything asks for them:
  // each is created once, by the first install that declares it, and
  // shared by every App created from a blueprint that names it. Nothing
  // deletes such a collection once created.
  for (const collection of builtin.collections) {
    // oxlint-disable-next-line no-await-in-loop -- a few, one at a time
    await ensureCollection(
      env,
      {
        ...collection,
        owner: releaseOwner,
        access: "everyone",
        sensitive: false,
        source: "here",
        createdAt: now,
      },
      { type: "system" },
      { builtin: builtin.id }
    );
  }
  const [first, ...rest] = [...created, ...changed];
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

  async unmark(blueprint: string): Promise<void> {
    await withPerson(this.#check, async (by) => {
      await unmarkBlueprint(this.#env, by, blueprint);
    });
  }

  async create(
    blueprint: string,
    input: FromBlueprint
  ): Promise<CreatedFromBlueprint> {
    return await withPerson(
      this.#check,
      async (by) => await createFromBlueprint(this.#env, by, blueprint, input)
    );
  }
}
