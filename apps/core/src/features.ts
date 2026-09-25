import { featureErrors } from "@grasp-os/shared/errors";
import { z } from "zod";

import { deploymentConfig } from "./deployment-config.ts";

// Features ship switched off. The console switches one on for a deployment
// with the `FEATURES` var, e.g. `{"apps": true}`, and switching it off again
// is its kill switch. A feature not named, or a var that doesn't parse, is
// off: flags fail closed.
//
// Changing a var deploys a new version of the Worker: every request and
// every connection opened from then on gets the new flags. A WebSocket
// opened before stays on the version it opened with, and so keeps its
// flags, until it closes (at the latest when its session ends).

/** Every feature behind a flag. */
export type Feature = "apps" | "permissions" | "knowledge";

// Names nobody knows (a flag since removed) are ignored, not an error.
const featuresSchema = z.record(z.string(), z.boolean());

/** Whether `feature` is switched on for this deployment. */
export const featureEnabled = (env: Env, feature: Feature): boolean =>
  deploymentConfig(featuresSchema, "FEATURES", env.FEATURES)?.[feature] ===
  true;

/** Refuses with `feature.disabled` while `feature` is off. */
export const requireFeature = (env: Env, feature: Feature): void => {
  if (!featureEnabled(env, feature)) {
    throw featureErrors.create("feature.disabled", { feature });
  }
};
