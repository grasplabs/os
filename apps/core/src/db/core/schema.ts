import type {
  AgentProposer,
  AppExports,
  AppRecordTypes,
} from "@grasp-os/shared/apps";
import { auditRejectReasons } from "@grasp-os/shared/audit";
import type { Json } from "@grasp-os/shared/json";
import { signalKinds } from "@grasp-os/shared/signals";
import type {
  EventFilter,
  ParamValue,
  RunFailure,
} from "@grasp-os/shared/workflows";
/**
 * Core D1 database: identity (Better Auth), permissions and the App registry.
 *
 * The identity tables are the ones Better Auth and its organization and SSO
 * plugins expect (`src/auth/auth.ts` maps them by these export names), with
 * plural table names and snake_case columns. Better Auth fills ids and
 * timestamps itself.
 */
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const timestamp = (name: string) => integer(name, { mode: "timestamp_ms" });

/** A person. Found by their IdP account, never by email alone. */
export const users = sqliteTable("users", {
  id: text().primaryKey(),
  name: text().notNull(),
  email: text().notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).notNull(),
  image: text(),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
});

/** A signed-in browser. The cookie holds the token; revoking deletes the row. */
export const sessions = sqliteTable(
  "sessions",
  {
    id: text().primaryKey(),
    token: text().notNull().unique(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    activeOrganizationId: text("active_organization_id"),
    activeTeamId: text("active_team_id"),
    /** A Grasp staff session: time-bound, and not a member of the organization. */
    staff: integer({ mode: "boolean" }).notNull().default(false),
  },
  (table) => [index("sessions_user_id_idx").on(table.userId)]
);

/**
 * A person's identity at an IdP: the provider and its stable subject. Sign-in
 * tokens are never stored here (see `src/auth/auth.ts`); the columns exist
 * because Better Auth's model has them.
 */
export const accounts = sqliteTable(
  "accounts",
  {
    id: text().primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at"),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
    scope: text(),
    password: text(),
    /**
     * The Entra object id (`oid`) from the ID token of the latest sign-in,
     * so staff sessions can be checked against the current staff list.
     */
    oid: text(),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
  },
  (table) => [
    index("accounts_user_id_idx").on(table.userId),
    uniqueIndex("accounts_provider_account_idx").on(
      table.providerId,
      table.accountId
    ),
  ]
);

/** Short-lived values, such as the state of a sign-in in progress. */
export const verifications = sqliteTable(
  "verifications",
  {
    id: text().primaryKey(),
    identifier: text().notNull(),
    value: text().notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
  },
  (table) => [index("verifications_identifier_idx").on(table.identifier)]
);

/** The deployment's one organization. */
export const organizations = sqliteTable("organizations", {
  id: text().primaryKey(),
  name: text().notNull(),
  slug: text().notNull().unique(),
  logo: text(),
  metadata: text(),
  createdAt: timestamp("created_at").notNull(),
});

/** A person's place in the organization, with their role. */
export const members = sqliteTable(
  "members",
  {
    id: text().primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text().notNull(),
    createdAt: timestamp("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("members_organization_user_idx").on(
      table.organizationId,
      table.userId
    ),
    index("members_user_id_idx").on(table.userId),
  ]
);

/**
 * People an admin removed from the organization. Everyone else from the
 * client's IdP gets a membership when they sign in if they have none (also
 * repairing one whose creation failed); a removal recorded here keeps them
 * out. Kept apart from `members`, whose rows the organization plugin treats
 * as live memberships. Who removed them is in the audit log.
 */
export const memberRemovals = sqliteTable(
  "member_removals",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    removedAt: timestamp("removed_at").notNull(),
    /**
     * When connect completed disconnecting their personal connections;
     * until then the cron trigger retries it (`retryDisconnects`).
     */
    disconnectedAt: timestamp("disconnected_at"),
  },
  (table) => [primaryKey({ columns: [table.organizationId, table.userId] })]
);

/**
 * Part of the organization plugin's model. Invitations aren't offered: people
 * join by signing in with the deployment's IdP.
 */
