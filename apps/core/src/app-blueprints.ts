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
import { appIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import { requireBuilder, roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { RpcTarget } from "capnweb";
import { and, asc, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

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
} from "./apps.ts";
import type { AppRow, VersionRow } from "./apps.ts";
import { auditedBatch, outboxed, outboxedIfChanged } from "./audit-outbox.ts";
import {
  appBlueprints,
  apps,
  appVersions,
  permissions,
} from "./db/core/schema.ts";
import { blueprintRequests, toPermission } from "./permissions.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";

// Blueprints. A builder of an App marks one of its versions as a
// blueprint; whoever has a role in the App (app-access.ts) and builds
// (an admin or builder in the organization) creates an App of their own
// from it. The new App is theirs. Its first version is the blueprint's
// code, exactly, and it asks for what the blueprint's App was given or
// asked for, each request waiting for an admin (permissions.ts). Nothing
// else comes with it: none of the App's data (its storage, its workflows'
// state, its runs), settings (parameter values), members or error log.
// A version never changes, so neither does a blueprint's code.
//
// Marking, unmarking and creating are audited, each in the same batch as
// its change. Grasp staff don't create from blueprints: that asks for
// permissions, which staff never do for a client.

type Row = typeof appBlueprints.$inferSelect;

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

/**
 * Creates an App of `by`'s own from the blueprint of App `app` at
 * `version`: the code at that version as its first version, and requests
 * for what that App was given or asked for. All of it lands in one batch,
 * or none of it (the version's files, stored first, are only named once
 * it lands).
 */
export const createFromBlueprint = async (
  env: Env,
  by: Identity,
  app: unknown,
  version: unknown,
  input: unknown
): Promise<CreatedFromBlueprint> => {
  requireBuilder(by);
  if (by.staff) {
    throw roleErrors.create("role.forbidden");
  }
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
  };
  const requests = await blueprintRequests(env, by, source.id, id);
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [
    db.insert(apps).values(appRow),
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
    ...requests.entries.map((entry) => outboxed(db, entry)),
  ]);
  return {
    app: toApp(appRow),
    version: toVersion(versionRow),
    permissions: requests.rows.map(toPermission),
  };
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
