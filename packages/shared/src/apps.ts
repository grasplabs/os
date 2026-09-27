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

/**
 * What an App's current version offers people: its screens by name (`inbox`
 * for `screens/inbox.tsx`) and its workflows by ID (`report` for
 * `workflows/report.ts`), each sorted. Empty while it has no current
 * version.
 */
export interface AppContents {
  /** The current version; null while it has none. */
  version: number | null;
  screens: string[];
  workflows: string[];
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

/**
 * A role in one App: a `user` works in its screens; a `builder` also
 * changes its code, its settings and whom it is shared with. The person's
 * role in the organization is a ceiling: someone whose role there is
 * `user` never builds, whatever an App's members say.
 */
export const appRoleSchema = z.enum(["user", "builder"]);
export type AppRole = z.infer<typeof appRoleSchema>;

/** Whom an App is shared with: a person or a team of the organization. */
export const appMemberRefSchema = z.strictObject({
  type: z.enum(["person", "team"]),
  id: identifierSchema,
});
export type AppMemberRef = z.infer<typeof appMemberRefSchema>;

/** Sharing an App with someone, or changing their role in it. */
export const newAppMemberSchema = z.strictObject({
  ...appMemberRefSchema.shape,
  role: appRoleSchema,
});
export type NewAppMember = z.input<typeof newAppMemberSchema>;

/** Someone an App is shared with. Times are ISO 8601. */
export interface AppMember extends AppMemberRef {
  /** The person's or team's name; null once they are gone. */
  name: string | null;
  role: AppRole;
  /** Who shared it with them, or last changed their role. */
  addedBy: string;
  addedAt: string;
}

/**
 * Whom an App is shared with. Apps are private: open to their owner
 * (always a builder, and not listed here), to the organization's admins,
 * who manage every App, and to the people and teams they are shared
 * with. Anyone with a role in the App lists them; its builders change
 * them.
 */
export interface AppMembersApi {
  list: (app: string) => Promise<AppMember[]>;
  /**
   * Shares the App, or changes the role of someone it is shared with.
   * Refused with `app.share_unreadable`, naming the `sources` and `people`
   * in its details, when the App has read data (from someone's personal
   * connection, or a collection they can't read) that anyone it would reach
   * can't read where it comes from.
   */
  add: (app: string, member: NewAppMember) => Promise<AppMember>;
  /**
   * Stops sharing the App with them. Their open screens of it stop at
   * once, or within a few seconds, as every push checks their role again.
   */
  remove: (app: string, member: AppMemberRef) => Promise<void>;
}

/**
 * The App registry and each App's code. An App is open to its owner, the
 * organization's admins and the people and teams it is shared with
 * (`members`): its users call what its screens use, its builders the
 * rest.
 */
export interface AppsApi {
  create: (app: NewApp) => Promise<App>;
  /** The Apps the person has a role in, oldest first. */
  list: () => Promise<App[]>;
  get: (app: string) => Promise<App>;
  /** The screens and workflows of the App's current version. */
  contents: (app: string) => Promise<AppContents>;
  readonly files: AppFilesApi;
  readonly versions: AppVersionsApi;
  readonly members: AppMembersApi;
}

/** Why a call to the App registry was refused. */
export const appErrors = defineErrorFamily({
  "app.invalid": "That isn't a valid request for an App.",
  "app.not_found": "There's no such App.",
  "app.member_invalid": "The App can't be shared with them like that.",
  "app.share_unreadable":
    "This App has read data they can't read where it comes from, such as someone else's mailbox or a collection they can't read, so it can't be shared with them.",
  "app.unreadable":
    "This App has read data you can't read where it comes from, so it isn't open to you. Ask whoever shared it.",
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
  /**
   * For a workflow run's step: that step's idempotency key. The App's
   * connection calls for this caller take this key and no other
   * (`env.OUTLOOK.call(caller, action, input, { idempotencyKey:
   * caller.idempotencyKey })`), so a side effect happens once per step
   * and run however often the step is retried.
   */
  idempotencyKey?: string;
}
