/**
 * Knowledge D1 database: collections, documents, versions (text in the row),
 * sections, links and the full-text index (unicode61 plus trigram).
 *
 * Versions keep every text a document ever had, but for what a purge
 * removed (knowledge/purge.ts). Sections and links are those of the
 * current version only, replaced on each save and purge: they are what
 * search indexes and agents read and follow, and an earlier version's are
 * derived from its text again when needed.
 *
 * The full-text index (`search_rows`, `search_words`, `search_trigrams` and
 * the triggers that keep them) is FTS5, which Drizzle can't describe: it
 * lives in its own migration, `0001_search.sql`.
 */
import type { Json } from "@grasp-os/shared/json";
import { knowledgeSignalKinds } from "@grasp-os/shared/knowledge-signals";
import { sql } from "drizzle-orm";
import {
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// The outbox of audit events for changes to this database, and the rows
// moved out of it, with the same shape as the core database's (see
// src/audit-outbox.ts).
export { auditOutbox, auditOutboxRejected } from "../core/schema.ts";

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
    enum: ["here", "upload", "grasp", "apps"],
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
    // The daily usage signals (knowledge/signals.ts) page through the
    // documents unchanged for long, and those past their review date.
    index("documents_updated_at_idx").on(table.updatedAt, table.id),
    index("documents_review_date_idx")
      .on(table.reviewDate, table.id)
      .where(sql`${table.reviewDate} IS NOT NULL`),
  ]
);

/**
 * Every version of every document, with its whole text, which only a purge
 * rewrites. The primary key is also the edit check: two saves from the
 * same version both write the next number, and the second one fails.
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

/**
 * A change an agent proposed to a shared memory file
 * (knowledge/memory-proposals.ts):
 * the whole new text, from `base_version` of the document at `path`, which
 * waits for someone who can change the collection to approve or decline it.
 */
export const memoryProposals = sqliteTable(
  "memory_proposals",
  {
    id: text().primaryKey(),
    collectionId: text("collection_id")
      .notNull()
      .references(() => collections.id, { onDelete: "cascade" }),
    path: text().notNull(),
    /** The document's version it was proposed from, 0 for a new one. */
    baseVersion: integer("base_version").notNull(),
    text: text().notNull(),
    message: text(),
    /** JSON: who proposed it, and where. */
    source: text().notNull(),
    /** The agent that proposed it: its proposals waiting are capped. */
    agentId: text("agent_id").notNull(),
    /** User ID: the person it acted for, whom the cap counts by too. */
    onBehalfOf: text("on_behalf_of").notNull(),
    status: text({ enum: ["pending", "approved", "declined"] }).notNull(),
    /** User ID. */
    decidedBy: text("decided_by"),
    createdAt: timestamp("created_at").notNull(),
    decidedAt: timestamp("decided_at"),
  },
  (table) => [
    index("memory_proposals_status_idx").on(table.status, table.createdAt),
    index("memory_proposals_agent_idx").on(
      table.agentId,
      table.onBehalfOf,
      table.status
    ),
  ]
);

/**
 * Which version of each App its entry in the Apps collection holds
 * (knowledge/apps-collection.ts): written in the same batch as the entry,
 * so it never names a version the entry doesn't have. An App whose current
 * version differs, or that has no row, is indexed again.
 */
export const appEntries = sqliteTable("app_entries", {
  /** An App in the core database. */
  appId: text("app_id").primaryKey(),
  version: integer().notNull(),
  indexedAt: timestamp("indexed_at").notNull(),
});

/**
 * A file uploaded into a collection (knowledge/uploads.ts): its original,
 * kept in R2 under its hash, and where extracting its text into the
 * document at `path` stands. Only the person who uploaded it sees it.
 */
export const uploads = sqliteTable(
  "uploads",
  {
    id: text().primaryKey(),
    collectionId: text("collection_id")
      .notNull()
      .references(() => collections.id, { onDelete: "cascade" }),
    /** The file's name, and the path of its document. */
    path: text().notNull(),
    mediaType: text("media_type").notNull(),
    /** The file's size. */
    bytes: integer().notNull(),
    /** The file's SHA-256, in hex, which R2 checks the original against. */
    sha256: text().notNull(),
    /** User ID. */
    uploadedBy: text("uploaded_by").notNull(),
    /** JSON: the audit log's actor for the person who uploaded it. */
    actor: text().notNull(),
    status: text({
      enum: ["pending", "extracting", "ready", "failed"],
    }).notNull(),
    /** The code of the error it failed with. */
    failure: text(),
    /** The document and version it was saved as, once ready. */
    documentId: text("document_id"),
    version: integer(),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
  },
  (table) => [
    index("uploads_path_idx").on(
      table.collectionId,
      table.path,
      table.createdAt
    ),
    index("uploads_original_idx").on(table.collectionId, table.sha256),
    index("uploads_status_idx").on(table.status, table.updatedAt),
  ]
);

