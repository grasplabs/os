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
import { fakeGateway } from "./ai-gateway.ts";
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

/** What a held call returned to the chat's code, as the model read it. */
const pendingOf = (id: string | undefined) =>
  `Returned:\n${JSON.stringify({ output: null, pending: { id } })}`;

/** The model reads how the held call `id` ended, or why it can't. */
const outcomeOf = (id: string) =>
  codeStep(
    `export default async (env) => { try { return await env.connections.outcome(${JSON.stringify(id)}); } catch (error) { return error.message; } };`
  );

/** What the chat's code steps returned, as the model read them. */
const texts = async (
  stub: Awaited<ReturnType<typeof chatOf>>["stub"],
  chatId: string
) => {
  const results = await codeResults(stub, chatId);
  return results.map(({ text }) => text);
};

describe("a chat's connections", setUpTime, () => {
  it("hold a write, with no key of the model's, for the person to confirm, and send it once when they do", async () => {
    const { person, mail, chat, grant } = await setUp(
      codeStep(
        `export default async (env) => await env.connections.call("MAIL", "mail.send", ${JSON.stringify(invoiceMail)});`
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

    await person.api.pendingActions.confirm(
      held?.id ?? "",
      held?.inputHash ?? ""
    );
    // Taken: it can't be confirmed, and so sent, a second time.
    await expect(
      outcome(
        person.api.pendingActions.confirm(held?.id ?? "", held?.inputHash ?? "")
      )
    ).resolves.toBe("connect.pending_not_found");
    expect({
      waiting: await person.api.pendingActions.list(),
      sent: await mail.did(),
    }).toStrictEqual({
      waiting: [],
      sent: { calls: 1, sent: [invoiceMail] },
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
    // Each call recorded once, naming the chat: the listing and the call
    // refused before connect as the agent's, the calls connect took by
    // connect.
    const events = await eventsOf(
      chat.agent.agentId,
      (all) =>
        all.filter(
          ({ action, detail }) =>
            // Not the catalog each turn reads for its skills.
            (action === "agent.call" && detail.turn !== true) ||
            action === "connection.call"
        ).length === 4
    );
    const actor = { ...chat.agent, onBehalfOf: person.userId };
    expect(
      events
        .filter(
          ({ action, detail }) =>
            // Not the catalog each turn reads for its skills.
            (action === "agent.call" && detail.turn !== true) ||
            action === "connection.call"
        )
        .map(({ action, actor: by, target, detail }) => ({
          action,
          by,
          target: target?.id ?? null,
          method: detail.method ?? null,
          outcome: detail.outcome,
          reason: detail.reason ?? null,
          chat: detail.chat,
        }))
        .toSorted(
          (one, other) =>
            one.action.localeCompare(other.action) ||
            String(one.method).localeCompare(String(other.method)) ||
            String(one.target).localeCompare(String(other.target))
        )
    ).toStrictEqual(
      [
        {
          action: "agent.call",
          by: actor,
          target: null,
          method: "connections.call",
          outcome: "refused",
          reason: "connect.connection_not_found",
          chat: chat.chat.id,
        },
        {
          action: "agent.call",
          by: actor,
          target: null,
          method: "connections.list",
          outcome: "ok",
          reason: null,
          chat: chat.chat.id,
        },
        {
          action: "connection.call",
          by: actor,
          target: mail.id,
          method: null,
          outcome: "ok",
          reason: null,
          chat: chat.chat.id,
        },
        {
          action: "connection.call",
          by: actor,
          target: theirs.id,
          method: null,
          outcome: "refused",
          reason: "connect.not_owner",
          chat: chat.chat.id,
        },
      ].toSorted(
        (one, other) =>
          one.action.localeCompare(other.action) ||
          String(one.method).localeCompare(String(other.method)) ||
          String(one.target).localeCompare(String(other.target))
      )
    );
  });

  it("audit a call refused before connect once, by core, and one connect took by connect alone", async () => {
    const { mail, chat, grant } = await setUp(
      codeStep(
        `export default async (env) => {
          const tried = async (action) => { try { await env.connections.call("MAIL", action, { query: "invoice" }); return "ok"; } catch (error) { return error.message; } };
          return {
            search: await tried("mail.search"),
            badAction: await tried("not an action!"),
          };
        };`
      ),
      says("Done.")
    );
    await grant(mail.id, "MAIL");

    await chat.ask("Try them.");

    const invalid = connectErrors.create("connect.invalid").message;
    const [result] = await codeResults(chat.stub, chat.chat.id);
    expect(result?.text).toBe(
      `Returned:\n${JSON.stringify({ search: "ok", badAction: invalid })}`
    );
    // The one refused before connect, by core, once; the one connect took,
    // by connect alone.
    const events = await eventsOf(
      chat.agent.agentId,
      (all) =>
        all.filter(
          ({ action, detail }) =>
            (action === "agent.call" && detail.method === "connections.call") ||
            action === "connection.call"
        ).length === 2
    );
    expect(
      events
        .filter(
          ({ action, detail }) =>
            (action === "agent.call" && detail.method === "connections.call") ||
            action === "connection.call"
        )
        .map(
          ({ action, detail }) =>
            `${action} ${String(detail.outcome)} ${String(detail.reason ?? "")}`
        )
        .toSorted()
    ).toStrictEqual([
      "agent.call refused connect.invalid",
      "connection.call ok ",
    ]);
  });

  it("find the same held write when the model asks for it again while it waits, whatever options it passes, and hold a new one once it is decided", async () => {
    // A fourth argument, as the API once took a key there, is ignored: two
    // keys don't make two actions.
    const send = (key: string) =>
      codeStep(
        `export default async (env) => await env.connections.call("MAIL", "mail.send", ${JSON.stringify(invoiceMail)}, { idempotencyKey: "${key}" });`
      );
    const { person, mail, chat, grant } = await setUp(
      send("first"),
      says("It waits for you."),
      send("second"),
      says("It still waits for you."),
      send("third"),
      says("I asked anew.")
    );
    await grant(mail.id, "MAIL");

    await chat.ask("Send Ben the invoice.");
    await chat.ask("Try again.");
    const waiting = await person.api.pendingActions.list();
    const [held] = waiting;
    await person.api.pendingActions.decline(held?.id ?? "");
    await chat.ask("Once more.");

    const anew = await person.api.pendingActions.list();
    const results = await codeResults(chat.stub, chat.chat.id);
    expect({
      waiting: waiting.map(({ input }) => input),
      anew: anew.map(({ input }) => input),
      sameAction: anew[0]?.id === held?.id,
      results: results.map(({ text }) => text),
      sent: await mail.did(),
    }).toStrictEqual({
      waiting: [JSON.stringify(invoiceMail)],
      anew: [JSON.stringify(invoiceMail)],
      sameAction: false,
      results: [
        pendingOf(held?.id),
        pendingOf(held?.id),
        pendingOf(anew[0]?.id),
      ],
      sent: { calls: 0, sent: [] },
    });
  });

  it("read how a held call ended by its ID: a read held in a restricted chat, once its person confirmed it, and only in the chat that asked", async () => {
    const { person, mail, chat, grant } = await setUp(
      codeStep(
        `export default async (env) => {
          const held = await env.connections.call("MAIL", "mail.search", { query: "invoice" });
          return { held: held.output, now: await env.connections.outcome(held.pending.id) };
        };`
      ),
      says("It waits for you.")
    );
    await grant(mail.id, "MAIL");
    // The chat has read restricted data: on a Composio connection every
    // call from it is held now, a read too.
    await chat.stub.restrictChat(chat.chat.id);

    await chat.ask("Find the invoice.");
    const [held] = await person.api.pendingActions.list();
    const id = held?.id ?? "";
    const searchedBefore = await mail.searched();
    await person.api.pendingActions.confirm(id, held?.inputHash ?? "");

    await pointAtGateway(
      chat.stub,
      fakeGateway(outcomeOf(id), says("Found it."), outcomeOf(id), says("No."))
    );
    await chat.ask("What did it find?");
    // Another chat of the same person and agent, and another person's chat.
    const other = await chat.stub.createChat("Other", person.userId, chat.id);
    await chat.stub.ask(other.id, { text: "What did it find?", model });
    const ben = await signedInApi(idp, "user");
    const bens = await chatOf(ben.userId, outcomeOf(id), says("No."));
    await bens.ask("What did it find?");

    const notFound = connectErrors.create("connect.pending_not_found").message;
    const found = { messages: ["invoice-1"] };
    expect({
      searchedBefore,
      searched: await mail.searched(),
      mine: await texts(chat.stub, chat.chat.id),
      otherChat: await texts(chat.stub, other.id),
      bens: await texts(bens.stub, bens.chat.id),
    }).toStrictEqual({
      searchedBefore: [],
      searched: ["invoice"],
      mine: [
        `Returned:\n${JSON.stringify({ held: null, now: { status: "waiting", output: null, error: null } })}`,
        `Returned:\n${JSON.stringify({ status: "done", output: found, error: null })}`,
      ],
      otherChat: [`Returned:\n${notFound}`],
      bens: [`Returned:\n${notFound}`],
    });
    // Each read of the outcome is audited, with the connection it read.
    const events = await eventsOf(
      chat.agent.agentId,
      (all) =>
        all.filter(({ detail }) => detail.method === "connections.outcome")
          .length === 3
    );
    expect(
      events
        .filter(({ detail }) => detail.method === "connections.outcome")
        .map(({ detail }) => ({
          outcome: detail.outcome,
          status: detail.status ?? detail.reason,
          connection: detail.connection ?? null,
          pendingActionId: detail.pendingActionId,
        }))
        .toSorted((one, two) =>
          String(one.status).localeCompare(String(two.status))
        )
    ).toStrictEqual([
      {
        outcome: "refused",
        status: "connect.pending_not_found",
        connection: null,
        pendingActionId: id,
      },
      {
        outcome: "ok",
        status: "done",
        connection: mail.id,
        pendingActionId: id,
      },
      {
        outcome: "ok",
        status: "waiting",
        connection: mail.id,
        pendingActionId: id,
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