export const invitations = sqliteTable(
  "invitations",
  {
    id: text().primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: text().notNull(),
    role: text(),
    teamId: text("team_id"),
    status: text().notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").notNull(),
    inviterId: text("inviter_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (table) => [
    index("invitations_organization_id_idx").on(table.organizationId),
    index("invitations_email_idx").on(table.email),
  ]
);

export const teams = sqliteTable(
  "teams",
  {
    id: text().primaryKey(),
    name: text().notNull(),
    memberCount: integer("member_count").notNull().default(0),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at"),
  },
  (table) => [index("teams_organization_id_idx").on(table.organizationId)]
);

export const teamMembers = sqliteTable(
  "team_members",
  {
    id: text().primaryKey(),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    membershipKey: text("membership_key").unique(),
    createdAt: timestamp("created_at"),
  },
  (table) => [
    index("team_members_team_id_idx").on(table.teamId),
    index("team_members_user_id_idx").on(table.userId),
  ]
);

/**
 * Part of the SSO plugin's model, and stays empty: sign-in providers come
 * only from deployment config, and registering one in-product is refused.
 */
export const ssoProviders = sqliteTable("sso_providers", {
  id: text().primaryKey(),
  issuer: text().notNull(),
  oidcConfig: text("oidc_config"),
  samlConfig: text("saml_config"),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
  providerId: text("provider_id").notNull().unique(),
  organizationId: text("organization_id"),
  domain: text().notNull(),
});

/**
 * Audit events of changes to this database that haven't reached the audit
 * log yet. Each is written in the same batch as its change, so a change is
 * never kept without its event; `src/audit-outbox.ts` appends them to the
 * log and removes them. `event` is the event as JSON.
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
 * What each App and agent may use: one row per permission, never deleted,
 * so who asked, who granted and who revoked stays readable. Only its status
 * and the grant and revoke columns ever change.
 *
 * The object is stored by type: a connection is `object_id`, with
 * `resource` naming one resource in it or null for all of it; a collection
 * is `object_id`; a workflow is its App's ID in `object_id` and the
 * workflow's in `resource`; another App's exports are that App's ID in
 * `object_id`. `actions` is a JSON array of action names.
 */
export const permissions = sqliteTable(
  "permissions",
  {
    id: text().primaryKey(),
    subjectType: text("subject_type", { enum: ["app", "agent"] }).notNull(),
    subjectId: text("subject_id").notNull(),
    objectType: text("object_type", {
      enum: ["connection", "collection", "workflow", "app", "platform"],
    }).notNull(),
    objectId: text("object_id").notNull(),
    resource: text(),
    actions: text().notNull(),
    binding: text().notNull(),
    status: text({ enum: ["requested", "active", "revoked"] }).notNull(),
    requestedBy: text("requested_by").notNull(),
    requestedAt: timestamp("requested_at").notNull(),
    grantedBy: text("granted_by"),
    grantedAt: timestamp("granted_at"),
    revokedBy: text("revoked_by"),
    revokedAt: timestamp("revoked_at"),
    /**
     * The chat's agent that asked for it, for `requested_by` (JSON,
     * `AgentProposer`); null when the person asked themselves. A row the
     * previous release writes gets none.
     */
    requestedVia: text("requested_via", {
      mode: "json",
    }).$type<AgentProposer>(),
  },
  (table) => [
    index("permissions_subject_idx").on(
      table.subjectType,
      table.subjectId,
      table.status
    ),
    // The Apps granted to call an App's exports, found from that App
    // (app-provenance.ts): by object, not subject.
    index("permissions_object_idx").on(table.objectType, table.objectId),
    // A binding name is one stub in the subject's env, so it is unique
    // among the permissions that aren't revoked.
    uniqueIndex("permissions_live_binding_idx")
      .on(table.subjectType, table.subjectId, table.binding)
      .where(sql`status <> 'revoked'`),
  ]
);

/**
 * The App registry. Each App's code is a series of versions
 * (`app_versions`); `current_version` is the one that runs and
 * `pending_version` one put up for review. Both only ever name a version
 * the App has.
 */
export const apps = sqliteTable("apps", {
  id: text().primaryKey(),
  name: text().notNull(),
  description: text().notNull(),
  /** The user who created it. */
  ownerId: text("owner_id").notNull(),
  blueprint: text(),
  currentVersion: integer("current_version"),
  pendingVersion: integer("pending_version"),
  createdAt: timestamp("created_at").notNull(),
});

/**
 * Whom each App is shared with (src/app-access.ts): a person
 * (`member_type` `person`, `member_id` their user ID) or a team, with their
 * role in it. Sharing again changes the role; unsharing deletes the row.
 * Who did which is in the audit log. The App's owner has no row: they are
 * always one of its builders.
 */
export const appMembers = sqliteTable(
  "app_members",
  {
    appId: text("app_id")
      .notNull()
      .references(() => apps.id),
    memberType: text("member_type", { enum: ["person", "team"] }).notNull(),
    memberId: text("member_id").notNull(),
    role: text({ enum: ["user", "builder"] }).notNull(),
    addedBy: text("added_by").notNull(),
    addedAt: timestamp("added_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.appId, table.memberType, table.memberId] }),
    // Which Apps are shared with someone, for listing theirs.
    index("app_members_member_idx").on(table.memberType, table.memberId),
  ]
);

/**
 * The versions of Apps marked as blueprints (src/app-blueprints.ts), to
 * create Apps from. Unmarking deletes the row; who marked and unmarked
 * which is in the audit log. A version itself never changes, so a
 * blueprint's code never does either.
 */
export const appBlueprints = sqliteTable(
  "app_blueprints",
  {
    appId: text("app_id")
      .notNull()
      .references(() => apps.id),
    version: integer().notNull(),
    markedBy: text("marked_by").notNull(),
    markedAt: timestamp("marked_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.appId, table.version] })]
);

/**
 * Every committed version of an App, never changed or deleted. `tree` is
 * the SHA-256 of the version's files, which are stored under it in R2
 * (`src/apps.ts`). Versions count up from 1 per App, and the primary key
 * makes two commits of the same version conflict instead of both landing.
 */
export const appVersions = sqliteTable(
  "app_versions",
  {
    appId: text("app_id")
      .notNull()
      .references(() => apps.id),
    version: integer().notNull(),
    parent: integer(),
    tree: text().notNull(),
    files: integer().notNull(),
    authorId: text("author_id").notNull(),
    message: text().notNull(),
    createdAt: timestamp("created_at").notNull(),
    /**
     * Whether an admin approved this version's code for the App's
     * permissions to change things with (permissions.ts, `authorize`): 1
     * once an admin made it current or granted a permission while it was,
     * or it is an App's first version copied from a blueprint; 0 once
     * someone who couldn't grant made it current, until then. Null for a
     * version made current before this column, which counts as approved,
     * and for one never made current, which never runs.
     */
    approved: integer(),
    /**
     * The IDs of the version's workflows (JSON), written when it is
     * committed, as a version never changes: so listing an App's
     * workflows reads no files (workflows/overview.ts). A row the
     * previous release writes gets none (the default).
     */
    workflows: text({ mode: "json" })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    /**
     * The version's exports (JSON, `AppExports`), read from its
     * `app/exports.json` when it is committed (app-exports.ts): so a call
     * from another App reads no files to find what it may call.
     */
    exports: text({ mode: "json" })
      .$type<AppExports>()
      .notNull()
      .default(sql`'{}'`),
    /**
     * The chat's agent that wrote and proposed it, for `author_id` (JSON,
     * `AgentProposer`); null for a version a person committed. A row the
     * previous release writes gets none.
     */
    proposedBy: text("proposed_by", { mode: "json" }).$type<AgentProposer>(),
    /**
     * The version's record types (JSON, `AppRecordTypes`), read from its
     * `app/records.json` when it is committed (app-records.ts): so a save
     * to Knowledge reads no files to find the types it is checked against.
     */
    records: text({ mode: "json" })
      .$type<AppRecordTypes>()
      .notNull()
      .default(sql`'{}'`),
  },
  (table) => [primaryKey({ columns: [table.appId, table.version] })]
);

/**
 * Which App a record type in a collection (a Knowledge collection, by ID)
 * belongs to: the first whose declaration took effect there
 * (knowledge/record-types.ts). Claimed when an App's write permission on
 * the collection is granted or its version is made current, and kept
 * while that App may write there with a version that declares the type;
 * another App claims it only once it no longer does.
 */
export const recordTypeOwners = sqliteTable(
  "record_type_owners",
  {
    collectionId: text("collection_id").notNull(),
    type: text().notNull(),
    appId: text("app_id").notNull(),
    claimedAt: timestamp("claimed_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.collectionId, table.type] })]
);

/**
 * Every run of an App's workflow (src/workflows/): the App version it is
 * pinned to, and who it acts for. A run a person started acts for them
 * (`started_by`); one a trigger started (`started_by` null) for the App's
 * owner. Cloudflare Workflows keeps the run's steps; this row is what core
 * needs to load it again, and lists runs. `status` is where the run was
 * last seen by core: `running` covers waiting too. `failure` is a failed
 * run's report (JSON): where and why it stopped, without the values it
 * worked on.
 *
 * `details_removed_at` is when an ended run's details were removed, its
 * retention over (workflows/retention.ts): the engine's record of it (its
 * input, what its steps returned, its output), the message of its
 * `failure` and the key of the step that names, and what its decisions
 * asked and were answered, with the keys of their steps. The row itself
 * stays, so the run is still listed, counted and found by the
 * audit log's events of it, and its trigger key still stands for it.
 */
export const workflowRuns = sqliteTable(
  "workflow_runs",
  {
    id: text().primaryKey(),
    appId: text("app_id")
      .notNull()
      .references(() => apps.id),
    workflowId: text("workflow_id").notNull(),
    version: integer().notNull(),
    startedBy: text("started_by"),
    status: text({
      // `starting`: written, its engine instance not yet known to exist
      // (src/workflows/runs.ts, `startRun`).
      enum: [
        "starting",
        "running",
        "paused",
        "completed",
        "failed",
        "cancelled",
      ],
    }).notNull(),
    createdAt: timestamp("created_at").notNull(),
    endedAt: timestamp("ended_at"),
    failure: text({ mode: "json" }).$type<RunFailure>(),
    /**
     * What a trigger started it for (src/workflows/triggers.ts): one key
     * per scheduled time, so the same one delivered twice starts one run.
     * Null for a run a person started, and for one whose start failed,
     * which gives its key up for the delivery tried again.
     */
    triggerKey: text("trigger_key"),
    detailsRemovedAt: timestamp("details_removed_at"),
  },
  (table) => [
    index("workflow_runs_app_idx").on(table.appId, table.createdAt),
    // Runs across Apps, newest first: the Workflows page's Runs tab
    // (src/workflows/overview.ts).
    index("workflow_runs_created_idx").on(table.createdAt, table.id),
    // An App's runs of one workflow, newest first: what its screens list.
    index("workflow_runs_app_workflow_idx").on(
      table.appId,
      table.workflowId,
      table.createdAt
    ),
    // The improvement signals (src/signals.ts): runs that failed in a
    // window, latest first. Runs started in one are counted per App
    // workflow by the index above.
    index("workflow_runs_status_ended_idx").on(
      table.status,
      table.endedAt,
      table.id
    ),
    uniqueIndex("workflow_runs_trigger_key_idx").on(table.triggerKey),
    // The retention sweep (src/workflows/retention.ts): ended runs that
    // still have their details, longest ended first, then by ID, which
    // the sweep pages by. Only those: a live run has no `ended_at`, and a
    // swept one leaves the index.
    index("workflow_runs_details_kept_idx")
      .on(table.endedAt, table.id)
      .where(sql`ended_at IS NOT NULL AND details_removed_at IS NULL`),
  ]
);

/**
 * The triggers of the workflows in each App's current version
 * (src/workflows/trigger-registry.ts), written when a version is made
 * current and removed when another is. `position` is the trigger's place
 * among its workflow's. A schedule keeps its cron expression as its
 * parameter holds it now (`cron`), in its time zone, when it next
 * fires (`next_run_at`), and how many starts of its run have failed in a
 * row (`failed_starts`): at `maxFailedStarts` it stops, with no next time
 * (src/workflows/triggers.ts). An email trigger keeps the address it receives
 * mail at (`address`, the part before the `@`); an event trigger its event
 * type (`event`) and filter (`filter`, JSON).
 */
export const workflowTriggers = sqliteTable(
  "workflow_triggers",
  {
    id: text().primaryKey(),
    appId: text("app_id")
      .notNull()
      .references(() => apps.id),
    version: integer().notNull(),
    workflowId: text("workflow_id").notNull(),
    position: integer().notNull(),
    type: text({ enum: ["schedule", "email", "event"] }).notNull(),
    param: text(),
    cron: text(),
    timeZone: text("time_zone"),
    nextRunAt: timestamp("next_run_at"),
    createdAt: timestamp("created_at").notNull(),
    address: text(),
    event: text(),
    filter: text({ mode: "json" }).$type<EventFilter>(),
    failedStarts: integer("failed_starts").notNull().default(0),
  },
  (table) => [
    uniqueIndex("workflow_triggers_position_idx").on(
      table.appId,
      table.version,
      table.workflowId,
      table.position
    ),
    index("workflow_triggers_next_run_idx").on(table.nextRunAt),
    index("workflow_triggers_address_idx").on(table.address),
    index("workflow_triggers_event_idx").on(table.event),
  ]
);

/**
 * Every decision a workflow run waits for (`step.decision`, src/decisions/),
 * one per run and step: who answers it (`deciders`: `person:<id>`,
 * `role:<role>` or `team:<id>`), until when (`expires_at`), and how it
 * ended. `status` moves from `open` once, in one conditional update, to an
 * answer (`approved`, `rejected`) or `timed_out`, so the first answer is
 * the only one. An answer keeps who gave it, when, and the payload they
 * sent (JSON), which the run gets.
 */
export const workflowDecisions = sqliteTable(
  "workflow_decisions",
  {
    id: text().primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => workflowRuns.id),
    step: text().notNull(),
    deciders: text().notNull(),
    description: text().notNull(),
    status: text({
      enum: ["open", "approved", "rejected", "timed_out"],
    }).notNull(),
    openedAt: timestamp("opened_at").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    decidedBy: text("decided_by"),
    decidedAt: timestamp("decided_at"),
    payload: text({ mode: "json" }).$type<Json>(),
  },
  (table) => [
    uniqueIndex("workflow_decisions_run_step_idx").on(table.runId, table.step),
    // A run's open decisions (src/workflows/overview.ts): whether it waits.
    index("workflow_decisions_run_status_idx").on(table.runId, table.status),
    // The improvement signals (src/signals.ts): open decisions, oldest
    // first, and decisions answered in a window, latest first.
    index("workflow_decisions_status_opened_idx").on(
      table.status,
      table.openedAt,
      table.id
    ),
    index("workflow_decisions_decided_idx").on(table.decidedAt, table.id),
  ]
);

/**
 * The values people set for workflows' parameters, one per App, workflow
 * and parameter; a parameter without one has its code's default. `set_by`
 * set it directly.
 */
export const workflowParamValues = sqliteTable(
  "workflow_param_values",
  {
    appId: text("app_id")
      .notNull()
      .references(() => apps.id),
    workflowId: text("workflow_id").notNull(),
    param: text().notNull(),
    value: text({ mode: "json" }).$type<ParamValue>().notNull(),
    setBy: text("set_by").notNull(),
    setAt: timestamp("set_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.appId, table.workflowId, table.param] }),
  ]
);

/**
 * What model calls cost, in millionths of a US dollar, per budget and
 * month (model-rules.ts): `scope` is the budget's (`deployment`, `workflow`
 * or `user`), `key` what it counts within it (the deployment, a workflow
 * or a person, as JSON), and `period` the UTC month, such as `2026-09`.
 * Only ever added to, in one statement, so concurrent calls never lose
 * each other's cost. `model_spend_top_idx` reads a budget's month most
 * first, ties by `key` descending, without sorting (`budgetSpend`).
 */
export const modelSpend = sqliteTable(
  "model_spend",
  {
    scope: text({ enum: ["deployment", "workflow", "user"] }).notNull(),
    key: text().notNull(),
    period: text().notNull(),
    spentMicros: integer("spent_micros").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scope, table.key, table.period] }),
    index("model_spend_top_idx").on(
      table.scope,
      table.period,
      table.spentMicros,
      table.key
    ),
  ]
);

/**
 * The budget alerts admins got, one per budget, month, kind (`alert` at
 * the alert threshold, `exhausted` at the limit) and threshold value in
 * millionths of a dollar (model-budgets.ts): an alert is stored only with
 * a new row here, so each value alerts once a month, however often the
 * config changes it.
 */
export const modelBudgetAlerts = sqliteTable(
  "model_budget_alerts",
  {
    scope: text({ enum: ["deployment", "workflow", "user"] }).notNull(),
    key: text().notNull(),
    period: text().notNull(),
    kind: text({ enum: ["alert", "exhausted"] }).notNull(),
    thresholdMicros: integer("threshold_micros").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.scope,
        table.key,
        table.period,
        table.kind,
        table.thresholdMicros,
      ],
    }),
  ]
);

