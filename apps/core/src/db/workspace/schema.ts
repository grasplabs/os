/**
 * Workspace Durable Object SQLite: chats and agent state. Migrates itself on
 * first wake-up after a release.
 */
import type { ChatId } from "@grasp-os/shared/ids";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const chats = sqliteTable("chats", {
  id: text().$type<ChatId>().primaryKey(),
  title: text().notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  /** It read restricted data, and is in restricted mode for good. */
  restricted: integer({ mode: "boolean" }).notNull().default(false),
});
