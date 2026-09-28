import type { App } from "@grasp-os/shared/apps";

import { timeoutMs, withTimeout } from "./core.ts";
import type { Session } from "./core.ts";

// Who and what a page names by ID: people and Apps, read beside the page's
// own data, only for their names. Either list may be refused (Grasp staff
// don't list members) or slow; IDs then stand in for the names, and the
// page still shows what it read. A page that decides anything by these
// lists reads them itself, and fails with them.

/** People's names and the Apps, by ID. */
export interface Directory {
  people: ReadonlyMap<string, string>;
  apps: ReadonlyMap<string, App>;
}

/**
 * How long a list read for names may take: half a page's own limit, so a
 * list that hangs costs only the names, never the page's data.
 */
const namesTimeoutMs = timeoutMs / 2;

/** What `read` lists in time, or nothing: for names only. */
export const listedOrNone = async <T>(read: Promise<T[]>): Promise<T[]> => {
  try {
    return await withTimeout(read, namesTimeoutMs);
  } catch {
    return [];
  }
};

/** People's names by ID, as far as the person may list them in time. */
export const readPeople = async (
  session: Session
): Promise<ReadonlyMap<string, string>> => {
  const members = await listedOrNone(session.members.list());
  return new Map(members.map(({ userId, name }) => [userId, name]));
};

/** Apps by ID. */
export const appsById = (apps: readonly App[]): ReadonlyMap<string, App> =>
  new Map(apps.map((app) => [app.id, app]));

/** The people and Apps the person may list in time, by ID: for names only. */
export const readDirectory = async (session: Session): Promise<Directory> => {
  const [people, apps] = await Promise.all([
    readPeople(session),
    listedOrNone(session.apps.list()),
  ]);
  return { people, apps: appsById(apps) };
};

/** A person's name, or their ID when it isn't known. */
export const personName = (directory: Directory, userId: string): string =>
  directory.people.get(userId) ?? userId;

/** An App's name, or its ID when it isn't known. */
export const appName = (directory: Directory, appId: string): string =>
  directory.apps.get(appId)?.name ?? appId;

/** A time (ISO 8601) as the viewer's locale writes it. */
export const formatTime = (iso: string): string =>
  new Date(iso).toLocaleString();