/**
 * The catalog entries an admin stopped offering (connections.ts): one row
 * each, by its source (`native` or `composio`) and its ID there. Nobody
 * starts connecting a hidden entry, admins included, until an admin offers
 * it again, which deletes its row. Everything else is offered, a new
 * Composio toolkit too. Connections made before an entry was hidden go on.
 */
export const hiddenConnectors = sqliteTable(
  "hidden_connectors",
  {
    source: text({ enum: ["native", "composio"] }).notNull(),
    connectorId: text("connector_id").notNull(),
    hiddenBy: text("hidden_by").notNull(),
    hiddenAt: timestamp("hidden_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.source, table.connectorId] })]
);

/**
 * Each computation of the improvement signals (src/signals.ts), one a UTC
 * day: `started_at` claims it, `finished_at` is set once all its signals
 * are written. The signals people read are those of the finished one
 * started last; finishing deletes every computation started before it,
 * with its signals.
 */
export const improvementSignalComputations = sqliteTable(
  "improvement_signal_computations",
  {
    id: text().primaryKey(),
    /** The UTC day it is the computation of, such as `2026-09-27`. */
    day: text().notNull(),
    startedAt: timestamp("started_at").notNull(),
    finishedAt: timestamp("finished_at"),
  },
  (table) => [
    index("improvement_signal_computations_day_idx").on(table.day),
    index("improvement_signal_computations_started_idx").on(table.startedAt),
  ]
);

/**
 * The improvement signals of a computation: one per kind, App, workflow
 * and subject (the deciders, the step, a search's key). `app_id` and
 * `workflow_id` are empty for the deployment's own signals and for none.
 * `value` ranks it within its kind; `evidence` is JSON, IDs and counts
 * only (@grasp-os/shared/signals).
 */
export const improvementSignals = sqliteTable(
  "improvement_signals",
  {
    computation: text()
      .notNull()
      .references(() => improvementSignalComputations.id),
    appId: text("app_id").notNull(),
    workflowId: text("workflow_id").notNull(),
    kind: text({ enum: signalKinds }).notNull(),
    subject: text().notNull(),
    value: real().notNull(),
    evidence: text({ mode: "json" }).$type<Json>().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.computation,
        table.appId,
        table.workflowId,
        table.kind,
        table.subject,
      ],
    }),
    index("improvement_signals_kind_idx").on(
      table.computation,
      table.kind,
      table.value
    ),
  ]
);

