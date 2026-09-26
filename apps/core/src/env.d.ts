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
  /** Days the audit log keeps events before archiving (src/audit-retention.ts). */
  AUDIT_RETENTION_DAYS?: unknown;
  /** `none` where Durable Objects have no jurisdiction (src/durable-objects.ts). */
  DURABLE_OBJECT_JURISDICTION?: string;
  /** Tests only: a shorter limit for one call into an App (src/app.ts). */
  APP_CALL_TIMEOUT_MS?: string;
  /** Local dev only (src/router-secret.ts). */
  DEV_SKIP_ROUTER_SECRET?: string;
}
