import { signCapability } from "@grasp-os/shared/capability";
import { connectErrors } from "@grasp-os/shared/connect";
import type {
  ConnectionPerson,
  ConnectResult,
  PendingAction,
} from "@grasp-os/shared/connect";
import type { Authority } from "@grasp-os/shared/permissions";
import { env, exports } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vite-plus/test";

import {
  connections,
  idempotentCalls,
  pendingActions,
} from "../src/db/schema.ts";
import {
  addConnection,
  agentFor,
  appFor,
  auditEvents,
  callAs,
  chatOrigin,
  outcome,
  serverUrl,
  someone,
} from "./connect.ts";
import type { Call, Signed } from "./connect.ts";
import { fakeMcpServer } from "./mcp-server.ts";

// Side effects held until the person they act for confirms them (threat
// model R7, R12, CN7, CN8, CN15). The ways it can fail come first: a write
// from chat, or from a context that read restricted data, runs before the
// person confirms it; confirming twice runs it twice; someone else
// confirms it (another member, Grasp staff, the agent itself with a
// capability of its own); it runs after its connection was disconnected or
// reconnected to another account, or with another input than the person
// was shown; a confirmation for one App's or connection's action runs
// another's; declining or dropping it leaves anything behind but its
// event; a refusal is recorded as a confirmation.

const server = fakeMcpServer(serverUrl, [
  {
    name: "mail.send",
    run: ({ to }) => ({ output: { sent: to } }),
  },
  {
    name: "mail.archive",
    run: () => ({ output: { archived: true } }),
  },
]);

const audit = auditEvents();

/** An agent in chat, acting for `person`. */
const inChat = (person: ConnectionPerson, agentId = "agent-chat"): Authority =>
  agentFor(person.userId, agentId, "interactive");

const mail = (connectionId: string, to = "ben@acme.test"): Call => ({
  connectionId,
  action: "mail.send",
  input: { to, subject: "Invoice" },
  idempotencyKey: `chat-1:${crypto.randomUUID()}`,
});

/** Makes `call` from chat, as core signs it: the reference connect held. */
const hold = async (
  authority: Authority,
  call: Call,
  signed: Signed = {}
): Promise<ConnectResult> =>
  await callAs(authority, call, { origin: chatOrigin, ...signed });

const waitingFor = async (person: ConnectionPerson): Promise<PendingAction[]> =>
  await exports.default.listPendingActions(person);

/** The one held action waiting for `person`. */
const heldFor = async (person: ConnectionPerson): Promise<PendingAction> => {
  const [held, ...others] = await waitingFor(person);
  if (held === undefined || others.length > 0) {
    throw new Error("Expected one held action");
  }
  return held;
};

/**
 * Confirms `held` as `person`, as core does: with a capability for the
 * held call that confirms it, for `authority` (by default, the App or
 * agent that asked, acting for `person`).
 */
const confirm = async (
  person: ConnectionPerson,
  held: PendingAction,
  {
    authority = inChat(person),
    inputHash = held.inputHash,
    signed = {},
    call = {},
  }: {
    authority?: Authority;
    inputHash?: string;
    signed?: Signed;
    call?: Partial<Call>;
  } = {}
): Promise<ConnectResult> =>
  await exports.default.confirmAction({
    person,
    id: held.id,
    inputHash,
    capability: await signCapability(env.CAPABILITY_SIGNING_KEY, authority, {
      connectionId: held.connectionId,
      resource: held.resource ?? undefined,
      action: held.action,
      idempotencyKey: held.idempotencyKey,
      origin: chatOrigin,
      confirms: held.id,
      ...call,
      ...signed,
    }),
  });

const decline = async (
  person: ConnectionPerson,
  held: PendingAction
): Promise<void> => {
  await exports.default.declineAction({ person, id: held.id });
};

/** Where an App's call comes from, as core signs it. */
const appOrigin = {
  permissionId: "permission-mail",
  context: { type: "app" as const, appId: "app-crm" },
};

/** Where a run's call comes from, as core signs it. */
const runOrigin = {
  permissionId: "permission-mail",
  context: { type: "run" as const, appId: "app-crm", runId: "run-1" },
};

