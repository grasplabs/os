import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { z } from "zod";

/** A database's migrations, read by vite.config.ts into a binding. */
const migrationsSchema = z.array(
  z.object({ name: z.string(), queries: z.array(z.string()) })
);

// Runs before each test file; applying is idempotent.
await applyD1Migrations(
  env.DB,
  migrationsSchema.parse(Reflect.get(env, "CORE_MIGRATIONS"))
);
await applyD1Migrations(
  env.KNOWLEDGE,
  migrationsSchema.parse(Reflect.get(env, "KNOWLEDGE_MIGRATIONS"))
);
