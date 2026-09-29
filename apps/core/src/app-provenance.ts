import type { ConnectionOwner } from "@grasp-os/shared/connect";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import { and, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { connectionOwnersOf } from "./connections.ts";
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
// every collection it was ever granted to read; and, through calls between
// Apps, what the Apps it was ever granted to call may have read (their
// answers carry it), and what the Apps ever granted to write into it may
// have read (their input carries it), whatever the depth
// (`reachedThroughCalls`). Once granted counts for
// good, revoked or not: the App may still hold what it read. Who may read
// each: a personal connection (such as a mailbox) only its owner; a shared
// connection everyone in the organization, who may all use it; a
// collection whoever Knowledge lets read it now (`mayRead`, the rule of
// knowledge/access.ts), so a collection whose access narrows reaches fewer
// people from then on. A granted source that doesn't resolve (connect
// doesn't know the connection, Knowledge has no such collection) fails
// closed: nobody reads it but the App's owner and admins, who aren't
// checked, since what the App read of it can't be placed. So does the
// Apps collection: it is open to everyone, but Knowledge shows each entry
// only to whoever may open its App, so its access says nothing of what
// the App read there. No App is given it now (permissions.ts
// `requireCollection`); one granted it before counts it unresolved.
//
// An App's code is treated as free of provenance, but for its AGENTS.md:
// that is written from what the App's agents read, and is read only by
// those who may open the App (its builders, and its users through the
// Apps collection), so it is under the App's sources like its data. Any
// other file is taken to hold no data, which nothing checks: builders
// must not put data into code. A blueprint copy (app-blueprints.ts)
// doesn't inherit its source's provenance: it has no sources until an
// admin grants its requests, and its code is the source's, which is why
// its AGENTS.md isn't copied but starts as a stub.
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
  /** Granted sources that don't resolve, as `sourceId` names them. */
  unresolved: string[];
}

const actionsSchema = z.array(z.string());

/**
 * Who may read each of the collections `ids` now, as `mayRead` needs it.
 * The Apps collection is left out, so it doesn't resolve: its readers are
 * decided per entry, not by its access, so what an App granted it (before
 * permissions.ts refused that) read there can't be placed.
 */
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
      .where(and(inList(collections.id, ids), ne(collections.source, "apps"))),
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

/**
 * The Apps whose data each of `apps` may hold through calls between Apps
 * (app-calls.ts), itself included, following every permission on another
 * App's exports ever granted, as sources are: an App may hold what the
 * Apps it calls answered, so what they may have read; and what the Apps
 * that may write into it (any permission beyond `read`) sent it, so what
 * they may have read. Both on, whatever the depth. A few queries a level
 * of the graph, both directions at once; the permissions of an App
 * by their subject's index, and those on it by their object's.
 */
const reachedThroughCalls = async (
  env: Env,
  apps: readonly AppId[]
): Promise<Map<AppId, Set<AppId>>> => {
  const db = drizzle(env.DB);
  const holds = new Map<AppId, Set<AppId>>();
  const edge = (from: AppId, to: AppId): void => {
    holds.set(from, (holds.get(from) ?? new Set()).add(to));
  };
  const explored = new Set<AppId>();
  let frontier = [...new Set(apps)];
  const everGranted = and(
    eq(permissions.subjectType, "app"),
    eq(permissions.objectType, "app"),
    isNotNull(permissions.grantedAt)
  );
  while (frontier.length > 0) {
    for (const app of frontier) {
      explored.add(app);
    }
    // oxlint-disable-next-line no-await-in-loop -- one level at a time
    const [called, writers] = await Promise.all([
      db
        .select({ from: permissions.subjectId, to: permissions.objectId })
        .from(permissions)
        .where(and(everGranted, inList(permissions.subjectId, frontier))),
      db
        .select({ from: permissions.objectId, to: permissions.subjectId })
        .from(permissions)
        .where(
          and(
            everGranted,
            inList(permissions.objectId, frontier),
            // Anything beyond reading, as permissions.ts's changesThingsSql.
            sql`EXISTS (SELECT 1 FROM json_each(${permissions.actions}) WHERE value <> 'read')`
          )
        ),
    ]);
    const next = new Set<AppId>();
    for (const { from, to } of [...called, ...writers]) {
      const [holder, held] = [appIdSchema.parse(from), appIdSchema.parse(to)];
      edge(holder, held);
      if (!explored.has(held)) {
        next.add(held);
      }
    }
    frontier = [...next];
  }
  return new Map(
    apps.map((app) => {
      const reached = new Set<AppId>([app]);
      const queue = [app];
      for (let at = queue.shift(); at !== undefined; at = queue.shift()) {
        for (const held of holds.get(at) ?? []) {
          if (!reached.has(held)) {
            reached.add(held);
            queue.push(held);
          }
        }
      }
      return [app, reached];
    })
  );
};

