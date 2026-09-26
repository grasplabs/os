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
  AppFiles,
  AppVersion,
  FileDiff,
} from "@grasp-os/shared/apps";
import type { AuditDetailValue, AuditEntry } from "@grasp-os/shared/audit";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { issuesOf } from "@grasp-os/shared/errors";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import { canonicalJson } from "@grasp-os/shared/json";
import { canBuild, roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { and, asc, desc, eq, lt, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { outboxed, outboxedIfChanged, auditedBatch } from "./audit-outbox.ts";
import { actorOf } from "./audit.ts";
import { apps, appVersions, appWorkingFiles } from "./db/core/schema.ts";
import { inList, isUniqueViolation } from "./db/d1.ts";

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

type AppRow = typeof apps.$inferSelect;
type VersionRow = typeof appVersions.$inferSelect;

/** A tree as `commitFiles` stores it. */
const storedTreeSchema = z.record(z.string(), z.string());

/** Most versions one `listVersions` call returns. */
const versionsPerPage = 100;

const requireBuilder = (by: Identity): void => {
  if (!canBuild(by.role)) {
    throw roleErrors.create("role.forbidden");
  }
};

/** `input` as `schema` has it, or `app.invalid` saying why not. */
const parse = <Schema extends z.ZodType>(
  schema: Schema,
  input: unknown
): z.output<Schema> => {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw appErrors.create("app.invalid", {
      issues: issuesOf(parsed.error),
    });
  }
  return parsed.data;
};

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

const toApp = (row: AppRow): App => ({
  id: appIdSchema.parse(row.id),
  name: row.name,
  description: row.description,
  owner: row.ownerId,
  blueprint: row.blueprint,
  currentVersion: row.currentVersion,
  pendingVersion: row.pendingVersion,
  createdAt: row.createdAt.toISOString(),
});

const toVersion = (row: VersionRow): AppVersion => ({
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
const changeEntry = (
  by: Identity,
  action:
    | "app.created"
    | "app.committed"
    | "app.version.proposed"
    | "app.version.current",
  app: AppId,
  detail: Record<string, AuditDetailValue>
): AuditEntry => ({
  actor: actorOf(by),
  action,
  target: { type: "app", id: app },
  detail,
});

/** The App `input` names, which must exist. */
const findApp = async (env: Env, input: unknown): Promise<App> => {
  const id = appIdSchema.safeParse(input);
  const row = id.success
    ? await drizzle(env.DB)
        .select()
        .from(apps)
        .where(eq(apps.id, id.data))
        .get()
    : undefined;
  if (!row) {
    throw appErrors.create("app.not_found");
  }
  return toApp(row);
};

const findVersion = async (
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
  const { name, description, blueprint } = parse(newAppSchema, input);
  const row: AppRow = {
    id: crypto.randomUUID(),
    name,
    description,
    ownerId: by.userId,
    blueprint: blueprint ?? null,
    currentVersion: null,
    pendingVersion: null,
    workingRevision: null,
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

/** Every App, oldest first. */
export const listApps = async (env: Env, by: Identity): Promise<App[]> => {
  requireBuilder(by);
  const rows = await drizzle(env.DB)
    .select()
    .from(apps)
    .orderBy(asc(apps.createdAt), asc(apps.id));
  return rows.map(toApp);
};

export const getApp = async (
  env: Env,
  by: Identity,
  app: unknown
): Promise<App> => {
  requireBuilder(by);
  return await findApp(env, app);
};

/** An App's files at `version`, or its working copy without one. */
export const readFiles = async (
  env: Env,
  by: Identity,
  app: unknown,
  version?: unknown
): Promise<AppFiles> => {
  requireBuilder(by);
  const { id: appId } = await findApp(env, app);
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
  requireBuilder(by);
  const { id: appId } = await findApp(env, app);
  const changes = Object.entries(parse(fileChangesSchema, input));
  const { files, revision } = await workingCopy(env, appId);
  const before = sizeOf(files);
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
  requireBuilder(by);
  const { id: appId } = await findApp(env, app);
  const text = parse(commitMessageSchema, message);
  const { latest, rows, files } = await workingCopy(env, appId);
  if (rows.length === 0) {
    throw appErrors.create("app.nothing_to_commit");
  }
  checkLimits(files);
  const json = canonicalJson(Object.fromEntries(files));
  const tree = await sha256Hex(json);
  if (tree === latest?.tree) {
    throw appErrors.create("app.nothing_to_commit");
  }
  // R2 checks the upload against its hash, so what's stored is what's named.
  await env.FILES.put(treeKey(appId, tree), json, { sha256: tree });

  const row: VersionRow = {
    appId,
    version: (latest?.version ?? 0) + 1,
    parent: latest?.version ?? null,
    tree,
    files: files.size,
    authorId: by.userId,
    message: text,
    createdAt: new Date(),
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
  requireBuilder(by);
  const { id } = await findApp(env, app);
  const until =
    before === undefined ? undefined : parse(appVersionSchema, before);
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
  requireBuilder(by);
  const { id: appId } = await findApp(env, app);
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
  requireBuilder(by);
  const { id: appId } = await findApp(env, app);
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
  requireBuilder(by);
  const found = await findApp(env, app);
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
 * cleared once it is current.
 */
export const setCurrentVersion = async (
  env: Env,
  by: Identity,
  app: unknown,
  version: unknown
): Promise<App> => {
  requireBuilder(by);
  const found = await findApp(env, app);
  const appId = found.id;
  const { version: number } = await findVersion(env, appId, version);
  if (found.currentVersion === number) {
    return found;
  }
  const previous = found.currentVersion;
  const db = drizzle(env.DB);
  // Only over the current version read above, so the event's `previous`
  // is the version this replaced.
  const [[changed]] = await auditedBatch(env, db, [
    db
      .update(apps)
      .set({
        currentVersion: number,
        pendingVersion: sql`CASE WHEN ${apps.pendingVersion} = ${number} THEN NULL ELSE ${apps.pendingVersion} END`,
      })
      .where(
        and(eq(apps.id, appId), sql`${apps.currentVersion} IS ${previous}`)
      )
      .returning(),
    outboxedIfChanged(
      db,
      changeEntry(by, "app.version.current", appId, {
        version: number,
        previous,
      })
    ),
  ]);
  if (!changed) {
    throw appErrors.create("app.conflict");
  }
  return toApp(changed);
};
