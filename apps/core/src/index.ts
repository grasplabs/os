import { errorFields, log } from "@grasp-os/shared/log";

import { sweepPendingCopies } from "./app-blueprints.ts";
import { auditLog } from "./audit-log.ts";
import { drainAuditOutboxes } from "./audit-outbox.ts";
import { refreshDailySignals } from "./daily-signals.ts";
import { handleRequest } from "./entry.ts";
import { featureEnabled } from "./features.ts";
import { indexApps } from "./knowledge/apps-collection.ts";
import { syncGraspSkills } from "./knowledge/grasp-skills.ts";
import { sweepUploads } from "./knowledge/uploads.ts";
import { retryDisconnects } from "./members.ts";
import { recordPlatformUpdate } from "./platform-updates.ts";
import { sweepStatistics } from "./statistics.ts";
import { pumpConnectorEvents } from "./workflows/connector-events.ts";
import { receiveEmail } from "./workflows/inbound-email.ts";
import { deleteExpiredEmail } from "./workflows/kept-email.ts";
import { failOrphans } from "./workflows/runs.ts";
import { startDueSchedules } from "./workflows/triggers.ts";

/** The cron trigger that runs every 15 minutes (wrangler.jsonc). */
const quarterHourCron = "*/15 * * * *";

export { App } from "./app.ts";
export { AuditLog } from "./audit-log.ts";
export { ChatApi } from "./agent-apis.ts";
export { AppsApi } from "./agent-apps.ts";
export { BuildApi } from "./agent-builds.ts";
export { ConnectionsApi } from "./agent-connections.ts";
export { KnowledgeApi } from "./agent-knowledge.ts";
export { MemoryApi } from "./agent-memory.ts";
export { WorkflowsApi } from "./agent-workflows.ts";
export { Builtins } from "./builtins.ts";
export { AppConnectionBinding } from "./app-bindings.ts";
export { AppExportBinding } from "./app-calls.ts";
export { AppStatisticsBinding } from "./statistics-binding.ts";
export { ConnectionBinding } from "./bindings.ts";
export { AppCollectionBinding } from "./knowledge/app-binding.ts";
export { CollectionBinding } from "./knowledge/binding.ts";
export { KnowledgeBinding } from "./knowledge/tools-binding.ts";
export { WorkflowDispatcher } from "./workflows/dispatcher.ts";
export { DynamicWorkflowBinding } from "./workflows/engine.ts";
export {
  PreviewCollection,
  PreviewConnection,
  PreviewExports,
  PreviewStatistics,
} from "./preview-bindings.ts";
export { Workspace } from "./workspace.ts";

export default {
  fetch: handleRequest,
  // Mail Email Routing sends to workflows' email triggers (see
  // src/workflows/inbound-email.ts).
  email: async (message, env) => {
    await receiveEmail(message, env);
  },
  // Every minute: audit events waiting in core's outboxes and connect's
  // (see src/audit-outbox.ts), personal connections of removed people still
  // connected (see src/members.ts), Apps copied from a blueprint left
  // pending (see src/app-blueprints.ts), the release's Grasp skills while
  // `builtins` is off (see src/knowledge/grasp-skills.ts; once it's on, the
  // first request installs them, src/builtins.ts), uploads left behind
  // (see src/knowledge/uploads.ts), a new version of core, audited as
  // a platform update (see src/platform-updates.ts), and workflows'
  // schedules due by the minute it runs for (see src/workflows/triggers.ts),
  // runs whose start stopped before the engine had them, marked failed
  // (see `failOrphans`, src/workflows/runs.ts), and connector events:
  // where connect listens, and the events it read, delivered (see
  // src/workflows/connector-events.ts).
  //
  // Every 15 minutes, on a trigger of its own so neither shares an
  // invocation with the jobs above: the day's improvement signals and
  // Knowledge usage signals, until they're computed, from one pass over the audit log (see
  // src/daily-signals.ts), and Apps whose entry in the Apps
  // collection isn't of their current version (see
  // src/knowledge/apps-collection.ts), statistics past their retention
  // (see src/statistics.ts), and messages email triggers kept, deleted
  // once their days are over (see src/workflows/kept-email.ts). And the
  // audit log's retention alarm armed, if it isn't yet: retention itself
  // runs on that alarm (see
  // src/audit-log.ts), and a deployment that appends nothing after a
  // release still gets it.
  scheduled: async (controller, env) => {
    const jobs =
      controller.cron === quarterHourCron
        ? [
            refreshDailySignals(env),
            indexApps(env),
            sweepStatistics(env),
            deleteExpiredEmail(env, new Date(controller.scheduledTime)),
            auditLog(env).armRetention(),
          ]
        : [
            drainAuditOutboxes(env),
            retryDisconnects(env),
            sweepPendingCopies(env),
            // Remove with the `builtins` flag, in a later release.
            ...(featureEnabled(env, "builtins") ? [] : [syncGraspSkills(env)]),
            sweepUploads(env),
            // Deploys apply migrations first (CI's db:migrate, and the
            // console's deploy), so `platform_versions` exists. A version
            // running before it does records nothing, and the first run
            // after the migration records the version then running: only a
            // version that came and went in between goes unrecorded.
            recordPlatformUpdate(env),
            startDueSchedules(env, new Date(controller.scheduledTime)),
            failOrphans(env),
            pumpConnectorEvents(env),
          ];
    const results = await Promise.allSettled(jobs);
    for (const result of results) {
      if (result.status === "rejected") {
        log.error("cron.failed", errorFields(result.reason));
      }
    }
  },
} satisfies ExportedHandler<Env>;
