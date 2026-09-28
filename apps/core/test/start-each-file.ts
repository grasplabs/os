/**
 * Runs before each test file. Files share a runtime, one per Vitest worker
 * (`isolate: false` in vite.config.ts), so each starts where a runtime of
 * its own would: empty storage, the env as configured, real timers, and
 * the databases at the committed migrations.
 */
import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { vi } from "vite-plus/test";
import { z } from "zod";

import { configuredEnv } from "./configured-env.ts";
import { connectDb, testBinding } from "./test-env.ts";

/** Migrations, read by vite.config.ts into bindings. */
const migrationsSchema = z.array(
  z.object({ name: z.string(), queries: z.array(z.string()) })
);

// Every Durable Object's storage, and with it every D1 database, R2 bucket
// and workflow, connect's included: they are all Durable Objects locally.
await reset();

// What a test changed in the env and didn't put back: restore it.
for (const name of Object.keys(env)) {
  if (!configuredEnv.has(name)) {
    Reflect.deleteProperty(env, name);
  }
}
for (const [name, value] of configuredEnv) {
  Reflect.set(env, name, value);
}

vi.useRealTimers();

await applyD1Migrations(
  env.DB,
  migrationsSchema.parse(testBinding("CORE_MIGRATIONS"))
);
await applyD1Migrations(
  env.KNOWLEDGE,
  migrationsSchema.parse(testBinding("KNOWLEDGE_MIGRATIONS"))
);

// Connect's database too: core's tests call the real connect Worker, which
// reads its connection registry there.
await applyD1Migrations(
  connectDb(),
  migrationsSchema.parse(testBinding("CONNECT_MIGRATIONS"))
);
