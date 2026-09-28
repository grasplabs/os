import { workflowIdOf } from "@grasp-os/compiler";
import { appLimits } from "@grasp-os/shared/app-limits";
import {
  appErrors,
  appVersionSchema,
  commitMessageSchema,
  fileChangesSchema,
  newAppSchema,
} from "@grasp-os/shared/apps";
import type {
  App,
  AppContents,
  AppFiles,
  AppRole,
  AppVersion,
  FileDiff,
} from "@grasp-os/shared/apps";
import type { AuditDetailValue, AuditEntry } from "@grasp-os/shared/audit";
import { actorOf, createAuditEvent } from "@grasp-os/shared/audit";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import { canonicalJson } from "@grasp-os/shared/json";
import { requireBuilder, roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { and, asc, desc, eq, isNull, lt, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { appsFoundBy, requireAppRole } from "./app-access.ts";
import type { Person } from "./app-access.ts";
import {
  auditedBatch,
  outboxed,
  outboxedEventWhere,
  outboxedIfChanged,
  storedEvent,
} from "./audit-outbox.ts";
import { builtinOwner } from "./builtin-app-id.ts";
import { apps, appVersions, appWorkingFiles } from "./db/core/schema.ts";
import { inList, isUniqueViolation } from "./db/d1.ts";
import { featureEnabled } from "./features.ts";
import { appMemoryPath, requireWithinLimit } from "./knowledge/memory-files.ts";
import { madeCurrent } from "./permissions.ts";
import { requireWorkflowTestsPass } from "./workflows/code.ts";
import {
  registerTriggers,
  registrationHolds,
  triggerRegistration,
  triggerSummary,
} from "./workflows/trigger-registry.ts";

// The App registry and each App's code. The registry, the versions and the
// working copy (files written since the latest version) are rows in the
// core database. A version's files are one object in R2 (EU),
// `apps/<app>/trees/<sha256>.json`: canonical JSON by path, stored under
// its own SHA-256, which the version row names. Reading a version is one
// read, checked against the hash.
//
// A tree is only ever written under its own hash and version rows never
// change, so a version's files stay exactly as committed whatever happens
// to the App later. The tree is stored before the row that names it, so a
// row never names a missing tree. A commit refused as a conflict can leave
// its tree named by no version: rare, and one version's size at most.
//
// Versions are linear: each commit is the latest version plus the working
// copy, as the next number. Two commits at once both try the same number,
// and the database keeps one; the other is refused as a conflict.

export type AppRow = typeof apps.$inferSelect;
export type VersionRow = typeof appVersions.$inferSelect;

/** A tree as `commitFiles` stores it. */
const storedTreeSchema = z.record(z.string(), z.string());

/** Most versions one `listVersions` call returns. */
const versionsPerPage = 100;

const treeKey = (app: AppId, tree: string): string =>
  `apps/${app}/trees/${tree}.json`;

/** A version's files, checked against the hash that names them. */
const readTree = async (
  env: Env,
  app: AppId,
  tree: string
): Promise<Map<string, string>> => {
  const key = treeKey(app, tree);
  const object = await env.FILES.get(key);
  const text = await object?.text();
  if (text === undefined || (await sha256Hex(text)) !== tree) {
    throw new Error(`App tree ${key} is missing or damaged`);
  }
  return new Map(Object.entries(storedTreeSchema.parse(JSON.parse(text))));
};

export const toApp = (row: AppRow): App => ({
  id: appIdSchema.parse(row.id),
  name: row.name,
  description: row.description,
  owner: row.ownerId,
  blueprint: row.blueprint,
  currentVersion: row.currentVersion,
  pendingVersion: row.pendingVersion,
  createdAt: row.createdAt.toISOString(),
});

export const toVersion = (row: VersionRow): AppVersion => ({
  app: appIdSchema.parse(row.appId),
  version: row.version,
  parent: row.parent,
  tree: row.tree,
  files: row.files,
  author: row.authorId,
  message: row.message,
  createdAt: row.createdAt.toISOString(),
});

/** The audit entry of a change to `app` by `by`: identifiers only. */
export const changeEntry = (
  by: Identity,
  action:
    | "app.created"
    | "app.committed"
    | "app.version.proposed"
    | "app.version.current"
    | "app.blueprint.marked"
    | "app.blueprint.unmarked"
    | "app.blueprint.connection_dropped"
    | "app.blueprint.revoked",
  app: AppId,
  detail: Record<string, AuditDetailValue>
): AuditEntry => ({
  actor: actorOf(by),
  action,
  target: { type: "app", id: app },
  detail,
});

/**
 * The App `input` names, which must exist, and be in use: one created from
 * a blueprint that is still pending (app-blueprints.ts) isn't found.
 */
export const findApp = async (env: Env, input: unknown): Promise<App> => {
  const id = appIdSchema.safeParse(input);
  const row = id.success
    ? await drizzle(env.DB)
        .select()
        .from(apps)
        .where(and(eq(apps.id, id.data), isNull(apps.pendingSince)))
        .get()
    : undefined;
  if (!row) {
    throw appErrors.create("app.not_found");
  }
  return toApp(row);
};

/**
 * The App `input` names, for `by` with at least `needed` in it
 * (app-access.ts). While `app_sharing` is off, the rule from before Apps
 * had roles: admins and builders build every App, and users none. A
 * built-in's App is `user` at most for everyone, admins included, whether
 * `app_sharing` is on or off: `role.forbidden` for anything that needs
 * `builder`.
 */
export const appFor = async (
  env: Env,
  by: Person,
  input: unknown,
  needed: AppRole
): Promise<App> => {
  if (!featureEnabled(env, "app_sharing")) {
    requireBuilder(by);
    const app = await findApp(env, input);
    if (app.owner === builtinOwner && needed === "builder") {
      throw roleErrors.create("role.forbidden");
    }
    return app;
  }
  const app = await findApp(env, input);
  await requireAppRole(env, by, app, needed);
  return app;
};

/** One of an App's versions, which must exist. */
export const findVersion = async (
  env: Env,
  app: AppId,
  input: unknown
): Promise<VersionRow> => {
  const version = appVersionSchema.safeParse(input);
  const row = version.success
    ? await drizzle(env.DB)
        .select()
        .from(appVersions)
        .where(
          and(eq(appVersions.appId, app), eq(appVersions.version, version.data))
        )
        .get()
    : undefined;
  if (!row) {
    throw appErrors.create("app.version_not_found");
  }
  return row;
};

interface Size {
  files: number;
  /** Characters in all files together. */
  length: number;
}

const sizeOf = (files: ReadonlyMap<string, string>): Size => {
  let length = 0;
  for (const content of files.values()) {
    length += content.length;
  }
  return { files: files.size, length };
};

/**
 * An App's working copy: its latest version's files with the changes
 * written since over them. The version, the rows and the App's working
 * revision are read in one batch, so a commit landing in between can't
 * pair a new version with rows it already committed.
 */
const workingCopy = async (env: Env, app: AppId) => {
  const db = drizzle(env.DB);
  const [[latest], rows, [registered]] = await db.batch([
    db
      .select()
      .from(appVersions)
      .where(eq(appVersions.appId, app))
      .orderBy(desc(appVersions.version))
      .limit(1),
    db
      .select()
      .from(appWorkingFiles)
      .where(eq(appWorkingFiles.appId, app))
      .orderBy(asc(appWorkingFiles.path)),
    db
      .select({ revision: apps.workingRevision })
      .from(apps)
      .where(eq(apps.id, app)),
  ]);
  const files = latest
    ? await readTree(env, app, latest.tree)
    : new Map<string, string>();
  for (const { path, content } of rows) {
    if (content === null) {
      files.delete(path);
    } else {
      files.set(path, content);
    }
  }
  return { latest, rows, files, revision: registered?.revision ?? null };
};

/**
 * `app.invalid` if two paths can't both exist on a disk: a file and a
 * folder of the same name (`a` and `a/b.ts`), or names of files or folders
 * that differ only in case (`App.ts` and `app.ts`, `components/` and
 * `Components/`), which a case-insensitive file system, and whoever reads
 * the code, can't tell apart. Only collisions with a path this write
 * `added` count, as with the limits: an App whose files already collide
 * can still be changed, and fixed.
 */
const checkPaths = (
  paths: Iterable<string>,
  added: ReadonlySet<string>
): void => {
  // Every name a path takes, as a file or a folder, by its lowercase form:
  // the first spelling, and the path that took it. Paths that were there
  // before come first, so a clash names the one the write adds.
  const taken = new Map<
    string,
    { spelling: string; file: boolean; path: string }
  >();
  const issues = new Set<string>();
  const ordered = [...paths].toSorted(
    (a, b) => Number(added.has(a)) - Number(added.has(b)) || (a < b ? -1 : 1)
  );
  for (const path of ordered) {
    const segments = path.split("/");
    for (let depth = 1; depth <= segments.length; depth += 1) {
      const spelling = segments.slice(0, depth).join("/");
      const file = depth === segments.length;
      const first = taken.get(spelling.toLowerCase());
      if (first === undefined) {
        taken.set(spelling.toLowerCase(), { spelling, file, path });
      } else if (
        (first.spelling !== spelling || first.file || file) &&
        added.has(path)
      ) {
        issues.add(
          first.file === file
            ? `${path}: Differs only in case from ${first.path}`
            : `${path}: A file and a folder of the same name, with ${first.path}`
        );
      }
    }
  }
  if (issues.size > 0) {
    throw appErrors.create("app.invalid", { issues: [...issues] });
  }
};

/**
 * `app.too_large` if `files` are over an App's limits. With `before`, the
 * working copy's size before a write, only if they also grew: a working
 * copy that is over them (from before they were lowered) can still shrink.
 * A version is always within them, so it always fits a build.
 */
const checkLimits = (
  files: ReadonlyMap<string, string>,
  before?: Size
): void => {
  const after = sizeOf(files);
  const over =
    after.files > appLimits.files || after.length > appLimits.totalLength;
  const grows =
    before === undefined ||
    after.files > before.files ||
    after.length > before.length;
  if (over && grows) {
    throw appErrors.create("app.too_large", {
      files: after.files,
      maxFiles: appLimits.files,
      length: after.length,
      maxLength: appLimits.totalLength,
    });
  }
};

/**
 * `knowledge.memory_too_large` if the App's AGENTS.md, which agents
 * working on the App have in their context (knowledge/memory.ts), is over
 * its limit, and only if it also grew, as with `checkLimits`. While
 * `memory` is switched off, an App's AGENTS.md is a file like any other.
 */
const checkMemory = (
  env: Env,
  before: string | undefined,
  after: string | undefined
): void => {
  const grew =
    after !== undefined &&
    (before === undefined || after.length > before.length);
  if (grew && featureEnabled(env, "memory")) {
    requireWithinLimit(env, "AGENTS.md", after);
  }
};

/** A version's files as stored: canonical JSON, and its SHA-256. */
interface Tree {
  tree: string;
  json: string;
}

/**
 * `files` as a version's tree, or `app.too_large` if they are over an
 * App's limits: a version always fits them.
 */
export const versionTree = async (
  files: ReadonlyMap<string, string>
): Promise<Tree> => {
  checkLimits(files);
  const json = canonicalJson(Object.fromEntries(files));
  return { tree: await sha256Hex(json), json };
};

/** Stores a tree under its hash, before any version row names it. */
export const storeTree = async (
  env: Env,
  app: AppId,
  { tree, json }: Tree
): Promise<void> => {
  // R2 checks the upload against its hash, so what's stored is what's named.
  await env.FILES.put(treeKey(app, tree), json, { sha256: tree });
};

/** The files of one of an App's versions. For the runtime and the compiler. */
export const versionFiles = async (
  env: Env,
  app: AppId,
  version: unknown
): Promise<AppFiles> => {
  const row = await findVersion(env, app, version);
  return Object.fromEntries(await readTree(env, app, row.tree));
};

/** Creates an App, with no versions yet. */
export const createApp = async (
  env: Env,
  by: Identity,
  input: unknown
): Promise<App> => {
  requireBuilder(by);
  const { name, description, blueprint } = appErrors.parse(
    "app.invalid",
    newAppSchema,
    input
  );
  const row: AppRow = {
    id: crypto.randomUUID(),
    name,
    description,
    ownerId: by.userId,
    blueprint: blueprint ?? null,
    currentVersion: null,
    pendingVersion: null,
    workingRevision: null,
    pendingSince: null,
    createdAt: new Date(),
  };
  const app = toApp(row);
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [
    db.insert(apps).values(row),
    outboxed(
      db,
      changeEntry(by, "app.created", app.id, { blueprint: row.blueprint })
    ),
  ]);
  return app;
};

/**
 * The Apps `by` has a role in (app-access.ts), as a condition on `apps`.
 * As with `appFor`, while `app_sharing` is off: every App for admins and
 * builders, and users are refused. Never a pending App (`findApp`).
 */
export const appsListedFor = (env: Env, by: Identity): SQL => {
  if (!featureEnabled(env, "app_sharing")) {
    requireBuilder(by);
  }
  return appsFoundBy(env, by);
};

/** The Apps `by` has a role in (app-access.ts), oldest first. */
export const listApps = async (env: Env, by: Identity): Promise<App[]> => {
  const rows = await drizzle(env.DB)
    .select()
    .from(apps)
    .where(appsListedFor(env, by))
    .orderBy(asc(apps.createdAt), asc(apps.id));
  return rows.map(toApp);
};

export const getApp = async (
  env: Env,
  by: Identity,
  app: unknown
): Promise<App> => await appFor(env, by, app, "user");

/**
 * A screen's name, from its file's path (as `openScreen` finds it, in
 * screens-rpc.ts); undefined for any other file.
 */
const screenPath = /^screens\/(?<name>[\w-]{1,64})\.tsx$/u;

/** The names `nameOf` finds in `paths`, in their order. */
const namesIn = (
  paths: string[],
  nameOf: (path: string) => string | undefined
): string[] =>
  paths.flatMap((path) => {
    const name = nameOf(path);
    return name === undefined ? [] : [name];
  });

/**
 * The IDs of the workflows in a version's files, sorted: what its row
 * keeps (`app_versions.workflows`) when it is committed.
 */
export const workflowsIn = (files: ReadonlyMap<string, string>): string[] =>
  namesIn([...files.keys()].toSorted(), workflowIdOf);

/** The screens and workflows of an App's current version. */
export const appContents = async (
  env: Env,
  by: Person,
  app: unknown
): Promise<AppContents> => {
  const { id, currentVersion } = await appFor(env, by, app, "user");
  if (currentVersion === null) {
    return { version: null, screens: [], workflows: [] };
  }
  const paths = Object.keys(
    await versionFiles(env, id, currentVersion)
  ).toSorted();
  return {
    version: currentVersion,
    screens: namesIn(paths, (path) => screenPath.exec(path)?.groups?.name),
    workflows: namesIn(paths, workflowIdOf),
  };
};

/** An App's files at `version`, or its working copy without one. */
export const readFiles = async (
  env: Env,
  by: Identity,
  app: unknown,
  version?: unknown
): Promise<AppFiles> => {
  const { id: appId } = await appFor(env, by, app, "builder");
  if (version !== undefined) {
    return await versionFiles(env, appId, version);
  }
  const { files } = await workingCopy(env, appId);
  return Object.fromEntries(files);
};

/**
 * Writes changes to an App's working copy: new content by path, or null to
 * delete a file. Refused as a whole when the working copy would be over
 * the App's limits.
 *
 * Each write is a new revision of the working copy, and lands only over
 * the revision its limit check read: two writes at once can't together
 * take the App over its limits. The one that loses is refused as a
 * conflict, and nothing of it is written.
 */
export const writeFiles = async (
  env: Env,
  by: Identity,
  app: unknown,
  input: unknown
): Promise<void> => {
  const { id: appId } = await appFor(env, by, app, "builder");
  const changes = Object.entries(
    appErrors.parse("app.invalid", fileChangesSchema, input)
  );
  const { files, revision } = await workingCopy(env, appId);
  const before = sizeOf(files);
  const agentsBefore = files.get(appMemoryPath);
  const added = new Set(
    changes.flatMap(([path, content]) =>
      content === null || files.has(path) ? [] : [path]
    )
  );
  for (const [path, content] of changes) {
    if (content === null) {
      files.delete(path);
    } else {
      files.set(path, content);
    }
  }
  checkLimits(files, before);
  checkPaths(files.keys(), added);
  checkMemory(env, agentsBefore, files.get(appMemoryPath));

  const db = drizzle(env.DB);
  const next = crypto.randomUUID();
  const writtenAt = Date.now();
  const [[claimed]] = await db.batch([
    db
      .update(apps)
      .set({ workingRevision: next })
      .where(
        and(eq(apps.id, appId), sql`${apps.workingRevision} IS ${revision}`)
      )
      .returning({ id: apps.id }),
    // Each only if this write claimed the revision above.
    ...changes.map(([path, content]) =>
      db
        .insert(appWorkingFiles)
        .select(
          sql`SELECT ${appId}, ${path}, ${content}, ${next}, ${by.userId}, ${writtenAt} WHERE (SELECT ${apps.workingRevision} FROM ${apps} WHERE ${apps.id} = ${appId}) = ${next}`
        )
        .onConflictDoUpdate({
          target: [appWorkingFiles.appId, appWorkingFiles.path],
          set: {
            content: sql`excluded.content`,
            revision: sql`excluded.revision`,
            writtenBy: sql`excluded.written_by`,
            writtenAt: sql`excluded.written_at`,
          },
        })
    ),
  ]);
  if (!claimed) {
    throw appErrors.create("app.conflict");
  }
};

/**
 * Commits an App's working copy as its next version, by `by` with
 * `message`. Changes written while it commits stay in the working copy.
 */
export const commitFiles = async (
  env: Env,
  by: Identity,
  app: unknown,
  message: unknown
): Promise<AppVersion> => {
  const { id: appId } = await appFor(env, by, app, "builder");
  const text = appErrors.parse("app.invalid", commitMessageSchema, message);
  const { latest, rows, files } = await workingCopy(env, appId);
  if (rows.length === 0) {
    throw appErrors.create("app.nothing_to_commit");
  }
  const { tree, json } = await versionTree(files);
  if (tree === latest?.tree) {
    throw appErrors.create("app.nothing_to_commit");
  }
  await storeTree(env, appId, { tree, json });

  const row: VersionRow = {
    appId,
    version: (latest?.version ?? 0) + 1,
    parent: latest?.version ?? null,
    tree,
    files: files.size,
    authorId: by.userId,
    message: text,
    createdAt: new Date(),
    approved: null,
    workflows: workflowsIn(files),
  };
  // Only the rows this commit read: each write gives the rows it writes a
  // new revision, so a row written since has one this commit didn't read.
  const committed = [...new Set(rows.map(({ revision }) => revision))];
  const db = drizzle(env.DB);
  try {
    await auditedBatch(env, db, [
      db.insert(appVersions).values(row),
      outboxed(
        db,
        changeEntry(by, "app.committed", appId, {
          version: row.version,
          parent: row.parent,
          tree,
          files: row.files,
        })
      ),
      db
        .delete(appWorkingFiles)
        .where(
          and(
            eq(appWorkingFiles.appId, appId),
            inList(appWorkingFiles.revision, committed)
          )
        ),
    ]);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw appErrors.create("app.conflict");
    }
    throw error;
  }
  return toVersion(row);
};

