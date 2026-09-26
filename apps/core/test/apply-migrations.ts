import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { z } from "zod";

import { connectDb, testBinding } from "./test-env.ts";

/** Migrations, read by vite.config.ts into bindings. */
const migrationsSchema = z.array(
  z.object({ name: z.string(), queries: z.array(z.string()) })
);

// Runs before each test file; applying is idempotent.
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
