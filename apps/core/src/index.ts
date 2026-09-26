import { errorFields, log } from "@grasp-os/shared/log";

import { sendAuditOutbox } from "./audit-outbox.ts";
import { consumeAuditQueue } from "./audit-queue.ts";
import { archiveAuditLog } from "./audit-retention.ts";
import { handleRequest } from "./entry.ts";
import { retryDisconnects } from "./members.ts";

export { App } from "./app.ts";
export { AuditLog } from "./audit-log.ts";
export { AppConnectionBinding } from "./app-bindings.ts";
export { ConnectionBinding } from "./bindings.ts";
export { CollectionBinding } from "./knowledge/binding.ts";
export {
  DynamicWorkflowBinding,
  WorkflowDispatcher,
} from "./workflows/dispatcher.ts";
export { Workspace } from "./workspace.ts";

export default {
  fetch: handleRequest,
  queue: consumeAuditQueue,
  // Every minute: audit events whose first send failed (see
  // src/audit-outbox.ts), personal connections of removed people still
  // connected (see src/members.ts), and audit events past retention (see
  // src/audit-retention.ts).
  scheduled: async (_controller, env) => {
    const results = await Promise.allSettled([
      sendAuditOutbox(env),
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
