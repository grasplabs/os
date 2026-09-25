import { verifyCapability } from "@grasp-os/shared/capability";
import { connectCallSchema, connectErrors } from "@grasp-os/shared/connect";
import type { ConnectApi, ConnectResult } from "@grasp-os/shared/connect";
import { WorkerEntrypoint } from "cloudflare:workers";

/**
 * The connector layer. Every external call from agents, Apps and the
 * knowledge indexer passes through here: scoped, approved, logged.
 *
 * Only core reaches it, over its service binding; it has no route and no
 * public address. Even so it trusts no call on its own: each one carries a
 * capability core made for exactly that call, and connect checks it first.
 */
export default class Connect
  extends WorkerEntrypoint<Env>
  implements ConnectApi
{
  // oxlint-disable-next-line class-methods-use-this -- the Worker's fetch handler
  override fetch(request: Request): Response {
    const { pathname } = new URL(request.url);
    if (pathname === "/health") {
      return Response.json({ ok: true });
    }
    return new Response("Not found", { status: 404 });
  }

  async call(request: unknown): Promise<ConnectResult> {
    const call = connectCallSchema.safeParse(request);
    if (!call.success) {
      throw connectErrors.create("connect.invalid_call");
    }
    const { capability, ...scope } = call.data;
    await verifyCapability(this.env.CAPABILITY_SIGNING_KEY, capability, scope);
    // Connections come with the connection registry; until then there are
    // none, so a verified call has nothing to reach.
    throw connectErrors.create("connect.connection_not_found");
  }
}
