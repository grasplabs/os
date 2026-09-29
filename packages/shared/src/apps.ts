import { z } from "zod";

import { appLimits } from "./app-limits.ts";
import { defineErrorFamily } from "./errors.ts";
import { collectionIdSchema, identifierSchema } from "./ids.ts";
import type { AppId } from "./ids.ts";
import { recordTypeNameSchema } from "./knowledge.ts";
import type { Permission } from "./permissions.ts";
import type { TriggerDeclaration } from "./workflows.ts";

// An App's code is a tree of text files, versioned as a whole: builders
// write files into the App's working copy and commit it as the next
// version; the chat's agent, for a builder, writes into a draft of its
// chat's own instead. Versions never change once committed.
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
  /**
   * A label for what the App was made from, as its creator gives it,
   * unchecked. An App made from a blueprint (`AppBlueprintsApi.create`)
   * gets `<app>@<version>` instead.
   */
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

/**
 * The owner of the built-in blueprints' Apps: Grasp, never a person. A
 * built-in never runs: its permissions say what the Apps created from it
 * ask for, and nobody grants or revokes them (`permission.builtin`).
 */
export const builtinOwner = "grasp";

/** An App in the registry. Times are ISO 8601. */
export interface App {
  id: AppId;
  name: string;
  description: string;
  /** The user who created it. */
  owner: string;
  /**
   * What the App was made from: `<app>@<version>` for an App made from a
   * blueprint, otherwise the label its creator gave, if any.
   */
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
  /**
   * The user who committed it, or whom the chat's agent that wrote it
   * acted for (`proposedBy`).
   */
  author: string;
  /** What changed and why, in its author's words (the agent's, too). */
  message: string;
  createdAt: string;
  /** The chat's agent that wrote and proposed it; null for a person's. */
  proposedBy: AgentProposer | null;
}

/**
 * The chat's agent, as the one that wrote a version or asked for a
 * permission: the workspace agent, the person it acted for, and the chat
 * (in that person's Workspace object) it acted in.
 */
