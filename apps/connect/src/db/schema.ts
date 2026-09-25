/**
 * Connect D1 schema: the connection registry, the stored answers of side
 * effects and the audit outbox. OAuth providers, encrypted tokens and
 * pending actions join them here.
 */
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

const timestamp = (name: string) => integer(name, { mode: "timestamp_ms" });

/**
 * One connection to an outside system, and the MCP server that carries out
 * its actions: a native connector of ours (`server` names it) or a Composio
 * server scoped to one toolkit (`server` is its HTTPS URL).
 *
 * A personal connection is one person's own account: only calls acting for
 * `owner_user_id` may use it. A shared one (a service account or an
 * admin-consented app) has no owner; permissions decide who uses it.
 */
export const connections = sqliteTable(
  "connections",
  {
    id: text().primaryKey(),
    /** The outside system, such as `microsoft` or `hubspot`. */
    provider: text().notNull(),
    scope: text({ enum: ["personal", "shared"] }).notNull(),
    ownerUserId: text("owner_user_id"),
    /** Only an active connection takes calls. */
    status: text({
      enum: ["active", "needs_reauth", "disconnected"],
    }).notNull(),
    serverKind: text("server_kind", { enum: ["native", "composio"] }).notNull(),
    server: text().notNull(),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
  },
  (table) => [
    check(
      "connections_owner_check",
      sql`(${table.scope} = 'personal') = (${table.ownerUserId} IS NOT NULL)`
    ),
  ]
);

/**
 * One side effect per subject, person, connection, action and idempotency
 * key: its claim while it runs, then its result, returned to a repeat
 * instead of calling out again. Never keyed by the key alone: App and agent
 * code chooses keys, so one subject's key must never reach another
 * subject's result, another person's, or another action's.
 *
 * `input_hash` is the SHA-256 of the call's resource and input, so a key
 * can't be reused for a different call. `state` is `running` while the call
 * is out, `done` once its result is stored, `failed` once the tool's error
 * is stored (a tool may have acted before it failed, so that is final too),
 * and `unknown` when the call failed after it may have reached the server:
 * that key is spent for good, and its row is never deleted.
 */
export const idempotentCalls = sqliteTable(
  "idempotent_calls",
  {
    subjectType: text("subject_type", { enum: ["app", "agent"] }).notNull(),
    subjectId: text("subject_id").notNull(),
    onBehalfOf: text("on_behalf_of").notNull(),
    connectionId: text("connection_id").notNull(),
    action: text().notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    inputHash: text("input_hash").notNull(),
    state: text({ enum: ["running", "done", "failed", "unknown"] }).notNull(),
    /** Set once done or failed: the result as returned to the first call. */
    output: text(),
    provenance: text(),
    createdAt: timestamp("created_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.subjectType,
        table.subjectId,
        table.onBehalfOf,
        table.connectionId,
        table.action,
        table.idempotencyKey,
      ],
    }),
    index("idempotent_calls_created_idx").on(table.createdAt),
  ]
);

/**
 * Audit events not yet on the audit queue. Each call's events are stored
 * here first, with the call's own result where it has one, then sent; what
 * didn't go out is sent again by the cron trigger. `event` is the event as
 * JSON.
 */
export const auditOutbox = sqliteTable("audit_outbox", {
  id: text().primaryKey(),
  event: text().notNull(),
  createdAt: timestamp("created_at").notNull(),
});
