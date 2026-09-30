import { auditRejectReasons } from "@grasp-os/shared/audit";
/**
 * Connect D1 schema: the connection registry, OAuth and Composio flows under
 * way, the connections' sealed tokens, the stored answers of side effects, the side
 * effects held for their person, the audit outbox, and where connect
 * listens for events and the events it read.
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
    /**
     * For a Composio connection: the MCP server and the auth config
     * Composio made for it, which disconnecting deletes with its account,
     * and the tools the admin allowed, as a JSON array of names, or of
     * rules saying which tools only read and which input property names a
     * tool's resource (`ComposioToolRule`). A call of any other tool is
     * refused, and a Composio connection without them takes no calls.
     */
    composioServerId: text("composio_server_id"),
    composioAuthConfigId: text("composio_auth_config_id"),
    tools: text(),
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
 * `unknown` when the call failed after it may have reached the server, and
 * `declined` when a workflow run's held side effect was declined or
 * dropped (`output` says why): its step's retry fails, never asks again.
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
    state: text({
      enum: ["running", "done", "failed", "unknown", "declined"],
    }).notNull(),
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
    // How a held action ended, found by the key connect made for it.
    index("idempotent_calls_key_idx").on(table.idempotencyKey),
  ]
);

/**
 * Side effects held until the person they act for confirms them (threat
 * model R7, R12, CN7, CN15): those from chat or from a person using an
 * App, and every one of a context that read restricted data. The exact
 * call, and everything its confirmation is checked against. One per
 * subject, person, connection, action and idempotency key, like the
 * answers above, so a repeat of the call finds the same one. A row exists
 * only while it waits: confirming, declining or dropping it deletes it, in
 * one batch with its audit event.
 *
 * `account_id` is the connection's account when it was held: confirmed on
 * a connection that reaches another account, it is refused. `input` is the
 * call's input as JSON, and `input_hash` the SHA-256 of its resource and
 * input, which the confirmation names. `permission_id` and `context` (JSON)
 * are what core checks again when the person confirms it.
 */
