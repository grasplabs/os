import { errorFields, log } from "@grasp-os/shared/log";

import { drainAuditOutboxes } from "./audit-outbox.ts";
import { consumeLeftoverAuditQueue } from "./audit-queue-leftovers.ts";
import { archiveAuditLog } from "./audit-retention.ts";
import { handleRequest } from "./entry.ts";
import { retryDisconnects } from "./members.ts";

export { App } from "./app.ts";
export { AuditLog } from "./audit-log.ts";
export { AppConnectionBinding } from "./app-bindings.ts";
export { ConnectionBinding } from "./bindings.ts";
export { AppCollectionBinding } from "./knowledge/app-binding.ts";
export { CollectionBinding } from "./knowledge/binding.ts";
export {
  DynamicWorkflowBinding,
  WorkflowDispatcher,
} from "./workflows/dispatcher.ts";
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
  // connected (see src/members.ts), and audit events past retention (see
  // src/audit-retention.ts).
  scheduled: async (_controller, env) => {
    const results = await Promise.allSettled([
      drainAuditOutboxes(env),
      retryDisconnects(env),
      archiveAuditLog(env),
    ]);
    for (const result of results) {
      if (result.status === "rejected") {
        log.error("cron.failed", errorFields(result.reason));
      }
    }
  },
} satisfies ExportedHandler<Env>;
