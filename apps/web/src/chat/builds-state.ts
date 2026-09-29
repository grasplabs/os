import type { App, FileDiff } from "@grasp-os/shared/apps";

// What the side panel's "Being built" section decides (builds.tsx): pure
// logic, so tested on its own.

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
