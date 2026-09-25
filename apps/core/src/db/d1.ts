import { sql } from "drizzle-orm";
import type { SQL, SQLWrapper } from "drizzle-orm";

/** Whether D1 refused a write for a unique index, however it was wrapped. */
export const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Error &&
  (error.message.includes("UNIQUE constraint failed") ||
    isUniqueViolation(error.cause));

/**
 * `value IN (...values)`, bound as one parameter however many values there
 * are: D1 binds at most 100 to one statement.
 */
export const inList = (value: SQLWrapper, values: readonly string[]): SQL =>
  sql`${value} IN (SELECT value FROM json_each(${JSON.stringify(values)}))`;
