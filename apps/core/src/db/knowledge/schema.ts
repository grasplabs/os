/**
 * Knowledge D1 database: collections, documents, versions (text in the row),
 * sections, links and the full-text index (unicode61 plus trigram).
 *
 * Versions keep every text a document ever had. Sections and links are
 * those of the current version only, replaced on each save: they are what
 * search indexes and agents read and follow, and an earlier version's are
 * derived from its text again when needed.
 */
import {
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// The outbox of audit events for changes to this database, with the same
// shape as the core database's (see src/audit-outbox.ts).
export { auditOutbox } from "../core/schema.ts";

const timestamp = (name: string) => integer(name, { mode: "timestamp_ms" });

/** A set of documents with one owner, access rule and source. */
export const collections = sqliteTable("collections", {
  id: text().primaryKey(),
  name: text().notNull(),
  description: text().notNull(),
  /** User ID. */
  owner: text().notNull(),
  access: text({ enum: ["everyone", "teams", "me"] }).notNull(),
  sensitive: integer({ mode: "boolean" }).notNull().default(false),
  source: text({
    enum: ["here", "upload", "playbook", "grasp", "apps"],
  }).notNull(),
  createdAt: timestamp("created_at").notNull(),
});

/** The teams that may read a `teams` collection. */
export const collectionTeams = sqliteTable(
  "collection_teams",
  {
    collectionId: text("collection_id")
      .notNull()
      .references(() => collections.id, { onDelete: "cascade" }),
    /** A team in the core database. */
    teamId: text("team_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.collectionId, table.teamId] }),
    index("collection_teams_team_id_idx").on(table.teamId),
  ]
);

/**
 * A document: its place, and what its current version's frontmatter says,
 * so listings don't parse any text.
 */
export const documents = sqliteTable(
  "documents",
  {
    id: text().primaryKey(),
    collectionId: text("collection_id")
      .notNull()
      .references(() => collections.id, { onDelete: "cascade" }),
    path: text().notNull(),
    title: text().notNull(),
    type: text().notNull(),
    description: text().notNull(),
    owner: text().notNull(),
    /** JSON array of strings. */
    tags: text().notNull(),
    /** `YYYY-MM-DD`. */
    reviewDate: text("review_date"),
    currentVersion: integer("current_version").notNull(),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("documents_collection_path_idx").on(
      table.collectionId,
      table.path
    ),
  ]
);

/**
 * Every version of every document, with its whole text. The primary key is
 * also the edit check: two saves from the same version both write the next
 * number, and the second one fails.
 */
export const versions = sqliteTable(
  "versions",
  {
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    number: integer().notNull(),
    text: text().notNull(),
    /** User ID. */
    author: text().notNull(),
    message: text(),
    /** The version this one restored. */
    restoredFrom: integer("restored_from"),
    createdAt: timestamp("created_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.documentId, table.number] })]
);

/** The current version's sections, split by heading, in order. */
export const sections = sqliteTable(
  "sections",
  {
    documentId: text("document_id").notNull(),
    version: integer().notNull(),
    position: integer().notNull(),
    /** JSON array: the headings above and of this section, outermost first. */
    headings: text().notNull(),
    text: text().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.documentId, table.position] }),
    foreignKey({
      columns: [table.documentId, table.version],
      foreignColumns: [versions.documentId, versions.number],
    }).onDelete("cascade"),
  ]
);

/**
 * The current version's `[[links]]`, by the path they name, so a link to a
 * document that doesn't exist yet finds it once it does.
 */
export const links = sqliteTable(
  "links",
  {
    fromDocumentId: text("from_document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    toCollectionId: text("to_collection_id").notNull(),
    toPath: text("to_path").notNull(),
    label: text(),
  },
  (table) => [
    primaryKey({
      columns: [table.fromDocumentId, table.toCollectionId, table.toPath],
    }),
    index("links_to_idx").on(table.toCollectionId, table.toPath),
  ]
);
