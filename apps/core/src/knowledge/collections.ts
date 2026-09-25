import { collectionIdSchema } from "@grasp-os/shared/ids";
import {
  collectionIdInputSchema,
  collectionInputSchema,
  knowledgeErrors,
  readOnlySources,
} from "@grasp-os/shared/knowledge";
import type { Collection, CollectionSource } from "@grasp-os/shared/knowledge";
import type { Identity } from "@grasp-os/shared/rpc";
import { and, asc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";

import { outboxed, sendAuditOutboxNow } from "../audit-outbox.ts";
import { actorOf } from "../audit.ts";
import { organizationId } from "../auth/auth.ts";
import { teams } from "../db/core/schema.ts";
import { collectionTeams, collections } from "../db/knowledge/schema.ts";
import { canCreate, canWrite, readableBy } from "./access.ts";
import { issueLines } from "./frontmatter.ts";

export type CollectionRow = typeof collections.$inferSelect;

const toCollection = (row: CollectionRow, teamIds: string[]): Collection => ({
  id: collectionIdSchema.parse(row.id),
  name: row.name,
  description: row.description,
  owner: row.owner,
  access: row.access,
  teams: teamIds,
  sensitive: row.sensitive,
  source: row.source,
  createdAt: row.createdAt.toISOString(),
});

/** The collections `person` may read, by name. */
export const listCollections = async (
  env: Env,
  person: Identity
): Promise<Collection[]> => {
  const db = drizzle(env.KNOWLEDGE);
  const rows = await db
    .select()
    .from(collections)
    .where(readableBy(db, person))
    .orderBy(asc(collections.name), asc(collections.id));
  const shared = await db
    .select({
      collectionId: collectionTeams.collectionId,
      teamId: collectionTeams.teamId,
    })
    .from(collectionTeams)
    .innerJoin(collections, eq(collections.id, collectionTeams.collectionId))
    .where(readableBy(db, person))
    .orderBy(asc(collectionTeams.teamId));
  return rows.map((row) =>
    toCollection(
      row,
      shared
        .filter(({ collectionId }) => collectionId === row.id)
        .map(({ teamId }) => teamId)
    )
  );
};

/** The collection, if `person` may read it. */
export const readableCollection = async (
  db: DrizzleD1Database,
  person: Identity,
  collectionId: unknown
): Promise<CollectionRow> => {
  const id = collectionIdInputSchema.safeParse(collectionId);
  const row = id.success
    ? await db
        .select()
        .from(collections)
        .where(and(eq(collections.id, id.data), readableBy(db, person)))
        .get()
    : undefined;
  if (!row) {
    throw knowledgeErrors.create("knowledge.not_found");
  }
  return row;
};

/**
 * Refuses a change to `collection` that `person` may not make: one to a
 * collection only the platform writes, or one their access doesn't allow.
 */
export const requireWritable = (
  person: Identity,
  collection: CollectionRow
): void => {
  if (readOnlySources.has(collection.source)) {
    throw knowledgeErrors.create("knowledge.read_only");
  }
  if (!canWrite(person, collection)) {
    throw knowledgeErrors.create("knowledge.forbidden");
  }
};

/** The IDs in `teamIds` that aren't teams of the organization. */
const unknownTeams = async (env: Env, teamIds: string[]): Promise<string[]> => {
  if (teamIds.length === 0) {
    return [];
  }
  const found = await drizzle(env.DB)
    .select({ id: teams.id })
    .from(teams)
    .where(
      and(
        eq(teams.organizationId, organizationId),
        sql`${teams.id} IN (SELECT value FROM json_each(${JSON.stringify(teamIds)}))`
      )
    );
  const known = new Set(found.map(({ id }) => id));
  return teamIds.filter((id) => !known.has(id));
};

/**
 * Creates a collection `person` owns. People create collections written
 * here; the platform passes the `source` of the collections it fills
 * (uploads, the Playbook, Grasp's own, Apps').
 */
export const createCollection = async (
  env: Env,
  person: Identity,
  input: unknown,
  source: CollectionSource = "here"
): Promise<Collection> => {
  const parsed = collectionInputSchema.safeParse(input);
  if (!parsed.success) {
    throw knowledgeErrors.create("knowledge.invalid", {
      issues: issueLines(parsed.error, ""),
    });
  }
  const { name, description, access, teams: teamIds, sensitive } = parsed.data;
  if (!canCreate(person, access)) {
    throw knowledgeErrors.create("knowledge.forbidden");
  }
  const unknown = await unknownTeams(env, teamIds);
  if (unknown.length > 0) {
    throw knowledgeErrors.create("knowledge.invalid", {
      issues: unknown.map((id) => `teams: there's no team ${id}`),
    });
  }
  const row: CollectionRow = {
    id: crypto.randomUUID(),
    name,
    description,
    owner: person.userId,
    access,
    sensitive,
    source,
    createdAt: new Date(),
  };
  const db = drizzle(env.KNOWLEDGE);
  const insertTeams = teamIds.map((teamId) =>
    db.insert(collectionTeams).values({ collectionId: row.id, teamId })
  );
  await db.batch([
    db.insert(collections).values(row),
    ...insertTeams,
    outboxed(db, {
      actor: actorOf(person),
      action: "knowledge.collection.created",
      target: { type: "collection", id: row.id },
      detail: { access, sensitive, source },
    }),
  ]);
  await sendAuditOutboxNow(env);
  return toCollection(row, teamIds);
};
