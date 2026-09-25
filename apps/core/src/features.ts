import { featureErrors } from "@grasp-os/shared/errors";
import { z } from "zod";

import { jsonVar } from "./json-var.ts";
import { log } from "./log.ts";

// Features ship switched off. The console switches one on for a deployment
// with the `FEATURES` var, e.g. `{"apps": true}`, and switching it off again
// is its kill switch. A feature not named, or a var that doesn't parse, is
// off: flags fail closed.

/** Every feature behind a flag. */
export type Feature = "apps" | "permissions" | "knowledge";

/** What core reads the flags from; not in wrangler.jsonc, the console sets it. */
export interface FeaturesEnv {
  FEATURES?: unknown;
}

// Names nobody knows (a flag since removed) are ignored, not an error.
const featuresSchema = z.record(z.string(), z.boolean());

/** Whether `feature` is switched on for this deployment. */
export const featureEnabled = (
  env: Env & FeaturesEnv,
  feature: Feature
): boolean => {
  if (env.FEATURES === undefined) {
    return false;
  }
  const parsed = featuresSchema.safeParse(jsonVar(env.FEATURES));
  if (!parsed.success) {
    log.error("features.config_invalid", {
      paths: parsed.error.issues.map(({ path }) => path.join(".")).join(" "),
    });
    return false;
  }
  return parsed.data[feature] === true;
};

/** Refuses with `feature.disabled` while `feature` is off. */
export const requireFeature = (
  env: Env & FeaturesEnv,
  feature: Feature
): void => {
  if (!featureEnabled(env, feature)) {
    throw featureErrors.create("feature.disabled", { feature });
  }
};
