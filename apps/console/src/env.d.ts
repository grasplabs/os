// What the console reads from its env besides wrangler.jsonc's bindings,
// which `wrangler types` can't see. The Access settings come from each
// deploy's `--var` (the deploy workflows; `keep_vars` keeps them across a
// deploy that passes none); the console refuses every request without them.
// CLIENT_DOMAIN comes the same way. Merged into the interface
// worker-configuration.d.ts generates.
interface __BaseEnv_Env {
  /** The Access application's AUD tag (src/access.ts). */
  CF_ACCESS_AUD?: string;
  /** The Access team's URL, `https://<team>.cloudflareaccess.com` (src/access.ts). */
  CF_ACCESS_ISS?: string;
  /**
   * The domain clients are served under, a client being `<id>.<domain>`
   * (src/deploy/context.ts). No client is provisioned or deployed without it.
   */
  CLIENT_DOMAIN?: string;
  /**
   * Grasp's multi-tenant Entra and Google OAuth apps' client ids, which
   * every client's core signs people in with (src/deploy/core-config.ts):
   * not secrets. A client whose sign-in names an IdP without one isn't
   * deployed.
   */
  ENTRA_CLIENT_ID?: string;
  GOOGLE_CLIENT_ID?: string;
  /** Local dev only, from .dev.vars: who requests to this machine come from (src/access.ts). */
  DEV_ACCESS_EMAIL?: string;
}