/** An App's versions, newest first, a page at a time. */
export const listVersions = async (
  env: Env,
  by: Identity,
  app: unknown,
  before?: unknown
): Promise<AppVersion[]> => {
  const { id } = await appFor(env, by, app, "builder");
  const until =
    before === undefined
      ? undefined
      : appErrors.parse("app.invalid", appVersionSchema, before);
  const rows = await drizzle(env.DB)
    .select()
    .from(appVersions)
    .where(
      and(
        eq(appVersions.appId, id),
        until === undefined ? undefined : lt(appVersions.version, until)
      )
    )
    .orderBy(desc(appVersions.version))
    .limit(versionsPerPage);
  return rows.map(toVersion);
};

export const getVersion = async (
  env: Env,
  by: Identity,
  app: unknown,
  version: unknown
): Promise<AppVersion> => {
  const { id: appId } = await appFor(env, by, app, "builder");
  return toVersion(await findVersion(env, appId, version));
};

/** How the files of version `to` differ from those of `from`, by path. */
export const diffVersions = async (
  env: Env,
  by: Identity,
  app: unknown,
  from: unknown,
  to: unknown
): Promise<FileDiff[]> => {
  const { id: appId } = await appFor(env, by, app, "builder");
  const treeOf = async (version: unknown) => {
    const { tree } = await findVersion(env, appId, version);
    return await readTree(env, appId, tree);
  };
  const [before, after] = await Promise.all([treeOf(from), treeOf(to)]);
  const paths = [...new Set([...before.keys(), ...after.keys()])].toSorted();
  return paths.flatMap((path): FileDiff[] => {
    const old = before.get(path);
    const now = after.get(path);
    if (old === undefined) {
      return now === undefined ? [] : [{ path, change: "added", after: now }];
    }
    if (now === undefined) {
      return [{ path, change: "deleted", before: old }];
    }
    return old === now
      ? []
      : [{ path, change: "modified", before: old, after: now }];
  });
};