/**
 * The statistics Apps record (src/statistics.ts), added up by the UTC day:
 * one row per App, measure, day and dimensions (canonical JSON), holding
 * how many points, their sum, lowest and highest. So a read over a year
 * reads at most a day's rows (`statisticRowsPerDay`) for each day, and a
 * point is one upsert. Rows past the retention (`statisticRetentionDays`)
 * are swept.
 */
export const appStatistics = sqliteTable(
  "app_statistics",
  {
    appId: text("app_id").notNull(),
    measure: text().notNull(),
    /** `YYYY-MM-DD`, UTC. */
    day: text().notNull(),
    /** Canonical JSON of the point's dimensions, `{}` for none. */
    dimensions: text().notNull(),
    count: integer().notNull(),
    sum: real().notNull(),
    min: real().notNull(),
    max: real().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.appId, table.measure, table.day, table.dimensions],
    }),
    // A day's rows of an App, counted against its daily bound.
    index("app_statistics_app_day_idx").on(table.appId, table.day),
    // The sweep of rows past the retention.
    index("app_statistics_day_idx").on(table.day),
  ]
);

/**
 * The statistics points the attempts of a workflow run's steps recorded
 * through Apps' methods, not yet added up (src/statistics.ts): one row
 * per step (its idempotency key), attempt, App, measure, day and
 * dimensions, holding what `app_statistics` holds of them. When a step
 * that called an App completes, the points of the attempt that completed
 * it are added to `app_statistics`, and the step gets its marker (a row
 * of no App and no measure, `committed`), in one batch; no other
 * attempt's ever are, and a step with its marker adds nothing again.
 * Kept only while the run hasn't ended, and deleted when it ends.
 */
