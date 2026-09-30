import type { AuditEvent } from "@grasp-os/shared/audit";
import { connectErrors } from "@grasp-os/shared/connect";
import { permissionErrors } from "@grasp-os/shared/permissions";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { retryDisconnects } from "../src/members.ts";
import {
  codeResults,
  codeStep,
  personalChatsOf,
  says,
  transcript,
} from "./agent-chat.ts";
import { grantReviewed, requestGranted } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { mailConnection, mailWithSearch } from "./mail-connection.ts";
import { outcome, signedInApi } from "./sign-in.ts";
import { connectDb } from "./test-env.ts";

// A chat's agent asking for a connection, and its person granting their
// own on a card in the chat (chat-connections.ts). These start from the
// ways it can fail: someone grants a connection that isn't theirs; a card
// replayed or forged; the agent asks for more than it may, or gets more
// than it asked for; a grant reaching past its chat (another chat, the
// chat deleted, the connection gone); an admin-hidden connector; and a
// decision nobody can trace.

const idp = mockIdp();

/** Signing people in and running turns can be slow on CI. */
const setUpTime = { timeout: 90_000 };

/** A chat's code step running `expression`, returning why it was refused. */
const tries = (expression: string) =>
  codeStep(
    `export default async (env) => { try { return await ${expression}; } catch (error) { return error.message; } };`
  );

/** Asking for connection `connectionId` as `binding`, with `actions`. */
const asks = (
  connectionId: string,
  binding = "MAIL",
  actions: string[] = ["mail.search"]
) =>
  tries(
    `env.connections.request(${JSON.stringify({
      connectionId,
      actions,
      binding,
      reason: "To find the invoice you asked about.",
    })})`
  );

/** Searching mail through the connection named `binding`. */
const searches = (binding = "MAIL") =>
  tries(
    `env.connections.call("${binding}", "mail.search", { query: "invoice" }).then(({ output }) => output)`
  );

/** A mail connection `owner` holds as their personal one. */
const personalMail = async (owner: string) => {
  const mail = await mailConnection([], mailWithSearch);
  await connectDb()
    .prepare(
      "UPDATE connections SET scope = 'personal', owner_user_id = ? WHERE id = ?"
    )
    .bind(owner, mail.id)
    .run();
  return mail;
};

/** Hides the catalog entry every test mail connection is of. */
const hideMail = async (admin: string) => {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO hidden_connectors (source, connector_id, hidden_by, hidden_at) VALUES ('composio', 'mail', ?, ?)"
  )
    .bind(admin, Date.now())
    .run();
};

const offerMail = async () => {
  await env.DB.prepare(
    "DELETE FROM hidden_connectors WHERE source = 'composio' AND connector_id = 'mail'"
  ).run();
};

type Stub = Awaited<ReturnType<typeof personalChatsOf>>["stub"];

/** What each code step of the chat returned, as the model read it. */
const results = async (stub: Stub, chatId: string): Promise<string[]> => {
  const steps = await codeResults(stub, chatId);
  return steps.map(({ text }) => text);
};

/** What code step `index` of the chat returned. */
const resultAt = async (
  stub: Stub,
  chatId: string,
  index: number
): Promise<string | undefined> => {
  const all = await results(stub, chatId);
  return all[index];
};

const noteSchema = z.object({ role: z.literal("system"), content: z.string() });

/** The notes the chat keeps for its agent (system messages). */
const notes = async (stub: Stub, chatId: string): Promise<string[]> => {
  const messages: unknown[] = await transcript(stub, chatId);
  return messages.flatMap((message) => {
    const note = noteSchema.safeParse(message);
    return note.success ? [note.data.content] : [];
  });
};

const returned = (value: unknown) => `Returned:\n${JSON.stringify(value)}`;

/** A code step that caught a refusal and returned its message. */
const refusedWith = (message: string) => `Returned:\n${message}`;

/** The permission events of the permission `id`, once there are `count`. */
const permissionEvents = async (
  id: string,
  count: number
): Promise<AuditEvent[]> => {
  const of = async () => {
    const events = await allEvents();
    return events.filter(
      ({ action, target, detail }) =>
        action.startsWith("permission.") &&
        target?.id === id &&
        detail.outcome !== "refused"
    );
  };
  await vi.waitFor(
    async () => {
      await expect(of()).resolves.toHaveLength(count);
    },
    { timeout: 10_000, interval: 50 }
  );
  return await of();
};

