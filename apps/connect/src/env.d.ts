// The secrets connect reads besides those wrangler.jsonc requires, which
// `wrangler types` can't see. Each is optional: connect takes calls without
// them, and whatever needs one fails closed while it is unset. Merged into
// the interface worker-configuration.d.ts generates.
interface __BaseEnv_Env {
  /** Only while rotating: the capability key core signed with before. */
  CAPABILITY_SIGNING_KEY_PREVIOUS?: string;
  /**
   * Seals OAuth tokens (src/vault.ts): 32 random bytes in base64, e.g.
   * `openssl rand -base64 32`. Without it nobody can connect an account.
   */
  TOKEN_ENCRYPTION_KEY?: string;
  /** Only while rotating: the key that sealed tokens before. */
  TOKEN_ENCRYPTION_KEY_PREVIOUS?: string;
  /** Grasp's multi-tenant Entra app for connections (src/providers.ts). */
  MICROSOFT_CLIENT_ID?: string;
  MICROSOFT_CLIENT_SECRET?: string;
  /** Grasp's Google OAuth client for connections (src/providers.ts). */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /**
   * Deployment config the console used to set: the hosts a connector's
   * download could be redirected to. No longer read: a download follows
   * its route's own redirect hosts (src/egress.ts). An existing value is
   * left alone, and harmless.
   */
  DOWNLOAD_HOSTS?: unknown;
}
