import type { AuditEvent } from "@grasp-os/shared/audit";
import type { ConnectResult, PendingAction } from "@grasp-os/shared/connect";
import { authoritySchema } from "@grasp-os/shared/permissions";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { bindingsFor } from "../src/bindings.ts";
import { restrict } from "../src/restricted.ts";
import { requestGranted } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { connectionIn, newChat } from "./contexts.ts";
import { mockIdp } from "./idp.ts";
import { mailConnection } from "./mail-connection.ts";
import {
  openRpc,
  outcome,
  signedIn,
  signedInApi,
  staffPerson,
  unique,
} from "./sign-in.ts";

// Side effects from chat, as a person sees and decides them through core
// (threat model R7, CN8). Connect holds the write; core shows it only to
// the person it acts for and runs it only on their word, after checking
// the agent's permission, its chat's restricted mode and the person again.
// The ways it can fail come first: the write goes out before the person
// confirms; confirming twice sends twice; someone else confirms it (another
// member, Grasp staff, a person who was removed); it is confirmed after its
// permission was revoked or its chat read restricted data.

const idp = mockIdp();

const person = async (role: Role = "user") => await signedInApi(idp, role);
type Person = Awaited<ReturnType<typeof person>>;

const invoiceMail = { to: "ben@acme.test", subject: "Invoice INV-7" };

/**
 * An agent that may send mail on a mail connection of its own, working in
 * a chat for `owner`, and the mail it asks to send.
 */
const setUp = async () => {
  const owner = await person();
  const admin = await person("admin");
  const mail = await mailConnection();
  const agent = { type: "agent" as const, agentId: `agent-${unique()}` };
  const permissionId = await requestGranted(idp, admin, {
    subject: agent,
    object: { type: "connection", connectionId: mail.id },
    actions: ["mail.send"],
    binding: "MAIL",
  });
  const chat = await newChat();
  const key = `chat:${unique()}`;
  /** The agent asks to send the mail, with the same key each time. */
  const send = async (): Promise<ConnectResult> => {
    const bindings = await bindingsFor(
      env,
      authoritySchema.parse({
        subject: agent,
        onBehalfOf: owner.userId,
        mode: "interactive",
      }),
      chat
    );
    const stub = connectionIn(bindings, "MAIL");
    if (!stub) {
      throw new Error("No MAIL binding");
    }
    return await stub.call("mail.send", invoiceMail, { idempotencyKey: key });
  };
  return { owner, admin, mail, agent, chat, permissionId, send };
};

/** The one held action waiting for `someone`. */
const heldFor = async (someone: Person): Promise<PendingAction> => {
  const [held, ...others] = await someone.api.pendingActions.list();
  if (held === undefined || others.length > 0) {
    throw new Error("Expected one held action");
  }
  return held;
};

const confirm = async (
  someone: Pick<Person, "api">,
  held: PendingAction
): Promise<string> =>
  await outcome(someone.api.pendingActions.confirm(held.id, held.inputHash));

/** The audit events about held action `id`, once the log has `count`. */
const eventsOf = async (id: string, count: number): Promise<AuditEvent[]> =>
  await vi.waitFor(async () => {
    const all = await allEvents();
    const events = all.filter(({ detail }) => detail.pendingActionId === id);
    if (events.length < count) {
      throw new Error("Not every event is in the audit log yet");
    }
    return events;
  }, 10_000);

