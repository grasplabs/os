import { sql } from "drizzle-orm";
import type { SQL, SQLWrapper } from "drizzle-orm";

/** `value NOT IN (...values)`, bound as one parameter, as `inList` is. */
export const notInList = (value: SQLWrapper, values: readonly string[]): SQL =>
  sql`${value} NOT IN (SELECT value FROM json_each(${JSON.stringify(values)}))`;

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

/**
 * Splits `items` into runs of `size`: rows into inserts within D1's bound
 * parameters, statements into batches within its limits.
 */
export const chunks = <T>(items: readonly T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, (index + 1) * size)
  );
