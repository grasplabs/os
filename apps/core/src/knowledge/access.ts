import type { Identity } from "@grasp-os/shared/rpc";
import { and, eq, exists, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";

import { collectionTeams, collections } from "../db/knowledge/schema.ts";

// The one place Knowledge decides what a signed-in person may read and
// change. Every query that reads collections, documents, versions or links
// puts `readableBy` inside its SQL, never as a filter afterwards, so no
// path (listing, history, backlinks) can show more than a read would.
//
// This covers people only: a collection is read by everyone, by the members
// of its teams, or by its owner alone; its owner can always read it. Apps and agents (their grant
// intersected with the access of the person they act for), sensitivity
// markers on what is read, and restricted mode build on this function; none
// of them exist yet, so nothing but a signed-in person reaches Knowledge.

/** Collections `person` may read, as a condition on `collections`. */
export const readableBy = (db: DrizzleD1Database, person: Identity): SQL => {
  const teamIds = person.teams.map(({ id }) => id);
  return (
    or(
      eq(collections.access, "everyone"),
      // Its owner always, also of a team collection for teams they aren't in.
      eq(collections.owner, person.userId),
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
                    // One parameter however many teams: D1 binds at most 100.
                    sql`${collectionTeams.teamId} IN (SELECT value FROM json_each(${JSON.stringify(teamIds)}))`
                  )
                )
            )
          )
    ) ?? sql`0`
  );
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
