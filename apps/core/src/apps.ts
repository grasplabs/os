import {
  appErrors,
  appIdInputSchema,
  appLimits,
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
import { appIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import { canonicalJson } from "@grasp-os/shared/json";
import type { Identity } from "@grasp-os/shared/rpc";
import { and, asc, desc, eq, lt, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import {
  outboxed,
  outboxedIfChanged,
  sendAuditOutboxNow,
} from "./audit-outbox.ts";
import { actorOf } from "./audit.ts";
import { apps, appVersions, appWorkingFiles } from "./db/core/schema.ts";
import { isUniqueViolation } from "./db/d1.ts";

// The App registry and each App's code. The registry, the versions and the
// working copy are rows in the core database; the content is in R2 (EU),
// addressed by its SHA-256:
//
// - `apps/<app>/trees/<sha256>.json`: all of a version's files, as
//   canonical JSON by path. A version names its tree by hash, so reading a
//   version is one read, and what is read is checked against the hash.
// - `apps/<app>/blobs/<sha256>`: one file written to the working copy.
//
// Content is only ever written under its own hash, so nothing stored
// changes after the fact: a version's files stay exactly as committed
// whatever happens to the App later. Writing content comes first and the
// rows that name it after, so a row never names content that isn't there;
// a failure in between leaves content nothing names, which is harmless.
//
// Versions are linear: each commit is the latest version plus the working
// copy, as the next number. Two commits at once both try the same number,
// and the database keeps one; the other is refused as a conflict.

type AppRow = typeof apps.$inferSelect;
type VersionRow = typeof appVersions.$inferSelect;

/** A tree as `writeTree` stores it. */
const storedTreeSchema = z.record(z.string(), z.string());

/** Most versions one `listVersions` call returns. */
const versionsPerPage = 100;

const requireBuilder = (by: Identity): void => {
  if (by.role === "user") {
    throw appErrors.create("app.forbidden");
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
      issues: parsed.error.issues.map(
        ({ path, message }) => `${path.map(String).join(".")}: ${message}`
      ),
    });
  }
  return parsed.data;
};

const sha256 = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text)
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

const treeKey = (app: AppId, tree: string): string =>
  `apps/${app}/trees/${tree}.json`;
const blobKey = (app: AppId, blob: string): string =>
  `apps/${app}/blobs/${blob}`;

/** Stored content by its hash, checked against it. */
const readContent = async (
  env: Env,
  key: string,
  hash: string
): Promise<string> => {
  const object = await env.FILES.get(key);
  const text = await object?.text();
  if (text === undefined || (await sha256(text)) !== hash) {
    throw new Error(`App content ${key} is missing or damaged`);
  }
  return text;
};

const readTree = async (
  env: Env,
  app: AppId,
  tree: string
): Promise<Map<string, string>> => {
  const files = storedTreeSchema.parse(
    JSON.parse(await readContent(env, treeKey(app, tree), tree))
  );
  return new Map(Object.entries(files));
};

/** Stores `files` as a tree and returns its hash. */
const writeTree = async (
  env: Env,
  app: AppId,
  files: ReadonlyMap<string, string>
): Promise<string> => {
  const json = canonicalJson(Object.fromEntries(files));
  const tree = await sha256(json);
  await env.FILES.put(treeKey(app, tree), json);
  return tree;
};

const iso = (date: Date): string => date.toISOString();

const toApp = (row: AppRow): App => ({
  id: appIdSchema.parse(row.id),
  name: row.name,
  description: row.description,
  owner: row.ownerId,
  blueprint: row.blueprint,
  currentVersion: row.currentVersion,
  pendingVersion: row.pendingVersion,
  createdAt: iso(row.createdAt),
});

