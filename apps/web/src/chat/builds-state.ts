import type { App, FileDiff, VersionReview } from "@grasp-os/shared/apps";
import type { ChatDraft } from "@grasp-os/shared/chat";
import { screenPath } from "@grasp-os/shared/screens";
import type { TriggerDeclaration } from "@grasp-os/shared/workflows";
import { i18n } from "@lingui/core";
import { msg, plural } from "@lingui/core/macro";

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
      ? i18n._(msg`${path}, which would no longer run`)
      : i18n._(msg`${path}, as it would run`),
  before: i18n._(msg`Runs now`),
  after: i18n._(msg`Would run after approval`),
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
    return i18n._(msg`when someone starts it`);
  }
  if (trigger.type === "schedule") {
    const { param, timeZone } = trigger;
    return timeZone === undefined
      ? i18n._(msg`on a schedule (its parameter ${param})`)
      : i18n._(msg`on a schedule (its parameter ${param}, ${timeZone})`);
  }
  if (trigger.type === "event") {
    const { event } = trigger;
    // No filter, or an empty one: every such event.
    const filtered =
      trigger.filter !== undefined && Object.keys(trigger.filter).length > 0;
    return filtered
      ? i18n._(msg`on the event ${event}, filtered`)
      : i18n._(msg`on every ${event} event`);
  }
  const { address } = trigger;
  return i18n._(msg`on mail to ${address}@`);
};

/** How many times, as the panel says it: nothing for once. */
const timesText = (count: number): string =>
  i18n._(msg`${plural(count, { one: "once", other: "# times" })}`);

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
    const times = timesText(countAfter);
    return countAfter === 1
      ? i18n._(msg`Now runs ${how}`)
      : i18n._(msg`Now runs ${how}, ${times}`);
  }
  if (countAfter === 0) {
    return i18n._(msg`No longer runs ${how}`);
  }
  const now = timesText(countAfter);
  return countAfter > countBefore
    ? i18n._(
        msg`Runs ${how} ${plural(count, { one: "# more time", other: "# more times" })} (${now} now)`
      )
    : i18n._(
        msg`Runs ${how} ${plural(count, { one: "# fewer time", other: "# fewer times" })} (${now} now)`
      );
};

/** What an export lets another App do, in a reviewer's words. */
const accessWords = {
  read: msg`reads the App's data`,
  write: msg`changes the App's data`,
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
    const does = access === null ? undefined : i18n._(accessWords[access]);
    return {
      text:
        does === undefined
          ? i18n._(msg`Other Apps may now call ${name}`)
          : i18n._(msg`Other Apps may now call ${name}, which ${does}`),
      widens: access === "write",
    };
  }
  if (change === "removed") {
    return {
      text: i18n._(msg`Other Apps may no longer call ${name}`),
      widens: false,
    };
  }
  if (accessBefore === "read" && access === "write") {
    return {
      text: i18n._(msg`${name} now changes the App's data (read → write)`),
      widens: true,
    };
  }
  if (accessBefore === "write" && access === "read") {
    return {
      text: i18n._(
        msg`${name} no longer changes the App's data (write → read)`
      ),
      widens: false,
    };
  }
  const does = access === null ? undefined : i18n._(accessWords[access]);
  return {
    text:
      does === undefined
        ? i18n._(msg`${name} changed`)
        : i18n._(msg`${name} changed: it ${does}`),
    widens: false,
  };
};

/**
 * The screens a draft changes and still has (its `changed` paths, less
 * the ones it deletes), by name, in order: a deleted screen has nothing
 * to preview.
 */
export const changedScreens = ({
  changed,
  deleted,
}: Pick<ChatDraft, "changed" | "deleted">): string[] =>
  changed.flatMap((path) => {
    const name = screenPath.exec(path)?.groups?.name;
    return name === undefined || deleted.includes(path) ? [] : [name];
  });

/**
 * The screen a draft's preview shows: the one the person picked while the
 * draft still changes it, otherwise the first it changes; none when it
 * changes no screen, or only deletes some (core then shows the draft's
 * first).
 */
export const previewedScreen = (
  changed: readonly string[],
  picked?: string
): string | undefined =>
  picked !== undefined && changed.includes(picked) ? picked : changed[0];
