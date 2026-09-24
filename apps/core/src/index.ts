import { consumeAuditQueue } from "./audit-queue.ts";

export { App } from "./app.ts";
export { AuditLog } from "./audit-log.ts";
export { DynamicWorkflowBinding, WorkflowDispatcher } from "./workflows.ts";
export { Workspace } from "./workspace.ts";

export default {
  fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === "/health") {
      return Response.json({ ok: true });
    }
    return new Response("Not found", { status: 404 });
  },
  queue: consumeAuditQueue,
} satisfies ExportedHandler<Env>;
