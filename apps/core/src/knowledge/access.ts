import { collectionIdSchema } from "@grasp-os/shared/ids";
import type { PermissionId } from "@grasp-os/shared/ids";
import type { Provenance } from "@grasp-os/shared/knowledge";
import { permissionErrors } from "@grasp-os/shared/permissions";
import type { Authority } from "@grasp-os/shared/permissions";
import type { Identity } from "@grasp-os/shared/rpc";
import { and, eq, exists, ne, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";

import { teamsOf } from "../auth/identity.ts";
import { inList } from "../db/d1.ts";
import { collectionTeams, collections } from "../db/knowledge/schema.ts";
import { grantedPermissions } from "../permissions.ts";
import { restrict } from "../restricted.ts";
import type { WorkContext } from "../restricted.ts";

// The one place Knowledge decides what may be read. Every query that reads
// collections, documents, versions or links puts `allowedCollections`
// inside its SQL, never as a filter afterwards, so no path (listing,
// history, backlinks, search) shows more than a read would.
//
// A person reads a collection for everyone, one of their teams', or one
// they own. An App or agent reads the collections it has a permission to
// read, never a personal one, and of those only the ones the person it
// acts for may read too
// (R5): a grant never reaches past that person. What it reads is marked
// with where it came from, and restricted data puts the chat or App it
// works in in restricted mode (`recordRead`).

/**
 * Who reads Knowledge: a signed-in person, or an App or agent acting for
 * one in a chat or App. `permissionId` limits an App or agent to that one
 * permission: its stub's.
 *
 * A person's reads never put anything in restricted mode: a person has no
 * context to restrict. So an App or agent reads only as a delegate, through
 * its stubs (knowledge/binding.ts), never through a person's reader, or
 * restricted data would reach it without restricting it.
 */
export type Reader =
  | { type: "person"; person: Identity }
  | {
      type: "delegate";
      authority: Authority;
      context: WorkContext;
      permissionId?: PermissionId;
    };

/** A person, as far as reading Knowledge goes. */
interface PersonAccess {
  userId: string;
  teamIds: string[];
}

/** Collections a person may read, as a condition on `collections`. */
const readableBy = (
  db: DrizzleD1Database,
  { userId, teamIds }: PersonAccess
): SQL =>
  or(
    eq(collections.access, "everyone"),
    // Its owner always, also of a team collection for teams they aren't in.
    eq(collections.owner, userId),
    teamIds.length === 0
      ? undefined
      : and(
          eq(collections.access, "teams"),
          exists(
            db
              .select({ one: sql`1` })
              .from(collectionTeams)
              .where(
                and(
                  eq(collectionTeams.collectionId, collections.id),
                  inList(collectionTeams.teamId, teamIds)
                )
              )
          )
        )
  ) ?? sql`0`;

/**
 * The collections the App or agent may read under its permissions (only
 * `permissionId`, when given), read now. Throws `permission.person_inactive`
 * when the person it acts for has left, and `permission.denied` when
 * `permissionId` doesn't allow reading any more.
 */
const grantedToRead = async (
  env: Env,
  authority: Authority,
  permissionId: PermissionId | undefined
): Promise<string[]> => {
  const granted = await grantedPermissions(env, authority);
  const ids = granted.flatMap(({ id, object, actions }) =>
    object.type === "collection" &&
    actions.includes("read") &&
    (permissionId === undefined || id === permissionId)
      ? [object.collectionId]
      : []
  );
  if (permissionId !== undefined && ids.length === 0) {
    throw permissionErrors.create("permission.denied", { action: "read" });
  }
  return ids;
};

/** The collections `reader` may read, as a condition on `collections`. */
export const allowedCollections = async (
  env: Env,
  db: DrizzleD1Database,
  reader: Reader
): Promise<SQL> => {
  if (reader.type === "person") {
    const { userId, teams } = reader.person;
    return readableBy(db, { userId, teamIds: teams.map(({ id }) => id) });
  }
  const { authority, permissionId } = reader;
  const granted = await grantedToRead(env, authority, permissionId);
  if (granted.length === 0) {
    return sql`0`;
  }
  const teams = await teamsOf(env.DB, authority.onBehalfOf);
  return (
    and(
      inList(collections.id, granted),
      // A personal collection is read only in its owner's own context, and
      // no context is one yet: an App is shared, and workspaces have no
      // owner. Once a workspace has one, allow its owner's personal
      // collections in its chats here.
      ne(collections.access, "me"),
      readableBy(db, {
        userId: authority.onBehalfOf,
        teamIds: teams.map(({ id }) => id),
      })
    ) ?? sql`0`
  );
};

/**
 * Records that `reader` read from `sources` (a collection, or those a
 * search found something in; none when it found nothing), and returns the
 * read's provenance. Call it after the read and before handing over what it
 * returned: an App or agent that read restricted data puts its chat or App
 * in restricted mode first, so the data never reaches anything that can
 * still call out. If that fails, the read fails.
 */
export const recordRead = async (
  env: Env,
  reader: Reader,
  ...sources: { id: string; sensitive: boolean }[]
): Promise<Provenance> => {
  const sensitive = sources.some((source) => source.sensitive);
  const provenance: Provenance = {
    collectionIds: [...new Set(sources.map(({ id }) => id))].map((id) =>
      collectionIdSchema.parse(id)
    ),
    sensitive,
    // A sensitive collection holds restricted data (threat model Q12).
    restricted: sensitive,
  };
  if (provenance.restricted && reader.type === "delegate") {
    await restrict(env, reader.authority, reader.context);
  }
  return provenance;
};

/**
 * Whether `person` may change a collection they can read: its owner and
 * admins always; anyone who can read a team or personal collection. A
 * collection for everyone is read by everyone but changed only by its
 * owner and admins.
 */
export const canWrite = (
  person: Identity,
  collection: { owner: string; access: string }
): boolean =>
  collection.access !== "everyone" ||
  collection.owner === person.userId ||
  person.role === "admin";

/** Whether `person` may create a collection with `access`. */
export const canCreate = (person: Identity, access: string): boolean =>
  access === "me" || person.role === "admin";
