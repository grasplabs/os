/**
 * Console D1 schema: intent and history only. What runs in a client's
 * account (live Worker versions, secrets) is read from that account; client
 * account tokens live in Secrets Store, never here (threat model R17).
 */
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

const timestamp = (name: string) => integer(name, { mode: "timestamp_ms" });

/** A release CI built and published, imported once its blobs checked out. */
export const releases = sqliteTable("releases", {
  /** `r<run6>-<sha7>`. */
  id: text().primaryKey(),
  commitSha: text("commit_sha").notNull(),
  /** The release's manifest, as CI wrote it: JSON. */
  manifest: text().notNull(),
  /** The manifest's sha256, hex. */
  manifestSha256: text("manifest_sha256").notNull(),
  builtAt: timestamp("built_at").notNull(),
  importedAt: timestamp("imported_at").notNull(),
});

/**
 * A published release that didn't verify, and when the import tries it
 * again (src/releases/import.ts). Gone once it's imported.
 */
export const releaseImportFailures = sqliteTable("release_import_failures", {
  /** The release's id, as its R2 prefix names it. */
  releaseId: text("release_id").primaryKey(),
  /** Failed attempts so far: the wait before the next one doubles each time. */
  attempts: integer().notNull(),
  failedAt: timestamp("failed_at").notNull(),
  nextAttemptAt: timestamp("next_attempt_at").notNull(),
});

/** A client: one deployment of Grasp OS in its own Cloudflare account. */
export const clients = sqliteTable("clients", {
  /** The client's slug: its subdomain, `<slug>.<domain>`. */
  id: text().primaryKey(),
  name: text().notNull(),
  /** The Cloudflare account the console adopted for it. */
  accountId: text("account_id").notNull().unique(),
  /**
   * The generation of the client's derived secrets: each is
   * `HMAC(<master key>, "<purpose>:<id>:<generation>")`
   * (src/deploy/secrets.ts), so raising it rotates them with nothing
   * stored.
   */
  generation: integer().notNull().default(1),
  /** When the generation last rose; null before the first rotation. */
  rotatedAt: timestamp("rotated_at"),
  /**
   * When a deploy first made the current generation live; null while the
   * last rotation hasn't reached the client yet. The previous generation's
   * keys are kept for a window from here (src/deploy/secrets.ts).
   */
  rotationLiveAt: timestamp("rotation_live_at"),
  /**
   * The account's workers.dev subdomain, where its core answers
   * (`https://<core>.<subdomain>.workers.dev`); null before the first deploy.
   */
  workersSubdomain: text("workers_subdomain"),
  /** The rollout ring it's in: 0 first. */
  ring: integer().notNull().default(1),
  status: text({ enum: ["provisioning", "active", "offboarded"] })
    .notNull()
    .default("provisioning"),
  /** The release it stays on while pinned, whatever the rollouts. */
  pinnedReleaseId: text("pinned_release_id").references(() => releases.id),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
});

/**
 * A Worker the console deployed to a client (core, connect), and what it
 * last deployed there: drift is a live version that differs from this.
 */
export const clientWorkers = sqliteTable(
  "client_workers",
  {
    clientId: text("client_id")
      .notNull()
      .references(() => clients.id),
    worker: text({ enum: ["core", "connect"] }).notNull(),
    /** The script's name in the client's account. */
    scriptName: text("script_name").notNull(),
    releaseId: text("release_id").references(() => releases.id),
    versionId: text("version_id"),
    deployedAt: timestamp("deployed_at"),
  },
  (table) => [primaryKey({ columns: [table.clientId, table.worker] })]
);

/**
 * Making a client's account run a release (src/deploy/deploy.ts): how far
 * it got. Every step can run again, so a deploy that failed is resumed by
 * running it again from the start.
 */