export const pendingActions = sqliteTable(
  "pending_actions",
  {
    id: text().primaryKey(),
    subjectType: text("subject_type", { enum: ["app", "agent"] }).notNull(),
    subjectId: text("subject_id").notNull(),
    onBehalfOf: text("on_behalf_of").notNull(),
    /** Asked for with the person there (`interactive`), or by a run. */
    mode: text({ enum: ["interactive", "workflow"] }).notNull(),
    appVersion: integer("app_version"),
    connectionId: text("connection_id").notNull(),
    accountId: text("account_id"),
    resource: text(),
    action: text().notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    input: text().notNull(),
    inputHash: text("input_hash").notNull(),
    permissionId: text("permission_id").notNull(),
    context: text().notNull(),
    /** Asked for by a chat, App or run that had read restricted data. */
    restricted: integer({ mode: "boolean" }).notNull().default(false),
    createdAt: timestamp("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("pending_actions_call_idx").on(
      table.subjectType,
      table.subjectId,
      table.onBehalfOf,
      table.connectionId,
      table.action,
      table.idempotencyKey
    ),
    // A person's list, and dropping theirs when they are removed.
    index("pending_actions_person_idx").on(table.onBehalfOf),
    // Dropping a disconnected connection's.
    index("pending_actions_connection_idx").on(table.connectionId),
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
 * Composio flows under way: one row from the moment an admin consents to
 * connecting a Composio toolkit until Composio sends them back, at most ten
 * minutes. Keyed by the SHA-256 of the flow's `state`, like an OAuth flow,
 * and taken (deleted) the first time its state comes back. The auth config
 * and the connected account are the ones connect made at Composio for this
 * flow: finishing checks the account is that one, active, for that
 * toolkit. `tools` are the tools the admin allowed, as `connections.tools`
 * holds them. `flow_id` ties the admin's consent to the connection it led
 * to, in the audit log.
 */
export const composioFlows = sqliteTable(
  "composio_flows",
  {
    stateHash: text("state_hash").primaryKey(),
    flowId: text("flow_id").notNull(),
    /** The admin who consented: only they can finish it. */
    userId: text("user_id").notNull(),
    toolkit: text().notNull(),
    authConfigId: text("auth_config_id").notNull(),
    connectedAccountId: text("connected_account_id").notNull(),
    tools: text().notNull(),
    returnTo: text("return_to").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
  },
  (table) => [
    index("composio_flows_expires_idx").on(table.expiresAt),
    index("composio_flows_user_id_idx").on(table.userId),
  ]
);

/**
 * What connect made at Composio and still has to delete there: a flow
 * that didn't finish, or a connection that was disconnected, while
 * Composio didn't take the deletion or connect had no Composio key. The
 * cron trigger tries again at `retry_at`, waiting longer after each failed
 * `attempts`, until everything is gone. An account left there may hold
 * tokens, so nothing is forgotten.
 */
export const composioCleanups = sqliteTable(
  "composio_cleanups",
  {
    id: text().primaryKey(),
    serverId: text("server_id"),
    connectedAccountId: text("connected_account_id"),
    authConfigId: text("auth_config_id"),
    /**
     * For a flow's cleanup: the marker everything the flow made at Composio
     * carries in its name, which finds what no ID column names (an ID whose
     * write failed after Composio made it).
     */
    marker: text(),
    attempts: integer().notNull().default(0),
    retryAt: timestamp("retry_at").notNull(),
    createdAt: timestamp("created_at").notNull(),
  },
  (table) => [index("composio_cleanups_retry_idx").on(table.retryAt)]
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
 * Audit events core hasn't appended to the audit log yet. Each call's
 * events are stored here, with the call's own result where it has one;
 * core's cron trigger takes them and acknowledges those it appended
 * (src/audit.ts). `event` is the event as JSON.
 */
export const auditOutbox = sqliteTable("audit_outbox", {
  id: text().primaryKey(),
  event: text().notNull(),
  createdAt: timestamp("created_at").notNull(),
});

/**
 * Outbox rows a drain moved out because the audit log can't take them:
 * `refused` (not an event to the release that drained it, or over the size
 * cap) or `conflict` (the log holds its ID with other content, a bug or a
 * forgery). Kept as they were, for someone to look at; the chain records
 * each with an `audit.gap` naming its ID and reason (src/audit-outbox.ts in
 * core). Nothing reads them.
 */
export const auditOutboxRejected = sqliteTable(
  "audit_outbox_rejected",
  {
    // Its own key, so a second row with the same event ID is kept too.
    seq: integer().primaryKey(),
    id: text().notNull(),
    event: text().notNull(),
    reason: text({ enum: auditRejectReasons }).notNull(),
    /** When the row was stored in the outbox. */
    createdAt: timestamp("created_at").notNull(),
    rejectedAt: timestamp("rejected_at").notNull(),
  },
  (table) => [index("audit_outbox_rejected_id").on(table.id)]
);

/**
 * Where connect listens for events a workflow's trigger waits for
 * (src/events.ts): one row per connection, event type and resource,
 * while some App listens there. `resource` is the mailbox or drive a
 * permission names, or `''` for the account's own, which a permission on
 * the whole connection covers. `cursor` is where reading what changed
 * goes on from: the provider's delta or next-page link, null until the
 * first read sets it. Reading is due at `poll_at`; `failures` counts reads
 * that failed in a row, each waiting longer. `read_at` is when the last
 * read that reached the end of what the provider had began (one that
 * stopped with more to come leaves it), and `lost_at` when the source
 * last lost its cursor, until it has one again. Events are only of what
 * the source got after `created_at`.
 */
export const eventSources = sqliteTable(
  "event_sources",
  {
    id: text().primaryKey(),
    connectionId: text("connection_id").notNull(),
    type: text().notNull(),
    resource: text().notNull(),
    cursor: text(),
    pollAt: timestamp("poll_at").notNull(),
    failures: integer().notNull().default(0),
    readAt: timestamp("read_at"),
    lostAt: timestamp("lost_at"),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("event_sources_key_idx").on(
      table.connectionId,
      table.type,
      table.resource
    ),
    index("event_sources_poll_idx").on(table.pollAt),
  ]
);

/**
 * Events sources reported that core hasn't delivered yet: core takes those
 * due (`retry_at`), delivers them to workflows, and settles them. One per
 * source and the provider's ID of the item (`key`), so an item read twice
 * waits once. A failed delivery is tried again later, `attempts` making
 * each wait longer. `event` is the event as JSON, read from connection
 * `connection_id`: only an active connection's are delivered, and a
 * disconnected one's are dropped.
 */
export const connectorEvents = sqliteTable(
  "connector_events",
  {
    id: text().primaryKey(),
    key: text().notNull(),
    connectionId: text("connection_id").notNull(),
    event: text().notNull(),
    attempts: integer().notNull().default(0),
    retryAt: timestamp("retry_at").notNull(),
    createdAt: timestamp("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("connector_events_key_idx").on(table.key),
    index("connector_events_retry_idx").on(table.retryAt),
    index("connector_events_connection_idx").on(table.connectionId),
  ]
);
