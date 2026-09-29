// What core reads from its env besides wrangler.jsonc's bindings, which
// `wrangler types` can't see: deployment config the console sets per
// deployment, and switches local dev, tests and on-prem pass. Every one is
// optional: core works, or fails closed, without it. Merged into the
// interface worker-configuration.d.ts generates, which both `Env` and
// `cloudflare:workers`' `env` extend.
interface __BaseEnv_Env {
  /** Sign-in (src/auth/config.ts): JSON, parsed with `deploymentConfig`. */
  SIGN_IN?: unknown;
  ENTRA_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** The model gateway (src/models.ts): JSON. */
  MODEL_GATEWAY?: unknown;
  /** Feature flags (src/features.ts): JSON. */
  FEATURES?: unknown;
  /** Memory files' size limits, in tokens (src/knowledge/memory-files.ts): JSON. */
  MEMORY_LIMITS?: unknown;
  /**
   * The change that made this version (src/platform-updates.ts): JSON,
   * `{by, what, release, at}`, set by the console on every version it
   * deploys.
   */
  PLATFORM_CHANGE?: unknown;
  /** Days the audit log keeps events before archiving (src/audit-log.ts, `retainAuditLog`). */
  AUDIT_RETENTION_DAYS?: unknown;
  /** Days archived audit events are kept before they're purged (src/audit-log.ts). */
  AUDIT_ARCHIVE_RETENTION_DAYS?: unknown;
  /** `none` where Durable Objects have no jurisdiction (src/durable-objects.ts). */
  DURABLE_OBJECT_JURISDICTION?: string;
  /**
   * Tests only: the engine's step limit, when a test lowers it with the
   * workflow's `stepLimit` (src/workflows/host.ts).
   */
  WORKFLOW_STEP_LIMIT?: string;
  /**
   * Tests only: a shorter wait between a run's checks of a switched-off
   * feature (src/workflows/host.ts).
   */
  WORKFLOW_OFF_WAIT_MS?: string;
  /**
   * Tests only: the UTC month model budgets count in, such as `2031-01`
   * (src/model-budgets.ts).
   */
  MODEL_BUDGET_MONTH?: string;
  /**
   * Tests only: fewer connector events one cron run delivers
   * (src/workflows/connector-events.ts).
   */
  CONNECTOR_EVENTS_PER_RUN?: string;
  /** Tests only: a shorter limit for one call into an App (src/app.ts). */
  APP_CALL_TIMEOUT_MS?: string;
  /** Tests only: a shorter wait for a check's builds (src/agent-builds.ts). */
  CHECK_BUILD_WAIT_MS?: string;
  /** The router secret before the current one, while rotating (src/router-secret.ts). */
  ROUTER_SECRET_PREVIOUS?: string;
  /** Local dev only (src/router-secret.ts). */
  DEV_SKIP_ROUTER_SECRET?: string;
  /** Local dev and e2e only: a stand-in for Entra (src/auth/config.ts). */
  DEV_IDP_ORIGIN?: string;
}
