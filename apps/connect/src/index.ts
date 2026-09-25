import {
  capabilityErrors,
  verifyCapability,
} from "@grasp-os/shared/capability";
import type { CapabilityClaims } from "@grasp-os/shared/capability";
import { connectCallSchema, connectErrors } from "@grasp-os/shared/connect";
import type { ConnectApi, ConnectResult } from "@grasp-os/shared/connect";
import { WorkerEntrypoint } from "cloudflare:workers";

import { auditCall } from "./audit.ts";
import type { CallOutcome } from "./audit.ts";
import { carryOut } from "./call.ts";
import type { CallDone, CallProgress } from "./call.ts";

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

/** How a call that threw ended, for the audit log. */
const outcomeOf = (code: string | undefined): CallOutcome => {
  switch (code) {
    case "connect.outcome_unknown": {
      return "unknown";
    }
    case "connect.action_failed":
    case "connect.server_unavailable":
    case undefined: {
      return "failed";
    }
    default: {
      return "refused";
    }
  }
};

const codeOf = (error: unknown): string | undefined =>
  connectErrors.codeOf(error) ?? capabilityErrors.codeOf(error);

/**
 * The connector layer. Every external call from agents, Apps and the
 * knowledge indexer passes through here: scoped, approved, logged.
 *
 * Only core reaches it, over its service binding; it has no route and no
 * public address. Even so it trusts no call on its own: each one carries a
 * capability core made for exactly that call, and connect checks it first.
 * Every call goes into the audit log, refused ones too.
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
    const parsed = connectCallSchema.safeParse(request);
    if (!parsed.success) {
      await auditCall(this.env, {
        outcome: "refused",
        reason: "connect.invalid_call",
      });
      throw connectErrors.create("connect.invalid_call");
    }
    const { capability, ...call } = parsed.data;
    const { input: _input, ...stated } = call;
    let claims: CapabilityClaims | undefined;
    let done: CallDone;
    const progress: CallProgress = {};
    try {
      claims = await verifyCapability(signingKeys(this.env), capability, call);
      done = await carryOut(this.env, claims, call, progress);
    } catch (error) {
      const reason = codeOf(error);
      await auditCall(this.env, {
        call: stated,
        claims,
        sideEffect: progress.sideEffect,
        outcome: outcomeOf(reason),
        reason: reason ?? "internal",
      });
      throw error;
    }
    // Nothing is returned that the audit log doesn't have.
    await auditCall(this.env, {
      call: stated,
      claims,
      sideEffect: done.sideEffect,
      outcome: done.replayed ? "replayed" : "ok",
      provenance: done.result.provenance,
    });
    return done.result;
  }
}