/**
 * The sources each of the Apps `apps` may have read, as they are now, and
 * those of the Apps whose data they may hold through calls between Apps
 * (`reachedThroughCalls`), in a few queries whatever their number: those
 * that follow the calls, one for all their permissions, one series of
 * pages to connect for all their connections, and one Knowledge batch for
 * all their collections.
 */
export const sourcesOfApps = async (
  env: Env,
  apps: readonly AppId[]
): Promise<Map<AppId, AppSources>> => {
  const reach =
    apps.length === 0
      ? new Map<AppId, Set<AppId>>()
      : await reachedThroughCalls(env, apps);
  const all = [...new Set([...reach.values()].flatMap((of) => [...of]))];
  const rows =
    all.length === 0
      ? []
      : await drizzle(env.DB)
          .select({
            app: permissions.subjectId,
            type: permissions.objectType,
            id: permissions.objectId,
            actions: permissions.actions,
          })
          .from(permissions)
          .where(
            and(
              eq(permissions.subjectType, "app"),
              inList(permissions.subjectId, all),
              isNotNull(permissions.grantedAt),
              inArray(permissions.objectType, ["connection", "collection"])
            )
          );
  const own = new Map(
    all.map((app) => [
      app,
      { connected: new Set<string>(), read: new Set<string>() },
    ])
  );
  for (const { app, type, id, actions } of rows) {
    const of = own.get(appIdSchema.parse(app));
    if (type === "connection") {
      of?.connected.add(id);
    } else if (actionsSchema.parse(JSON.parse(actions)).includes("read")) {
      of?.read.add(id);
    }
  }
  const granted = new Map(
    apps.map((app) => {
      const reached = [...(reach.get(app) ?? [app])];
      return [
        app,
        {
          connected: new Set(
            reached.flatMap((of) => [...(own.get(of)?.connected ?? [])])
          ),
          read: new Set(
            reached.flatMap((of) => [...(own.get(of)?.read ?? [])])
          ),
        },
      ];
    })
  );
  const connectionIds = [
    ...new Set(
      [...granted.values()].flatMap(({ connected }) => [...connected])
    ),
  ];
  const collectionIds = [
    ...new Set([...granted.values()].flatMap(({ read }) => [...read])),
  ];
  const [owners, readable] = await Promise.all([
    connectionIds.length === 0 ? [] : connectionOwnersOf(env, connectionIds),
    collectionIds.length === 0 ? [] : accessOf(env, collectionIds),
  ]);
  const ownerOf = new Map(owners.map((owner) => [owner.id, owner]));
  const accessById = new Map(readable.map((access) => [access.id, access]));
  return new Map(
    [...granted].map(([app, { connected, read }]) => {
      const sources: AppSources = {
        connections: [],
        collections: [],
        unresolved: [],
      };
      for (const id of connected) {
        const owner = ownerOf.get(id);
        if (owner === undefined) {
          sources.unresolved.push(sourceId("connection", id));
        } else {
          sources.connections.push(owner);
        }
      }
      for (const id of read) {
        const access = accessById.get(id);
        if (access === undefined) {
          sources.unresolved.push(sourceId("collection", id));
        } else {
          sources.collections.push(access);
        }
      }
      return [app, sources];
    })
  );
};

/** The sources `app` may have read, as they are now. */
export const sourcesOf = async (env: Env, app: AppId): Promise<AppSources> => {
  const sources = await sourcesOfApps(env, [app]);
  return (
    sources.get(app) ?? { connections: [], collections: [], unresolved: [] }
  );
};

/** Whether an App has read from anything at all. */
export const hasSources = (sources: AppSources): boolean =>
  sources.connections.length > 0 ||
  sources.collections.length > 0 ||
  sources.unresolved.length > 0;

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
  ...sources.unresolved,
];
