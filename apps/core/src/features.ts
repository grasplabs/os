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

// A flag stops its feature everywhere core offers it: its `/rpc` namespace
// (session-rpc.ts), and what App and workflow code reach of it: collection
// stubs (`knowledge`), connection calls (`connections`), App methods
// (`apps`), starting runs and every step of one (`workflows`), and opening
// or asking a decision (`decisions`).
//
// `workflows` and `decisions` never fail a run. Before each step, sleep
// and wait, while `workflows` is off (or `decisions`, before a step that
// opens or asks a decision), the run waits, checking again after a
// minute, then after ever longer waits up to 15 minutes, and goes on by
// itself once it's back on. A wait already under way goes on. Each check
// is a step, so a run waits a long time (days at the default step limit),
// and past that fails with `workflow.too_many_steps` (workflows/host.ts).
// The other flags, met inside a step, refuse with `feature.disabled`,
// which is retryable: the step's retries cover a short outage, and a
// longer one fails the step. A decision's wait goes on while decisions
// are off; one that runs out ends timed out, never approved.

/** Every feature behind a flag. */
export type Feature =
  | "apps"
  | "permissions"
  | "knowledge"
  | "connections"
  | "workflows"
  | "decisions"
  | "screens"
  | "members"
  /** Reading the audit log: search, export and verify. */
  | "audit"
  /** Archiving and purging the audit log (audit-retention.ts). */
  | "audit_retention"
  | "approvals";

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
