import { env } from "cloudflare:workers";

// What core's database is asked, and how SQLite plans it: tests that
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

/** A statement sent to core's database, and the values bound to it. */
export interface Recorded {
  query: string;
  values: unknown[];
}

/**
 * The statements sent to core's database (`env.DB`) while `run` runs, as
 * drizzle binds them; every one goes through as ever.
 */
export const recordedQueries = async (
  run: () => Promise<unknown>
): Promise<Recorded[]> => {
  const db = env.DB;
  const recorded: Recorded[] = [];
  env.DB = new Proxy(db, {
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
                recorded.push({ query, values });
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
    env.DB = db;
  }
  return recorded;
};

/** How SQLite plans `recorded`, a step a line, as `EXPLAIN QUERY PLAN` says. */
export const planOf = async ({
  query,
  values,
}: Recorded): Promise<string[]> => {
  const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${query}`)
    .bind(...values)
    .all<{ detail: string }>();
  return results.map(({ detail }) => detail);
};
