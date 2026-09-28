/**
 * Workspace Durable Object SQLite: chats and agent state. Migrates itself on
 * first wake-up after a release.
 */
import type { ChatId } from "@grasp-os/shared/ids";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

export const chats = sqliteTable("chats", {
  id: text().$type<ChatId>().primaryKey(),
  title: text().notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  /** It read restricted data, and is in restricted mode for good. */
  restricted: integer({ mode: "boolean" }).notNull().default(false),
  /**
   * The person the chat belongs to, whom its agent acts for. Chats made
   * before agents have none, and their agent can't act.
   */
  personId: text("person_id"),
});

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
 * connections its code read through the chat's APIs. Every model request
 * of the chat carries all of them as provenance, so the client's model
 * rules judge a later turn by what an earlier one read. Written only for a
 * code run that is still open (`recordSources` in workspace.ts).
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