describe("a side effect an agent asks for in chat", () => {
  it("waits for its person, who sees the exact mail, and is sent once on their word", async () => {
    const { owner, mail, send } = await setUp();
    const asked = await send();
    const held = await heldFor(owner);
    const before = await mail.did();
    const confirmed = await owner.api.pendingActions.confirm(
      held.id,
      held.inputHash
    );
    const again = await confirm(owner, held);
    // The agent asking again gets the answer, and sends nothing more.
    const repeat = await send();
    expect({
      asked: asked.pending?.id,
      shown: held.input,
      before,
      confirmed: confirmed.output,
      again,
      repeat: repeat.output,
      after: await mail.did(),
      waiting: await owner.api.pendingActions.list(),
    }).toStrictEqual({
      asked: held.id,
      shown: JSON.stringify(invoiceMail),
      before: { calls: 0, sent: [] },
      confirmed: '{"messageId":"message-1"}',
      again: "connect.pending_not_found",
      repeat: '{"messageId":"message-1"}',
      after: { calls: 1, sent: [invoiceMail] },
      waiting: [],
    });
    const events = await eventsOf(held.id, 4);
    // Held and run as the agent's calls; confirmed, and confirmed again in
    // vain, by the person.
    expect(
      events
        .map(({ action, actor }) => ({
          action,
          by: actor.type === "person" ? actor.userId : actor.type,
        }))
        .toSorted((one, other) => one.action.localeCompare(other.action))
    ).toStrictEqual([
      { action: "connection.action.confirm_refused", by: owner.userId },
      { action: "connection.action.confirmed", by: owner.userId },
      { action: "connection.call", by: "agent" },
      { action: "connection.call", by: "agent" },
    ]);
  });

  it("is seen and decided by nobody else: not another member, staff or someone removed", async () => {
    const { owner, admin, mail, send } = await setUp();
    await send();
    const held = await heldFor(owner);
    const other = await person("admin");
    const staffSession = await signedIn(idp, "grasp-staff", staffPerson());
    const { core } = await openRpc(staffSession);
    const staff = { api: core.authenticate() };
    const others = {
      otherList: await other.api.pendingActions.list(),
      staffList: await staff.api.pendingActions.list(),
      other: await confirm(other, held),
      staff: await confirm(staff, held),
      otherDecline: await outcome(other.api.pendingActions.decline(held.id)),
      staffDecline: await outcome(staff.api.pendingActions.decline(held.id)),
    };
    await admin.api.members.remove(owner.userId);
    expect({
      ...others,
      removed: await confirm(owner, held),
      sent: await mail.did(),
    }).toStrictEqual({
      otherList: [],
      staffList: [],
      other: "connect.pending_not_found",
      staff: "connect.pending_not_found",
      otherDecline: "connect.pending_not_found",
      staffDecline: "connect.pending_not_found",
      removed: "auth.unauthenticated",
      sent: { calls: 0, sent: [] },
    });
  });

  it("isn't sent once the agent's permission is revoked, which is recorded under the person", async () => {
    const { owner, admin, mail, send, permissionId } = await setUp();
    await send();
    const held = await heldFor(owner);
    await admin.api.permissions.revoke(permissionId);
    const revoked = await confirm(owner, held);
    const stillWaiting = await owner.api.pendingActions.list();
    expect({
      revoked,
      sent: await mail.did(),
      stillWaiting: stillWaiting.map(({ id }) => id),
    }).toStrictEqual({
      revoked: "permission.denied",
      sent: { calls: 0, sent: [] },
      stillWaiting: [held.id],
    });
    const events = await eventsOf(held.id, 2);
    expect(
      events
        .filter(({ action }) => action === "connection.action.confirm_refused")
        .map(({ actor, detail }) => ({ actor, reason: detail.reason }))
    ).toStrictEqual([
      {
        actor: { type: "person", userId: owner.userId },
        reason: "permission.denied",
      },
    ]);
  });

  it("warns once its chat read restricted data, and records the confirmation as restricted", async () => {
    const { owner, agent, chat, mail, send } = await setUp();
    await send();
    await restrict(
      env,
      authoritySchema.parse({
        subject: agent,
        onBehalfOf: owner.userId,
        mode: "interactive",
      }),
      chat,
      ["collection-payroll"]
    );
    const held = await heldFor(owner);
    const confirmed = await confirm(owner, held);
    expect({
      warned: held.restricted,
      confirmed,
      sent: await mail.did(),
    }).toStrictEqual({
      warned: true,
      confirmed: "ok",
      sent: { calls: 1, sent: [invoiceMail] },
    });
    const events = await eventsOf(held.id, 3);
    // Held before the chat was restricted; confirmed and sent after.
    expect(
      events
        .map(({ action, detail }) => `${action} ${String(detail.restricted)}`)
        .toSorted()
    ).toStrictEqual([
      "connection.action.confirmed true",
      "connection.call true",
      "connection.call undefined",
    ]);
  });

  it("is dropped when its person declines it, recorded under them", async () => {
    const { owner, mail, send } = await setUp();
    await send();
    const held = await heldFor(owner);
    await owner.api.pendingActions.decline(held.id);
    expect({
      waiting: await owner.api.pendingActions.list(),
      confirmed: await confirm(owner, held),
      sent: await mail.did(),
    }).toStrictEqual({
      waiting: [],
      confirmed: "connect.pending_not_found",
      sent: { calls: 0, sent: [] },
    });
    const events = await eventsOf(held.id, 2);
    expect(
      events.find(({ action }) => action === "connection.action.declined")
        ?.actor
    ).toStrictEqual({ type: "person", userId: owner.userId });
  });

  it("is refused as before, and a restricted chat calls nothing, while held actions are switched off", async () => {
    const { owner, agent, chat, mail, send } = await setUp();
    const on = z.record(z.string(), z.boolean()).parse(env.FEATURES);
    const { FEATURES: features } = env;
    let whileOff: { unrestricted: string; restricted: string };
    try {
      env.FEATURES = { ...on, confirmations: false };
      const unrestricted = await outcome(send());
      await restrict(
        env,
        authoritySchema.parse({
          subject: agent,
          onBehalfOf: owner.userId,
          mode: "interactive",
        }),
        chat,
        ["collection-payroll"]
      );
      whileOff = { unrestricted, restricted: await outcome(send()) };
    } finally {
      env.FEATURES = features;
    }
    expect({
      whileOff,
      waiting: await owner.api.pendingActions.list(),
      sent: await mail.did(),
    }).toStrictEqual({
      whileOff: {
        unrestricted: "connect.confirmation_required",
        restricted: "permission.restricted",
      },
      waiting: [],
      sent: { calls: 0, sent: [] },
    });
  });
});
