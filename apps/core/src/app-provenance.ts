import { connectionOwnersMax } from "@grasp-os/shared/connect";
import type { ConnectionOwner } from "@grasp-os/shared/connect";
import type { AppId } from "@grasp-os/shared/ids";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { permissions } from "./db/core/schema.ts";
import { inList } from "./db/d1.ts";
import { collectionTeams, collections } from "./db/knowledge/schema.ts";
import { mayRead } from "./knowledge/access.ts";
import type { CollectionAccess, PersonAccess } from "./knowledge/access.ts";

// Provenance on sharing. An App keeps what it reads (in its storage, its
// workflows' state, what its screens show), so sharing it must not reach
// anyone who couldn't read that where it comes from.
//
// What an App may have read: every connection it was ever granted, and
// every collection it was ever granted to read. Once granted counts for
// good, revoked or not: the App may still hold what it read. Who may read
// each: a personal connection (such as a mailbox) only its owner; a shared
// connection everyone in the organization, who may all use it; a
// collection whoever Knowledge lets read it now (`mayRead`, the rule of
// knowledge/access.ts), so a collection whose access narrows reaches fewer
// people from then on. Sources that no longer exist are left out.
//
// The sources are read once, and each person is decided in memory
// (`unreadableBy`), so checking a whole team costs a few queries, not a
// few per person.
//
// Sharing an App with a person, or with a team (each of its people now),
// is refused when anyone it would reach can't read one of its sources
// (app-members.ts). The same check runs on every call of someone whose
// role in the App comes from whom it is shared with (app-access.ts), so a
// person who joins a team later, or a source the App is granted after it
// was shared, reaches nobody who can't read it. The App's owner and the
// organization's admins aren't checked: they manage the App whatever it
// read.

/** A source as the audit log and refusals name it. */
const sourceId = (type: "connection" | "collection", id: string): string =>
  `${type}:${id}`;

/** What an App may have read, as `sourcesOf` finds it. */
export interface AppSources {
  connections: ConnectionOwner[];
  collections: (CollectionAccess & { id: string })[];
}

const actionsSchema = z.array(z.string());

/** Whose each connection is, from connect, a page of IDs at a time. */
const ownersOf = async (
  env: Env,
  ids: string[]
): Promise<ConnectionOwner[]> => {
  const pages: string[][] = [];
  for (let start = 0; start < ids.length; start += connectionOwnersMax) {
    pages.push(ids.slice(start, start + connectionOwnersMax));
  }
  const owners = await Promise.all(
    pages.map(async (page) => await env.CONNECT.connectionOwners(page))
  );
  return owners.flat();
};

/** Who may read each of the collections `ids` now, as `mayRead` needs it. */
const accessOf = async (
  env: Env,
  ids: string[]
): Promise<AppSources["collections"]> => {
  const db = drizzle(env.KNOWLEDGE);
  const [rows, shared] = await db.batch([
    db
      .select({
        id: collections.id,
        access: collections.access,
        owner: collections.owner,
      })
      .from(collections)
      .where(inList(collections.id, ids)),
    db
      .select()
      .from(collectionTeams)
      .where(inList(collectionTeams.collectionId, ids)),
  ]);
  return rows.map((row) => ({
    ...row,
    teamIds: shared
      .filter(({ collectionId }) => collectionId === row.id)
      .map(({ teamId }) => teamId),
  }));
};

/** The sources `app` may have read, as they are now. */
export const sourcesOf = async (env: Env, app: AppId): Promise<AppSources> => {
  const rows = await drizzle(env.DB)
    .select({
      type: permissions.objectType,
      id: permissions.objectId,
      actions: permissions.actions,
    })
    .from(permissions)
    .where(
      and(
        eq(permissions.subjectType, "app"),
        eq(permissions.subjectId, app),
        isNotNull(permissions.grantedAt),
        inArray(permissions.objectType, ["connection", "collection"])
      )
    );
  const connectionIds = new Set<string>();
  const collectionIds = new Set<string>();
  for (const { type, id, actions } of rows) {
    if (type === "connection") {
      connectionIds.add(id);
    } else if (actionsSchema.parse(JSON.parse(actions)).includes("read")) {
      collectionIds.add(id);
    }
  }
  const [connections, readable] = await Promise.all([
    connectionIds.size === 0 ? [] : ownersOf(env, [...connectionIds]),
    collectionIds.size === 0 ? [] : accessOf(env, [...collectionIds]),
  ]);
  return { connections, collections: readable };
};

/** Whether an App has read from anything at all. */
export const hasSources = (sources: AppSources): boolean =>
  sources.connections.length > 0 || sources.collections.length > 0;

/**
 * The sources in `sources` that `reader` can't read, as
 * `connection:<id>` and `collection:<id>`; none when they may read all.
 */
export const unreadableBy = (
  sources: AppSources,
  reader: PersonAccess
): string[] => [
  ...sources.connections.flatMap(({ id, ownerUserId }) =>
    ownerUserId === null || ownerUserId === reader.userId
      ? []
      : [sourceId("connection", id)]
  ),
  ...sources.collections.flatMap((collection) =>
    mayRead(reader, collection) ? [] : [sourceId("collection", collection.id)]
  ),
];
