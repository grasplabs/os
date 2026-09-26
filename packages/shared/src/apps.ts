import { z } from "zod";

import { appLimits } from "./app-limits.ts";
import { defineErrorFamily } from "./errors.ts";
import { identifierSchema } from "./ids.ts";
import type { AppId } from "./ids.ts";

// An App's code is a tree of text files, versioned as a whole: builders
// (and the agent, for a builder) write files into the App's working copy
// and commit it as the next version. Versions never change once committed.
// One version is current, the one that runs; another can be pending, put
// up for review before a builder makes it current.

/**
 * One folder or file name: letters, digits, `_`, `-` and `.`, not starting
 * with a `.`. That rules out `.` and `..`, so a path can't step out of the
 * App, and hidden files.
 */
const segmentPattern = /^[\w-][\w.-]*$/u;

/**
 * A file's path in an App, relative to its root and `/`-separated, such
 * as `screens/inbox.tsx` or `app/server.ts`. No absolute paths, no empty,
 * `.` or `..` segments, no backslashes.
 */
export const appPathSchema = z
  .string()
  .min(1)
  .max(appLimits.pathLength)
  .refine(
    (path) => {
      const segments = path.split("/");
      return (
        segments.length <= appLimits.pathDepth &&
        segments.every((segment) => segmentPattern.test(segment)) &&
        // Files are keyed by path in plain objects: `__proto__` would be
        // the object's prototype, not a file.
        !Object.hasOwn(Object.prototype, path)
      );
    },
    {
      message: `A relative path of at most ${appLimits.pathDepth} names made of letters, digits, _, - and ., none starting with .`,
    }
  );

/** A version of an App: 1 for its first commit, then 2, 3, … */
export const appVersionSchema = z.int().min(1);

/** What a builder gives to create an App. */
export const newAppSchema = z.strictObject({
  name: z.string().trim().min(1).max(appLimits.nameLength),
  description: z.string().max(appLimits.descriptionLength).default(""),
  /** The blueprint the App was made from, if any. */
  blueprint: identifierSchema.optional(),
});
export type NewApp = z.input<typeof newAppSchema>;

/**
 * Changes to an App's working copy: a file's new content by path, or null
 * to delete it.
 */
export const fileChangesSchema = z
  .record(appPathSchema, z.string().max(appLimits.fileLength).nullable())
  .refine((changes) => Object.keys(changes).length > 0, {
    message: "At least one file",
  })
  .refine((changes) => Object.keys(changes).length <= appLimits.files, {
    message: `At most ${appLimits.files} files at once`,
  });
export type FileChanges = z.input<typeof fileChangesSchema>;

/** A commit message: what changed and why, for people. */
export const commitMessageSchema = z
  .string()
  .trim()
  .min(1)
  .max(appLimits.messageLength);

/** An App in the registry. Times are ISO 8601. */
export interface App {
  id: AppId;
  name: string;
  description: string;
  /** The user who created it. */
  owner: string;
  blueprint: string | null;
  /** The version that runs; null until one is made current. */
  currentVersion: number | null;
  /** The version up for review, if any. */
  pendingVersion: number | null;
  createdAt: string;
}

/** One committed version of an App. */
export interface AppVersion {
  app: AppId;
  version: number;
  /** The version it was committed on; null for the first. */
  parent: number | null;
  /** SHA-256 of the version's files, which identifies them exactly. */
  tree: string;
  files: number;
  /** The user who committed it. */
  author: string;
  message: string;
  createdAt: string;
}

/** An App's files by path. */
export type AppFiles = Record<string, string>;

/** How a file differs between two versions. */
export type FileDiff =
  | { path: string; change: "added"; after: string }
  | { path: string; change: "deleted"; before: string }
  | { path: string; change: "modified"; before: string; after: string };

/** An App's files and their working copy. */
export interface AppFilesApi {
  /**
   * The App's files at `version`; without one, its working copy: the
   * latest version with every change written since.
   */
  read: (app: string, version?: number) => Promise<AppFiles>;
  /** Writes changes (`FileChanges`) to the working copy. */
  write: (app: string, changes: FileChanges) => Promise<void>;
  /** Commits the working copy as the App's next version. */
  commit: (app: string, message: string) => Promise<AppVersion>;
}

/** An App's versions and which of them runs. */
export interface AppVersionsApi {
  /** The App's versions, newest first, at most 100 from before `before`. */
  list: (app: string, before?: number) => Promise<AppVersion[]>;
  get: (app: string, version: number) => Promise<AppVersion>;
  /** How the files of `to` differ from those of `from`, by path. */
  diff: (app: string, from: number, to: number) => Promise<FileDiff[]>;
  /** Puts a version up for review. */
  propose: (app: string, version: number) => Promise<App>;
  /** Makes a version the one that runs, after review or to roll back. */
  setCurrent: (app: string, version: number) => Promise<App>;
}

/** The App registry and each App's code. Admins and builders. */
export interface AppsApi {
  create: (app: NewApp) => Promise<App>;
  list: () => Promise<App[]>;
  get: (app: string) => Promise<App>;
  readonly files: AppFilesApi;
  readonly versions: AppVersionsApi;
}

/** Why a call to the App registry was refused. */
export const appErrors = defineErrorFamily({
  "app.invalid": "That isn't a valid request for an App.",
  "app.not_found": "There's no such App.",
  "app.version_not_found": "The App has no such version.",
  "app.too_large": "The App's files would be over its limits.",
  "app.nothing_to_commit": "Nothing was written since the latest version.",
  "app.conflict": "Someone else changed this App at the same time. Try again.",
  "app.not_running": "The App has no current version to run yet.",
  "app.build_failed": "The App's server code doesn't build.",
  "app.method_invalid": "The App's server has no method by that name.",
  "app.failed": "The App's server code failed.",
  "app.answer_invalid":
    "The App's server code answered with something other than plain data.",
  "app.timed_out": "The App's server code took too long to answer.",
  "app.caller_invalid":
    "Pass the caller of the App method this runs in, while that call runs.",
});

/**
 * Who calls a method of an App's server code. The platform passes it as
 * the method's first argument, from the person's session or the workflow
 * run: App code never chooses it. The App passes it on to its connections
 * (`env.OUTLOOK.call(caller, ...)`), which then act for that person;
 * `token` names this one call, and stops working when the call ends.
 */
export interface AppCaller {
  userId: string;
  /** A person is there (a screen), or a workflow runs on its own. */
  mode: "interactive" | "workflow";
  token: string;
}
