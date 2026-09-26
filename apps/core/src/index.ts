import { sendAuditOutbox } from "./audit-outbox.ts";
import { consumeAuditQueue } from "./audit-queue.ts";
import { handleRequest } from "./entry.ts";

export { App } from "./app.ts";
export { AuditLog } from "./audit-log.ts";
export { ChatApi } from "./agent-apis.ts";
export { AppConnectionBinding } from "./app-bindings.ts";
export { ConnectionBinding } from "./bindings.ts";
export { CollectionBinding } from "./knowledge/binding.ts";
export { DynamicWorkflowBinding, WorkflowDispatcher } from "./workflows.ts";
export { Workspace } from "./workspace.ts";

export default {
  fetch: handleRequest,
  queue: consumeAuditQueue,
  // Audit events whose first send failed (see src/audit-outbox.ts).
  scheduled: async (_controller, env) => {
    await sendAuditOutbox(env);
  },
} satisfies ExportedHandler<Env>;
