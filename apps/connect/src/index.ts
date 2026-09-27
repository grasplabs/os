import type { OutboxedAuditEvent } from "@grasp-os/shared/audit";
import {
  capabilityErrors,
  verifyCapability,
} from "@grasp-os/shared/capability";
import type { CapabilityClaims } from "@grasp-os/shared/capability";
import {
  confirmActionSchema,
  connectCallSchema,
  connectErrors,
  declineActionSchema,
} from "@grasp-os/shared/connect";
import type {
  ConnectApi,
  ConnectCall,
  ConnectionPerson,
  ConnectionSummary,
  ConnectResult,
  Disconnect,
  DisconnectPersonal,
  FinishConnection,
  PendingAction,
  StartConnection,
} from "@grasp-os/shared/connect";
import { errorFields, log } from "@grasp-os/shared/log";
import { WorkerEntrypoint } from "cloudflare:workers";

import { ackAuditEvents, auditCall, takeAuditEvents } from "./audit.ts";
import type { CallOutcome, CallRecord } from "./audit.ts";
import { carryOut, connectionFor } from "./call.ts";
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
import {
  anyPending,
  auditRefusedDecision,
  callOf,
  dropForEndedRun,
  heldFor,
  listPendingActions,
  pendingActionFor,
  refuseConfirmation,
  take,
} from "./pending.ts";
import type { HeldAction } from "./pending.ts";
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
const callOutcome = ({ failed, replayed, pending }: CallDone): CallOutcome => {
  if (pending !== undefined) {
    return "held";
  }
  if (replayed) {
    return "replayed";
  }
  return failed ? "failed" : "ok";
};

type StatedCall = Omit<ConnectCall, "capability" | "input">;