/**
 * Originals to delete from R2 (knowledge/uploads.ts), by key: recorded
 * with the upload, before its original is stored, and cleared once it is
 * saved; recorded again by a purge. Deleted by the failure that makes one
 * unneeded, or by the cron trigger once its upload is gone or failed.
 */
export const uploadCleanups = sqliteTable("upload_cleanups", {
  /** The original's key in R2. */
  key: text().primaryKey(),
  /** The upload whose original it is. */
  uploadId: text("upload_id").notNull(),
  /**
   * When its original may have been written, at the latest: the upload's
   * creation, or 0 for one known to be written already.
   */
  createdAt: timestamp("created_at").notNull(),
});

/**
 * The daily computations of the usage signals (knowledge/signals.ts), one
 * row per attempt, as core's `improvement_signal_computations` has them
 * (src/daily-claims.ts).
 */
export const knowledgeSignalComputations = sqliteTable(
  "knowledge_signal_computations",
  {
    id: text().primaryKey(),
    /** The UTC day it is the computation of, such as `2026-09-29`. */
    day: text().notNull(),
    startedAt: timestamp("started_at").notNull(),
    finishedAt: timestamp("finished_at"),
  },
  (table) => [
    index("knowledge_signal_computations_day_idx").on(table.day),
    index("knowledge_signal_computations_started_idx").on(
      table.startedAt,
      table.id
    ),
  ]
);

/**
 * The usage signals of a computation: one per kind, collection and subject
 * (a search's key, or a document's ID), for the collection's owner, with
 * an ID derived from those three, the same in every computation. Readers
 * take only the finished computation started last, so a computation's
 * signals show all at once when it finishes, and never those of one that
 * doesn't. Written under the computation's ID: one that outlived its lease
 * and lost its row fails on the foreign key. `evidence` is JSON, IDs and
 * counts only; `evidence_at` is when its latest evidence was seen (a
 * question's latest search), null for a document's.
 *
 * No foreign keys to collections or documents: a purge that deletes one
 * meanwhile must not fail a computation's writes. Reads join the
 * collection (and the document) and so never show a signal about one
 * that's gone.
 */
export const knowledgeSignals = sqliteTable(
  "knowledge_signals",
  {
    computation: text()
      .notNull()
      .references(() => knowledgeSignalComputations.id),
    id: text().notNull(),
    kind: text({ enum: knowledgeSignalKinds }).notNull(),
    collectionId: text("collection_id").notNull(),
    subject: text().notNull(),
    /** User ID: the collection's owner when it was computed. */
    owner: text().notNull(),
    /**
     * Ranks it within its kind: a question's searches, the days since an
     * unread document changed. Null for an overdue document, ranked by its
     * review date as it is when listed.
     */
    value: integer(),
    evidence: text({ mode: "json" }).$type<Json>().notNull(),
    evidenceAt: timestamp("evidence_at"),
  },
  (table) => [
    primaryKey({ columns: [table.computation, table.id] }),
    uniqueIndex("knowledge_signals_subject_idx").on(
      table.computation,
      table.collectionId,
      table.kind,
      table.subject
    ),
    index("knowledge_signals_owner_idx").on(
      table.computation,
      table.owner,
      table.kind,
      table.value,
      table.id
    ),
  ]
);

/**
 * Signals an owner dismissed, by kind, collection and subject, so they
 * outlast the computations: a signal is hidden while it has no evidence
 * newer than its dismissal. A computation's finish removes those whose
 * signal it no longer has, or has with newer evidence, so a signal that
 * went away and came back shows again.
 */
export const knowledgeSignalDismissals = sqliteTable(
  "knowledge_signal_dismissals",
  {
    kind: text({ enum: knowledgeSignalKinds }).notNull(),
    collectionId: text("collection_id").notNull(),
    subject: text().notNull(),
    dismissedAt: timestamp("dismissed_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.kind, table.collectionId, table.subject] }),
  ]
);
