import { verifyCapability } from "@grasp-os/shared/capability";
import { connectCallSchema, connectErrors } from "@grasp-os/shared/connect";
import type { ConnectApi, ConnectResult } from "@grasp-os/shared/connect";
import { WorkerEntrypoint } from "cloudflare:workers";

/**
 * Rotating the signing key: set the old one as
 * `CAPABILITY_SIGNING_KEY_PREVIOUS` on connect, then the new one as
 * `CAPABILITY_SIGNING_KEY` on connect and core (core always signs with the
 * current key), then remove the previous one. Optional, so it isn't in
 * `secrets.required`.
 */
interface ConnectEnv extends Env {
  CAPABILITY_SIGNING_KEY_PREVIOUS?: string;
}

/** The keys a capability may be made with: the current, then the previous. */
const signingKeys = (env: ConnectEnv): string[] =>
  [env.CAPABILITY_SIGNING_KEY, env.CAPABILITY_SIGNING_KEY_PREVIOUS].filter(
    (key): key is string => typeof key === "string" && key !== ""
  );

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
    await verifyCapability(signingKeys(this.env), capability, scope);
    // Connections come with the connection registry; until then there are
    // none, so a verified call has nothing to reach.
    throw connectErrors.create("connect.connection_not_found");
  }
}