const toVersion = (row: VersionRow): AppVersion => ({
  app: appIdSchema.parse(row.appId),
  version: row.version,
  parent: row.parent,
  tree: row.tree,
  files: row.files,
  author: row.authorId,
  message: row.message,
  createdAt: iso(row.createdAt),
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
  const id = appIdInputSchema.safeParse(input);
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

/**
 * An App's latest version and the working copy's rows, read together in
 * one batch, so a commit landing in between can't pair a new version with
 * rows it already committed.
 */
const workingState = async (env: Env, app: AppId) => {
  const db = drizzle(env.DB);
  const [[latest], rows] = await db.batch([
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
  ]);
  return { latest, rows };
};

/** `app.too_large` if `lengths` (by path) are over an App's limits. */
const checkLimits = (lengths: ReadonlyMap<string, number>): void => {
  let total = 0;
  for (const length of lengths.values()) {
    total += length;
  }
  if (lengths.size > appLimits.files || total > appLimits.totalLength) {
    throw appErrors.create("app.too_large", {
      files: lengths.size,
      maxFiles: appLimits.files,
      length: total,
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

/** The latest version's files with the working copy's changes over them. */
const workingCopy = async (env: Env, app: AppId) => {
  const { latest, rows } = await workingState(env, app);
  const files = latest
    ? await readTree(env, app, latest.tree)
    : new Map<string, string>();
  const written = await Promise.all(
    rows.map(async ({ path, blob }) =>
      blob === null
        ? ([path, undefined] as const)
        : ([path, await readContent(env, blobKey(app, blob), blob)] as const)
    )
  );
  for (const [path, content] of written) {
    if (content === undefined) {
      files.delete(path);
    } else {
      files.set(path, content);
    }
  }
  return { latest, rows, files };
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
    createdAt: new Date(),
  };
  const app = toApp(row);
  const db = drizzle(env.DB);
  await db.batch([
    db.insert(apps).values(row),
    outboxed(
      db,
      changeEntry(by, "app.created", app.id, { blueprint: row.blueprint })
    ),
  ]);
  await sendAuditOutboxNow(env);
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

  // The working copy's lengths after these changes.
  const { latest, rows } = await workingState(env, appId);
  const lengths = new Map<string, number>();
  if (latest) {
    for (const [path, content] of await readTree(env, appId, latest.tree)) {
      lengths.set(path, content.length);
    }
  }
  for (const { path, blob, length } of rows) {
    if (blob === null) {
      lengths.delete(path);
    } else {
      lengths.set(path, length);
    }
  }
  for (const [path, content] of changes) {
    if (content === null) {
      lengths.delete(path);
    } else {
      lengths.set(path, content.length);
    }
  }
  checkLimits(lengths);

  const written = await Promise.all(
    changes.map(async ([path, content]) => {
      if (content === null) {
        return { path, blob: null, length: 0 };
      }
      const blob = await sha256(content);
      await env.FILES.put(blobKey(appId, blob), content);
      return { path, blob, length: content.length };
    })
  );
  const db = drizzle(env.DB);
  const writtenAt = new Date();
  const [first, ...rest] = written.map(({ path, blob, length }) =>
    db
      .insert(appWorkingFiles)
      .values({ appId, path, blob, length, writtenBy: by.userId, writtenAt })
      .onConflictDoUpdate({
        target: [appWorkingFiles.appId, appWorkingFiles.path],
        set: { blob, length, writtenBy: by.userId, writtenAt },
      })
  );
  // The schema requires at least one change.
  if (first) {
    await db.batch([first, ...rest]);
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
  checkLimits(
    new Map([...files].map(([path, content]) => [path, content.length]))
  );
  const tree = await writeTree(env, appId, files);
  if (tree === latest?.tree) {
    throw appErrors.create("app.nothing_to_commit");
  }

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
  // Only the rows this commit read: one written since has other content.
  const committed = JSON.stringify(
    rows.map(({ path, blob }) => `${path}\u0000${blob ?? ""}`)
  );
  const db = drizzle(env.DB);
  try {
    await db.batch([
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
            sql`${appWorkingFiles.path} || char(0) || coalesce(${appWorkingFiles.blob}, '') IN (SELECT value FROM json_each(${committed}))`
          )
        ),
    ]);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw appErrors.create("app.conflict");
    }
    throw error;
  }
  await sendAuditOutboxNow(env);
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
  const [before, after] = await Promise.all(
    [from, to].map(async (version) => {
      const row = await findVersion(env, appId, version);
      return await readTree(env, appId, row.tree);
    })
  );
  if (!(before && after)) {
    throw new Error("Expected two trees");
  }
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
  const [[proposed]] = await db.batch([
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
  await sendAuditOutboxNow(env);
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
  const [[changed]] = await db.batch([
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
  await sendAuditOutboxNow(env);
  return toApp(changed);
};