export const appStatisticSteps = sqliteTable(
  "app_statistic_steps",
  {
    /** The step's idempotency key (`stepIdempotencyKey`): its run's ID first. */
    stepKey: text("step_key").notNull(),
    /** The attempt of the step, an ID the run's engine gives each. */
    attempt: text().notNull(),
    appId: text("app_id").notNull(),
    measure: text().notNull(),
    /** `YYYY-MM-DD`, UTC. */
    day: text().notNull(),
    /** Canonical JSON of the point's dimensions, `{}` for none. */
    dimensions: text().notNull(),
    count: integer().notNull(),
    sum: real().notNull(),
    min: real().notNull(),
    max: real().notNull(),
    /** Set on the step's marker only: the step completed with this attempt. */
    committed: integer({ mode: "boolean" }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.stepKey,
        table.attempt,
        table.appId,
        table.measure,
        table.day,
        table.dimensions,
      ],
    }),
  ]
);

/**
 * Every version of core the cron has seen running (src/platform-updates.ts),
 * each recorded once: the insert of a version not here is audited as
 * `platform.updated` in the same batch.
 */
export const platformVersions = sqliteTable("platform_versions", {
  versionId: text("version_id").primaryKey(),
  recordedAt: timestamp("recorded_at").notNull(),
});

