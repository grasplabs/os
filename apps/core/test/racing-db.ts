import { env } from "cloudflare:workers";

/**
 * Core's database, with `first` run just before each batch lands: a
 * change made by someone else between a check and the write it allowed.
 */
export const racingDb = (first: (db: D1Database) => unknown): D1Database =>
  new Proxy(env.DB, {
    get: (target, property) => {
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          await Promise.resolve(first(target));
          return await target.batch(statements);
        };
      }
      const value: unknown = Reflect.get(target, property);
      return typeof value === "function"
        ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
        : value;
    },
  });