export interface AgentProposer {
  type: "agent";
  agentId: string;
  onBehalfOf: string;
  workspaceId: string;
  chatId: string;
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

/**
 * What an App's current version offers other Apps: its exports
 * (`appExportsPath`). None while it has no current version.
 */
export interface CurrentExports {
  /** The current version; null while it has none. */
  version: number | null;
  exports: AppExports;
}

/** An App's files by path. */
export type AppFiles = Record<string, string>;

/** How a file differs between two versions. */
export type FileDiff =
  | { path: string; change: "added"; after: string }
  | { path: string; change: "deleted"; before: string }
  | { path: string; change: "modified"; before: string; after: string };

/** How something differs from the current version. */
export type ReviewChange = "added" | "modified" | "removed";

/**
 * What a version changes, as its reviewer reads it before making it
 * current (`AppVersionsApi.review`): worked out by core from the version
 * and the App as they are now, never written by whoever proposed it.
 */
export interface VersionReview {
  version: AppVersion;
  /**
   * The chat's agent that wrote it; null for a version a person
   * committed. `ownChat`: the reviewer is the person it acted for, who
   * alone gets the chat's title (a title may quote their question); null
   * for them once the chat is deleted.
   */
  proposedBy:
    | (AgentProposer & { ownChat: boolean; chatTitle: string | null })
    | null;
  /** What it is compared with: the current version; null while none is. */
  current: number | null;
  /** Its files that differ from the current version's, by path. */
  files: { path: string; change: ReviewChange }[];
  /**
   * How its server code (`app/**.ts`, as the server build reads it)
   * differs, if it does: it runs as whoever uses the App, with every
   * permission the App holds. Its files that differ are `serverFiles`.
   */
  server: ReviewChange | null;
  serverFiles: { path: string; change: ReviewChange }[];
  /**
   * Its workflows that differ from the current version's: their own files,
   * or code outside `screens/` they may import (`shared`), such as the
   * server code their steps call.
   */
  workflows: {
    id: string;
    change: ReviewChange;
    /** The changed files outside screens and its own that it may use. */
    shared: string[];
    /**
     * Its steps that differ, by name, each compared as its code is
     * written: whether each may change something outside Grasp (it says
     * so, or it calls any of the App's bindings), and the App's bindings
     * its code calls (`APP`, a connection, another App's exports). While `shared` code changed, every step is listed
     * (`sharedCode`), as any may now behave differently through it, and
     * may change things if the workflow calls bindings at all. Null when
     * the code can't be read as steps.
     */
    steps:
      | {
          name: string;
          change: ReviewChange;
          sideEffect: boolean;
          calls: string[];
          sharedCode: boolean;
        }[]
      | null;
    /** Its parameters that differ, by name; null when they can't be read. */
    params: { name: string; change: ReviewChange }[] | null;
    /**
     * Its triggers added or removed, with how many of each (identical
     * triggers each register), and how many it had before and has after:
     * what makes it run on its own, such as a schedule, an event or mail
     * to an address; null when they can't be read.
     */
    triggers:
      | {
          trigger: TriggerDeclaration;
          change: "added" | "removed";
          count: number;
          countBefore: number;
          countAfter: number;
        }[]
      | null;
    /**
     * The workflow can change something outside Grasp: any of its steps,
     * changed or not, may, or its steps can't be read at all.
     */
    sideEffect: boolean;
  }[];
  /**
   * Its exports (`app/exports.json`: the methods other Apps may call) that
   * differ, by name, with their access (`read`, or `write`: changes the
   * App's data) now and before; null where there is none.
   */
  exports: {
    name: string;
    change: ReviewChange;
    access: "read" | "write" | null;
    accessBefore: "read" | "write" | null;
  }[];
  /**
   * What the App asks for that no admin has granted yet: each waits for
   * an admin, whether the version is made current or not.
   */
  permissions: Permission[];
  /**
   * What the App holds now, which the version's code uses once current;
   * `askedAgain` for each that making it current would ask an admin for
   * again, as this reviewer can't grant it (`AppVersionsApi.setCurrent`).
   */
  grants: { permission: Permission; askedAgain: boolean }[];
  /**
   * Its workflows' tests: what making it current needs. Run once per
   * version's files, or taken from the check that proposed it.
   */
  tests: { status: "passed" | "failed" | "none"; failures: string[] };
}

/**
 * A problem a build found in an App's code: where it is, what found it,
 * how bad it is, and a fix when the check suggests one. What an agent
 * repairs from.
 */
export interface BuildDiagnostic {
  /** The App file; null when it is about the App as a whole. */
  file: string | null;
  /** 1-based; null when it is about the whole file. */
  line: number | null;
  /** 1-based, when the check knows it. */
  column?: number;
  /**
   * What found it: a TypeScript error code (`TS2322`), a lint rule
   * (`shadcn/no-restyle`), or a compiler stage (`imports`, `compile`).
   */
  rule?: string;
  severity: "error" | "warning";
  message: string;
  /** A change that would fix it, when the check suggests one. */
  fix?: string;
}

/**
 * How one build of a saved version went:
 * - `ok`: built.
 * - `failed`: it doesn't build; `diagnostics` says why.
 * - `none`: the version has no files of this kind.
 * - `pending`: not built by the time the save answered: still building
 *   after the save's wait (it lands in the background), or building on
 *   save is switched off. It builds at its first use otherwise.
 * - `error`: the build couldn't run (the compiler unreachable, or out of
 *   CPU); `error` says so. It runs again at its first use.
 */
export interface SavedBuild {
  status: "ok" | "failed" | "none" | "pending" | "error";
  diagnostics: BuildDiagnostic[];
  /** Why a build couldn't run, with `error`. */
  error?: string;
}

/** A committed version, with how its builds went (`AppFilesApi.commit`). */
export interface CommittedVersion extends AppVersion {
  builds: {
    screens: SavedBuild;
    server: SavedBuild;
    workflows: SavedBuild;
  };
}

/** An App's files and their working copy. */
export interface AppFilesApi {
  /**
   * The App's files at `version`; without one, its working copy: the
   * latest version with every change written since.
   */
  read: (app: string, version?: number) => Promise<AppFiles>;
  /** Writes changes (`FileChanges`) to the working copy. */
  write: (app: string, changes: FileChanges) => Promise<void>;
  /**
   * Commits the working copy as the App's next version, and starts its
   * screen, server and workflow builds at once, so the version opens
   * without building. Answers with how they went (`builds`) once they are
   * done, or after a few seconds with those still building as `pending`
   * (all three `pending` while `build_on_save` is off).
   * A build never fails or holds up the commit. Exports that aren't
   * valid (`appExportsPath`) do: the commit is refused with
   * `app.exports_invalid`, naming the issues; and so do record types
   * that aren't (`appRecordTypesPath`), with `app.records_invalid`.
   */
  commit: (app: string, message: string) => Promise<CommittedVersion>;
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
  /**
   * What a version changes against the current one (`VersionReview`),
   * for its builders to review before they make it current.
   */
  review: (app: string, version: number) => Promise<VersionReview>;
  /**
   * Makes a version the one that runs, after review or to roll back. By
   * anyone but one of the organization's admins (Grasp staff too, and a
   * rollback too), it asks again for the App's permissions on a
   * connection, to write a collection, to start a workflow or to call
   * another App's exports other than all those marked `read`: they allow
   * nothing until an admin grants them again, which approves the version
   * they reviewed (`PermissionsApi.grant`). Code of a version no admin approved changes
   * nothing, in a run that started on it too. Not for the first version
   * of an App created from a blueprint, made current for the first time:
   * it existed and was immutable when an admin granted its requests.
   */
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
 * A version of an App its builders marked as a blueprint: whoever has a
 * role in the App, and builds, can create an App of their own from it.
 * Times are ISO 8601.
 */
export interface Blueprint {
  app: AppId;
  /** The App's name and description now. */
  name: string;
  description: string;
  version: number;
  markedBy: string;
  markedAt: string;
}

/** What a builder gives to create an App from a blueprint. */
export const fromBlueprintSchema = newAppSchema.pick({
  name: true,
  description: true,
});
export type FromBlueprint = z.input<typeof fromBlueprintSchema>;

/**
 * An App created from a blueprint: its first version holds the code at
 * the blueprint's version, but for its AGENTS.md, a stub naming the
 * blueprint (the blueprint's was written from what its App read, which
 * the copy may not have read), and `permissions` are requests, waiting for an
 * admin, for the connections, collections, workflows and other Apps'
 * exports the blueprint's App was given or asked for, but for someone
 * else's personal connections, which only their owner's calls could use,
 * and connections connect doesn't know (`dropped`), and the workflows and
 * exports of Apps its creator has no role in, which they couldn't ask for
 * themselves (`droppedApps`): a copy never names an App its creator can't
 * see. While calls between Apps are switched off, any App's exports are
 * dropped too. Nothing else comes with it: no data, no settings, no runs,
 * no members.
 */
export interface CreatedFromBlueprint {
  app: App;
  version: AppVersion;
  permissions: Permission[];
  /** The connections, by binding, it doesn't ask for. */
  dropped: { connectionId: string; binding: string }[];
  /**
   * The workflows and exports of other Apps, by binding, it doesn't ask
   * for; never naming the App.
   */
  droppedApps: { type: "workflow" | "app"; binding: string }[];
}

/** Blueprints: App versions to create Apps from. */
export interface AppBlueprintsApi {
  /** The blueprints of the Apps the person has a role in, newest first. */
  list: () => Promise<Blueprint[]>;
  /** Marks a version of the App as a blueprint. Its builders. */
  mark: (app: string, version: number) => Promise<Blueprint>;
  /** Stops offering a version as a blueprint. Its builders. */
  unmark: (app: string, version: number) => Promise<void>;
  /** Creates an App of the person's own from a blueprint. */
  create: (
    app: string,
    version: number,
    input: FromBlueprint
  ) => Promise<CreatedFromBlueprint>;
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
  /**
   * What the App's current version exports to other Apps: read from its
   * version alone, for anyone with a role in the App. Refused with
   * `feature.disabled` while calls between Apps are off.
   */
  exports: (app: string) => Promise<CurrentExports>;
  readonly files: AppFilesApi;
  readonly versions: AppVersionsApi;
  readonly members: AppMembersApi;
  readonly blueprints: AppBlueprintsApi;
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
  "app.blueprint_not_found": "That version of the App isn't a blueprint.",
  "app.version_not_found": "The App has no such version.",
  "app.too_large": "The App's files would be over its limits.",
  "app.nothing_to_commit": "Nothing was written since the latest version.",
  "app.exports_invalid":
    "The App's exports (app/exports.json) aren't valid, so it can't be committed.",
  "app.records_invalid":
    "The App's record types (app/records.json) aren't valid, so it can't be committed.",
  "app.export_not_found":
    "The App doesn't export that method: it never did, or its current version no longer does.",
  "app.call_invalid":
    "That input doesn't match what the App's export takes, or isn't JSON.",
  "app.call_too_large":
    "The input or the answer of a call to another App is too large.",
  "app.call_cycle":
    "An App can't call an App whose call is already under way in this one.",
  "app.call_too_deep": "Too many Apps call one another in this one call.",
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
  "app.checks_exhausted":
    "This draft failed its checks too many times in a row this turn. Stop, and tell the person what still fails.",
  "app.builds_unfinished":
    "This draft's builds didn't finish in time too many times this turn. Tell the person it couldn't be checked now.",
  "app.dry_runs_exhausted":
    "This draft has had as many dry runs as one question may. Tell the person what you found.",
  "app.creates_exhausted":
    "This chat created as many Apps as one question may. Tell the person what you made.",
  "app.no_draft": "This chat has no draft of that App to preview.",
  "app.preview_outdated":
    "The draft changed since this preview loaded it. Load the preview again.",
  "app.preview_side_effect":
    "A preview changes nothing and reaches nothing outside it: no connections, no other Apps, no workflows and no writes to Knowledge.",
});

/**
 * Names an App's server class may have that aren't methods core calls:
 * the ones the Durable Object runtime, RPC or `Object` give a meaning of
 * their own. Core refuses them (`App.call`), and the workflow SDK's typed
 * stub of the App leaves them out (`appServer`).
 */
export const reservedAppMethods = [
  "alarm",
  "connect",
  "constructor",
  "delete",
  "dup",
  "fetch",
  "get",
  "hasOwnProperty",
  "id",
  "isPrototypeOf",
  "name",
  "propertyIsEnumerable",
  "put",
  "queue",
  "scheduled",
  "then",
  "toLocaleString",
  "toString",
  "valueOf",
  "webSocketClose",
  "webSocketError",
  "webSocketMessage",
] as const;

/** A name core refuses to call as an App's method (`reservedAppMethods`). */
export type ReservedAppMethod = (typeof reservedAppMethods)[number];

/**
 * A name core calls as an App's method: an identifier that starts with a
 * lowercase letter, of at most 64 letters and digits, and not reserved.
 */
export const appMethodPattern = /^[a-z][A-Za-z0-9]{0,63}$/u;

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
  /**
   * For a call from another App, through one of its exports: that App,
   * and the version of its code that called. The call works for anyone
   * using that App, under its permission on this App's exports; whether
   * `userId` has a role in this App isn't checked.
   */
  app?: { id: string; version: number };
}

