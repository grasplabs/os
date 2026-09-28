// What the console reads from its env besides wrangler.jsonc's bindings,
// which `wrangler types` can't see. The Access settings come from each
// deploy's `--var` (the deploy workflows; `keep_vars` keeps them across a
// deploy that passes none); the console refuses every request without them. Merged into the interface
// worker-configuration.d.ts generates.
interface __BaseEnv_Env {
  /** The Access application's AUD tag (src/access.ts). */
  CF_ACCESS_AUD?: string;
  /** The Access team's URL, `https://<team>.cloudflareaccess.com` (src/access.ts). */
  CF_ACCESS_ISS?: string;
  /** Local dev only, from .dev.vars: who requests to this machine come from (src/access.ts). */
  DEV_ACCESS_EMAIL?: string;
}
