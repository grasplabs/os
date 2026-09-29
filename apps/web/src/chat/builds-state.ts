import type { App, FileDiff, VersionReview } from "@grasp-os/shared/apps";
import type { TriggerDeclaration } from "@grasp-os/shared/workflows";

// What the side panel's "Being built" section decides (builds.tsx): pure
// logic, so tested on its own.

/** A workflow's trigger added or removed, as a version's review says. */
type TriggerChange = NonNullable<
  VersionReview["workflows"][number]["triggers"]
>[number];

/** An export added, removed or changed, as a version's review says. */
type ExportChange = VersionReview["exports"][number];

/** One changed file of a version's server code: before, and after. */
export interface ServerFile {
  path: string;
  /** As it runs now; absent for a file the version adds. */
  before?: string;
  /** As it would run once the version is current; absent once removed. */
  after?: string;
}

/** A file of a version's server code, from how the version changes it. */
export const serverFileOf = (file: FileDiff): ServerFile => ({
  path: file.path,
  ...(file.change === "added" ? {} : { before: file.before }),
  ...(file.change === "deleted" ? {} : { after: file.after }),
});

/** How the panel labels a server file and each of its blocks. */
export interface ServerFileLabels {
  summary: string;
  before: string;
  after: string;
}

/** A server file's labels: what runs now, and what would after approval. */
export const serverFileLabels = ({
  path,
  after,
}: ServerFile): ServerFileLabels => ({
  summary:
    after === undefined
      ? `${path}, which would no longer run`
      : `${path}, as it would run`,
  before: "Runs now",
  after: "Would run after approval",
});

/** Something read from core: loaded, or why not; undefined while it loads. */
type Read = { state: string } | undefined;

/**
 * Whether a version may be made current from the panel: once its review
 * has loaded, and, when its server code changed, every changed server
 * file's code has too. Never while any of it is loading or failed.
 */
export const readyToMakeCurrent = (
  review: Read,
  serverChanged: boolean,
  serverCode?: Read
): boolean =>
  review?.state === "ready" &&
  (!serverChanged || serverCode?.state === "ready");

/** A version of an App, as the panel keys what it made current. */
export const versionKey = (app: string, version: number): string =>
  `${app}:${version}`;

/**
 * What the panel still remembers having made current, once a fresh read
 * lists `apps`: only those still listed as pending (the read may predate
 * the change). One no longer pending is forgotten, so the same version
 * put up for review again later (after a rollback, say) shows again.
 */
export const stillMadeCurrent = (
  madeCurrent: ReadonlySet<string>,
  apps: readonly App[]
): ReadonlySet<string> => {
  const pending = new Set(
    apps.flatMap(({ id, pendingVersion }) =>
      pendingVersion === null ? [] : [versionKey(id, pendingVersion)]
    )
  );
  return new Set([...madeCurrent].filter((key) => pending.has(key)));
};

/**
 * The Apps with a version up for review to show: all but those the panel
 * made current itself (`madeCurrent`, by `versionKey`), which go at once,
 * before the next read says so, whatever the agent is doing.
 */
export const pendingToShow = (
  apps: readonly App[],
  madeCurrent: ReadonlySet<string>
): (App & { pendingVersion: number })[] =>
  apps.flatMap((app) =>
    app.pendingVersion === null ||
    madeCurrent.has(versionKey(app.id, app.pendingVersion))
      ? []
      : [{ ...app, pendingVersion: app.pendingVersion }]
  );

/** What makes a workflow run on its own, in a reviewer's words. */
export const triggerText = (trigger: TriggerDeclaration): string => {
  if (trigger.type === "manual") {
    return "when someone starts it";
  }
  if (trigger.type === "schedule") {
    const zone = trigger.timeZone === undefined ? "" : `, ${trigger.timeZone}`;
    return `on a schedule (its parameter ${trigger.param}${zone})`;
  }
  if (trigger.type === "event") {
    // No filter, or an empty one: every such event.
    const filtered =
      trigger.filter !== undefined && Object.keys(trigger.filter).length > 0;
    return filtered
      ? `on the event ${trigger.event}, filtered`
      : `on every ${trigger.event} event`;
  }
  return `on mail to ${trigger.address}@`;
};

/** How many times, as the panel says it: nothing for once. */
const timesText = (count: number): string =>
  count === 1 ? "once" : `${count} times`;

/**
 * A workflow's trigger change, as the panel says it, from how many of
 * that trigger it had before and has after: only "no longer" once none
 * are left, and only "now" where there were none.
 */
export const triggerChangeText = ({
  trigger,
  count,
  countBefore,
  countAfter,
}: TriggerChange): string => {
  const how = triggerText(trigger);
  if (countBefore === 0) {
    return countAfter === 1
      ? `Now runs ${how}`
      : `Now runs ${how}, ${timesText(countAfter)}`;
  }
  if (countAfter === 0) {
    return `No longer runs ${how}`;
  }
  const more = countAfter > countBefore;
  return `Runs ${how} ${count} ${more ? "more" : "fewer"} ${count === 1 ? "time" : "times"} (${timesText(countAfter)} now)`;
};

/** What an export lets another App do, in a reviewer's words. */
const accessWords = {
  read: "reads the App's data",
  write: "changes the App's data",
} as const;

/**
 * An export's change, as the panel says it, and whether it opens more to
 * other Apps (`widens`: a new export that changes data, or one that only
 * read and now changes data), which the panel highlights.
 */
export const exportChangeText = ({
  name,
  change,
  access,
  accessBefore,
}: ExportChange): { text: string; widens: boolean } => {
  if (change === "added") {
    const does = access === null ? "" : `, which ${accessWords[access]}`;
    return {
      text: `Other Apps may now call ${name}${does}`,
      widens: access === "write",
    };
  }
  if (change === "removed") {
    return { text: `Other Apps may no longer call ${name}`, widens: false };
  }
  if (accessBefore === "read" && access === "write") {
    return {
      text: `${name} now changes the App's data (read → write)`,
      widens: true,
    };
  }
  if (accessBefore === "write" && access === "read") {
    return {
      text: `${name} no longer changes the App's data (write → read)`,
      widens: false,
    };
  }
  const does = access === null ? "" : `: it ${accessWords[access]}`;
  return { text: `${name} changed${does}`, widens: false };
};