// Exports: the methods of an App's server code that other Apps may call,
// under a permission an admin grants (an `app` object, permissions.ts). An
// App declares them in one file of its code, so they are versioned with
// it: what a version exports never changes, and removing or changing an
// export takes a new version. Core reads them as the version is committed,
// never by running the code.

/** Where an App declares its exports. */
export const appExportsPath = "app/exports.json";

/** Most exports one App declares. */
export const appMaxExports = 64;

/** Most characters of an App's exports file. */
export const appExportsMaxLength = 64_000;

/**
 * The limits of a call to another App's export. The input and the answer
 * are JSON, measured in bytes of UTF-8 as sent: an answer fits a workflow
 * step's result. One call may lead to more (the called App calling
 * another), at most `depth` calls deep, so 3 hops, 4 Apps: A calls B, B
 * calls C, C calls D, and D calls no further. Never back into an App
 * already in it; all of them end by the time the first one must.
 */
export const appCallLimits = {
  inputBytes: 256 * 1024,
  answerBytes: 1024 * 1024,
  depth: 3,
} as const;

/**
 * Names no export has: those core refuses as an App's method, `read` and
 * `write`, which a permission's actions mean as all exports so marked (so
 * a grant of `read` never names an export marked `write`), and `toJSON`,
 * which the workflow SDK's typed stub leaves out (`appExports`).
 */
