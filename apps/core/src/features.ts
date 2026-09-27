import { deploymentConfig } from "@grasp-os/shared/config";
import { featureErrors } from "@grasp-os/shared/errors";
import { z } from "zod";

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
// stubs (`knowledge`), an agent's memory and its saves of it (`memory`,
// which gives every context no memory while off), purging Knowledge
// (`knowledge_purge`), the Playbook's collection and record saves
// (`playbook`), syncing and copying skills (`skills`), indexing Apps
// into the Apps collection (`apps_collection`), connection calls
// (`connections`), Composio's toolkits in the catalog and connecting them
// (`composio`), App methods
// (`apps`), starting runs and every step of one (`workflows`), and opening
// or asking a decision (`decisions`). `model_rules` stops the model
// gateway checking the client's rules beyond the allowlist.
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
  /**
   * App roles and sharing (app-access.ts). While off, admins and builders
   * build every App and users none, as before Apps had roles, and nobody
   * shares one.
   */
  | "app_sharing"
  /**
   * Blueprints: App versions to create Apps from (app-blueprints.ts);
   * needs `app_sharing` on too, whose roles decide who marks and copies.
   */
  | "app_blueprints"
  | "permissions"
  | "knowledge"
  /** Memory files (knowledge/memory.ts); needs `knowledge` on too. */
  | "memory"
  /** Purging personal data (knowledge/purge.ts); needs `knowledge` on too. */
  | "knowledge_purge"
  /**
   * The Playbook collection and saving its records (knowledge/playbook.ts);
   * needs `knowledge` on too. While off, nothing is saved to the Playbook,
   * by these helpers or any other save; what it holds is still read,
   * searched and purged like any document.
   */
  | "playbook"
  /**
   * Skills (knowledge/grasp-skills.ts): the release's Grasp skills synced
   * into their collection, the client's own skills collection, and
   * copying a Grasp skill into it; needs `knowledge` on too. While off,
   * nothing is synced, created or copied; what the collections hold is
   * still read and searched like any document.
   */
  | "skills"
  /**
   * The Apps collection (knowledge/apps-collection.ts): each App's
   * AGENTS.md, at its current version, indexed into Knowledge where those
   * who may open the App find it; needs `knowledge` on too. While off,
   * nothing is indexed and the collection's entries are found by nobody.
   */
  | "apps_collection"
  | "connections"
  /**
   * Composio's toolkits in the catalog, and starting and finishing
   * connections to them; needs `connections` on too. Switched off, the
   * catalog lists only native providers and no toolkit connection starts
   * or finishes. Calls on existing Composio connections go on: removing
   * connect's `COMPOSIO_API_KEY` stops those.
   */
  | "composio"
  | "workflows"
  | "decisions"
  | "screens"
  | "members"
  /** Reading the audit log: search, export and verify. */
  | "audit"
  /** Archiving and purging the audit log (audit-retention.ts). */
  | "audit_retention"
  /** Held side effects: listing, confirming and declining them. */
  | "confirmations"
  /**
   * The client's rules for model calls beyond the allowlist, which always
   * applies (model-rules.ts).
   */
  | "model_rules";

// Names nobody knows (a flag since removed) are ignored, not an error.
const featuresSchema = z.record(z.string(), z.boolean());

/** Whether `feature` is switched on for this deployment. */
export const featureEnabled = (
  env: Pick<Env, "FEATURES">,
  feature: Feature
): boolean =>
  deploymentConfig(featuresSchema, "FEATURES", env.FEATURES)?.[feature] ===
  true;

/** Refuses with `feature.disabled` while `feature` is off. */
export const requireFeature = (env: Env, feature: Feature): void => {
  if (!featureEnabled(env, feature)) {
    throw featureErrors.create("feature.disabled", { feature });
  }
};