/** Puts a version up for review. The current version can't be. */
export const proposeVersion = async (
  env: Env,
  by: Identity,
  app: unknown,
  version: unknown
): Promise<App> => {
  const found = await appFor(env, by, app, "builder");
  const appId = found.id;
  const { version: number } = await findVersion(env, appId, version);
  const db = drizzle(env.DB);
  const [[proposed]] = await auditedBatch(env, db, [
    db
      .update(apps)
      .set({ pendingVersion: number })
      .where(
        and(
          eq(apps.id, appId),
          sql`${apps.pendingVersion} IS NOT ${number}`,
          sql`${apps.currentVersion} IS NOT ${number}`
        )
      )
      .returning(),
    outboxedIfChanged(
      db,
      changeEntry(by, "app.version.proposed", appId, { version: number })
    ),
  ]);
  if (!proposed) {
    // Pending or current already: nothing changed, nothing is recorded.
    return await findApp(env, appId);
  }
  return toApp(proposed);
};

/**
 * Makes a version the one that runs: the pending one after review, or any
 * other, such as an earlier one to roll back. The pending version is
 * cleared once it is current. Made current by someone who couldn't grant
 * them, the version is unapproved and the App's permissions that change
 * things for the person using it are asked for again (`madeCurrent`), but
 * for an App's first version copied from a blueprint, the first time:
 * version 1 existed and was immutable when the admin granted its
 * requests.
 */