/** How a run's call ended: its output, or its code and the held action. */
const retried = async (
  result: Promise<ConnectResult>
): Promise<{ code: string; output?: string; pendingActionId?: unknown }> => {
  try {
    const { output } = await result;
    return { code: "ok", output };
  } catch (error) {
    const details: unknown =
      typeof error === "object" && error !== null && "details" in error
        ? error.details
        : undefined;
    return {
      code: connectErrors.codeOf(error) ?? String(error),
      pendingActionId:
        typeof details === "object" && details !== null
          ? Reflect.get(details, "pendingActionId")
          : undefined,
    };
  }
};

/** What is left of held actions and stored answers for `connectionId`. */
const leftFor = async (connectionId: string) => {
  const db = drizzle(env.DB);
  return {
    held: await db
      .select()
      .from(pendingActions)
      .where(eq(pendingActions.connectionId, connectionId)),
    answers: await db
      .select()
      .from(idempotentCalls)
      .where(eq(idempotentCalls.connectionId, connectionId)),
  };
};

/** The events about `connectionId`, by action and outcome. */
const eventsFor = async (connectionId: string) => {
  const events = await audit.events();
  return events
    .filter(({ target }) => target?.id === connectionId)
    .map(({ action, actor, detail }) => ({
      action,
      actor: actor.type,
      outcome: detail.outcome ?? detail.reason ?? null,
    }));
};

