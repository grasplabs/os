import {
  capabilityErrors,
  verifyCapability,
} from "@grasp-os/shared/capability";
import type { CapabilityClaims } from "@grasp-os/shared/capability";
import { connectCallSchema, connectErrors } from "@grasp-os/shared/connect";
import type {
  ConnectApi,
  ConnectionPerson,
  ConnectionSummary,
  ConnectResult,
  Disconnect,
  DisconnectPersonal,
  FinishConnection,
  StartConnection,
} from "@grasp-os/shared/connect";
import { errorFields, log } from "@grasp-os/shared/log";
import { WorkerEntrypoint } from "cloudflare:workers";

import { auditCall, sendAuditOutbox } from "./audit.ts";
import type { CallOutcome, CallRecord } from "./audit.ts";
import { carryOut } from "./call.ts";
import type { CallDone, CallProgress } from "./call.ts";
import {
  abandonFlow,
  disconnect,
  disconnectPersonal,
  finishConnection,
  listConnections,
  purgeExpiredFlows,
  resealFlows,
  startConnection,
} from "./oauth.ts";
import { resealTokens } from "./tokens.ts";

// The egress handler of native connectors' isolates (src/connectors.ts).
export { ConnectorEgress } from "./egress.ts";

/**
 * The keys a capability may be made with: the current, then the previous.
 *
 * Rotating the signing key: set the old one as
 * `CAPABILITY_SIGNING_KEY_PREVIOUS` on connect, then the new one as
 * `CAPABILITY_SIGNING_KEY` on connect and core (core always signs with the
 * current key), then remove the previous one. Optional, so it isn't in
 * `secrets.required`.
 */
const signingKeys = (env: Env): string[] =>
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

/**
 * Records a call that didn't go through. If even that fails, it is logged:
 * the caller learns why its call failed, not why its event did.
 */
const auditFailure = async (env: Env, record: CallRecord): Promise<void> => {
  try {
    await auditCall(env, record);
  } catch (error) {
    log.error("audit.record_failed", errorFields(error));
  }
};

/** How a call that returned ended, for the audit log. */
const callOutcome = ({ failed, replayed }: CallDone): CallOutcome => {
  if (replayed) {
    return "replayed";
  }
  return failed ? "failed" : "ok";
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

  /**
   * Every minute: sends the audit events whose first send failed, drops
   * OAuth flows nobody finished, and seals what a rotated key sealed again.
   */
  override async scheduled(): Promise<void> {
    const results = await Promise.allSettled([
      sendAuditOutbox(this.env),
      purgeExpiredFlows(this.env),
      resealTokens(this.env),
      resealFlows(this.env),
    ]);
    for (const result of results) {
      if (result.status === "rejected") {
        log.error("cron.failed", errorFields(result.reason));
      }
    }
  }

  // Connecting accounts (src/oauth.ts). Core calls these for a signed-in
  // person, whom it names; none of them returns a token.

  async startConnection(request: StartConnection): Promise<{ url: string }> {
    return await startConnection(this.env, request);
  }

  async finishConnection(
    request: FinishConnection
  ): Promise<{ connectionId: string; returnTo: string }> {
    return await finishConnection(this.env, request);
  }

  async listConnections(
    person: ConnectionPerson
  ): Promise<ConnectionSummary[]> {
    return await listConnections(this.env, person);
  }

  async disconnect(request: Disconnect): Promise<{ revoked: boolean }> {
    return await disconnect(this.env, request);
  }

  async disconnectPersonal(
    request: DisconnectPersonal
  ): Promise<{ disconnected: number }> {
    return await disconnectPersonal(this.env, request);
  }

  async abandonFlow(state: string): Promise<void> {
    await abandonFlow(this.env, state);
  }

  async call(request: unknown): Promise<ConnectResult> {
    const parsed = connectCallSchema.safeParse(request);
    if (!parsed.success) {
      await auditFailure(this.env, {
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
      await auditFailure(this.env, {
        call: stated,
        claims,
        sideEffect: progress.sideEffect,
        outcome: outcomeOf(reason),
        reason: reason ?? "internal",
      });
      throw error;
    }
    // Nothing is returned, or stored for a repeat, that the audit log
    // doesn't have: a side effect's answer is stored with its events. If
    // that fails, the call happened but went unrecorded: its key is spent,
    // and it is recorded, as far as possible, with an unknown outcome.
    const record: CallRecord = {
      call: stated,
      claims,
      sideEffect: done.sideEffect,
      outcome: callOutcome(done),
      reason: done.failed ? "connect.action_failed" : undefined,
      provenance: done.result.provenance,
    };
    try {
      await auditCall(
        this.env,
        record,
        done.commit === undefined ? [] : [done.commit]
      );
    } catch (error) {
      log.error("audit.record_failed", errorFields(error));
      await done.spend?.().catch((spendError: unknown) => {
        log.error("idempotency.spend_failed", errorFields(spendError));
      });
      await auditFailure(this.env, {
        ...record,
        outcome: "unknown",
        reason: "connect.outcome_unknown",
      });
      throw connectErrors.create("connect.outcome_unknown");
    }
    if (done.failed) {
      throw connectErrors.create("connect.action_failed", {
        output: done.result.output,
      });
    }
    return done.result;
  }
}
