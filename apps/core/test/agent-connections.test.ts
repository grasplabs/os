import type { AuditEvent } from "@grasp-os/shared/audit";
import { connectErrors } from "@grasp-os/shared/connect";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  chatOf,
  codeResults,
  codeStep,
  gatewayConfig,
  model,
  pointAtGateway,
  says,
} from "./agent-chat.ts";
import { requestGranted } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { mailConnection, mailWithSearch } from "./mail-connection.ts";
import { outcome, signedInApi } from "./sign-in.ts";
import { connectDb } from "./test-env.ts";

// `env.connections` in a chat's code: the chat's agent acting through the
// connections it was granted, for its person. These tests start from the
// ways it can fail: a write goes out before the person confirms it; the
// agent reaches a connection it wasn't granted, or someone else's personal
// connection (R5); a call leaves no trace; and what a connection returned
// reaches a model the client's rules forbid for that connection's data, in
// a later turn.

const idp = mockIdp();

/** Signing people in and granting permissions can be slow on CI. */
const setUpTime = { timeout: 60_000 };

const invoiceMail = { to: "ben@acme.test", subject: "Invoice INV-7" };

/** The chat's person, an admin to grant, and a mail connection. */
const setUp = async (...replies: Parameters<typeof chatOf>[1][]) => {
  const person = await signedInApi(idp, "user");
  const admin = await signedInApi(idp, "admin");
  const mail = await mailConnection([], mailWithSearch);
  const chat = await chatOf(person.userId, ...replies);
  const grant = async (connectionId: string, binding: string) =>
    await requestGranted(idp, admin, {
      subject: chat.agent,
      object: { type: "connection", connectionId },
      actions: ["mail.send", "mail.search"],
      binding,
    });
  return { person, admin, mail, chat, grant };
};

/** The audit events of the chat's agent, once `done` holds for them. */
const eventsOf = async (
  agentId: string,
  done: (events: AuditEvent[]) => boolean
): Promise<AuditEvent[]> => {
  const mine = async () => {
    const events = await allEvents();
    return events.filter(
      ({ actor }) => actor.type === "agent" && actor.agentId === agentId
    );
  };
  await vi.waitFor(
    async () => {
      expect(done(await mine())).toBeTruthy();
    },
    { timeout: 10_000, interval: 50 }
  );
  return await mine();
};

describe("a chat's connections", setUpTime, () => {
  it("hold a write for the person to confirm instead of sending it", async () => {
    const { person, mail, chat, grant } = await setUp(
      codeStep(
        `export default async (env) => await env.connections.call("MAIL", "mail.send", ${JSON.stringify(invoiceMail)}, { idempotencyKey: "invoice-7" });`
      ),
      says("It waits for you to confirm it.")
    );
    await grant(mail.id, "MAIL");

    await chat.ask("Send Ben the invoice.");

    const [held, ...others] = await person.api.pendingActions.list();
    expect({
      result: await codeResults(chat.stub, chat.chat.id),
      held: held?.input,
      others: others.length,
      sent: await mail.did(),
    }).toStrictEqual({
      result: [
        {
          isError: false,
          text: `Returned:\n${JSON.stringify({ output: null, pending: { id: held?.id } })}`,
        },
      ],
      held: JSON.stringify(invoiceMail),
      others: 0,
      sent: { calls: 0, sent: [] },
    });
  });

  it("list and call only the connections the agent was granted that its person may use", async () => {
    const { person, admin, mail, chat, grant } = await setUp(
      codeStep(
        `export default async (env) => {
          const tried = async (name) => { try { return (await env.connections.call(name, "mail.search", { query: "invoice" })).output; } catch (error) { return error.message; } };
          const listed = await env.connections.list();
          return {
            listed: listed.map(({ name, connectionId, actions }) => ({ name, connectionId, actions })),
            mail: await tried("MAIL"),
            theirs: await tried("THEIRS"),
            ungranted: await tried("OTHER"),
          };
        };`
      ),
      says("Done.")
    );
    // Someone else's personal connection, granted to the agent anyway.
    const theirs = await mailConnection([], mailWithSearch);
    await connectDb()
      .prepare(
        "UPDATE connections SET scope = 'personal', owner_user_id = ? WHERE id = ?"
      )
      .bind(admin.userId, theirs.id)
      .run();
    await grant(mail.id, "MAIL");
    await grant(theirs.id, "THEIRS");

    await chat.ask("Find the invoice.");

    const [result] = await codeResults(chat.stub, chat.chat.id);
    expect(result?.text).toBe(
      `Returned:\n${JSON.stringify({
        listed: [
          {
            name: "MAIL",
            connectionId: mail.id,
            actions: ["mail.send", "mail.search"],
          },
        ],
        mail: { messages: ["invoice-1"] },
        theirs: connectErrors.create("connect.not_owner").message,
        ungranted: connectErrors.create("connect.connection_not_found").message,
      })}`
    );
    // The listing is audited as the agent's; the calls by connect.
    const events = await eventsOf(chat.agent.agentId, (all) =>
      all.some(({ action }) => action === "agent.call")
    );
    expect(
      events
        .filter(({ action }) => action === "agent.call")
        .map(({ actor, detail }) => ({ actor, detail }))
    ).toStrictEqual([
      {
        actor: { ...chat.agent, onBehalfOf: person.userId },
        detail: {
          method: "connections.list",
          connections: 1,
          chat: chat.chat.id,
        },
      },
    ]);
  });

  it("keep a chat that read an EU-only connection to EU models, in every later turn", async () => {
    const { mail, chat, grant } = await setUp(
      codeStep(
        `export default async (env) => (await env.connections.call("MAIL", "mail.search", { query: "invoice" })).output;`
      ),
      says("Never sent.")
    );
    const euModel = "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast";
    await pointAtGateway(chat.stub, chat.gateway, {
      config: {
        gateway: gatewayConfig.gateway,
        models: [model, euModel],
        eu: { connections: [mail.id], models: [euModel] },
      },
    });
    await grant(mail.id, "MAIL");

    const first = await chat.ask("Find the invoice.");
    await expect(outcome(chat.ask("And now?"))).resolves.toBe("model.eu_only");

    expect({
      first: first.outcome,
      requests: chat.gateway.requests.length,
      searched: await mail.searched(),
    }).toStrictEqual({ first: "failed", requests: 1, searched: ["invoice"] });
    const events = await eventsOf(
      chat.agent.agentId,
      (all) =>
        all.filter(({ action }) => action === "model.refused").length === 2
    );
    expect(
      events
        .filter(({ action }) => action === "model.refused")
        .map(({ detail }) => detail.because)
    ).toStrictEqual(["connection", "connection"]);
  });
});