describe("a side effect from chat", () => {
  it("is held, not run, and its person sees the exact call", async () => {
    const anna = someone();
    const connectionId = await addConnection();
    const call = mail(connectionId);
    const result = await hold(inChat(anna), call);
    const held = await heldFor(anna);
    const { inputHash, requestedAt, ...shown } = held;
    expect({ result, ran: server.ran, shown }).toStrictEqual({
      result: { output: "null", provenance: [], pending: { id: held.id } },
      ran: [],
      shown: {
        id: held.id,
        subject: { type: "agent", agentId: "agent-chat" },
        appVersion: null,
        mode: "interactive",
        context: chatOrigin.context,
        permissionId: chatOrigin.permissionId,
        connectionId,
        resource: null,
        restricted: false,
        action: "mail.send",
        idempotencyKey: call.idempotencyKey,
        input: JSON.stringify(call.input),
      },
    });
    expect({
      hash: /^[0-9a-f]{64}$/u.test(inputHash),
      requested: Number.isNaN(Date.parse(requestedAt)),
    }).toStrictEqual({ hash: true, requested: false });
    await expect(eventsFor(connectionId)).resolves.toStrictEqual([
      { action: "connection.call", actor: "agent", outcome: "held" },
    ]);
  });

  it("is the same held action when the call is repeated, and refused with another input", async () => {
    const anna = someone();
    const connectionId = await addConnection();
    const call = mail(connectionId);
    const first = await hold(inChat(anna), call);
    const again = await hold(inChat(anna), call);
    const changed = await outcome(
      hold(inChat(anna), { ...call, input: { to: "eve@evil.test" } })
    );
    const waiting = await waitingFor(anna);
    expect({
      again: again.pending,
      changed,
      waiting: waiting.map(({ id, input }) => ({ id, input })),
    }).toStrictEqual({
      again: first.pending,
      changed: "connect.idempotency_conflict",
      waiting: [{ id: first.pending?.id, input: JSON.stringify(call.input) }],
    });
  });

  it("runs once its person confirms it, exactly as held, and a repeat gets its answer", async () => {
    const anna = someone();
    const connectionId = await addConnection();
    const call = mail(connectionId);
    await hold(inChat(anna), call);
    const held = await heldFor(anna);
    const confirmed = await confirm(anna, held);
    const repeat = await hold(inChat(anna), call);
    expect({
      confirmed,
      repeat,
      ran: server.ran,
      waiting: await waitingFor(anna),
      again: await outcome(confirm(anna, held)),
    }).toStrictEqual({
      confirmed: { output: '{"sent":"ben@acme.test"}', provenance: [] },
      repeat: { output: '{"sent":"ben@acme.test"}', provenance: [] },
      ran: [{ tool: "mail.send", input: call.input }],
      waiting: [],
      again: "connect.pending_not_found",
    });
    await expect(eventsFor(connectionId)).resolves.toStrictEqual([
      { action: "connection.call", actor: "agent", outcome: "held" },
      { action: "connection.action.confirmed", actor: "person", outcome: null },
      { action: "connection.call", actor: "agent", outcome: "ok" },
      { action: "connection.call", actor: "agent", outcome: "replayed" },
    ]);
    // The second confirmation found nothing left to name but its ID.
    const audited = await audit.events();
    expect(
      audited
        .filter(({ action }) => action === "connection.action.confirm_refused")
        .map(({ detail }) => detail)
    ).toStrictEqual([
      { pendingActionId: held.id, reason: "connect.pending_not_found" },
    ]);
  });

  it("runs once when confirmed twice at the same moment", async () => {
    const anna = someone();
    const connectionId = await addConnection();
    await hold(inChat(anna), mail(connectionId));
    const held = await heldFor(anna);
    const outcomes = await Promise.all([
      outcome(confirm(anna, held)),
      outcome(confirm(anna, held)),
    ]);
    expect({
      outcomes: outcomes.toSorted(),
      ran: server.ran.length,
    }).toStrictEqual({ outcomes: ["connect.pending_not_found", "ok"], ran: 1 });
  });

  it("is confirmed by nobody but the person it waits for, whatever they hold", async () => {
    const anna = someone();
    const ben = someone("admin");
    const staff: ConnectionPerson = { ...someone("admin"), staff: true };
    // Staff signed in with Anna's own ID changes nothing either.
    const annaAsStaff: ConnectionPerson = { ...anna, staff: true };
    const connectionId = await addConnection();
    await hold(inChat(anna), mail(connectionId));
    const held = await heldFor(anna);
    const attempts = await Promise.all([
      outcome(confirm(ben, held, { authority: inChat(ben) })),
      outcome(confirm(ben, held, { authority: inChat(anna) })),
      outcome(confirm(staff, held, { authority: inChat(staff) })),
      outcome(confirm(annaAsStaff, held)),
      // Anna's own session, with a capability for someone else...
      outcome(confirm(anna, held, { authority: inChat(ben) })),
      // ...for another agent, or the agent's own workflow...
      outcome(confirm(anna, held, { authority: inChat(anna, "agent-other") })),
      outcome(
        confirm(anna, held, {
          authority: agentFor(anna.userId, "agent-chat", "workflow"),
        })
      ),
      // ...or the agent's own call's capability, which confirms nothing.
      outcome(confirm(anna, held, { signed: { confirms: undefined } })),
    ]);
    const stillWaiting = await waitingFor(anna);
    expect({
      attempts,
      staffList: await waitingFor(annaAsStaff),
      benList: await waitingFor(ben),
      ran: server.ran,
      stillWaiting: stillWaiting.map(({ id }) => id),
    }).toStrictEqual({
      attempts: [
        "connect.pending_not_found",
        "connect.pending_not_found",
        "connect.pending_not_found",
        "connect.pending_not_found",
        "capability.invalid",
        "capability.invalid",
        "capability.invalid",
        "capability.invalid",
      ],
      staffList: [],
      benList: [],
      ran: [],
      stillWaiting: [held.id],
    });
    // Every attempt is recorded, under whoever made it.
    const audited = await audit.events();
    expect(
      audited
        .filter(({ action }) => action === "connection.action.confirm_refused")
        .map(({ actor }) => actor.type)
        .toSorted()
    ).toStrictEqual([
      "person",
      "person",
      "person",
      "person",
      "person",
      "person",
      "staff",
      "staff",
    ]);
  });

  it("isn't run by a confirmation's capability outside confirming it", async () => {
    const anna = someone();
    const connectionId = await addConnection();
    const call = mail(connectionId);
    await hold(inChat(anna), call);
    const held = await heldFor(anna);
    await expect(
      outcome(
        callAs(inChat(anna), call, { origin: chatOrigin, confirms: held.id })
      )
    ).resolves.toBe("capability.invalid");
    expect({ ran: server.ran, waiting: await waitingFor(anna) }).toStrictEqual({
      ran: [],
      waiting: [held],
    });
  });

  it("runs only for the action, connection and App or agent it was held for", async () => {
    const anna = someone();
    const [connectionId, otherConnection] = await Promise.all([
      addConnection(),
      addConnection(),
    ]);
    const crm = appFor(anna.userId, "app-crm");
    await hold({ ...crm, mode: "interactive" }, mail(connectionId));
    const held = await heldFor(anna);
    const attempts = await Promise.all([
      outcome(confirm(anna, held, { authority: inChat(anna) })),
      outcome(
        confirm(anna, held, {
          authority: {
            ...appFor(anna.userId, "app-other"),
            mode: "interactive",
          },
        })
      ),
      outcome(
        confirm(anna, held, {
          authority: { ...crm, mode: "interactive" },
          call: { connectionId: otherConnection },
        })
      ),
      outcome(
        confirm(anna, held, {
          authority: { ...crm, mode: "interactive" },
          call: { action: "mail.archive" },
        })
      ),
      outcome(
        confirm(anna, held, {
          authority: { ...crm, mode: "interactive" },
          call: { idempotencyKey: "chat-1:other" },
        })
      ),
    ]);
    expect({ attempts, ran: server.ran }).toStrictEqual({
      attempts: [
        "capability.invalid",
        "capability.invalid",
        "capability.invalid",
        "capability.invalid",
        "capability.invalid",
      ],
      ran: [],
    });
    await confirm(anna, held, { authority: { ...crm, mode: "interactive" } });
    expect(server.ran).toHaveLength(1);
  });

  it("runs only with the input its person was shown", async () => {
    const anna = someone();
    const connectionId = await addConnection();
    const call = mail(connectionId);
    await hold(inChat(anna), call);
    const held = await heldFor(anna);
    const otherHash = "0".repeat(64);
    await expect(
      outcome(confirm(anna, held, { inputHash: otherHash }))
    ).resolves.toBe("connect.pending_changed");
    await expect(waitingFor(anna)).resolves.toStrictEqual([held]);
    await confirm(anna, held);
    expect(server.ran).toStrictEqual([
      { tool: "mail.send", input: call.input },
    ]);
  });

  it("is dropped when declined, leaving nothing but its event", async () => {
    const anna = someone();
    const ben = someone();
    const connectionId = await addConnection();
    await hold(inChat(anna), mail(connectionId));
    const held = await heldFor(anna);
    const byBen = await outcome(decline(ben, held));
    const stillWaiting = await waitingFor(anna);
    await decline(anna, held);
    expect({
      byBen,
      stillWaiting: stillWaiting.map(({ id }) => id),
      confirmed: await outcome(confirm(anna, held)),
      ran: server.ran,
      left: await leftFor(connectionId),
    }).toStrictEqual({
      byBen: "connect.pending_not_found",
      stillWaiting: [held.id],
      confirmed: "connect.pending_not_found",
      ran: [],
      left: { held: [], answers: [] },
    });
    const events = await eventsFor(connectionId);
    expect(
      events.filter(({ action }) => action === "connection.action.declined")
    ).toStrictEqual([
      { action: "connection.action.declined", actor: "person", outcome: null },
    ]);
  });

  it("isn't taken while its connection is inactive or reaches another account", async () => {
    const anna = someone();
    const [gone, moved] = await Promise.all([
      addConnection({ accountId: `account-${crypto.randomUUID()}` }),
      addConnection({ accountId: `account-${crypto.randomUUID()}` }),
    ]);
    await hold(inChat(anna), mail(gone));
    await hold(inChat(anna), mail(moved));
    const waiting = await waitingFor(anna);
    const heldOn = (connectionId: string): PendingAction => {
      const held = waiting.find((each) => each.connectionId === connectionId);
      if (held === undefined) {
        throw new Error("No held action");
      }
      return held;
    };
    const db = drizzle(env.DB);
    await db
      .update(connections)
      .set({ status: "needs_reauth" })
      .where(eq(connections.id, gone));
    await db
      .update(connections)
      .set({ accountId: `account-${crypto.randomUUID()}` })
      .where(eq(connections.id, moved));
    const refused = {
      gone: await outcome(confirm(anna, heldOn(gone))),
      moved: await outcome(confirm(anna, heldOn(moved))),
    };
    const stillWaiting = await waitingFor(anna);
    const audited = await audit.events();
    expect({
      ...refused,
      ran: server.ran,
      // Refused before they were taken: they keep waiting, not confirmed.
      stillWaiting: stillWaiting.length,
      events: audited
        .filter(({ action }) => action.startsWith("connection.action."))
        .map(({ action, detail }) => `${action} ${String(detail.reason)}`)
        .toSorted(),
    }).toStrictEqual({
      gone: "connect.connection_inactive",
      moved: "connect.connection_changed",
      ran: [],
      stillWaiting: 2,
      events: [
        "connection.action.confirm_refused connect.connection_changed",
        "connection.action.confirm_refused connect.connection_inactive",
      ],
    });
  });

  it("is dropped by a disconnect retried after the connection was already stopped", async () => {
    const anna = someone();
    const admin = someone("admin");
    const connectionId = await addConnection();
    await hold(inChat(anna), mail(connectionId));
    // As a disconnect that stopped the connection, then failed to drop.
    await drizzle(env.DB)
      .update(connections)
      .set({ status: "disconnected" })
      .where(eq(connections.id, connectionId));
    const again = await exports.default.disconnect({
      person: admin,
      connectionId,
    });
    expect({
      again,
      waiting: await waitingFor(anna),
      left: await leftFor(connectionId),
    }).toStrictEqual({
      again: { revoked: false },
      waiting: [],
      left: { held: [], answers: [] },
    });
  });

  it("are all dropped by a disconnect, however many, a batch at a time", async () => {
    const anna = someone();
    const admin = someone("admin");
    const connectionId = await addConnection();
    const { pending } = await hold(inChat(anna), mail(connectionId));
    const db = drizzle(env.DB);
    const held = await db
      .select()
      .from(pendingActions)
      .where(eq(pendingActions.id, pending?.id ?? ""))
      .get();
    if (held === undefined) {
      throw new Error("Nothing held");
    }
    // More than two of a drop's batches, as many calls would leave them.
    const [one, ...more] = Array.from({ length: 120 }, (_, index) =>
      db.insert(pendingActions).values({
        ...held,
        id: crypto.randomUUID(),
        idempotencyKey: `chat-1:${crypto.randomUUID()}`,
        createdAt: new Date(held.createdAt.getTime() + index),
      })
    );
    if (one === undefined) {
      throw new Error("Nothing to insert");
    }
    await db.batch([one, ...more]);
    await exports.default.disconnect({ person: admin, connectionId });
    const audited = await audit.events();
    const dropped = audited.filter(
      ({ action, target }) =>
        action === "connection.action.dropped" && target?.id === connectionId
    );
    expect({
      left: await leftFor(connectionId),
      dropped: dropped.length,
      once: new Set(dropped.map(({ detail }) => detail.pendingActionId)).size,
    }).toStrictEqual({
      left: { held: [], answers: [] },
      dropped: 121,
      once: 121,
    });
  });

  it("is dropped with its event when its connection is disconnected, or its person removed", async () => {
    const anna = someone();
    const admin = someone("admin");
    const [shared, other] = await Promise.all([
      addConnection(),
      addConnection(),
    ]);
    await hold(inChat(anna), mail(shared));
    await hold(inChat(anna), mail(other));
    await exports.default.disconnect({ person: admin, connectionId: shared });
    const afterDisconnect = await waitingFor(anna);
    await exports.default.disconnectPersonal({
      person: null,
      ownerUserIds: [anna.userId],
    });
    const audited = await audit.events();
    expect({
      afterDisconnect: afterDisconnect.map(({ connectionId }) => connectionId),
      afterRemoval: await waitingFor(anna),
      left: [await leftFor(shared), await leftFor(other)],
      dropped: audited
        .filter(({ action }) => action === "connection.action.dropped")
        .map(({ actor, target, detail }) => ({
          actor: actor.type,
          connectionId: target?.id,
          reason: detail.reason,
        })),
      ran: server.ran,
    }).toStrictEqual({
      afterDisconnect: [other],
      afterRemoval: [],
      left: [
        { held: [], answers: [] },
        { held: [], answers: [] },
      ],
      dropped: [
        {
          actor: "person",
          connectionId: shared,
          reason: "connection.disconnected",
        },
        { actor: "system", connectionId: other, reason: "person.removed" },
      ],
      ran: [],
    });
  });

  it("runs at most once when its call fails after it was taken", async () => {
    const anna = someone();
    const connectionId = await addConnection();
    const call = mail(connectionId);
    await hold(inChat(anna), call);
    const held = await heldFor(anna);
    // The mail goes out, and its answer is lost on the way back.
    server.network = "drop";
    const confirmed = await outcome(confirm(anna, held));
    expect({
      confirmed,
      again: await outcome(confirm(anna, held)),
      // The agent asking again learns the outcome is unknown: never re-sent.
      repeat: await outcome(hold(inChat(anna), call)),
      ran: server.ran.length,
    }).toStrictEqual({
      confirmed: "connect.outcome_unknown",
      again: "connect.pending_not_found",
      repeat: "connect.outcome_unknown",
      ran: 1,
    });
  });

  it("frees its key when turned away after it was taken but before anything ran", async () => {
    const anna = someone();
    const connectionId = await addConnection();
    const call = mail(connectionId);
    await hold(inChat(anna), call);
    const held = await heldFor(anna);
    // The server turns the call away: the tool never ran.
    server.network = "unauthorised";
    const refused = await outcome(confirm(anna, held));
    await hold(inChat(anna), call);
    const again = await heldFor(anna);
    await confirm(anna, again);
    expect({
      refused,
      heldAgain: again.id !== held.id,
      ran: server.ran.length,
    }).toStrictEqual({
      refused: "connect.server_unavailable",
      heldAgain: true,
      ran: 1,
    });
  });

  it("from a chat that read restricted data is held too, marked so, and runs once confirmed", async () => {
    const anna = someone();
    const connectionId = await addConnection();
    const result = await hold(inChat(anna), mail(connectionId), {
      restricted: true,
    });
    const held = await heldFor(anna);
    const confirmed = await confirm(anna, held, {
      signed: { restricted: true },
    });
    const audited = await audit.events();
    expect({
      held: { pending: result.pending?.id, restricted: held.restricted },
      confirmed: confirmed.output,
      ran: server.ran.length,
      events: audited
        .filter(({ target }) => target?.id === connectionId)
        .map(({ action, detail }) => ({
          action,
          restricted: detail.restricted ?? false,
        })),
    }).toStrictEqual({
      held: { pending: held.id, restricted: true },
      confirmed: '{"sent":"ben@acme.test"}',
      ran: 1,
      events: [
        { action: "connection.call", restricted: true },
        { action: "connection.action.confirmed", restricted: true },
        { action: "connection.call", restricted: true },
      ],
    });
  });

  it("records a restricted confirmation when its chat read restricted data after it was held", async () => {
    const anna = someone();
    const connectionId = await addConnection();
    await hold(inChat(anna), mail(connectionId));
    const held = await heldFor(anna);
    await confirm(anna, held, { signed: { restricted: true } });
    const audited = await audit.events();
    expect({
      heldRestricted: held.restricted,
      ran: server.ran.length,
      confirmed: audited.find(
        ({ action }) => action === "connection.action.confirmed"
      )?.detail.restricted,
    }).toStrictEqual({ heldRestricted: false, ran: 1, confirmed: true });
  });

  it("from an App that read restricted data is held too, for the person using it", async () => {
    const anna = someone();
    const connectionId = await addConnection();
    const inApp = {
      ...appFor(anna.userId, "app-crm"),
      mode: "interactive" as const,
    };
    const result = await callAs(inApp, mail(connectionId), {
      restricted: true,
      origin: appOrigin,
    });
    const held = await heldFor(anna);
    const confirmed = await confirm(anna, held, {
      authority: inApp,
      signed: { restricted: true, origin: appOrigin },
    });
    expect({
      pending: result.pending?.id,
      shown: { restricted: held.restricted, context: held.context },
      confirmed: confirmed.output,
      ran: server.ran.length,
    }).toStrictEqual({
      pending: held.id,
      shown: { restricted: true, context: appOrigin.context },
      confirmed: '{"sent":"ben@acme.test"}',
      ran: 1,
    });
  });

  it("from a run that read restricted data waits for the person it acts for, and its retries get the answer", async () => {
    const anna = someone();
    const connectionId = await addConnection();
    const run = appFor(anna.userId, "app-crm");
    const call = { ...mail(connectionId), idempotencyKey: "run-1:send" };
    const signed = { restricted: true, origin: runOrigin };
    const attempt = async () => await retried(callAs(run, call, signed));
    const first = await attempt();
    const retry = await attempt();
    const held = await heldFor(anna);
    const before = server.ran.length;
    await confirm(anna, held, { authority: run, signed });
    const afterConfirm = await attempt();
    expect({
      first,
      retry,
      shown: { mode: held.mode, restricted: held.restricted },
      before,
      afterConfirm,
      ran: server.ran.length,
    }).toStrictEqual({
      // Retryable: the step tries again under the same key.
      first: { code: "connect.held", pendingActionId: held.id },
      retry: { code: "connect.held", pendingActionId: held.id },
      shown: { mode: "workflow", restricted: true },
      before: 0,
      afterConfirm: { code: "ok", output: '{"sent":"ben@acme.test"}' },
      ran: 1,
    });
  });

  it("from a run, declined or dropped, fails its retries for good, and waits no more", async () => {
    const anna = someone();
    const admin = someone("admin");
    const [declinedOn, droppedOn] = await Promise.all([
      addConnection(),
      addConnection(),
    ]);
    const run = appFor(anna.userId, "app-crm");
    const signed = { restricted: true, origin: runOrigin };
    const declinedCall = {
      ...mail(declinedOn),
      idempotencyKey: "run-1:declined",
    };
    const droppedCall = { ...mail(droppedOn), idempotencyKey: "run-1:dropped" };
    await retried(callAs(run, declinedCall, signed));
    await retried(callAs(run, droppedCall, signed));
    const waiting = await waitingFor(anna);
    const declined = waiting.find(
      ({ connectionId }) => connectionId === declinedOn
    );
    if (declined === undefined) {
      throw new Error("Nothing held");
    }
    await decline(anna, declined);
    await exports.default.disconnect({
      person: admin,
      connectionId: droppedOn,
    });
    const stillPending = await Promise.all(
      [declinedCall, droppedCall].map(
        async ({ idempotencyKey }) =>
          await exports.default.anyPending({
            onBehalfOf: anna.userId,
            idempotencyKey,
          })
      )
    );
    expect({
      stillPending,
      declined: await retried(callAs(run, declinedCall, signed)),
      ran: server.ran,
    }).toStrictEqual({
      stillPending: [false, false],
      declined: { code: "connect.declined", pendingActionId: undefined },
      ran: [],
    });
  });

  it("from a run that read nothing restricted isn't held", async () => {
    const anna = someone();
    const connectionId = await addConnection();
    const result = await callAs(appFor(anna.userId), mail(connectionId), {
      origin: runOrigin,
    });
    expect({
      output: result.output,
      waiting: await waitingFor(anna),
    }).toStrictEqual({ output: '{"sent":"ben@acme.test"}', waiting: [] });
  });

  it("lists the newest 200 waiting, newest first, and still confirms an older one", async () => {
    const anna = someone();
    const connectionId = await addConnection();
    const first = mail(connectionId);
    const { pending } = await hold(inChat(anna), first);
    const firstId = pending?.id ?? "";
    const db = drizzle(env.DB);
    const oldest = await db
      .select()
      .from(pendingActions)
      .where(eq(pendingActions.id, firstId))
      .get();
    if (oldest === undefined) {
      throw new Error("Nothing held");
    }
    // Two hundred newer ones, as more calls would leave them: one statement
    // each, as D1 binds at most 100 values to one.
    const [one, ...more] = Array.from({ length: 200 }, (_, index) =>
      db.insert(pendingActions).values({
        ...oldest,
        id: crypto.randomUUID(),
        idempotencyKey: `chat-1:${crypto.randomUUID()}`,
        createdAt: new Date(oldest.createdAt.getTime() + 1000 + index),
      })
    );
    if (one === undefined) {
      throw new Error("Nothing to insert");
    }
    await db.batch([one, ...more]);
    const listed = await waitingFor(anna);
    const found = await exports.default.pendingAction({
      person: anna,
      id: firstId,
    });
    if (found === null) {
      throw new Error("The oldest isn't found");
    }
    const requested = listed.map(({ requestedAt }) => Date.parse(requestedAt));
    await confirm(anna, found);
    expect({
      listed: listed.length,
      newestFirst: requested.every(
        (at, index) => index === 0 || at < (requested[index - 1] ?? at + 1)
      ),
      oldestListed: listed.some(({ id }) => id === firstId),
      ran: server.ran,
    }).toStrictEqual({
      listed: 200,
      newestFirst: true,
      oldestListed: false,
      ran: [{ tool: "mail.send", input: first.input }],
    });
  });

  it("isn't held without what core checks again on confirming it", async () => {
    const anna = someone();
    const connectionId = await addConnection();
    // As a core of the release before signs it: refused, as it was then.
    await expect(
      outcome(callAs(inChat(anna), mail(connectionId)))
    ).resolves.toBe("connect.confirmation_required");
    expect({ ran: server.ran, waiting: await waitingFor(anna) }).toStrictEqual({
      ran: [],
      waiting: [],
    });
  });
});