const reservedExportNames: ReadonlySet<string> = new Set([
  ...reservedAppMethods,
  "read",
  "write",
  "toJSON",
]);

/**
 * Whether `name` may be an export's (a method core calls, by
 * `appMethodPattern`, and none of `reservedExportNames`): what an export,
 * and a permission's action naming one, may be called.
 */
export const isExportName = (name: string): boolean =>
  appMethodPattern.test(name) && !reservedExportNames.has(name);

// The JSON Schema an export's input and answer may be written in: the
// keywords Zod enforces (`z.fromJSONSchema`), and only those, so the App
// that exports never believes a bound holds that core doesn't check (a
// `minItems` without `items`, say, or `allOf`, which Zod reads and
// ignores). No `pattern`, `patternProperties` or `format`: each would be
// a regular expression the exporting App's builders wrote, run by core on
// the input another App sends, where one written to backtrack takes
// seconds for a few dozen characters. No `$ref` either: a schema is a
// tree, of at most `jsonSchemaMaxDepth` levels.

/** Keywords any schema may have: what it says of itself, and choices. */
const commonKeywords = [
  "type",
  "title",
  "description",
  "default",
  "examples",
  "enum",
  "const",
  "anyOf",
  "oneOf",
] as const;

/** Keywords Zod enforces for each type, besides the common ones. */
const keywordsByType: Readonly<Record<string, readonly string[]>> = {
  string: ["minLength", "maxLength"],
  number: [
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "multipleOf",
  ],
  integer: [
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "multipleOf",
  ],
  boolean: [],
  null: [],
  object: ["properties", "required", "additionalProperties"],
  // `items` is required of an array: without it, Zod checks no bound.
  array: ["items", "minItems", "maxItems"],
};

