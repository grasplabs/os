/**
 * Connect D1 schema: the connection registry, OAuth flows under way, the
 * connections' sealed tokens, the stored answers of side effects and the
 * audit outbox. Pending actions join them here.
 */
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
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
    /**
     * For an OAuth connection: the organization's tenant at the provider,
     * the account in it (its stable subject, such as an Entra object ID)
     * and its name for people (an email address), and who connected it.
     */
    tenant: text(),
    accountId: text("account_id"),
    accountName: text("account_name"),
    connectedBy: text("connected_by"),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
  },
  (table) => [
    check(
      "connections_owner_check",
      sql`(${table.scope} = 'personal') = (${table.ownerUserId} IS NOT NULL)`
    ),
    // One live connection per account at a provider: two would share one
    // grant, and disconnecting either (which revokes it) would end both.
    uniqueIndex("connections_account_idx")
      .on(table.provider, table.accountId)
      .where(
        sql`${table.accountId} IS NOT NULL AND ${table.status} <> 'disconnected'`
      ),
    // Offboarding disconnects a removed person's personal connections.
    index("connections_owner_user_id_idx").on(table.ownerUserId),
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
 * and `unknown` when the call failed after it may have reached the server.
 * Rows are never deleted, so no key is ever used twice: past retention, or
 * when too large, an answer's output is dropped and a repeat is refused.
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
    /**
     * Once done or failed: the result as returned to the first call, while
     * it is kept.
     */
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
 * OAuth flows under way: one row from the moment a person starts
 * connecting until the provider sends them back, at most ten minutes.
 * Keyed by the SHA-256 of the flow's `state`, so the state itself, which
 * travels through the browser, is stored nowhere. A flow is taken (deleted)
 * the first time its state comes back, whatever happens next, so it is
 * used at most once. `verifier` is the PKCE code verifier, sealed like a
 * token (src/vault.ts).
 */
export const oauthFlows = sqliteTable(
  "oauth_flows",
  {
    stateHash: text("state_hash").primaryKey(),
    /** The person who started it: only they can finish it. */
    userId: text("user_id").notNull(),
    provider: text().notNull(),
    scope: text({ enum: ["personal", "shared"] }).notNull(),
    tenant: text().notNull(),
    redirectUri: text("redirect_uri").notNull(),
    returnTo: text("return_to").notNull(),
    verifier: text().notNull(),
    expiresAt: timestamp("expires_at").notNull(),
  },
  (table) => [
    index("oauth_flows_expires_idx").on(table.expiresAt),
    // Offboarding spends a removed person's open flows.
    index("oauth_flows_user_id_idx").on(table.userId),
  ]
);

/**
 * A connection's OAuth tokens, sealed with AES-GCM (src/vault.ts): nothing
 * here is readable without the key, which only connect holds. The sealed
 * value names the key that sealed it, so a rotated key can still open it.
 * `access_expires_at` is kept in the clear, so a read knows when to
 * refresh without opening anything.
 *
 * `generation` goes up with every write; a write names the generation it
 * read, so a refresh that finishes after a disconnect or another refresh
 * changes nothing (it would store stale tokens, or bring deleted ones
 * back). `refresh_until` is a short lease: while it runs, one refresh is
 * under way and others wait for its result, across isolates.
 */
export const connectionTokens = sqliteTable("connection_tokens", {
  connectionId: text("connection_id")
    .primaryKey()
    .references(() => connections.id),
  sealed: text().notNull(),
  accessExpiresAt: timestamp("access_expires_at").notNull(),
  generation: integer().notNull(),
  refreshUntil: timestamp("refresh_until"),
  updatedAt: timestamp("updated_at").notNull(),
});

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