/**
 * What core tells a person in the product (src/notifications.ts): for
 * now, that a workflow failed while acting for them (`run_failed`). One
 * unread row per person, App and workflow: another failure while it is
 * unread counts on it (`failures`) and names the latest run (`run_id`), so
 * a workflow that fails every minute makes one row, not thousands. Once
 * read (`read_at`), the next failure makes a new one. The person's rows
 * read over 30 days ago go when they next read, and all of them when
 * they are removed from the organization.
 */
export const notifications = sqliteTable(
  "notifications",
  {
    id: text().primaryKey(),
    personId: text("person_id").notNull(),
    type: text({ enum: ["run_failed"] }).notNull(),
    appId: text("app_id").notNull(),
    workflowId: text("workflow_id").notNull(),
    runId: text("run_id").notNull(),
    failures: integer().notNull(),
    createdAt: timestamp("created_at").notNull(),
    /** When it last changed: the latest failure it counts. */
    updatedAt: timestamp("updated_at").notNull(),
    readAt: timestamp("read_at"),
  },
  (table) => [
    // A person's list, latest first.
    index("notifications_person_idx").on(
      table.personId,
      table.updatedAt,
      table.id
    ),
    // The one unread row a failure counts on, and the unread count.
    uniqueIndex("notifications_unread_idx")
      .on(table.personId, table.type, table.appId, table.workflowId)
      .where(sql`read_at IS NULL`),
  ]
);

