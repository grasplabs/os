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
// (`knowledge_uploads`), record types Apps declare (`record_types`),
// syncing and copying skills (`skills`), indexing Apps
// into the Apps collection (`apps_collection`), connection calls
// (`connections`), Composio's toolkits in the catalog and connecting them
// (`composio`), App methods
// (`apps`), the chat's agent building Apps (`app_builder`), starting
// runs and every step of one (`workflows`), opening
// or asking a decision (`decisions`), and screens' calls on their App's
// runs (`screen_workflows`), and telling people of failed runs and asking
// the agent to fix them (`run_notifications`), and guest chats, their
// links and what Apps read of them (`guest_chats`). `model_rules` stops the model
// gateway checking the client's rules beyond the allowlist,
// `model_settings` admins reading those rules and the month's spend, and
// `improvement_signals` the daily signals and reading them, and
// `knowledge_signals` Knowledge's usage signals and reading them. `builtins`
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
   * Blueprints: App versions to create Apps from (app-blueprints.ts):
   * App roles decide who marks and copies.
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
   * Record types Apps declare (app/records.json) for the collections they
   * write, checked on every save of one of their records
   * (knowledge/record-types.ts); needs `knowledge` on too. While off, no
   * App's declaration counts: a save of a type the platform doesn't know
   * is refused, as before record types, and such records read as
   * unreadable, until it's back on.
   */
  | "record_types"
  /**
   * Statistics (statistics.ts): Apps recording measures of their own and
   * reading them through their `STATISTICS` stub, and asking for and
   * reading the platform's under an admin's grant.
   * While off, every point and read is refused; what was recorded stays
   * until the sweep's retention, and reads again once it's back on.
   */
  | "statistics"
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
   * Knowledge usage signals (knowledge/signals.ts): computing them daily,
   * their owners listing and dismissing them, and a chat's agent reading
   * its person's; needs `knowledge` on too. While off, nothing is computed
   * and nobody reads what was.
   */
  | "knowledge_signals"
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
   * Connections' events starting workflows (workflows/connector-events.ts):
   * connect listening where Apps' event triggers and permissions say, and
   * the events it reads delivered; needs `triggers` and `workflows` on
   * too. While off, connect reads nothing and nothing is delivered; the
   * events it read before wait, and are delivered once it's back on.
   */
  | "connector_events"
  /**
   * Keeping messages email triggers receive, with their attachments, for
   * 30 days, and runs reading those attachments
   * (workflows/inbound-email.ts). While off, no message is kept (a run's
   * input says `stored: null`) and no attachment is read; the messages
   * kept before are still deleted once their 30 days pass.
   */
  | "email_attachments"
  /**
   * Apps calling each other's exports (app-exports.ts): reading what an
   * App exports (people and the agent alike), asking for a permission on
   * another App's exports, and every call through one; needs `apps` on
   * too. While off, no exports are read, no such permission can be asked
   * for and every call is refused; granted ones stay, and work again once
   * it's back on.
   */
  | "app_calls"
  /**
   * The chat agent (workspace.ts, agent.ts): asking a chat's agent. It
   * stays off on-prem: plain workerd doesn't enforce the CPU limit of the
   * isolates Code Mode runs the agent's code in (code-mode.ts), and has no
   * AI binding for its model calls either.
   */
  | "agent"
  /**
   * People's chats with the agent over `/rpc` (chats-rpc.ts): their list,
   * asking, and following a chat as it streams; needs `agent` on too.
   * While off, nobody reaches a chat; turns under way go on to their end.
   */
  | "chat"
  /**
   * The chat's agent building Apps (agent-builds.ts): creating one (from
   * a blueprint too, while `app_blueprints` is on),
   * writing, checking and dry-running a draft of its own per chat, and
   * proposing it as a pending version for a builder to make current, with
   * the permissions it asks for; needs
   * `apps`, `agent` and `apps_collection` on too (the agent's
   * permission to build is on the Apps collection). While off, it does
   * none of that; drafts already written stay with their chats, and
   * versions it proposed stay up for review.
   */
  | "app_builder"
  /**
   * Telling the person a failed run acted for (notifications.ts), and
   * their asking the chat's agent, in a new chat, to fix its workflow
   * (`fixRun` in chats-rpc.ts); needs `workflows` on too, and `agent` and
   * `chat` to ask. While off, a failed run tells nobody, nobody lists
   * notifications, and no chat starts from a failed run; chats started
   * before keep their report attached.
   */
  | "run_notifications"
  /**
   * Previewing a chat's draft of an App (preview.ts): its screens in the
   * chat's side panel, calling its server code in a preview with no side
   * effects; needs `app_builder`, `apps` and `screens` on too (a preview
   * runs an App's screens and server code, so their kill switches stop it).
   * While off, no draft is previewed, and a preview open in a page stops
   * at its next call.
   */
  | "app_preview"
  /**
   * Guest chats (guests.ts): Apps inviting people who aren't members to a
   * short chat with a model through a link, the guests chatting, and Apps
   * reading back what they wrote. Its kill switch: while off, nobody is
   * invited, no link opens and no message is taken (a guest's page says
   * the link doesn't work), and no App reads a chat back; what was written
   * stays until its retention ends, and the links that haven't expired
   * work again once it's back on.
   */
  | "guest_chats";

/** Whether `feature` is switched on for this deployment. */
export const featureEnabled = (
  env: Pick<Env, "FEATURES">,
  feature: Feature
): boolean =>
  deploymentConfig(featuresSchema, "FEATURES", env.FEATURES)?.[feature] ===
  true;

/**
 * What a preview of a chat's draft needs switched on: it runs an App's
 * screens and server code, so the kill switches of both (`apps`,
 * `screens`) stop it as they stop an App's own, besides the agent's
 * building and previews themselves.
 */
export const previewFeatures = [
  "apps",
  "screens",
  "app_builder",
  "app_preview",
] as const satisfies readonly Feature[];

/** Whether drafts can be previewed: all of {@link previewFeatures} are on. */
export const previewsEnabled = (env: Pick<Env, "FEATURES">): boolean =>
  previewFeatures.every((feature) => featureEnabled(env, feature));

/** Refuses with `feature.disabled` while `feature` is off. */
export const requireFeature = (env: Env, feature: Feature): void => {
  if (!featureEnabled(env, feature)) {
    throw featureErrors.create("feature.disabled", { feature });
  }
};
