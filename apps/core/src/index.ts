import { consumeAuditQueue } from "./audit-queue.ts";
import { handleRequest } from "./entry.ts";

export { App } from "./app.ts";
export { AuditLog } from "./audit-log.ts";
export { ConnectionBinding } from "./bindings.ts";
export { DynamicWorkflowBinding, WorkflowDispatcher } from "./workflows.ts";
export { Workspace } from "./workspace.ts";

export default {
  fetch: handleRequest,
  queue: consumeAuditQueue,
} satisfies ExportedHandler<Env>;