/**
 * A guest chat (src/guests.ts): someone who isn't a member, invited by an
 * App for one of its people, chatting with a model through a link. The
 * link's secret is never stored, only its SHA-256 (`token_hash`). A chat
 * takes one turn at a time: `busy_until` is set while one is under way,
 * and a turn claims it only when it is unset or past.
 */
export const guestChats = sqliteTable(
  "guest_chats",
  {
    id: text().primaryKey(),
    appId: text("app_id").notNull(),
    /** The permission it was made under: each turn needs it still active. */
    permissionId: text("permission_id").notNull(),
    /** The member it was made for: its turns spend their model budget. */
    invitedBy: text("invited_by").notNull(),
    name: text().notNull(),
    skill: text().notNull(),
    /** The model it talks with, the deployment's first when invited. */
    model: text().notNull(),
    tokenHash: text("token_hash").notNull(),
    turns: integer().notNull(),
    busyUntil: timestamp("busy_until"),
    createdAt: timestamp("created_at").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    /** When the guest first opened it. */
    openedAt: timestamp("opened_at"),
    /** When the guest finished it, or it was revoked. */
    endedAt: timestamp("ended_at"),
    ended: text({ enum: ["finished", "revoked"] }),
  },
  (table) => [
    uniqueIndex("guest_chats_token_idx").on(table.tokenHash),
    // An App's chats, newest first.
    index("guest_chats_app_idx").on(table.appId, table.createdAt, table.id),
    // An App's chats that haven't ended, newest first: listed first, and
    // counted as it invites. Expired ones stay in it until they are swept.
    index("guest_chats_open_idx")
      .on(table.appId, table.createdAt, table.id)
      .where(sql`ended IS NULL`),
    // What the retention sweep deletes, oldest first.
    index("guest_chats_expires_idx").on(table.expiresAt),
  ]
);

/** A guest chat's messages, in order: the guest's, and the model's answers. */
export const guestMessages = sqliteTable(
  "guest_messages",
  {
    chatId: text("chat_id")
      .notNull()
      .references(() => guestChats.id, { onDelete: "cascade" }),
    seq: integer().notNull(),
    role: text({ enum: ["guest", "agent"] }).notNull(),
    text: text().notNull(),
    createdAt: timestamp("created_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.chatId, table.seq] })]
);
