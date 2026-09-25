import { errorFields, log } from "../log.ts";

/**
 * A Durable Object's migrations, as drizzle-kit bundles them
 * (`migrations.js`): the journal lists them in order, and each one's SQL is
 * filed under `m` and its zero-padded index.
 */
export interface Migrations {
  journal: { entries: readonly { idx: number; tag: string }[] };
  migrations: Readonly<Record<string, string>>;
}

const breakpoint = "--> statement-breakpoint";

const sqlOf = (migrations: Migrations, idx: number, tag: string): string => {
  const text = migrations.migrations[`m${String(idx).padStart(4, "0")}`];
  if (text === undefined) {
    throw new Error(`Migration ${tag} has no SQL`);
  }
  return text;
};

/**
 * Brings a Durable Object's SQLite schema up to date. Call it from the
 * constructor: it runs synchronously, so the object handles nothing before
 * its schema is current.
 *
 * Applies, in order and in one transaction, every migration in the journal
 * that `_migrations` doesn't list yet, and records each by index and tag. By
 * index, not by timestamp, so a migration can't be skipped for being older
 * than one already applied. An object whose schema is ahead of the code
 * (after a rollback) is left as it is, which is why schema changes must stay
 * additive until the old code is gone.
 *
 * Refuses a history that doesn't match the code: an applied migration with
 * another tag, or a missing migration before one already applied. If anything
 * fails, the transaction rolls back and the error is logged with the object
 * and rethrown; the next request wakes the object and tries again.
 */
export const migrateOnWake = (
  ctx: DurableObjectState,
  migrations: Migrations
): void => {
  const { sql } = ctx.storage;
  try {
    ctx.storage.transactionSync(() => {
      sql.exec(
        "CREATE TABLE IF NOT EXISTS _migrations (idx INTEGER PRIMARY KEY, tag TEXT NOT NULL)"
      );
      const applied = new Map(
        sql
          .exec<{ idx: number; tag: string }>(
            "SELECT idx, tag FROM _migrations"
          )
          .toArray()
          .map(({ idx, tag }) => [idx, tag])
      );
      const last = Math.max(-1, ...applied.keys());
      for (const { idx, tag } of migrations.journal.entries) {
        const appliedTag = applied.get(idx);
        if (appliedTag !== undefined && appliedTag !== tag) {
          throw new Error(
            `Migration ${idx} was applied as ${appliedTag}, but the code has ${tag}`
          );
        }
        if (appliedTag === undefined && idx < last) {
          throw new Error(
            `Migration ${tag} comes before migration ${last}, which is already applied`
          );
        }
        if (appliedTag === undefined) {
          for (const statement of sqlOf(migrations, idx, tag).split(
            breakpoint
          )) {
            if (statement.trim() !== "") {
              sql.exec(statement);
            }
          }
          sql.exec(
            "INSERT INTO _migrations (idx, tag) VALUES (?, ?)",
            idx,
            tag
          );
        }
      }
    });
  } catch (error) {
    log.error("migration.failed", {
      object: ctx.id.toString(),
      ...errorFields(error),
    });
    throw error;
  }
};