export const clientDeploys = sqliteTable(
  "client_deploys",
  {
    id: text().primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => clients.id),
    releaseId: text("release_id")
      .notNull()
      .references(() => releases.id),
    /** `superseded`: a newer deploy of the client started, so this one no longer runs. */
    status: text({
      enum: ["running", "done", "failed", "superseded"],
    }).notNull(),
    /** The last step that finished, such as `resources`; null before the first. */
    step: text(),
    /** Why it failed: an error code, never a token or a response body. */
    error: text(),
    /**
     * The versions this deploy uploaded, and the secrets generation they
     * carry: JSON, `{"generation": 1, "byApp": {"connect": "<version id>"}}`.
     * A resumed deploy deploys these rather than upload again, unless the
     * generation has changed since.
     */
    versions: text(),
    /** The staff member who started it, or `system`. */
    startedBy: text("started_by").notNull(),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
  },
  (table) => [
    index("client_deploys_client_idx").on(table.clientId, table.createdAt),
  ]
);

/** Rolling a release (or only new secrets) out to clients, ring by ring. */
export const rollouts = sqliteTable(
  "rollouts",
  {
    id: text().primaryKey(),
    /** A release's code, or only new secrets on what runs. */
    kind: text({ enum: ["release", "secrets"] }).notNull(),
    releaseId: text("release_id").references(() => releases.id),
    /** `waiting`: for a staff member's approval of the next ring. */
    status: text({
      enum: ["running", "waiting", "done", "failed", "cancelled"],
    }).notNull(),
    /** The ring it's rolling out to, or waiting after. */
    ring: integer().notNull().default(0),
    /** The staff member who started it. */
    startedBy: text("started_by").notNull(),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
  },
  (table) => [index("rollouts_status_idx").on(table.status)]
);

/** One client in a rollout, and how far it got. */
export const rolloutTargets = sqliteTable(
  "rollout_targets",
  {
    rolloutId: text("rollout_id")
      .notNull()
      .references(() => rollouts.id),
    clientId: text("client_id")
      .notNull()
      .references(() => clients.id),
    ring: integer().notNull(),
    status: text({
      enum: ["pending", "deploying", "done", "failed", "rolled_back"],
    })
      .notNull()
      .default("pending"),
    /** Why it failed: an error code, never a token or a response body. */
    error: text(),
    updatedAt: timestamp("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.rolloutId, table.clientId] }),
    index("rollout_targets_client_idx").on(table.clientId),
  ]
);

/**
 * A client's deployment config (sign-in, model gateway, features), one row
 * per setting. Never a secret: those go straight to the client's Worker.
 */
export const settings = sqliteTable(
  "settings",
  {
    clientId: text("client_id")
      .notNull()
      .references(() => clients.id),
    key: text().notNull(),
    /** JSON. */
    value: text().notNull(),
    updatedBy: text("updated_by").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.clientId, table.key] })]
);

/**
 * Grasp staff, as Access names them. Access decides who reaches the console;
 * this lists who may be granted staff access in a client's deployment.
 */
export const staff = sqliteTable("staff", {
  email: text().primaryKey(),
  name: text().notNull(),
  /** Their Entra object id, which staff sessions in client deployments name. */
  entraOid: text("entra_oid"),
  addedAt: timestamp("added_at").notNull(),
});

/**
 * Every console action, written in the same batch as the change it records
 * (`act` and `actIfChanged`, src/db/act.ts). Append-only; identifiers only, never secrets or
 * content (threat model R16, R17).
 */
export const auditEvents = sqliteTable(
  "audit_events",
  {
    id: text().primaryKey(),
    at: timestamp("at").notNull(),
    /** The staff member's email, or `system` for the console's own jobs. */
    actor: text().notNull(),
    /** A dotted verb, such as `client.create`. */
    action: text().notNull(),
    /** The client it concerns, if any. */
    clientId: text("client_id"),
    /** What it acted on within that client, such as a release or rollout id. */
    target: text(),
    /** Identifiers and counts: JSON, never content. */
    detail: text(),
  },
  (table) => [
    index("audit_events_at_idx").on(table.at),
    index("audit_events_client_idx").on(table.clientId, table.at),
  ]
);
