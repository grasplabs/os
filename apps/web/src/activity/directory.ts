import type { App } from "@grasp-os/shared/apps";

import { timeoutMs, withTimeout } from "../core.ts";
import type { Session } from "../core.ts";

// Who and what the Activity page names by ID: people and Apps, read beside
// the page's own data. Either list may be refused (Grasp staff don't list
// members) or slow; IDs then stand in for the names, and the page still
// shows what it read.

/** People's names and the Apps, by ID. */
export interface Directory {
  people: ReadonlyMap<string, string>;
  apps: ReadonlyMap<string, App>;
}

/**
 * How long each list may take: half the page's own limit, so a list that
 * hangs costs only the names, never the page's data.
 */
const directoryTimeoutMs = timeoutMs / 2;

/** What `read` returns in time, or nothing. */
const orNone = async <T>(read: Promise<T[]>): Promise<T[]> => {
  try {
    return await withTimeout(read, directoryTimeoutMs);
  } catch {
    return [];
  }
};

/** The people and Apps the person may list, by ID. */
export const readDirectory = async (session: Session): Promise<Directory> => {
  const [members, apps] = await Promise.all([
    orNone(session.members.list()),
    orNone(session.apps.list()),
  ]);
  return {
    people: new Map(members.map(({ userId, name }) => [userId, name])),
    apps: new Map(apps.map((app) => [app.id, app])),
  };
};

/** A person's name, or their ID when it isn't known. */
export const personName = (directory: Directory, userId: string): string =>
  directory.people.get(userId) ?? userId;

/** An App's name, or its ID when it isn't known. */
export const appName = (directory: Directory, appId: string): string =>
  directory.apps.get(appId)?.name ?? appId;