/** The call as the audit log states it: never its input. */
const statedOf = ({
  input: _input,
  ...stated
}: Omit<ConnectCall, "capability">): StatedCall => stated;

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
   * Every minute: drops OAuth flows nobody finished, and seals what a
   * rotated key sealed again.
   */
  override async scheduled(): Promise<void> {
    const results = await Promise.allSettled([
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

  // The audit outbox (src/audit.ts). Core's cron trigger takes the events
  // connect recorded, appends them to the audit log, then acknowledges them,
  // with those the log can't take, which connect moves aside.

  async takeAuditEvents(): Promise<OutboxedAuditEvent[]> {
    return await takeAuditEvents(this.env);
  }

  async ackAuditEvents(appended: unknown, rejected?: unknown): Promise<void> {
    await ackAuditEvents(this.env, appended, rejected);
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

  // Held actions (src/pending.ts). Core names the person from their
  // session; only they see and decide what waits for them.

  async listPendingActions(person: ConnectionPerson): Promise<PendingAction[]> {
    return await listPendingActions(this.env, person);
  }

  async refuseConfirmation(request: unknown): Promise<void> {
    await refuseConfirmation(this.env, request);
  }

  async pendingAction(request: unknown): Promise<PendingAction | null> {
    return await pendingActionFor(this.env, request);
  }

  async dropForEndedRun(request: unknown): Promise<void> {
    await dropForEndedRun(this.env, request);
  }

  async anyPending(request: unknown): Promise<boolean> {
    return await anyPending(this.env, request);
  }

  async declineAction(request: unknown): Promise<void> {
    const parsed = declineActionSchema.safeParse(request);
    if (!parsed.success) {
      throw connectErrors.create("connect.invalid");
    }
    const { person, id } = parsed.data;
    await take(
      this.env,
      person,
      await heldFor(this.env, person, id, "decline"),
      "decline"
    );
  }

  /**
   * Runs a held action its person confirmed: the stored call, exactly, on
   * the normal path, once. Only with the capability core signed for
   * confirming this action for this person, from their session, once it
   * checked the permission and the context again; and only while the input
   * is the one they were shown.
   *
   * What can still refuse it is checked before it is taken, so a refusal
   * leaves it waiting and is recorded as refused, not confirmed: the
   * capability, the input, and the connection (active, the person's to
   * use, the same account). The call path checks them all
   * again once it is taken, and those checks are the ones that count.
   */
  async confirmAction(request: unknown): Promise<ConnectResult> {
    const parsed = confirmActionSchema.safeParse(request);
    if (!parsed.success) {
      throw connectErrors.create("connect.invalid");
    }
    const { capability, person, id, inputHash } = parsed.data;
    const held = await heldFor(this.env, person, id, "confirm");
    const call = callOf(held);
    let claims: CapabilityClaims | undefined;
    try {
      claims = await verifyCapability(signingKeys(this.env), capability, call);
      const { authority } = claims;
      const subjectId =
        authority.subject.type === "app"
          ? authority.subject.appId
          : authority.subject.agentId;
      // Not the App version: core signs the one the held action recorded.
      const forThisAction =
        claims.confirms === held.id &&
        authority.mode === held.mode &&
        authority.onBehalfOf === person.userId &&
        authority.subject.type === held.subjectType &&
        subjectId === held.subjectId;
      if (!forThisAction) {
        throw capabilityErrors.create("capability.invalid", {
          reason: "scope",
        });
      }
      if (inputHash !== held.inputHash) {
        throw connectErrors.create("connect.pending_changed");
      }
      await connectionFor(this.env, claims, call.connectionId, held);
    } catch (error) {
      await auditRefusedDecision(
        this.env,
        person,
        "confirm",
        id,
        codeOf(error) ?? "internal",
        held,
        claims?.restricted
      );
      throw error;
    }
    await take(this.env, person, held, "confirm", claims.restricted);
    return await this.#carryOutAudited(call, claims, held);
  }

  async call(request: unknown): Promise<ConnectResult> {
    const parsed = connectCallSchema.safeParse(request);
    if (!parsed.success) {
      await auditFailure(this.env, {
        outcome: "refused",
        reason: "connect.invalid",
      });
      throw connectErrors.create("connect.invalid");
    }
    const { capability, ...call } = parsed.data;
    let claims: CapabilityClaims;
    try {
      claims = await verifyCapability(signingKeys(this.env), capability, call);
      // A confirmation's capability runs a held action through
      // `confirmAction`, never anything here.
      if (claims.confirms !== undefined) {
        throw capabilityErrors.create("capability.invalid", {
          reason: "scope",
        });
      }
    } catch (error) {
      const reason = codeOf(error);
      await auditFailure(this.env, {
        call: statedOf(call),
        outcome: outcomeOf(reason),
        reason: reason ?? "internal",
      });
      throw error;
    }
    return await this.#carryOutAudited(call, claims);
  }

  /**
   * Carries out a call whose capability is verified, or the held action
   * `held` its person confirmed, and records it, refused ones too.
   */
  async #carryOutAudited(
    call: Omit<ConnectCall, "capability">,
    claims: CapabilityClaims,
    held?: HeldAction
  ): Promise<ConnectResult> {
    const stated = statedOf(call);
    let done: CallDone;
    const progress: CallProgress = {};
    try {
      done = await carryOut(this.env, claims, call, progress, held);
    } catch (error) {
      const reason = codeOf(error);
      await auditFailure(this.env, {
        call: stated,
        claims,
        sideEffect: progress.sideEffect,
        outcome: outcomeOf(reason),
        reason: reason ?? "internal",
        pendingActionId: held?.id,
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
      pendingActionId: done.pending?.id ?? held?.id,
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
    if (done.pending === undefined) {
      return done.result;
    }
    // A run's step can't carry on with an answer that says "held": it ends
    // as held, and core waits for the person's decision before running it
    // again under the same key (workflows/host.ts), which then finds the
    // answer, or `connect.declined`.
    if (claims.authority.mode === "workflow") {
      throw connectErrors.create("connect.held", {
        pendingActionId: done.pending.id,
      });
    }
    return { ...done.result, pending: done.pending };
  }
}