/** Most levels one schema nests. */
const jsonSchemaMaxDepth = 16;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The schemas `schema` holds, each by its path. */
const nestedSchemas = (
  schema: Record<string, unknown>,
  path: string
): Map<string, unknown> => {
  const { properties, items, additionalProperties, anyOf, oneOf } = schema;
  const nested = new Map<string, unknown>();
  if (isRecord(properties)) {
    for (const [name, of] of Object.entries(properties)) {
      nested.set(`${path}.properties.${name}`, of);
    }
  }
  if (items !== undefined) {
    nested.set(`${path}.items`, items);
  }
  if (isRecord(additionalProperties)) {
    nested.set(`${path}.additionalProperties`, additionalProperties);
  }
  for (const [keyword, choices] of [
    ["anyOf", anyOf],
    ["oneOf", oneOf],
  ] as const) {
    if (Array.isArray(choices)) {
      for (const [at, of] of choices.entries()) {
        nested.set(`${path}.${keyword}.${at}`, of);
      }
    }
  }
  return nested;
};

/** What's wrong with an object's `properties` and `required`. */
const propertyIssues = (
  { properties, required }: Record<string, unknown>,
  path: string
): string[] => {
  const issues: string[] = [];
  if (properties !== undefined && !isRecord(properties)) {
    issues.push(`${path}.properties: An object of schemas`);
  }
  const named = isRecord(properties) ? Object.keys(properties) : [];
  const namesProperties =
    Array.isArray(required) &&
    required.every((name) => typeof name === "string" && named.includes(name));
  if (required !== undefined && !namesProperties) {
    issues.push(`${path}.required: Names of its properties`);
  }
  return issues;
};