export const setCurrentVersion = async (
  env: Env,
  by: Identity,
  app: unknown,
  version: unknown
): Promise<App> => {
  const found = await appFor(env, by, app, "builder");
  const appId = found.id;
  const { version: number, approved } = await findVersion(env, appId, version);
  if (found.currentVersion === number) {
    return found;
  }
  // Tested whatever the workflows flag says, so switching it on never runs untested code.
  const files = await versionFiles(env, appId, number);
  await requireWorkflowTestsPass(env, appId, number, files);
  // Registered whatever the triggers flag says, so switching it on starts
  // the triggers of the version current then.
  const triggers = await triggerRegistration(env, appId, number, files);
  const previous = found.currentVersion;
  const event = createAuditEvent(
    changeEntry(by, "app.version.current", appId, {
      version: number,
      previous,
      ...triggerSummary(triggers),
    }),
    "core"
  );
  const db = drizzle(env.DB);
  // Only over the current version read above, so the event's `previous`
  // is the version this replaced, and only while what its triggers were
  // worked out from still holds (trigger-registry.ts). The event is stored
  // only if this batch made it current, and what follows it only then.
  const [[changed]] = await auditedBatch(env, db, [
    db
      .update(apps)
      .set({
        currentVersion: number,
        pendingVersion: sql`CASE WHEN ${apps.pendingVersion} = ${number} THEN NULL ELSE ${apps.pendingVersion} END`,
      })
      .where(
        and(
          eq(apps.id, appId),
          sql`${apps.currentVersion} IS ${previous}`,
          registrationHolds(appId, triggers)
        )
      )
      .returning(),
    outboxedEventWhere(db, event, sql`changes() > 0`),
    ...madeCurrent(env, by, {
      app: appId,
      version: number,
      previous,
      changed: storedEvent(event.id),
      // A copy's first version, approved as it was created from the
      // blueprint (app-blueprints.ts), made current for the first time.
      keep: previous === null && approved === 1,
    }),
    ...registerTriggers(db, appId, number, triggers, storedEvent(event.id)),
  ]);
  if (!changed) {
    throw appErrors.create("app.conflict");
  }
  return toApp(changed);
};
