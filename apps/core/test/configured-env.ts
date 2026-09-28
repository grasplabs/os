import { env } from "cloudflare:workers";

/**
 * Core's test env as vite.config.ts configures it. A module is evaluated
 * once per runtime, when the first test file's setup imports it, so this
 * is the env before any test changed it (see start-each-file.ts).
 */
export const configuredEnv: ReadonlyMap<string, unknown> = new Map(
  Object.entries(env)
);
