import { collectionIdSchema } from "@grasp-os/shared/ids";
import type { CollectionId } from "@grasp-os/shared/ids";
import { isAdmin } from "@grasp-os/shared/roles";
import { and, ne, or } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";

import { appsFoundBy, appsReadableBy } from "../app-access.ts";
import type { Person } from "../app-access.ts";
import { memberOf } from "../auth/identity.ts";
import { apps } from "../db/core/schema.ts";
import { inList } from "../db/d1.ts";
import { collections, documents } from "../db/knowledge/schema.ts";
import { collectionsAllowed } from "./access.ts";
import type { Reader } from "./access.ts";

// Who finds what in the Apps collection (apps-collection.ts): one entry
// per App, found exactly by those who may open the App, as
// `requireAppRole` (app-access.ts) decides it: its owner and admins, and
// those it is shared with, while they may read everything it read. The
// collection is for everyone, so the rule is per document: an entry's
// path names its App, and every query that reads documents asks, in its
// own SQL, for the paths of the Apps the reader may open, read from the
// core database on the same read. Nothing of who may open an App is
// copied into Knowledge, so unsharing, a team change, a new role or a
// source the App is granted counts from the next read.
//
// The lookup is made only when a read can reach the collection: not for
// a read scoped to another collection, not for an App or agent without a
// permission to read the Apps collection (only agents are given one:
// permissions.ts `requireCollection`; an App granted it before counts it
// as a source that doesn't resolve, app-provenance.ts, so the App reaches
// nobody but its owner and admins), and not for those who may open
// every App (admins), who find every entry. Apps are never deleted, so
// every entry's App exists.

/** The Apps collection, under this ID: no other has it. */
export const appsCollectionId: CollectionId = collectionIdSchema.parse("apps");

/** Where the entry of the App `appId` is in the Apps collection. */
export const appEntryPath = (appId: string): string => `${appId}/AGENTS.md`;

/** The App whose entry is at `path`, or `undefined` if it's no entry's. */
export const appOfEntry = (path: string): string | undefined => {
  const [appId, file, ...rest] = path.split("/");
  const isEntry =
    file === "AGENTS.md" && rest.length === 0 && appId !== undefined;
  return isEntry && appId !== "" ? appId : undefined;
};

/** What a reader may read. */
export interface Allowed {
  /** The collections they may read, as a condition on `collections`. */
  collections: SQL;
  /**
   * The documents they may read, as a condition on `collections` and on
   * the column that has their path (`documents.path` unless an alias's):
   * those of `collections`, and in the Apps collection only the entries
   * of Apps they may open.
   */
  documents: (path?: SQLiteColumn) => SQL;
}

/** The person whose Apps `reader` finds; undefined once they have left. */
const personOf = async (
  env: Env,
  reader: Reader
): Promise<Person | undefined> => {
  if (reader.type === "person") {
    return reader.person;
  }
  return await memberOf(env.DB, reader.authority.onBehalfOf);
};

/** The entries a reader finds: every one, or those at these paths. */
type Found = "every" | readonly string[];

/** The entries `person` finds: those of the Apps they may open. */
const foundBy = async (env: Env, person: Person): Promise<Found> => {
  // Who may open every App (as `appFor` decides it), whatever it read.
  if (isAdmin(person.role)) {
    return "every";
  }
  const rows = await drizzle(env.DB)
    .select({ id: apps.id })
    .from(apps)
    .where(appsFoundBy(env, person));
  const ids = rows.map(({ id }) => id);
  const open = await appsReadableBy(env, person, ids);
  return ids.filter((id) => open.has(id)).map(appEntryPath);
};

/**
 * What `reader` may read: the collections of `allowedCollections`, and of
 * their documents, those `Allowed.documents` says. Every query that reads
 * documents, their versions, sections or links uses `documents`. A read
 * of one collection passes it as `scope`: of any other, it finds no entry,
 * and asks nothing of the core database.
 */
export const allowedFor = async (
  env: Env,
  db: DrizzleD1Database,
  reader: Reader,
  scope?: unknown
): Promise<Allowed> => {
  const { condition: allowed, granted } = await collectionsAllowed(
    env,
    db,
    reader
  );
  const reaches =
    (scope === undefined || scope === appsCollectionId) &&
    (granted === undefined || granted.includes(appsCollectionId));
  const person = reaches ? await personOf(env, reader) : undefined;
  const found: Found = person ? await foundBy(env, person) : [];
  return {
    collections: allowed,
    documents: (path = documents.path) => {
      if (found === "every") {
        return allowed;
      }
      const notAnEntry = ne(collections.source, "apps");
      const entries =
        found.length === 0 ? notAnEntry : or(notAnEntry, inList(path, found));
      return and(allowed, entries) ?? allowed;
    },
  };
};
