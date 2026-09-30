/**
 * Workspace Durable Object SQLite: chats and agent state. Migrates itself on
 * first wake-up after a release.
 */
import type { ChatId } from "@grasp-os/shared/ids";
import {
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

export const chats = sqliteTable(
  "chats",
  {
    id: text().$type<ChatId>().primaryKey(),
    title: text().notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    /** It read restricted data, and is in restricted mode for good. */
    restricted: integer({ mode: "boolean" }).notNull().default(false),
    /**
     * The person the chat belongs to, whom its agent acts for, and the
     * only one who reaches it.
     */
    personId: text("person_id").notNull(),
    /**
     * The agent that answers in the chat, acting for its person: the
     * organization's agent admins grant to, whichever object holds the
     * chat.
     */
    agentId: text("agent_id").notNull(),
  },
  // A person's list, newest first.
  (table) => [index("chats_person").on(table.personId, table.createdAt)]
);

/**
 * A chat's transcript, in order: the agent's messages as pi shapes them
 * (system, user, assistant and tool results), as JSON. A message is stored
 * when the loop finishes it, so a turn cut short keeps its finished steps.
 */
export const chatMessages = sqliteTable(
  "chat_messages",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    chatId: text("chat_id")
      .$type<ChatId>()
      .notNull()
      .references(() => chats.id),
    message: text().notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("chat_messages_chat").on(table.chatId, table.id)]
);

/**
 * What a chat's agent has read from, each source once: the collections and
 * connections its code read through the chat's APIs, and, for a chat
 * started to fix a failed run, the run and its App's sources. Every model
 * request of the chat carries all of them as provenance, so the client's
 * model rules judge a later turn by what an earlier one read. Written only
 * for a code run that is still open (`recordSources` in workspace.ts), or
 * with the chat that attaches a run's report (`createChat`).
 */
export const chatSources = sqliteTable(
  "chat_sources",
  {
    chatId: text("chat_id")
      .$type<ChatId>()
      .notNull()
      .references(() => chats.id),
    sourceId: text("source_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.chatId, table.sourceId] })]
);

/**
 * A chat's drafts: one per App its agent writes to, over the version it
 * started from (`base`, null for an App with none). A draft is the chat's
 * own: it reaches the App only when the agent proposes it as a version
 * (agent-builds.ts). Each write is
 * a new `revision`, and lands only over the revision it read. A draft
 * whose changes are all gone (proposed, discarded, or written back as the
 * base has them) keeps its row, and its revision: it has no changes, and
 * its next write starts over the App's latest version.
 */
export const chatDrafts = sqliteTable(
  "chat_drafts",
  {
    chatId: text("chat_id")
      .$type<ChatId>()
      .notNull()
      .references(() => chats.id),
    appId: text("app_id").notNull(),
    base: integer(),
    revision: integer().notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.chatId, table.appId] })]
);

/**
 * A draft's changes (`chatDrafts`): a file's new content by path, or null
 * to delete it, a row each, so no row holds more than one file.
 */
export const chatDraftFiles = sqliteTable(
  "chat_draft_files",
  {
    chatId: text("chat_id").$type<ChatId>().notNull(),
    appId: text("app_id").notNull(),
    path: text().notNull(),
    content: text(),
  },
  (table) => [
    primaryKey({ columns: [table.chatId, table.appId, table.path] }),
    foreignKey({
      columns: [table.chatId, table.appId],
      foreignColumns: [chatDrafts.chatId, chatDrafts.appId],
    }),
  ]
);

/**
 * Audit events of changes to this object's chats (made, renamed, deleted,
 * started to fix a failed run, restricted from the start),
 * each stored in the same transaction as its change, until the object has
 * delivered it to the audit log (`drainObjectOutbox` in audit-outbox.ts).
 */
export const auditOutbox = sqliteTable("audit_outbox", {
  id: text().primaryKey(),
  event: text().notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

/**
 * What a chat was started with, besides its question: for now, the
 * failure report of the workflow run the person asked its agent to fix
 * (`chats.fixRun` in chats-rpc.ts), as JSON. Its agent reads it through
 * `env.chat.attachments()`, as data: the report's message is the
 * workflow's own text, and never goes into the agent's instructions.
 */
export const chatAttachments = sqliteTable(
  "chat_attachments",
  {
    chatId: text("chat_id")
      .$type<ChatId>()
      .notNull()
      .references(() => chats.id),
    runId: text("run_id").notNull(),
    report: text().notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.chatId, table.runId] })]
);