/**
 * What's wrong with `schema` as an export's JSON Schema, at `path`: each
 * keyword Zod wouldn't enforce, and each nested schema's too. None when
 * it may be used.
 */
const jsonSchemaIssues = (
  schema: unknown,
  path: string,
  depth = 0
): string[] => {
  if (!isRecord(schema)) {
    return [`${path}: A schema is an object`];
  }
  if (depth > jsonSchemaMaxDepth) {
    return [`${path}: At most ${jsonSchemaMaxDepth} levels deep`];
  }
  const { type } = schema;
  if (
    type !== undefined &&
    !(typeof type === "string" && Object.hasOwn(keywordsByType, type))
  ) {
    return [`${path}.type: One of ${Object.keys(keywordsByType).join(", ")}`];
  }
  const allowed = new Set<string>([
    ...commonKeywords,
    ...(type === undefined ? [] : (keywordsByType[type] ?? [])),
  ]);
  const forType = type === undefined ? " without a type" : ` for a ${type}`;
  const issues = Object.keys(schema).flatMap((keyword) =>
    allowed.has(keyword)
      ? []
      : [`${path}.${keyword}: Not a keyword core checks${forType}`]
  );
  if (type === "array" && schema.items === undefined) {
    issues.push(`${path}.items: An array says what its items are`);
  }
  return [
    ...issues,
    ...propertyIssues(schema, path),
    ...[...nestedSchemas(schema, path)].flatMap(([at, of]) =>
      jsonSchemaIssues(of, at, depth + 1)
    ),
  ];
};

/**
 * A JSON Schema, as an export's input or answer: only keywords Zod
 * enforces (see above), read as a schema by `z.fromJSONSchema`, which
 * core checks each call's input and answer against.
 */
const jsonSchemaSchema = z
  .record(z.string(), z.unknown())
  .superRefine((schema, context) => {
    const issues = jsonSchemaIssues(schema, "schema");
    for (const message of issues) {
      context.addIssue({ code: "custom", message });
    }
    if (issues.length > 0) {
      return;
    }
    try {
      z.fromJSONSchema(schema);
    } catch {
      context.addIssue({
        code: "custom",
        message: "A JSON Schema Zod can read (z.fromJSONSchema)",
      });
    }
  });

/**
 * One export: whether it only reads the App's data or also changes it,
 * what it does, and the JSON Schemas of its one argument and its answer.
 * A permission that allows `read` allows only the exports marked `read`.
 */
export const appExportSchema = z.strictObject({
  access: z.enum(["read", "write"]),
  description: z.string().max(appLimits.descriptionLength).default(""),
  input: jsonSchemaSchema,
  output: jsonSchemaSchema,
});
export type AppExport = z.infer<typeof appExportSchema>;

/**
 * An App's exports file (`appExportsPath`): each export by the name of the
 * server method it calls, which gets the caller first and the input
 * second, as every method does.
 *
 * ```json
 * {
 *   "findCustomers": {
 *     "access": "read",
 *     "description": "Customers whose name starts with the query",
 *     "input": { "type": "object", "properties": { "query": { "type": "string" } }, "required": ["query"] },
 *     "output": { "type": "array", "items": { "type": "object" } }
 *   }
 * }
 * ```
 */
export const appExportsSchema = z
  .record(
    z.string().refine(isExportName, {
      message:
        "A method's name: a lowercase letter, then up to 63 letters and digits, and not a reserved name",
    }),
    appExportSchema
  )
  .refine((exported) => Object.keys(exported).length <= appMaxExports, {
    message: `At most ${appMaxExports} exports`,
  });
export type AppExports = z.infer<typeof appExportsSchema>;

