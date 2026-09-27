import { auditRejectReasons } from "@grasp-os/shared/audit";
import type { Json } from "@grasp-os/shared/json";
import { signalKinds } from "@grasp-os/shared/signals";
import type { ParamValue, RunFailure } from "@grasp-os/shared/workflows";
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
 * workflow's in `resource`. `actions` is a JSON array of action names.
 */
export const permissions = sqliteTable(
  "permissions",
  {
    id: text().primaryKey(),
    subjectType: text("subject_type", { enum: ["app", "agent"] }).notNull(),
    subjectId: text("subject_id").notNull(),
    objectType: text("object_type", {
      enum: ["connection", "collection", "workflow"],
    }).notNull(),
    objectId: text("object_id").notNull(),
    resource: text(),
    actions: text().notNull(),
    /** A connection permission's masked fields, as a JSON array. */
    mask: text(),
    binding: text().notNull(),
    status: text({ enum: ["requested", "active", "revoked"] }).notNull(),
    requestedBy: text("requested_by").notNull(),
    requestedAt: timestamp("requested_at").notNull(),
    grantedBy: text("granted_by"),
    grantedAt: timestamp("granted_at"),
    revokedBy: text("revoked_by"),
    revokedAt: timestamp("revoked_at"),
  },
  (table) => [
    index("permissions_subject_idx").on(
      table.subjectType,
      table.subjectId,
      table.status
    ),
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
  /** The latest write to the working copy (`app_working_files.revision`). */
  workingRevision: text("working_revision"),
  createdAt: timestamp("created_at").notNull(),
  /**
   * Set while an App created from a blueprint waits for the check that
   * lets it be used (src/app-blueprints.ts); null for every App in use.
   * No path finds a pending App: it is inert until activated, and the
   * cron trigger deletes one left pending.
   */
  pendingSince: timestamp("pending_since"),
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
  },
  (table) => [primaryKey({ columns: [table.appId, table.version] })]
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
 * `owner_waits` and `acting_for`, and the `paused` status, were for a
 * triggered run that paused while its App had no owner. Nothing reads or
 * writes them any more; the previous release still may, and copes with
 * the defaults (0, null) new rows get. They go in a later release
 * (expand, then contract).
 *
 * `waiting_for` is the switched-off feature the run was last seen waiting
 * on, until it goes on: so a run stopped and resumed while it waits (a
 * deploy, a crash) records its wait once, though the resumed execution
 * waits again before the first step it replays (workflows/runs.ts).
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
      enum: ["running", "paused", "completed", "failed", "cancelled"],
    }).notNull(),
    ownerWaits: integer("owner_waits").notNull().default(0),
    createdAt: timestamp("created_at").notNull(),
    endedAt: timestamp("ended_at"),
    failure: text({ mode: "json" }).$type<RunFailure>(),
    actingFor: text("acting_for"),
    waitingFor: text("waiting_for"),
  },
  (table) => [
    index("workflow_runs_app_idx").on(table.appId, table.createdAt),
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
  ]
);

/**
 * Every decision a workflow run waits for (`step.decision`, src/decisions/),
 * one per run and step: who answers it (`deciders`: `person:<id>`,
 * `role:<role>` or `team:<id>`), until when (`expires_at`), and how it
 * ended. `status` moves from `open` once, in one conditional update, to an
 * answer (`approved`, `rejected`) or `timed_out`, so the first answer is
 * the only one. An answer keeps who gave it, when, and the payload they
 * sent (JSON), which the run gets. `decided_via` is no longer read, as
 * links are plain; an answer still writes `rpc` so the previous release
 * reads the row as answered after a rollback. It goes in a later release
 * (expand, then contract).
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
    decidedVia: text("decided_via", { enum: ["link", "rpc"] }),
    payload: text({ mode: "json" }).$type<Json>(),
  },
  (table) => [
    uniqueIndex("workflow_decisions_run_step_idx").on(table.runId, table.step),
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
 * An App's working copy: the files written since its latest version, until
 * they are committed. A null `content` means the file is deleted.
 * `revision` names the write that wrote the row.
 */
export const appWorkingFiles = sqliteTable(
  "app_working_files",
  {
    appId: text("app_id")
      .notNull()
      .references(() => apps.id),
    path: text().notNull(),
    content: text(),
    revision: text().notNull(),
    writtenBy: text("written_by").notNull(),
    writtenAt: timestamp("written_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.appId, table.path] })]
);

/**
 * Legacy, and a later release drops it: permission grants and workflow
 * parameter changes that once needed a second person's approval. Admins
 * grant permissions directly now (src/permissions.ts), and nothing reads or
 * writes this table. It stays, unchanged, so the release before this one
 * still runs against it after a rollback: that release opens an approval
 * for a requested permission that has none when it is granted, and reads
 * every permission by its own `status`, never by its approval.
 */
export const approvals = sqliteTable(
  "approvals",
  {
    id: text().primaryKey(),
    kind: text({ enum: ["permission", "param"] }).notNull(),
    permissionId: text("permission_id").references(() => permissions.id),
    appId: text("app_id"),
    workflowId: text("workflow_id"),
    param: text(),
    value: text({ mode: "json" }).$type<ParamValue>(),
    previous: text({ mode: "json" }).$type<ParamValue>(),
    approvers: text({ enum: ["admins", "builders"] }).notNull(),
    status: text({
      enum: ["pending", "approved", "declined", "withdrawn"],
    }).notNull(),
    requestedBy: text("requested_by").notNull(),
    requestedAt: timestamp("requested_at").notNull(),
    decidedBy: text("decided_by"),
    decidedAt: timestamp("decided_at"),
    breakGlass: integer("break_glass", { mode: "boolean" })
      .notNull()
      .default(false),
    version: integer(),
    decision: text(),
  },
  (table) => [
    uniqueIndex("approvals_pending_permission_idx")
      .on(table.permissionId)
      .where(sql`status = 'pending'`),
    uniqueIndex("approvals_pending_param_idx")
      .on(table.appId, table.workflowId, table.param)
      .where(sql`status = 'pending'`),
    index("approvals_status_idx").on(table.status, table.requestedAt),
  ]
);

/**
 * The values people set for workflows' parameters, one per App, workflow
 * and parameter; a parameter without one has its code's default. `set_by`
 * set it directly. `approval_id` is legacy, and a later release drops it
 * with `approvals`: set only by an approval from when sensitive values
 * needed one, and cleared by the next set.
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
    approvalId: text("approval_id"),
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
 * each other's cost.
 */
export const modelSpend = sqliteTable(
  "model_spend",
  {
    scope: text({ enum: ["deployment", "workflow", "user"] }).notNull(),
    key: text().notNull(),
    period: text().notNull(),
    spentMicros: integer("spent_micros").notNull(),
  },
  (table) => [primaryKey({ columns: [table.scope, table.key, table.period] })]
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
