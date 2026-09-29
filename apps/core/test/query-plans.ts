import { env } from "cloudflare:workers";

// What core's databases are asked, and how SQLite plans it: tests that
// check a query reads an index, not a whole table, on a database without
// statistics, as a fresh D1 is.

/** `target`'s `key`, a method bound to it, as a proxy passes it through. */
const through = (target: object, key: PropertyKey): unknown => {
  const value: unknown = Reflect.get(target, key);
  if (typeof value !== "function") {
    return value;
  }
  const bound: unknown = value.bind(target);
  return bound;
};

/**
 * A plan's step that reads a table whole: a scan by no index, of neither
 * a list of values (`json_each`) nor a subquery.
 */
export const fullScan = /^SCAN (?!\(|.* (?:USING|VIRTUAL TABLE))/u;

/** A database of core's: its own, or Knowledge's. */
type Database = "DB" | "KNOWLEDGE";

/** A statement sent to a database, and the values bound to it. */
export interface Recorded {
  query: string;
  values: unknown[];
  database: Database;
}

/**
 * The statements sent to `database` (core's own, `env.DB`, by default)
 * while `run` runs, as drizzle binds them; every one goes through as ever.
 */
export const recordedQueries = async (
  run: () => Promise<unknown>,
  database: Database = "DB"
): Promise<Recorded[]> => {
  const db = env[database];
  const recorded: Recorded[] = [];
  env[database] = new Proxy(db, {
    get: (target, key) => {
      if (key !== "prepare") {
        return through(target, key);
      }
      return (query: string) => {
        const statement = target.prepare(query);
        return new Proxy(statement, {
          get: (inner, innerKey) => {
            if (innerKey === "bind") {
              return (...values: unknown[]) => {
                recorded.push({ query, values, database });
                return inner.bind(...values);
              };
            }
            return through(inner, innerKey);
          },
        });
      };
    },
  });
  try {
    await run();
  } finally {
    env[database] = db;
  }
  return recorded;
};

/** How SQLite plans `recorded`, a step a line, as `EXPLAIN QUERY PLAN` says. */
export const planOf = async ({
  query,
  values,
  database,
}: Recorded): Promise<string[]> => {
  const { results } = await env[database]
    .prepare(`EXPLAIN QUERY PLAN ${query}`)
    .bind(...values)
    .all<{ detail: string }>();
  return results.map(({ detail }) => detail);
};
