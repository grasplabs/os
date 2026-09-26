/**
 * The bindings vite.config.ts adds to core's test env, which the Worker's
 * own types don't name.
 */
import { env } from "cloudflare:workers";

/** A binding of the test env, by name. */
export const testBinding = (name: string): unknown => Reflect.get(env, name);

const isDatabase = (value: unknown): value is D1Database =>
  typeof value === "object" &&
  value !== null &&
  "prepare" in value &&
  "batch" in value;

/**
 * Connect's database, as CONNECT_DB: core's tests call the real connect
 * Worker, which keeps its connection registry and tokens there.
 */
export const connectDb = (): D1Database => {
  const db = testBinding("CONNECT_DB");
  if (!isDatabase(db)) {
    throw new TypeError("Expected connect's database as CONNECT_DB");
  }
  return db;
};
