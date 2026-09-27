import { applyD1Migrations } from "cloudflare:test";
import type { D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";

/** The console's migrations, read by vite.test.config.ts into a binding. */
const migrations: unknown = Reflect.get(env, "CONSOLE_MIGRATIONS");

const isMigrationList = (value: unknown): value is D1Migration[] =>
  Array.isArray(value) &&
  value.every(
    (migration: unknown) =>
      typeof migration === "object" &&
      migration !== null &&
      "name" in migration &&
      typeof migration.name === "string" &&
      "queries" in migration &&
      Array.isArray(migration.queries)
  );

if (!isMigrationList(migrations)) {
  throw new TypeError(
    "Expected the console's migrations as CONSOLE_MIGRATIONS"
  );
}

// Runs before each test file; applying is idempotent.
await applyD1Migrations(env.DB, migrations);
