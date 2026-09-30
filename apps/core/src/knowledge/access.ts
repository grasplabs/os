import {
  actorOf,
  auditProvenanceMaxItems,
  delegateActorOf,
} from "@grasp-os/shared/audit";
import type { AuditActor, AuditDetailValue } from "@grasp-os/shared/audit";
import { collectionIdSchema } from "@grasp-os/shared/ids";
import type { PermissionId } from "@grasp-os/shared/ids";
import type { Provenance } from "@grasp-os/shared/knowledge";
import { permissionErrors } from "@grasp-os/shared/permissions";
import type { Authority } from "@grasp-os/shared/permissions";
import type { Identity } from "@grasp-os/shared/rpc";
import { and, eq, exists, ne, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";

import { keepAuditEvent } from "../audit-outbox.ts";
import { teamsOf } from "../auth/identity.ts";
import { inList } from "../db/d1.ts";
import { collectionTeams, collections } from "../db/knowledge/schema.ts";
import { grantedPermissions } from "../permissions.ts";
import { restrict } from "../restricted.ts";
import type { WorkContext } from "../restricted.ts";

// The one place Knowledge decides what may be read. Every query that reads
// collections puts `allowedCollections` inside its SQL, and every query
// that reads documents, versions or links puts `allowedFor`'s `documents`
// (app-entries.ts: these collections, and of the Apps collection only the
// entries of Apps the reader may open), never as a filter afterwards, so
// no path (listing, history, backlinks, search) shows more than a read
// would.
//
// A person reads a collection for everyone, one of their teams', or one
// they own. An App or agent reads the collections it has a permission to
// read, never a personal one, and of those only the ones the person it
// acts for may read too
// (R5): a grant never reaches past that person. The one exception is an
// agent's memory (`readableForPerson`), which reads what the person may
// read, without a grant, and only their memory files. What anyone reads is
// marked with where it came from and recorded in the audit log, and
// restricted data puts the chat or App an App or agent works in in
// restricted mode (`noteProvenance`).

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
export interface PersonAccess {
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

/** A collection as `mayRead` needs it: its access, owner and teams. */
export interface CollectionAccess {
  access: (typeof collections.$inferSelect)["access"];
  owner: string;
  teamIds: readonly string[];
}

/**
 * Whether `person` may read `collection`: `readableBy`'s rule, decided in
 * memory, for checking many people against collections read once (sharing
 * an App, app-provenance.ts). The two must always agree: a new kind of
 * access doesn't compile here until it is decided.
 */
export const mayRead = (
  { userId, teamIds }: PersonAccess,
  { access, owner, teamIds: shared }: CollectionAccess
): boolean => {
  // Its owner always, also of a team collection for teams they aren't in.
  if (owner === userId) {
    return true;
  }
  switch (access) {
    case "everyone": {
      return true;
    }
    case "teams": {
      return shared.some((team) => teamIds.includes(team));
    }
    case "me": {
      return false;
    }
    default: {
      return access satisfies never;
    }
  }
};

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

/** The collections a reader may read, and for a delegate, those granted. */
export interface CollectionsAllowed {
  /** A condition on `collections`. */
  condition: SQL;
  /**
   * The collections an App or agent is granted to read, read now (every
   * collection's own rule applies on top); undefined for a person.
   */
  granted: readonly string[] | undefined;
}

/**
 * The collections `reader` may read (`condition`), and those an App or
 * agent is granted.
 */
export const collectionsAllowed = async (
  env: Env,
  db: DrizzleD1Database,
  reader: Reader
): Promise<CollectionsAllowed> => {
  if (reader.type === "person") {
    const { userId, teams } = reader.person;
    return {
      condition: readableBy(db, {
        userId,
        teamIds: teams.map(({ id }) => id),
      }),
      granted: undefined,
    };
  }
  const { authority, permissionId } = reader;
  const granted = await grantedToRead(env, authority, permissionId);
  if (granted.length === 0) {
    return { condition: sql`0`, granted };
  }
  const teams = await teamsOf(env.DB, authority.onBehalfOf);
  return {
    condition:
      and(
        inList(collections.id, granted),
        // A personal collection is never read under a grant: an App is
        // shared, and a grant isn't the person's own. What an agent reads
        // of its person's own collection (their USER.md) it reads as
        // memory, through `readableForPerson`.
        ne(collections.access, "me"),
        readableBy(db, {
          userId: authority.onBehalfOf,
          teamIds: teams.map(({ id }) => id),
        })
      ) ?? sql`0`,
    granted,
  };
};

/** The collections `reader` may read, as a condition on `collections`. */
export const allowedCollections = async (
  env: Env,
  db: DrizzleD1Database,
  reader: Reader
): Promise<SQL> => {
  const { condition } = await collectionsAllowed(env, db, reader);
  return condition;
};

/**
 * The collections the person `userId` may read themselves, their teams
 * read now, as a condition on `collections`. Only for memory (memory.ts):
 * an agent's memory is the person's own files and the company's, which it
 * gets without a permission, in the contexts that are that person's own.
 * Every other read by an App or agent goes through `allowedCollections`.
 */
export const readableForPerson = async (
  env: Env,
  db: DrizzleD1Database,
  userId: string
): Promise<SQL> => {
  const teams = await teamsOf(env.DB, userId);
  return readableBy(db, { userId, teamIds: teams.map(({ id }) => id) });
};

/** Who read, as the audit log names them. */
export const readerActor = (reader: Reader): AuditActor =>
  reader.type === "person"
    ? actorOf(reader.person)
    : delegateActorOf(reader.authority);

/**
 * A read, as the audit log records it: which read (`knowledge.read`, with
 * `detail.read` naming it, or a search), what it was of, and the documents
 * it returned beyond that (a search's hits). Identifiers and counts only,
 * never what was read or searched for.
 */
export interface ReadRecord {
  action: "knowledge.read" | "knowledge.search" | "knowledge.search.empty";
  target?: { type: "document" | "collection"; id: string };
  documentIds?: string[];
  detail: Record<string, AuditDetailValue>;
}

/**
 * Notes where what `reader` read came from, `sources` (a collection, or
 * those a search found something in; none when it found nothing), and
 * returns the read's provenance. Call it after the read and before handing
 * over what it returned: an App or agent that read restricted data puts
 * its chat or App in restricted mode first, so the data never reaches
 * anything that can still call out. If that fails, the read fails, and
 * isn't recorded as one (entering restricted mode is, in restricted.ts).
 *
 * Then the read is recorded (R16), whoever read, staff included: `record`,
 * with the collections it read from and the documents it names as the
 * event's provenance, and whether any was sensitive. Through the Knowledge
 * outbox, which never fails the read (`keepAuditEvent`): what was read is
 * read, and a read that can't be recorded there goes straight to the log,
 * or to the logs.
 */
export const noteProvenance = async (
  env: Env,
  reader: Reader,
  record: ReadRecord,
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
    await restrict(
      env,
      reader.authority,
      reader.context,
      provenance.collectionIds
    );
  }
  const { action, target, documentIds = [], detail } = record;
  await keepAuditEvent(env, drizzle(env.KNOWLEDGE), {
    actor: readerActor(reader),
    action,
    target,
    // At most one collection per document a search returns, and a search
    // returns at most `searchMaxLimit` (50): both fit.
    provenance: [
      ...new Set([...provenance.collectionIds, ...documentIds]),
    ].slice(0, auditProvenanceMaxItems),
    // Every chat's agent is the organization's: which chat read.
    detail:
      reader.type === "delegate" && reader.context.type === "chat"
        ? { ...detail, sensitive, chat: reader.context.chatId }
        : { ...detail, sensitive },
  });
  return provenance;
};

/**
 * Whether `person` may change a collection they can read: its owner and
 * admins always; anyone who can read a team or personal collection. A
 * collection for everyone is read by everyone but changed only by its
 * owner and admins.
 */
export const canWrite = (
  person: Pick<Identity, "userId" | "role">,
  collection: { owner: string; access: string }
): boolean =>
  collection.access !== "everyone" ||
  collection.owner === person.userId ||
  person.role === "admin";

/** Whether `person` may create a collection with `access`. */
export const canCreate = (person: Identity, access: string): boolean =>
  access === "me" || person.role === "admin";
