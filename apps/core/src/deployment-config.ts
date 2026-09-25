import { log } from "@grasp-os/shared/log";
import type { z } from "zod";

import { jsonVar } from "./json-var.ts";

// Parsed configs by the var's raw value: a Worker's env holds the same
// values for every request, so each is parsed once per isolate.
const parsedConfigs = new WeakMap<z.ZodType, Map<unknown, unknown>>();

/**
 * A deployment config var as `schema` has it: the value the console set,
 * `undefined` when none is set. One that doesn't parse counts as none, so
 * whatever needs it fails closed, and is logged as `config.invalid` with the
 * var's name and the paths that are wrong, never their values.
 */
export const deploymentConfig = <Schema extends z.ZodType>(
  schema: Schema,
  name: string,
  raw: unknown
): z.output<Schema> | undefined => {
  if (raw === undefined) {
    return undefined;
  }
  const cache = parsedConfigs.get(schema) ?? new Map<unknown, unknown>();
  parsedConfigs.set(schema, cache);
  if (cache.has(raw)) {
    // SAFETY: only this function stores under `schema`, its parsed output.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    return cache.get(raw) as z.output<Schema> | undefined;
  }
  const parsed = schema.safeParse(jsonVar(raw));
  if (!parsed.success) {
    log.error("config.invalid", {
      var: name,
      // Text that isn't JSON fails as a whole, at the root.
      paths: parsed.error.issues
        .map(({ path }) => (path.length === 0 ? "<root>" : path.join(".")))
        .join(" "),
    });
  }
  const config = parsed.success ? parsed.data : undefined;
  cache.set(raw, config);
  return config;
};
