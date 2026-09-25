/**
 * Audit log Durable Object SQLite: append-only, hash-chained events. Migrates
 * itself on first wake-up after a release.
 */
import { sql } from "drizzle-orm";
import { check, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** The chain: one row per event, never updated or deleted (src/audit-chain.ts). */
export const events = sqliteTable(
  "events",
  {
    /** Position in the chain, from 1, without gaps. */
    seq: integer().primaryKey(),
    /** The event's own ID; unique, so a redelivered event is appended once. */
    id: text().notNull().unique(),
    /** The hash format the row was hashed with. */
    version: integer().notNull(),
    /** When the log received the event (ISO 8601), set by the log. */
    receivedAt: text("received_at").notNull(),
    /** The event's canonical JSON, exactly as it was hashed. */
    event: text().notNull(),
    prevHash: text("prev_hash").notNull(),
    hash: text().notNull(),
  },
  (table) => [check("events_seq_positive", sql`${table.seq} >= 1`)]
);
