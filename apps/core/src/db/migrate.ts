import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";

/** A Durable Object's migrations, as drizzle-kit bundles them (`migrations.js`). */
export type Migrations = Parameters<typeof migrate>[1];

/**
 * Brings a Durable Object's SQLite schema up to date. Call it from the
 * constructor, so it runs once per wake-up before the object handles anything.
 *
 * Drizzle records each applied migration in `__drizzle_migrations` and runs
 * only those newer than the last one, all in one transaction. An object whose
 * schema is ahead of the code (after a rollback) is left as it is, which is
 * why schema changes must stay additive until the old code is gone. If a
 * migration fails, the transaction rolls back and the object resets; the next
 * request wakes it and tries again, so callers need not handle the promise.
 */
export const migrateOnWake = async (
  ctx: DurableObjectState,
  migrations: Migrations
): Promise<void> => {
  await ctx.blockConcurrencyWhile(async () => {
    await migrate(drizzle(ctx.storage), migrations);
  });
};