/** A permission's status as stored, whoever may list it. */
const statusOf = async (id: string): Promise<string | undefined> => {
  const row = await env.DB.prepare(
    "SELECT status FROM permissions WHERE id = ?"
  )
    .bind(id)
    .first<{ status: string }>();
  return row?.status;
};

/** Whether `userId`'s removal still waits for the disconnect retry. */
const pending = async (userId: string): Promise<boolean> => {
  const row = await env.DB.prepare(
    "SELECT disconnected_at FROM member_removals WHERE user_id = ?"
  )
    .bind(userId)
    .first<{ disconnected_at: number | null }>();
  return row?.disconnected_at === null;
};

interface Refused {
  action: string;
  by: string | null;
  target: string | null;
  reason: string;
}

/** A stable order for refusals, whichever landed first. */
const byFields = (one: Refused, other: Refused): number =>
  JSON.stringify(one).localeCompare(JSON.stringify(other));

/** The refused decisions on the requests `ids`, once there are `count`. */
const refusedDecisions = async (
  ids: string[],
  count: number
): Promise<Refused[]> => {
  const of = async () => {
    const events = await allEvents();
    return events.flatMap(({ action, actor, target, detail }) =>
      detail.outcome === "refused" && ids.includes(target?.id ?? "")
        ? [
            {
              action,
              by: "userId" in actor ? actor.userId : null,
              target: target?.id ?? null,
              reason: String(detail.reason),
            },
          ]
        : []
    );
  };
  await vi.waitFor(
    async () => {
      await expect(of()).resolves.toHaveLength(count);
    },
    { timeout: 10_000, interval: 50 }
  );
  const refused = await of();
  return refused.toSorted(byFields);
};

