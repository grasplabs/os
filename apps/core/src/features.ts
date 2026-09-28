import { deploymentConfig } from "@grasp-os/shared/config";
import { featuresSchema } from "@grasp-os/shared/deployment-config";
import { featureErrors } from "@grasp-os/shared/errors";

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
// (`knowledge_purge`), uploading files and extracting their text
// (`knowledge_uploads`), the Playbook's collection and record saves
// (`playbook`), syncing and copying skills (`skills`), indexing Apps
// into the Apps collection (`apps_collection`), connection calls
// (`connections`), Composio's toolkits in the catalog and connecting them
// (`composio`), App methods
// (`apps`), starting runs and every step of one (`workflows`), opening
// or asking a decision (`decisions`), and screens' calls on their App's
// runs (`screen_workflows`). `model_rules` stops the model
// gateway checking the client's rules beyond the allowlist,
// `model_settings` admins reading those rules and the month's spend, and
// `improvement_signals` the daily signals and reading them. `builtins`
// moves installing what ships with the release (builtins.ts) from the
// cron trigger to the first request.
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

/**
 * What uploading into Knowledge needs switched on: uploads become
 * Knowledge documents, so its kill switch stops them too. The upload RPCs,
 * the upload paths, and what a collection offers (`uploadable`) all go by
 * this one list.
 */
export const uploadFeatures = [
  "knowledge",
  "knowledge_uploads",
] as const satisfies readonly Feature[];

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
   * Uploading files into Knowledge and extracting their text
   * (knowledge/uploads.ts); needs `knowledge` on too. While off, nothing is
   * uploaded or downloaded, and an extraction under way fails once its
   * retries run out; what earlier uploads saved is still read and searched
   * like any document. It runs on the engine (workflows/engine.ts), which
   * plain workerd lacks: on-prem it stays off.
   */
  | "knowledge_uploads"
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
  /**
   * An App's screens starting, following and answering its workflow runs
   * (workflows/screen-runs.ts); needs `apps`, `screens` and `workflows`
   * on too, and `decisions` to answer one.
   */
  | "screen_workflows"
  | "members"
  /** Reading the audit log: search, export and verify. */
  | "audit"
  /** Archiving and purging the audit log (audit-log.ts, `retainAuditLog`). */
  | "audit_retention"
  /** Held side effects: listing, confirming and declining them. */
  | "confirmations"
  /**
   * The client's rules for model calls beyond the allowlist, which always
   * applies (model-rules.ts). Uploads read the rule that keeps the whole
   * deployment in the EU whether this is on or not (knowledge/extract.ts).
   */
  | "model_rules"
  /**
   * Admins reading the model gateway's settings and this month's spend
   * against its budgets (models-rpc.ts). While off, nobody reads them; the
   * gateway goes on checking every call as before.
   */
  | "model_settings"
  /**
   * Improvement signals (signals.ts): computing them daily, and reading
   * them. While off, nothing is computed and nobody reads what was.
   */
  | "improvement_signals"
  /**
   * What ships with the release, installed once per release on the first
   * request (builtins.ts): the built-in blueprints, while `apps` and
   * `app_blueprints` are on too, and the Grasp skills, instead of synced
   * by the cron trigger every minute. Switched off, nothing is installed
   * and the cron trigger syncs the skills as before; the built-in
   * blueprints already installed stay, as any App's blueprint does.
   * Switch it on only once a release that has it is fully
   * rolled out: a release from before it still syncs its own skills on
   * the cron trigger, which the install would not undo.
   */
  | "builtins"
  /**
   * Triggers starting runs on their own (workflows/triggers.ts). While
   * off, they start none; a schedule that missed times starts one run
   * once it's back on.
   */
  | "triggers"
  /**
   * The chat agent (workspace.ts, agent.ts): asking a chat's agent. It
   * stays off on-prem: plain workerd doesn't enforce the CPU limit of the
   * isolates Code Mode runs the agent's code in (code-mode.ts), and has no
   * AI binding for its model calls either.
   */
  | "agent";

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
