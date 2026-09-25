import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { z } from "zod";

/** Migrations, read by vite.config.ts into bindings. */
const migrationsSchema = z.array(
  z.object({ name: z.string(), queries: z.array(z.string()) })
);

const isDatabase = (value: unknown): value is D1Database =>
  typeof value === "object" &&
  value !== null &&
  "prepare" in value &&
  "batch" in value;

// Runs before each test file; applying is idempotent.
await applyD1Migrations(
  env.DB,
  migrationsSchema.parse(Reflect.get(env, "CORE_MIGRATIONS"))
);
await applyD1Migrations(
  env.KNOWLEDGE,
  migrationsSchema.parse(Reflect.get(env, "KNOWLEDGE_MIGRATIONS"))
);

// Connect's database too: core's tests call the real connect Worker, which
// reads its connection registry there.
const connectDb: unknown = Reflect.get(env, "CONNECT_DB");
if (!isDatabase(connectDb)) {
  throw new TypeError("Expected connect's database as CONNECT_DB");
}
await applyD1Migrations(
  connectDb,
  migrationsSchema.parse(Reflect.get(env, "CONNECT_MIGRATIONS"))
);