// Record types: the kinds of record an App keeps in a collection it may
// write, such as a workflow map's `workflow`, declared in one file of its
// code, so they are versioned with it: what a version declares never
// changes, and changing a type takes a new version, which changes it
// expand, then contract, as a schema does. A type in a collection is one
// App's: the first whose declaration took effect there, while it holds a
// permission to write there and its current version declares it (core's
// knowledge/record-types.ts). Knowledge checks every write of a record of
// the type to that collection against that App's declaration, whoever
// writes: the App, the agent, or a person editing the text. Its schema is
// JSON Schema, in the keywords an export's may use.

/** Where an App declares its record types. */
export const appRecordTypesPath = "app/records.json";

/** Most record types one App declares. */
export const appMaxRecordTypes = 32;

/** Most characters of an App's record types file. */
export const appRecordTypesMaxLength = 64_000;

/** Most fields one record type keeps. */
export const recordTypeMaxKept = 32;

/** Most methods one record type gives kept fields to. */
export const recordTypeMaxKeepers = 8;

/** A method's name, as an export's is (`isExportName`). */
const methodNameSchema = z.string().refine(isExportName, {
  message:
    "A method's name: a lowercase letter, then up to 63 letters and digits, and not a reserved name",
});

/**
 * One record type: the collection it is kept in, by ID, what it is, the
 * JSON Schema of its frontmatter (an object, in the keywords an export's
 * schemas may use), and optionally fields that only one method of the
 * App's server code sets (`kept`, a method and its fields each): its
 * record's `app` link, say, or what a snapshot froze. Every other write,
 * by a person or the agent too, keeps them as the version it goes over
 * has them. A type in a collection is one App's: the first whose
 * declaration took effect there (core's knowledge/record-types.ts).
 */
export const appRecordTypeSchema = z
  .strictObject({
    collection: collectionIdSchema,
    description: z.string().max(appLimits.descriptionLength).default(""),
    schema: jsonSchemaSchema.refine((schema) => schema.type === "object", {
      message: "A record's frontmatter is an object: `type: object`",
    }),
    kept: z
      .array(
        z.strictObject({
          method: methodNameSchema,
          fields: z.array(z.string().min(1).max(64)).min(1),
        })
      )
      .max(recordTypeMaxKeepers)
      .default([]),
  })
  .superRefine(({ schema, kept }, context) => {
    const { properties } = schema;
    const declared = new Set(
      typeof properties === "object" && properties !== null
        ? Object.keys(properties)
        : []
    );
    const seen = new Set<string>();
    for (const [group, { fields }] of kept.entries()) {
      for (const [index, field] of fields.entries()) {
        const path = ["kept", group, "fields", index];
        if (!declared.has(field)) {
          context.addIssue({
            code: "custom",
            path,
            message: "A field the schema's properties declare",
          });
        }
        if (seen.has(field)) {
          context.addIssue({
            code: "custom",
            path,
            message: "Each field is kept for one method only",
          });
        }
        seen.add(field);
      }
    }
    if (seen.size > recordTypeMaxKept) {
      context.addIssue({
        code: "custom",
        path: ["kept"],
        message: `At most ${recordTypeMaxKept} kept fields`,
      });
    }
  });
export type AppRecordType = z.infer<typeof appRecordTypeSchema>;

/**
 * An App's record types file (`appRecordTypesPath`): each type by its
 * name, which is the `type` in its records' frontmatter.
 *
 * ```json
 * {
 *   "workflow": {
 *     "collection": "playbook",
 *     "description": "A workflow as it runs now, or as it should",
 *     "schema": {
 *       "type": "object",
 *       "properties": {
 *         "title": { "type": "string", "maxLength": 200 },
 *         "state": { "enum": ["drawn", "designed"] },
 *         "app": { "type": "object", "properties": { "appId": { "type": "string" } } }
 *       },
 *       "required": ["state"]
 *     },
 *     "kept": [{ "method": "link", "fields": ["app"] }]
 *   }
 * }
 * ```
 */
export const appRecordTypesSchema = z
  .record(recordTypeNameSchema, appRecordTypeSchema)
  .refine((types) => Object.keys(types).length <= appMaxRecordTypes, {
    message: `At most ${appMaxRecordTypes} record types`,
  });
export type AppRecordTypes = z.infer<typeof appRecordTypesSchema>;
