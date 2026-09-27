import { errorFields, log } from "@grasp-os/shared/log";

import { sweepPendingCopies } from "./app-blueprints.ts";
import { auditLog } from "./audit-log.ts";
import { drainAuditOutboxes } from "./audit-outbox.ts";
import { consumeLeftoverAuditQueue } from "./audit-queue-leftovers.ts";
import { handleRequest } from "./entry.ts";
import { indexApps } from "./knowledge/apps-collection.ts";
import { syncGraspSkills } from "./knowledge/grasp-skills.ts";
import { sweepUploads } from "./knowledge/uploads.ts";
import { retryDisconnects } from "./members.ts";
import { refreshSignalsIfDue } from "./signals.ts";

/** The cron trigger that runs every 15 minutes (wrangler.jsonc). */
const quarterHourCron = "*/15 * * * *";

export { App } from "./app.ts";
export { AuditLog } from "./audit-log.ts";
export { AppConnectionBinding } from "./app-bindings.ts";
export { ConnectionBinding } from "./bindings.ts";
export { AppCollectionBinding } from "./knowledge/app-binding.ts";
export { CollectionBinding } from "./knowledge/binding.ts";
export { KnowledgeBinding } from "./knowledge/tools-binding.ts";
export { WorkflowDispatcher } from "./workflows/dispatcher.ts";
export { DynamicWorkflowBinding } from "./workflows/engine.ts";
export { Workspace } from "./workspace.ts";

export default {
  fetch: handleRequest,
  // Audit events an older release left on the audit queues (see
  // src/audit-queue-leftovers.ts). Remove it with the queues, in a later
  // release.
  queue: async (batch, env) => {
    await consumeLeftoverAuditQueue(batch, env);
  },
  // Every minute: audit events waiting in core's outboxes and connect's
  // (see src/audit-outbox.ts), personal connections of removed people still
  // connected (see src/members.ts), Apps copied from a blueprint left
  // pending (see src/app-blueprints.ts), the release's Grasp skills (see
  // src/knowledge/grasp-skills.ts), and uploads left behind (see
  // src/knowledge/uploads.ts).
  //
  // Every 15 minutes, on a trigger of its own so neither shares an
  // invocation with the jobs above: the day's improvement signals, until
  // they're computed (see src/signals.ts), and Apps whose entry in the Apps
  // collection isn't of their current version (see
  // src/knowledge/apps-collection.ts). And the audit log's retention
  // alarm armed, if it isn't yet: retention itself runs on that alarm (see
  // src/audit-log.ts), and a deployment that appends nothing after a
  // release still gets it.
  scheduled: async (controller, env) => {
    const jobs =
      controller.cron === quarterHourCron
        ? [
            refreshSignalsIfDue(env),
            indexApps(env),
            auditLog(env).armRetention(),
          ]
        : [
            drainAuditOutboxes(env),
            retryDisconnects(env),
            sweepPendingCopies(env),
            syncGraspSkills(env),
            sweepUploads(env),
          ];
    const results = await Promise.allSettled(jobs);
    for (const result of results) {
      if (result.status === "rejected") {
        log.error("cron.failed", errorFields(result.reason));
      }
    }
  },
} satisfies ExportedHandler<Env>;
