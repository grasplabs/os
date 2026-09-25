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
 * queue yet. Each is written in the same batch as its change, so a change
 * is never kept without its event; `src/audit-outbox.ts` sends and removes
 * them. `event` is the event as JSON.
 */
export const auditOutbox = sqliteTable("audit_outbox", {
  id: text().primaryKey(),
  event: text().notNull(),
  createdAt: timestamp("created_at").notNull(),
});

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
  createdAt: timestamp("created_at").notNull(),
});

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
 * An App's working copy: the files written since its latest version, until
 * they are committed. `blob` is the SHA-256 of the content, stored in R2;
 * null means the file is deleted. `length` is the content's length.
 */
export const appWorkingFiles = sqliteTable(
  "app_working_files",
  {
    appId: text("app_id")
      .notNull()
      .references(() => apps.id),
    path: text().notNull(),
    blob: text(),
    length: integer().notNull(),
    writtenBy: text("written_by").notNull(),
    writtenAt: timestamp("written_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.appId, table.path] })]
);
