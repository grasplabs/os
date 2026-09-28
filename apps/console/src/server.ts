/**
 * The console's Worker entry: TanStack Start's handler, behind the Access
 * check (src/access.ts). Every request the Worker sees, pages and server
 * functions alike, passes the check first; server code reads the verified
 * staff member from the request context. The built client files (JS, CSS)
 * are served before the Worker, behind Access at the edge only: they hold
 * nothing but the open-source app's code.
 */
import handler from "@tanstack/react-start/server-entry";

import { withAccess } from "./access.ts";
import type { Staff } from "./access.ts";

declare module "@tanstack/react-start" {
  interface Register {
    server: { requestContext: { staff: Staff } };
  }
}

export default {
  fetch: withAccess(
    async (request, staff) =>
      await handler.fetch(request, { context: { staff } })
  ),
} satisfies ExportedHandler<Env>;