describe("a connection the chat's agent asks for", setUpTime, () => {
  it("is granted by its person, from the chat, as asked, in that chat alone, and audited", async () => {
    const person = await signedInApi(idp, "user");
    const mail = await personalMail(person.userId);
    const chats = await personalChatsOf(
      person.userId,
      asks(mail.id),
      says("It waits for you."),
      searches(),
      says("Found it."),
      searches(),
      says("That chat can't."),
      tries(
        `env.connections.call("MAIL", "mail.send", { to: "ben@acme.test", subject: "Invoice" })`
      ),
      says("I may only search.")
    );
    const first = await chats.newChat();
    const other = await chats.newChat();

    await first.ask("Find the invoice in my mail.");
    const [request, ...more] = await person.api.chats.connectionRequests(
      first.chat.id
    );
    const { id = "", requestedAt, ...shown } = request ?? {};
    expect({
      shown,
      requestedAt: typeof requestedAt,
      more: more.length,
    }).toStrictEqual({
      shown: {
        connectionId: mail.id,
        provider: "mail",
        accountName: null,
        resource: null,
        actions: ["mail.search"],
        binding: "MAIL",
        reason: "To find the invoice you asked about.",
        decidedBy: "you",
      },
      requestedAt: "string",
      more: 0,
    });
    // The other chat has nothing waiting.
    await expect(
      person.api.chats.connectionRequests(other.chat.id)
    ).resolves.toStrictEqual([]);

    await person.api.chats.grantConnection(first.chat.id, id);
    await first.ask("Now look.");
    await other.ask("Look here too.");
    await first.ask("Send it to Ben.");

    const notFound = connectErrors.create("connect.connection_not_found");
    const denied = permissionErrors.create("permission.denied");
    expect({
      first: await results(chats.stub, first.chat.id),
      other: await results(chats.stub, other.chat.id),
      waiting: await person.api.chats.connectionRequests(first.chat.id),
    }).toStrictEqual({
      first: [
        returned({ id, binding: "MAIL", decidedBy: "person" }),
        returned({ messages: ["invoice-1"] }),
        // Only what was asked for: search, not send.
        refusedWith(denied.message),
      ],
      other: [refusedWith(notFound.message)],
      waiting: [],
    });
    // The agent was told, in its chat only.
    const [firstNotes, otherNotes] = await Promise.all([
      notes(chats.stub, first.chat.id),
      notes(chats.stub, other.chat.id),
    ]);
    expect({
      first: firstNotes.some((note) =>
        note.includes('"MAIL" was granted, in this chat only')
      ),
      other: otherNotes.some((note) => note.includes('"MAIL"')),
    }).toStrictEqual({ first: true, other: false });
    const events = await permissionEvents(id, 2);
    expect(
      events.map(({ action, actor, detail }) => ({
        action,
        actor,
        chat: detail.chat,
        actions: detail.actions,
      }))
    ).toStrictEqual([
      {
        action: "permission.requested",
        actor: {
          type: "agent",
          agentId: chats.agent.agentId,
          onBehalfOf: person.userId,
        },
        chat: first.chat.id,
        actions: "mail.search",
      },
      {
        action: "permission.granted",
        actor: { type: "person", userId: person.userId },
        chat: first.chat.id,
        actions: "mail.search",
      },
    ]);
  });

  it("once granted, still holds its writes for the person, and stops with the connection", async () => {
    const person = await signedInApi(idp, "user");
    const mail = await personalMail(person.userId);
    const invoice = { to: "ben@acme.test", subject: "Invoice INV-7" };
    const chats = await personalChatsOf(
      person.userId,
      asks(mail.id, "MAIL", ["mail.send", "mail.search"]),
      says("It waits for you."),
      tries(
        `env.connections.call("MAIL", "mail.send", ${JSON.stringify(invoice)})`
      ),
      says("The mail waits for you."),
      searches(),
      says("It is gone.")
    );
    const { chat, ask } = await chats.newChat();
    await ask("Send Ben the invoice.");
    const [request] = await person.api.chats.connectionRequests(chat.id);
    await person.api.chats.grantConnection(chat.id, request?.id ?? "");

    await ask("Go on.");

    const [held] = await person.api.pendingActions.list();
    expect({ sent: await mail.did(), held: held?.input }).toStrictEqual({
      sent: { calls: 0, sent: [] },
      held: JSON.stringify(invoice),
    });
    await person.api.pendingActions.confirm(
      held?.id ?? "",
      held?.inputHash ?? ""
    );
    await connectDb()
      .prepare("UPDATE connections SET status = 'disconnected' WHERE id = ?")
      .bind(mail.id)
      .run();
    await ask("Search again.");
    expect({
      sent: await mail.did(),
      search: await resultAt(chats.stub, chat.id, 2),
    }).toStrictEqual({
      sent: { calls: 1, sent: [invoice] },
      search: refusedWith(
        connectErrors.create("connect.connection_inactive").message
      ),
    });
  });

  it("is granted only by the person whose chat and connection it is, once, exactly as stored", async () => {
    const person = await signedInApi(idp, "user");
    const someone = await signedInApi(idp, "user");
    const admin = await signedInApi(idp, "admin");
    const mine = await personalMail(person.userId);
    const shared = await mailConnection([], mailWithSearch);
    // First: objects may share the env a gateway is pointed in.
    const theirs = await personalChatsOf(someone.userId);
    const theirChat = await theirs.newChat();
    const chats = await personalChatsOf(
      person.userId,
      asks(mine.id, "MINE"),
      asks(shared.id, "SHARED"),
      says("Both wait.")
    );
    const { chat, ask } = await chats.newChat();
    await ask("Find the invoice.");
    const requests = await person.api.chats.connectionRequests(chat.id);
    const idOf = (binding: string) =>
      requests.find((request) => request.binding === binding)?.id ?? "";
    expect(
      requests.map(({ binding, decidedBy }) => ({ binding, decidedBy }))
    ).toStrictEqual([
      { binding: "MINE", decidedBy: "you" },
      { binding: "SHARED", decidedBy: "admin" },
    ]);

    expect({
      // Someone else, naming the person's chat, or their own.
      othersChat: await outcome(
        someone.api.chats.grantConnection(chat.id, idOf("MINE"))
      ),
      ownChat: await outcome(
        someone.api.chats.grantConnection(theirChat.chat.id, idOf("MINE"))
      ),
      // A card of no request, or of another chat's.
      forged: await outcome(
        person.api.chats.grantConnection(chat.id, crypto.randomUUID())
      ),
      notAnId: await outcome(person.api.chats.grantConnection(chat.id, "MINE")),
      // A shared connection is an admin's; a personal one its owner's.
      shared: await outcome(
        person.api.chats.grantConnection(chat.id, idOf("SHARED"))
      ),
      adminPersonal: await outcome(grantReviewed(admin.api, idOf("MINE"))),
    }).toStrictEqual({
      othersChat: "agent.chat_not_found",
      ownChat: "permission.not_found",
      forged: "permission.not_found",
      notAnId: "permission.not_found",
      shared: "permission.admin_decides",
      adminPersonal: "permission.not_found",
    });

    await person.api.chats.grantConnection(chat.id, idOf("MINE"));
    // Replayed, or decided again the other way: it is decided.
    expect({
      again: await outcome(
        person.api.chats.grantConnection(chat.id, idOf("MINE"))
      ),
      denied: await outcome(
        person.api.chats.denyConnection(chat.id, idOf("MINE"))
      ),
    }).toStrictEqual({
      again: "permission.not_requested",
      denied: "permission.not_requested",
    });
    // Each decision refused past the chat check is on record, and why.
    const refused = await refusedDecisions([idOf("MINE"), idOf("SHARED")], 4);
    // An admin neither sees nor revokes the personal one; the shared one
    // they see as one chat's, without the agent's words.
    const listed = await admin.api.permissions.list(chats.agent);
    expect({
      refused,
      listed: listed.map(({ binding, chat: of, ...rest }) => ({
        binding,
        chat: of,
        reason: "reason" in rest,
      })),
      revoke: await outcome(admin.api.permissions.revoke(idOf("MINE"))),
    }).toStrictEqual({
      listed: [{ binding: "SHARED", chat: chat.id, reason: false }],
      revoke: "permission.not_found",
      refused: [
        {
          action: "permission.granted",
          by: someone.userId,
          target: idOf("MINE"),
          reason: "permission.not_found",
        },
        {
          action: "permission.granted",
          by: person.userId,
          target: idOf("SHARED"),
          reason: "permission.admin_decides",
        },
        {
          action: "permission.granted",
          by: person.userId,
          target: idOf("MINE"),
          reason: "permission.not_requested",
        },
        {
          action: "permission.request_denied",
          by: person.userId,
          target: idOf("MINE"),
          reason: "permission.not_requested",
        },
      ].toSorted(byFields),
    });
    // An admin grants the shared one, in that chat alone.
    const granted = await grantReviewed(admin.api, idOf("SHARED"));
    expect({
      status: granted.status,
      chat: granted.chat,
      actions: granted.actions,
    }).toStrictEqual({
      status: "active",
      chat: chat.id,
      actions: ["mail.search"],
    });
  });

  it("can't be asked for past what the person may use, and waits in few cards", async () => {
    const person = await signedInApi(idp, "user");
    const someone = await signedInApi(idp, "user");
    const theirs = await personalMail(someone.userId);
    const mine = await personalMail(person.userId);
    const gone = await personalMail(person.userId);
    await connectDb()
      .prepare("UPDATE connections SET status = 'disconnected' WHERE id = ?")
      .bind(gone.id)
      .run();
    const chats = await personalChatsOf(
      person.userId,
      codeStep(
        `export default async (env) => {
          const tried = async (ask) => { try { return (await env.connections.request({ reason: "To help.", actions: ["mail.search"], ...ask })).binding; } catch (error) { return error.message; } };
          const available = await env.connections.available();
          return {
            available: available.filter(({ connectionId }) => [${JSON.stringify(mine.id)}, ${JSON.stringify(theirs.id)}, ${JSON.stringify(gone.id)}].includes(connectionId)),
            theirs: await tried({ connectionId: ${JSON.stringify(theirs.id)}, binding: "THEIRS" }),
            gone: await tried({ connectionId: ${JSON.stringify(gone.id)}, binding: "GONE" }),
            noSuchAction: await tried({ connectionId: ${JSON.stringify(mine.id)}, binding: "ODD", actions: ["mail.delete_everything"] }),
            platformName: await tried({ connectionId: ${JSON.stringify(mine.id)}, binding: "CONNECT" }),
            waiting: [
              await tried({ connectionId: ${JSON.stringify(mine.id)}, binding: "ONE" }),
              await tried({ connectionId: ${JSON.stringify(mine.id)}, binding: "ONE" }),
              await tried({ connectionId: ${JSON.stringify(mine.id)}, binding: "TWO" }),
              await tried({ connectionId: ${JSON.stringify(mine.id)}, binding: "THREE" }),
              await tried({ connectionId: ${JSON.stringify(mine.id)}, binding: "FOUR" }),
              await tried({ connectionId: ${JSON.stringify(mine.id)}, binding: "FIVE" }),
              await tried({ connectionId: ${JSON.stringify(mine.id)}, binding: "SIX" }),
            ],
          };
        };`
      ),
      says("Done.")
    );
    const { chat, ask } = await chats.newChat();

    await ask("Find the invoice.");

    const invalid = permissionErrors.create("permission.invalid").message;
    await expect(results(chats.stub, chat.id)).resolves.toStrictEqual([
      returned({
        available: [
          {
            connectionId: mine.id,
            provider: "mail",
            account: null,
            scope: "personal",
            actions: ["mail.send", "mail.search"],
            decidedBy: "person",
          },
        ],
        theirs: invalid,
        gone: invalid,
        noSuchAction: invalid,
        platformName: invalid,
        waiting: [
          "ONE",
          permissionErrors.create("permission.conflict").message,
          "TWO",
          "THREE",
          "FOUR",
          "FIVE",
          permissionErrors.create("permission.too_many_requests").message,
        ],
      }),
    ]);
  });

  it("can't be asked for or granted once an admin hid its connector", async () => {
    const person = await signedInApi(idp, "user");
    const admin = await signedInApi(idp, "admin");
    const mine = await personalMail(person.userId);
    const chats = await personalChatsOf(
      person.userId,
      asks(mine.id, "EARLY"),
      says("It waits."),
      asks(mine.id, "LATE"),
      says("Hidden.")
    );
    const { chat, ask } = await chats.newChat();
    try {
      await ask("Find the invoice.");
      const [early] = await person.api.chats.connectionRequests(chat.id);
      await hideMail(admin.userId);
      await ask("Try again.");
      expect({
        grant: await outcome(
          person.api.chats.grantConnection(chat.id, early?.id ?? "")
        ),
        late: await resultAt(chats.stub, chat.id, 1),
      }).toStrictEqual({
        grant: "permission.invalid",
        late: refusedWith(
          permissionErrors.create("permission.invalid").message
        ),
      });
    } finally {
      await offerMail();
    }
  });

  it("is denied by its person: nothing granted, the agent told, audited", async () => {
    const person = await signedInApi(idp, "user");
    const mine = await personalMail(person.userId);
    const chats = await personalChatsOf(
      person.userId,
      asks(mine.id),
      says("It waits."),
      searches(),
      says("Denied.")
    );
    const { chat, ask } = await chats.newChat();
    await ask("Find the invoice.");
    const [request] = await person.api.chats.connectionRequests(chat.id);
    const id = request?.id ?? "";

    await person.api.chats.denyConnection(chat.id, id);
    await ask("Look anyway.");

    const told = await notes(chats.stub, chat.id);
    expect({
      search: await resultAt(chats.stub, chat.id, 1),
      grant: await outcome(person.api.chats.grantConnection(chat.id, id)),
      told: told.some((note) => note.includes('"MAIL" was denied')),
    }).toStrictEqual({
      search: refusedWith(
        connectErrors.create("connect.connection_not_found").message
      ),
      grant: "permission.not_requested",
      told: true,
    });
    const events = await permissionEvents(id, 2);
    expect(
      events.map(({ action, actor }) => ({ action, actor }))
    ).toStrictEqual([
      {
        action: "permission.requested",
        actor: {
          type: "agent",
          agentId: chats.agent.agentId,
          onBehalfOf: person.userId,
        },
      },
      {
        action: "permission.request_denied",
        actor: { type: "person", userId: person.userId },
      },
    ]);
  });

  it("goes with its chat: deleting the chat revokes what was granted in it, audited", async () => {
    const person = await signedInApi(idp, "user");
    const admin = await signedInApi(idp, "admin");
    const mine = await personalMail(person.userId);
    // The agent also holds a permission for everywhere, which stays.
    const everywhere = await mailConnection([], mailWithSearch);
    const chats = await personalChatsOf(
      person.userId,
      asks(mine.id),
      says("It waits.")
    );
    const { chat, ask } = await chats.newChat();
    const kept = await requestGranted(idp, admin, {
      subject: chats.agent,
      object: { type: "connection", connectionId: everywhere.id },
      actions: ["mail.search"],
      binding: "SHARED_MAIL",
    });
    await ask("Find the invoice.");
    const [request] = await person.api.chats.connectionRequests(chat.id);
    const id = request?.id ?? "";
    await person.api.chats.grantConnection(chat.id, id);

    await person.api.chats.remove(chat.id);

    expect({
      granted: await statusOf(id),
      kept: await statusOf(kept),
    }).toStrictEqual({ granted: "revoked", kept: "active" });
    const events = await permissionEvents(id, 3);
    expect(events.at(-1)).toMatchObject({
      action: "permission.revoked",
      actor: { type: "person", userId: person.userId },
      detail: { chat: chat.id, why: "chat_deleted" },
    });
  });

  it("waits in few cards, asked for all at once, and what was turned down isn't asked for again", async () => {
    const person = await signedInApi(idp, "user");
    const mine = await personalMail(person.userId);
    const ask = (binding: string, actions: string[]) =>
      `env.connections.request({ connectionId: ${JSON.stringify(mine.id)}, actions: ${JSON.stringify(actions)}, binding: "${binding}", reason: "To help." }).then(({ binding }) => binding, (error) => error.message)`;
    const chats = await personalChatsOf(
      person.userId,
      codeStep(
        `export default async (env) => await Promise.all([${["A", "B", "C", "D", "E", "F", "G"].map((binding) => ask(binding, ["mail.search"])).join(", ")}]);`
      ),
      says("Some wait."),
      codeStep(
        `export default async (env) => await Promise.all([${ask("AGAIN", ["mail.search"])}, ${ask("SEND", ["mail.send"])}]);`
      ),
      says("Asked.")
    );
    const { chat, ask: question } = await chats.newChat();

    await question("Find the invoice.");
    const waiting = await person.api.chats.connectionRequests(chat.id);
    const [first] = waiting;
    await person.api.chats.denyConnection(chat.id, first?.id ?? "");
    await question("Try again.");

    const [all, again] = await results(chats.stub, chat.id);
    const tooMany = permissionErrors.create(
      "permission.too_many_requests"
    ).message;
    expect({
      waiting: waiting.length,
      all: all?.split(tooMany).length,
      again,
    }).toStrictEqual({
      waiting: 5,
      // Two of the seven refused: the text splits in three.
      all: 3,
      again: returned([
        permissionErrors.create("permission.denied_before").message,
        "SEND",
      ]),
    });
  });

  it("never lets a later grant take over a name a chat's code calls, either way", async () => {
    const person = await signedInApi(idp, "user");
    const admin = await signedInApi(idp, "admin");
    const mine = await personalMail(person.userId);
    const chats = await personalChatsOf(
      person.userId,
      asks(mine.id, "OUTLOOK"),
      asks(mine.id, "MAIL"),
      asks(mine.id, "RACE", ["mail.send"]),
      says("They wait.")
    );
    const { chat, ask } = await chats.newChat();
    // A permission that holds everywhere, asked for first.
    await admin.api.permissions.request({
      subject: chats.agent,
      object: { type: "connection", connectionId: mine.id },
      actions: ["mail.search"],
      binding: "OUTLOOK",
    });

    await ask("Find the invoice.");
    const requests = await person.api.chats.connectionRequests(chat.id);
    const idOf = (binding: string) =>
      requests.find((request) => request.binding === binding)?.id ?? "";
    await person.api.chats.grantConnection(chat.id, idOf("MAIL"));
    // One that holds everywhere, landing while RACE waits.
    const everywhere = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO permissions (id, subject_type, subject_id, object_type, object_id, actions, binding, status, requested_by, requested_at) VALUES (?, 'agent', ?, 'connection', ?, '[\"mail.search\"]', 'RACE', 'requested', ?, ?)"
    )
      .bind(everywhere, chats.agent.agentId, mine.id, admin.userId, Date.now())
      .run();

    const conflict = permissionErrors.create("permission.conflict").message;
    expect({
      asked: await resultAt(chats.stub, chat.id, 0),
      everywhereAfter: await outcome(
        admin.api.permissions.request({
          subject: chats.agent,
          object: { type: "connection", connectionId: mine.id },
          actions: ["mail.search"],
          binding: "MAIL",
        })
      ),
      chatGrant: await outcome(
        person.api.chats.grantConnection(chat.id, idOf("RACE"))
      ),
      everywhereGrant: await outcome(grantReviewed(admin.api, everywhere)),
    }).toStrictEqual({
      asked: refusedWith(conflict),
      everywhereAfter: "permission.conflict",
      chatGrant: "permission.conflict",
      everywhereGrant: "permission.conflict",
    });
  });

  it("goes with its person: removing them revokes their chats' grants, audited", async () => {
    const person = await signedInApi(idp, "user");
    const admin = await signedInApi(idp, "admin");
    const mine = await personalMail(person.userId);
    const chats = await personalChatsOf(
      person.userId,
      asks(mine.id),
      says("It waits.")
    );
    const { chat, ask } = await chats.newChat();
    await ask("Find the invoice.");
    const [request] = await person.api.chats.connectionRequests(chat.id);
    const id = request?.id ?? "";
    await person.api.chats.grantConnection(chat.id, id);

    await admin.api.members.remove(person.userId);

    const events = await permissionEvents(id, 3);
    expect({ status: await statusOf(id), last: events.at(-1) }).toMatchObject({
      status: "revoked",
      last: {
        action: "permission.revoked",
        actor: { type: "person", userId: admin.userId },
        detail: { chat: chat.id, why: "person_removed" },
      },
    });
  });

  it("is decided when an admin revokes a shared one that waits: the agent told, the card gone", async () => {
    const person = await signedInApi(idp, "user");
    const admin = await signedInApi(idp, "admin");
    const shared = await mailConnection([], mailWithSearch);
    const chats = await personalChatsOf(
      person.userId,
      asks(shared.id, "SHARED"),
      says("An admin decides.")
    );
    const { chat, ask } = await chats.newChat();
    await ask("Find the invoice.");
    const [request] = await person.api.chats.connectionRequests(chat.id);
    const id = request?.id ?? "";

    await admin.api.permissions.revoke(id);

    const told = await notes(chats.stub, chat.id);
    expect({
      waiting: await person.api.chats.connectionRequests(chat.id),
      told: told.some((note) => note.includes('"SHARED" was denied')),
    }).toStrictEqual({ waiting: [], told: true });
  });

  it("goes with its person even when their removal's revoke didn't finish: the retry revokes it", async () => {
    const person = await signedInApi(idp, "user");
    const admin = await signedInApi(idp, "admin");
    const mine = await personalMail(person.userId);
    const chats = await personalChatsOf(
      person.userId,
      asks(mine.id),
      says("It waits.")
    );
    const { chat, ask } = await chats.newChat();
    await ask("Find the invoice.");
    const [request] = await person.api.chats.connectionRequests(chat.id);
    const id = request?.id ?? "";
    await person.api.chats.grantConnection(chat.id, id);
    // Removed, but as if the revoke hadn't gone through: still granted,
    // and the removal not finished.
    await admin.api.members.remove(person.userId);
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE permissions SET status = 'active', revoked_by = NULL, revoked_at = NULL WHERE id = ?"
      ).bind(id),
      env.DB.prepare(
        "UPDATE member_removals SET disconnected_at = NULL WHERE user_id = ?"
      ).bind(person.userId),
    ]);
    // Someone else removed then too, whose revoke fails every time: a
    // chat grant of theirs that can't be read.
    const broken = `removed-${crypto.randomUUID()}`;
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES (?, 'Removed', ?, 1, ?, ?)"
      ).bind(broken, `${broken}@acme.test`, now, now),
      env.DB.prepare(
        "INSERT INTO member_removals (organization_id, user_id, removed_at) VALUES ('organization', ?, ?)"
      ).bind(broken, now),
      env.DB.prepare(
        "INSERT INTO permissions (id, subject_type, subject_id, object_type, object_id, actions, binding, status, requested_by, requested_at, chat_id) VALUES (?, 'agent', ?, 'connection', ?, 'not json', 'BROKEN', 'active', ?, ?, ?)"
      ).bind(
        crypto.randomUUID(),
        chats.agent.agentId,
        mine.id,
        broken,
        now,
        crypto.randomUUID()
      ),
    ]);

    await retryDisconnects(env);

    const events = await permissionEvents(id, 4);
    const seen = {
      status: await statusOf(id),
      last: events.at(-1),
      // The failing one waits for the next run; the other one finished.
      brokenPending: await pending(broken),
      personPending: await pending(person.userId),
    };
    // No removal left failing for the other tests' retries.
    await env.DB.batch([
      env.DB.prepare("DELETE FROM permissions WHERE requested_by = ?").bind(
        broken
      ),
      env.DB.prepare("DELETE FROM member_removals WHERE user_id = ?").bind(
        broken
      ),
    ]);
    expect(seen).toMatchObject({
      status: "revoked",
      last: {
        action: "permission.revoked",
        actor: { type: "system" },
        detail: { chat: chat.id, why: "person_removed" },
      },
      brokenPending: true,
      personPending: false,
    });
  });
});
