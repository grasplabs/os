import { actorOf } from "@grasp-os/shared/audit";
import { collectionIdSchema } from "@grasp-os/shared/ids";
import {
  collectionInputSchema,
  knowledgeErrors,
  readOnlySources,
} from "@grasp-os/shared/knowledge";
import type { Collection, CollectionSource } from "@grasp-os/shared/knowledge";
import type { Identity } from "@grasp-os/shared/rpc";
import { and, asc, eq } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";

import { auditedBatch, outboxed } from "../audit-outbox.ts";
import { organizationId } from "../auth/auth.ts";
import { teams } from "../db/core/schema.ts";
import { inList } from "../db/d1.ts";
import { collectionTeams, collections } from "../db/knowledge/schema.ts";
import { allowedCollections, canCreate, canWrite } from "./access.ts";
import type { Reader } from "./access.ts";

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

/** The collections `reader` may read, by name. */
export const listCollections = async (
  env: Env,
  reader: Reader
): Promise<Collection[]> => {
  const db = drizzle(env.KNOWLEDGE);
  const allowed = await allowedCollections(env, db, reader);
  const rows = await db
    .select()
    .from(collections)
    .where(allowed)
    .orderBy(asc(collections.name), asc(collections.id));
  const shared = await db
    .select({
      collectionId: collectionTeams.collectionId,
      teamId: collectionTeams.teamId,
    })
    .from(collectionTeams)
    .innerJoin(collections, eq(collections.id, collectionTeams.collectionId))
    .where(allowed)
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

/** The collection, if it is one of the `allowed` collections. */
export const readableCollection = async (
  db: DrizzleD1Database,
  allowed: SQL,
  collectionId: unknown
): Promise<CollectionRow> => {
  const id = collectionIdSchema.safeParse(collectionId);
  const row = id.success
    ? await db
        .select()
        .from(collections)
        .where(and(eq(collections.id, id.data), allowed))
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
      and(eq(teams.organizationId, organizationId), inList(teams.id, teamIds))
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
  const {
    name,
    description,
    access,
    teams: teamIds,
    sensitive,
  } = knowledgeErrors.parse("knowledge.invalid", collectionInputSchema, input);
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
  await auditedBatch(env, db, [
    db.insert(collections).values(row),
    ...insertTeams,
    outboxed(db, {
      actor: actorOf(person),
      action: "knowledge.collection.created",
      target: { type: "collection", id: row.id },
      detail: { access, sensitive, source },
    }),
  ]);
  return toCollection(row, teamIds);
};
