import { applyPartial } from "@grasp-os/shared/chat";
import type {
  ChatPartial,
  ChatProvenance,
  ChatUpdate,
} from "@grasp-os/shared/chat";
import { chatIdSchema } from "@grasp-os/shared/ids";
import { authoritySchema } from "@grasp-os/shared/permissions";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { bindingsFor } from "../src/bindings.ts";
import { chatAgentId, personalWorkspaceId } from "../src/chats-rpc.ts";
import { personOf } from "../src/connections.ts";
import { workspace } from "../src/durable-objects.ts";
import { maxChatsPerPerson } from "../src/workspace.ts";
import {
  codeStep,
  model,
  pausedReply,
  pointAtGateway,
  says,
} from "./agent-chat.ts";
import { fakeGateway } from "./ai-gateway.ts";
import type { GatewayReply } from "./ai-gateway.ts";
import { requestGranted } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { connectionIn } from "./contexts.ts";
import { mockIdp } from "./idp.ts";
import { mailConnection } from "./mail-connection.ts";
import { fullScan } from "./query-plans.ts";
import { callAuth, openRpc, outcome, signedInApi } from "./sign-in.ts";
import { connectDb } from "./test-env.ts";

// People's chats, through `/rpc` as the frontend reaches them: each is its
// person's alone, is kept in the workspace's object over a restart, and
// streams to whoever follows it, who picks the stream up again after a
// lost connection or a reload. The ways it can fail come first: someone
// else reads, renames, deletes, asks in, stops or follows a chat; a
// follower misses or repeats a message on reconnecting; a reply is lost
// when nobody watches or the object restarts; a turn that stopped short
// looks like one still running; a deleted chat leaves writes nobody can
// decide, or goes unrecorded.

const idp = mockIdp();

/** A member signed in on a connection of their own, and their chats. */
const person = async () => {
  const signedIn = await signedInApi(idp, "user");
  return { ...signedIn, chats: signedIn.api.chats };
};
type Person = Awaited<ReturnType<typeof person>>;

/** The object that holds `someone`'s chats. */
const objectOf = ({ userId }: { userId: string }) =>
  workspace(env, personalWorkspaceId(userId));

/** Points `someone`'s chats at a fake gateway that answers `replies`. */
const answering = async (
  someone: { userId: string },
  ...replies: GatewayReply[]
) => {
  const gateway = fakeGateway(...replies);
  await pointAtGateway(objectOf(someone), gateway);
  return gateway;
};

/** A Workspace object's env, to point it elsewhere. */
const envOf = (instance: object): object => {
  const objectEnv: unknown = Reflect.get(instance, "env");
  if (typeof objectEnv !== "object" || objectEnv === null) {
    throw new TypeError("The Workspace object has no env");
  }
  return objectEnv;
};

/** Follows a chat, keeping every update. */
const follow = async (
  chats: Person["chats"],
  chatId: string,
  after: number | null = null
) => {
  const updates: ChatUpdate[] = [];
  // Put together as the page does.
  let partial: ChatPartial | null = null;
  let provenance: ChatProvenance | undefined;
  const subscription = await chats.watch(chatId, after, (update) => {
    updates.push(update);
    partial = applyPartial(partial, update.partial);
    provenance = update.provenance ?? provenance;
  });
  return {
    updates,
    subscription,
    /** Every message it was sent, in the order they came. */
    messages: () => updates.flatMap(({ messages }) => messages),
    /** The chat as the updates so far show it. */
    now: () => {
      const last = updates.at(-1);
      return last === undefined
        ? undefined
        : {
            running: last.running,
            stopped: last.stopped,
            held: last.held,
            partial,
            provenance,
          };
    },
  };
};
type Follower = Awaited<ReturnType<typeof follow>>;

/** Waits until the follower's chat has ended its turn. */
const settled = async (follower: Follower) => {
  await vi.waitFor(
    () => {
      expect(follower.now()?.running).toBeFalsy();
      expect(follower.messages().at(-1)?.role).toBe("assistant");
    },
    { timeout: 10_000 }
  );
};

/** What the person reads of the messages: their role and text. */
const shown = (follower: Follower) =>
  follower.messages().map((message) => ({
    role: message.role,
    text: message.text,
  }));

describe("chats", () => {
  it("are kept per person: made, listed newest first, renamed and deleted", async () => {
    const ann = await person();
    const first = await ann.chats.create("Invoices");
    const second = await ann.chats.create("  Travel  ");
    await ann.chats.rename(first.id, "Invoices of May");

    await expect(ann.chats.list()).resolves.toMatchObject([
      { id: second.id, title: "Travel", running: false },
      { id: first.id, title: "Invoices of May", running: false },
    ]);
    await expect(
      Promise.all([
        outcome(ann.chats.create(" ")),
        outcome(ann.chats.rename(first.id, "x".repeat(201))),
      ])
    ).resolves.toStrictEqual(["agent.invalid_title", "agent.invalid_title"]);

    await ann.chats.remove(first.id);
    await expect(ann.chats.list()).resolves.toMatchObject([{ id: second.id }]);
    await expect(outcome(follow(ann.chats, first.id))).resolves.toBe(
      "agent.chat_not_found"
    );
  });

  it("are recorded as their person makes, renames and deletes them, and a deleted one's held writes are rejected", async () => {
    const ann = await person();
    const ben = await person();
    const admin = await signedInApi(idp, "admin");
    const mail = await mailConnection();
    // The workspace's agent may send mail, held for its person each time:
    // one grant, for everyone's chats, each in its person's own object.
    const agent = { type: "agent" as const, agentId: chatAgentId };
    await requestGranted(idp, admin, {
      subject: agent,
      object: { type: "connection", connectionId: mail.id },
      actions: ["mail.send"],
      binding: "MAIL",
    });
    /** The chat's agent asks to send a mail: connect holds it for its person. */
    const holdMail = async (
      { userId }: Person,
      chatId: string
    ): Promise<string> => {
      const bindings = await bindingsFor(
        env,
        authoritySchema.parse({
          subject: agent,
          onBehalfOf: userId,
          mode: "interactive",
        }),
        {
          type: "chat",
          workspaceId: personalWorkspaceId(userId),
          chatId: chatIdSchema.parse(chatId),
        }
      );
      const result = await connectionIn(bindings, "MAIL")?.call(
        "mail.send",
        { to: "ben@acme.test", subject: `Invoice ${chatId}` },
        { idempotencyKey: `chat:${crypto.randomUUID()}` }
      );
      return result?.pending?.id ?? "not held";
    };

    let chat = "";
    let other = "";
    let held: string[] = [];
    const { id: benChat } = await ben.chats.create("Ben's");
    const bens = await holdMail(ben, benChat);
    ({ id: chat } = await ann.chats.create("Invoices for Ben"));
    ({ id: other } = await ann.chats.create("Other"));
    await ann.chats.rename(chat, "Invoices of May");
    held = [
      await holdMail(ann, chat),
      await holdMail(ann, chat),
      await holdMail(ann, other),
    ];
    await ann.chats.remove(chat);
    // Each object delivers its chats' events to the log a moment after.
    const recorded = await vi.waitFor(
      async () => {
        const all = await allEvents();
        const events = all.filter(
          ({ action, target }) =>
            action.startsWith("chat.") &&
            (target?.id === chat || target?.id === other)
        );
        expect(events).toHaveLength(4);
        return events;
      },
      { timeout: 10_000 }
    );

    // The chat's two writes were rejected; Ann's other chat's and Ben's
    // still wait, and nothing was sent.
    const waiting = await ann.api.pendingActions.list();
    const bensWaiting = await ben.api.pendingActions.list();
    expect({
      waiting: waiting.map(({ id }) => id),
      bensWaiting: bensWaiting.map(({ id }) => id),
      sent: await mail.did(),
    }).toStrictEqual({
      waiting: [held[2]],
      bensWaiting: [bens],
      sent: { calls: 0, sent: [] },
    });
    // Each recorded as the person's own, on the chat, never with its title.
    expect(
      recorded
        .filter(({ action }) => action.startsWith("chat."))
        .map(({ actor, action, target, detail }) => ({
          actor,
          action,
          target,
          detail,
        }))
    ).toStrictEqual([
      {
        actor: { type: "person", userId: ann.userId },
        action: "chat.created",
        target: { type: "chat", id: chat },
        detail: { workspace: personalWorkspaceId(ann.userId) },
      },
      {
        actor: { type: "person", userId: ann.userId },
        action: "chat.created",
        target: { type: "chat", id: other },
        detail: { workspace: personalWorkspaceId(ann.userId) },
      },
      {
        actor: { type: "person", userId: ann.userId },
        action: "chat.renamed",
        target: { type: "chat", id: chat },
        detail: { workspace: personalWorkspaceId(ann.userId) },
      },
      {
        actor: { type: "person", userId: ann.userId },
        action: "chat.deleted",
        target: { type: "chat", id: chat },
        detail: { workspace: personalWorkspaceId(ann.userId), declined: 2 },
      },
    ]);
    // Connect recorded each rejection, as the person's.
    await vi.waitFor(
      async () => {
        const events = await allEvents();
        const declined = events.filter(
          ({ action, detail }) =>
            action === "connection.action.declined" &&
            held.includes(String(detail.pendingActionId))
        );
        expect(
          new Set(declined.map(({ detail }) => detail.pendingActionId))
        ).toStrictEqual(new Set([held[0], held[1]]));
        expect(declined).toHaveLength(2);
      },
      { timeout: 10_000 }
    );
  });

  it("reject every write a deleted chat's agent holds, however many newer ones wait elsewhere", async () => {
    const ann = await person();
    const workspaceId = personalWorkspaceId(ann.userId);
    const chat = await ann.chats.create("Old writes");
    const elsewhere = crypto.randomUUID();
    /** A held write of Ann's from chat `chatId`, held `at`, as connect keeps one. */
    const held = (chatId: string, at: number) => {
      const id = crypto.randomUUID();
      return {
        id,
        insert: connectDb()
          .prepare(
            "INSERT INTO pending_actions (id, subject_type, subject_id, on_behalf_of, mode, connection_id, action, idempotency_key, input, input_hash, permission_id, context, restricted, created_at) VALUES (?, 'agent', ?, ?, 'interactive', ?, 'mail.send', ?, '{}', ?, ?, ?, 0, ?)"
          )
          .bind(
            id,
            chatAgentId,
            ann.userId,
            `connection-${crypto.randomUUID()}`,
            `chat:${id}`,
            "0".repeat(64),
            crypto.randomUUID(),
            JSON.stringify({ type: "chat", workspaceId, chatId }),
            at
          ),
      };
    };
    // More from the chat than connect declines in one round, then more
    // than a list of held writes holds, all newer, from another chat.
    const now = Date.now();
    const old = Array.from({ length: 150 }, (_, index) =>
      held(chat.id, now + index)
    );
    const newer = Array.from({ length: 205 }, (_, index) =>
      held(elsewhere, now + 1000 + index)
    );
    await connectDb().batch([...old, ...newer].map(({ insert }) => insert));

    await ann.chats.remove(chat.id);

    const left = await connectDb()
      .prepare("SELECT id FROM pending_actions WHERE on_behalf_of = ?")
      .bind(ann.userId)
      .all<{ id: string }>();
    const ids = new Set(left.results.map(({ id }) => id));
    expect({
      oldLeft: old.filter(({ id }) => ids.has(id)).length,
      newerLeft: newer.filter(({ id }) => ids.has(id)).length,
    }).toStrictEqual({ oldLeft: 0, newerLeft: newer.length });
  });

  it("tell a follower the moment its agent has a write held, mid-turn", async () => {
    const ann = await person();
    const admin = await signedInApi(idp, "admin");
    const mail = await mailConnection();
    await requestGranted(idp, admin, {
      subject: { type: "agent", agentId: chatAgentId },
      object: { type: "connection", connectionId: mail.id },
      actions: ["mail.send"],
      binding: "HELD_MAIL",
    });
    const { reply, release } = pausedReply(says("It waits for you."), 2);
    await answering(
      ann,
      codeStep(
        'export default async (env) => await env.connections.call("HELD_MAIL", "mail.send", { to: "ben@acme.test", subject: "Invoice" }, { idempotencyKey: "invoice" });'
      ),
      reply
    );
    const chat = await ann.chats.create("Held");
    const follower = await follow(ann.chats, chat.id);
    await ann.chats.send(chat.id, { text: "Send Ben the invoice.", model });

    // Still answering: the follower already knows a write waits.
    await vi.waitFor(
      () => {
        expect(follower.now()).toMatchObject({ running: true, held: 1 });
      },
      { timeout: 10_000 }
    );
    await expect(ann.api.pendingActions.list()).resolves.toHaveLength(1);
    release();
    await settled(follower);
  });

  it("are refused to anyone but their person, as if there were none", async () => {
    const ann = await person();
    const ben = await person();
    const gateway = await answering(ann, says("Hi, Ann."));
    const chat = await ann.chats.create("Mine");

    await expect(ben.chats.list()).resolves.toStrictEqual([]);
    await expect(
      Promise.all([
        outcome(ben.chats.rename(chat.id, "Ben's now")),
        outcome(ben.chats.remove(chat.id)),
        outcome(ben.chats.send(chat.id, { text: "Hi.", model })),
        outcome(ben.chats.cancel(chat.id)),
        outcome(follow(ben.chats, chat.id)),
      ])
    ).resolves.toStrictEqual(
      Array.from({ length: 5 }, () => "agent.chat_not_found")
    );
    // Nothing reached the model, and the chat is as Ann left it.
    expect(gateway.requests).toHaveLength(0);
    await expect(ann.chats.list()).resolves.toMatchObject([
      { id: chat.id, title: "Mine" },
    ]);

    // Ann's own question is answered.
    const annSees = await follow(ann.chats, chat.id);
    await ann.chats.send(chat.id, { text: "Hi.", model });
    await settled(annSees);
    expect(shown(annSees)).toStrictEqual([
      { role: "user", text: "Hi." },
      { role: "assistant", text: "Hi, Ann." },
    ]);
  });

  it("stream a reply as it is written: its code steps, their results, and the answer", async () => {
    const ann = await person();
    const { reply, release } = pausedReply(says("Two plus two is four."), 9);
    await answering(ann, codeStep("export default async () => 2 + 2;"), reply);
    const chat = await ann.chats.create("Sums");
    const follower = await follow(ann.chats, chat.id);

    await ann.chats.send(chat.id, { text: "What is 2 + 2?", model });
    // Caught mid-answer: the code step and its result are stored, and the
    // answer so far shows as it is written.
    await vi.waitFor(
      () => {
        expect(follower.now()).toMatchObject({
          running: true,
          partial: { text: "Two plus ", code: [] },
        });
      },
      { timeout: 10_000 }
    );
    await expect(ann.chats.list()).resolves.toMatchObject([
      { id: chat.id, running: true },
    ]);
    release();
    await settled(follower);

    const messages = follower.messages();
    const [, step] = messages;
    const callId = step?.role === "assistant" ? step.code[0]?.callId : "none";
    expect({ messages, now: follower.now() }).toMatchObject({
      messages: [
        { role: "user", text: "What is 2 + 2?" },
        {
          role: "assistant",
          code: [{ code: "export default async () => 2 + 2;" }],
          end: "done",
        },
        // The step's result, paired with its code.
        { role: "result", callId, text: "Returned:\n4", failed: false },
        { role: "assistant", text: "Two plus two is four.", end: "done" },
      ],
      // Once stored, the answer is no longer shown as being written.
      now: { partial: null, running: false },
    });
    // Each message came once, in order; the answer came as what it gained
    // each time, never all of it again; and the provenance only in the
    // first update, as nothing was read since.
    const ids = messages.map(({ id }) => id);
    const answerText = follower.updates.flatMap(({ partial }) =>
      partial === null || partial.text === ""
        ? []
        : [[partial.from, partial.text]]
    );
    expect({
      ids,
      first: answerText[0],
      resent: answerText.slice(1).filter(([from]) => from !== 9),
      provenance: follower.updates.map(
        ({ provenance }) => provenance !== undefined
      ),
    }).toStrictEqual({
      ids: [...new Set(ids)].toSorted((a, b) => a - b),
      first: [0, "Two plus "],
      resent: [],
      provenance: follower.updates.map((_, index) => index === 0),
    });
  });

  it("resume a reply mid-stream after a lost connection or a reload, and it goes on with nobody watching", async () => {
    const ann = await person();
    const { reply, release } = pausedReply(
      says("Half an answer, then the rest."),
      14
    );
    await answering(ann, reply);
    const chat = await ann.chats.create("Resume");
    const before = await follow(ann.chats, chat.id);
    await ann.chats.send(chat.id, { text: "Tell me.", model });
    await vi.waitFor(
      () => {
        expect(before.now()?.partial?.text).toBe("Half an answer");
      },
      { timeout: 10_000 }
    );
    // The connection goes, mid-reply.
    const [seen] = before.messages();
    ann.core[Symbol.dispose]();

    // A new connection picks up after the last message it saw; a reloaded
    // page, which saw none, from the start. Both see the answer so far.
    const { core } = await openRpc(ann.session);
    const { chats } = core.authenticate();
    const reconnected = await follow(chats, chat.id, seen?.id ?? null);
    const reloaded = await follow(chats, chat.id);
    await vi.waitFor(
      () => {
        for (const follower of [reconnected, reloaded]) {
          expect(follower.now()).toMatchObject({
            running: true,
            partial: { text: "Half an answer" },
          });
        }
      },
      { timeout: 10_000 }
    );
    expect(reconnected.messages()).toStrictEqual([]);
    expect(shown(reloaded)).toStrictEqual([{ role: "user", text: "Tell me." }]);

    release();
    await settled(reconnected);
    await settled(reloaded);
    expect(shown(reconnected)).toStrictEqual([
      { role: "assistant", text: "Half an answer, then the rest." },
    ]);
    expect(shown(reloaded)).toStrictEqual([
      { role: "user", text: "Tell me." },
      { role: "assistant", text: "Half an answer, then the rest." },
    ]);
    core[Symbol.dispose]();
  });

  it("survive the object restarting, and a turn cut short by it ends, which the chat says once", async () => {
    const ann = await person();
    await answering(ann, says("Kept."), { hang: true });
    const chat = await ann.chats.create("Durable");
    const first = await follow(ann.chats, chat.id);
    await ann.chats.send(chat.id, { text: "Keep this.", model });
    await settled(first);
    // The next question is under way when the object restarts.
    await ann.chats.send(chat.id, { text: "And this?", model });
    await vi.waitFor(
      () => {
        expect(first.now()?.running).toBeTruthy();
      },
      { timeout: 10_000 }
    );

    // Restarted, as a deploy restarts it: its alarm and its watchers keep
    // it up, so the runtime won't just evict it.
    const restart = async () => {
      await runInDurableObject(objectOf(ann), (_instance, state) => {
        state.abort("Restarted by the test");
      }).catch(() => {
        // Aborting fails the call that aborted: that is the restart.
      });
    };
    await restart();
    // Restarted again with no turn under way: nothing more to say.
    await restart();
    const gateway = await answering(ann, says("Still here."));
    const after = await follow(ann.chats, chat.id);
    await vi.waitFor(
      () => {
        expect(after.updates).not.toHaveLength(0);
      },
      { timeout: 10_000 }
    );
    // What was stored is there, and the chat says, once, that the turn was
    // cut short; it isn't running any more.
    const interrupted =
      "I was interrupted before I finished, so what I was doing may be incomplete. Ask again and I'll go on from here.";
    expect(shown(after)).toStrictEqual([
      { role: "user", text: "Keep this." },
      { role: "assistant", text: "Kept." },
      { role: "user", text: "And this?" },
      { role: "assistant", text: interrupted },
    ]);
    expect(after.now()).toMatchObject({ running: false, partial: null });
    await expect(ann.chats.list()).resolves.toMatchObject([
      { id: chat.id, title: "Durable", running: false },
    ]);

    // The chat goes on from there, its agent knowing what was cut short.
    await ann.chats.send(chat.id, { text: "Hello again.", model });
    await vi.waitFor(
      () => {
        expect(after.messages().at(-1)).toMatchObject({ text: "Still here." });
      },
      { timeout: 10_000 }
    );
    const sent = JSON.stringify(gateway.requests[0]?.body);
    expect(
      ["And this?", interrupted, "Hello again."].map((text) =>
        sent.includes(text)
      )
    ).toStrictEqual([true, true, true]);
  });

  it("take one question at a time, and aren't deleted under their agent", async () => {
    const ann = await person();
    await answering(ann, { hang: true });
    const chat = await ann.chats.create("Busy");
    const follower = await follow(ann.chats, chat.id);
    await ann.chats.send(chat.id, { text: "First.", model });

    await expect(
      Promise.all([
        outcome(ann.chats.send(chat.id, { text: "Second.", model })),
        outcome(ann.chats.remove(chat.id)),
      ])
    ).resolves.toStrictEqual(["agent.busy", "agent.busy"]);

    await expect(ann.chats.cancel(chat.id)).resolves.toBeTruthy();
    await settled(follower);
    expect(follower.messages().at(-1)).toMatchObject({ end: "cancelled" });
    await ann.chats.remove(chat.id);
    await expect(ann.chats.list()).resolves.toStrictEqual([]);
  });

  it("refuse a question that can't start before taking it", async () => {
    const ann = await person();
    const gateway = await answering(ann, says("Never."));
    const chat = await ann.chats.create("Refused");

    await expect(
      Promise.all([
        outcome(
          ann.chats.send(chat.id, { text: "Hi.", model: "openai/gpt-5.4" })
        ),
        outcome(ann.chats.send(chat.id, { text: " ", model })),
      ])
    ).resolves.toStrictEqual(["model.not_allowed", "agent.invalid_question"]);
    expect(gateway.requests).toHaveLength(0);
    const follower = await follow(ann.chats, chat.id);
    await vi.waitFor(
      () => {
        expect(follower.now()).toMatchObject({ running: false });
      },
      { timeout: 10_000 }
    );
    expect(follower.messages()).toStrictEqual([]);
  });

  it("show why a turn stopped short, and a failed answer with the gateway's reason", async () => {
    const ann = await person();
    const { reply, release } = pausedReply(says("Looking it up."), 7);
    await answering(
      ann,
      {
        ...reply,
        toolCalls: [
          {
            id: "call_look",
            name: "executeCode",
            arguments: { code: "export default async () => 1;" },
          },
        ],
      },
      { status: 500 }
    );
    const chat = await ann.chats.create("Stopped");
    const follower = await follow(ann.chats, chat.id);
    await ann.chats.send(chat.id, { text: "Look it up.", model });
    await vi.waitFor(
      () => {
        expect(follower.now()?.partial?.text).toBe("Looking");
      },
      { timeout: 10_000 }
    );
    // The agent is switched off mid-turn: the next request doesn't go.
    await pointAtGateway(objectOf(ann), fakeGateway(), { agentOn: false });
    release();
    await vi.waitFor(
      () => {
        expect(follower.now()).toMatchObject({
          running: false,
          stopped: "This isn't switched on for this deployment.",
        });
      },
      { timeout: 10_000 }
    );

    // Back on, the model fails: the answer says so, and nothing is stopped.
    await answering(ann, { status: 500 });
    await ann.chats.send(chat.id, { text: "Again.", model });
    await settled(follower);
    const last = follower.messages().at(-1);
    expect(
      last?.role === "assistant" ? [last.end, typeof last.error] : last
    ).toStrictEqual(["failed", "string"]);
    expect(follower.now()?.stopped).toBeNull();
  });

  it("keep their object up while a turn nobody waits on runs", async () => {
    const ann = await person();
    const { reply, release } = pausedReply(says("Done in a while."), 4);
    await answering(ann, reply);
    const chat = await ann.chats.create("Kept up");
    const follower = await follow(ann.chats, chat.id);
    await ann.chats.send(chat.id, { text: "Take your time.", model });
    await vi.waitFor(
      () => {
        expect(follower.now()?.running).toBeTruthy();
      },
      { timeout: 10_000 }
    );

    // The alarm runs until the turn has ended, however long that takes:
    // started while it runs, it ends only once the chat is done.
    let alarmEnded: Promise<unknown> = Promise.resolve();
    await runInDurableObject(objectOf(ann), (instance) => {
      alarmEnded = (async () => {
        await instance.alarm();
        return instance.chats(ann.userId);
      })();
    });
    release();
    await expect(alarmEnded).resolves.toMatchObject([
      { id: chat.id, running: false },
    ]);
  });

  it("are listed, and followed, by index: never a whole table or a sort", async () => {
    const ann = await person();
    const plans = await runInDurableObject(objectOf(ann), (_instance, state) =>
      [
        "SELECT id, title, created_at FROM chats WHERE person_id = 'p' ORDER BY created_at DESC LIMIT 200",
        "SELECT * FROM chat_messages WHERE chat_id = 'c' AND id > 7 ORDER BY id",
      ].map((query) =>
        state.storage.sql
          .exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`)
          .toArray()
          .map(({ detail }) => detail)
      )
    );
    for (const plan of plans) {
      expect(plan.some((step) => fullScan.test(step))).toBeFalsy();
      expect(plan.some((step) => step.includes("TEMP B-TREE"))).toBeFalsy();
    }
  });

  it("are each person's own object's: one person's watches and restarts leave another's chats be", async () => {
    const ann = await person();
    const ben = await person();
    const annChat = await ann.chats.create("Ann's");
    const { reply, release } = pausedReply(says("Still answering Ben."), 5);
    await answering(ben, reply);
    const benChat = await ben.chats.create("Ben's");
    const benSees = await follow(ben.chats, benChat.id);
    await ben.chats.send(benChat.id, { text: "Go on.", model });
    await vi.waitFor(
      () => {
        expect(benSees.now()?.partial?.text).toBe("Still");
      },
      { timeout: 10_000 }
    );

    // Ann fills her object with watches, 10 a connection, then restarts it.
    const connections = await Promise.all(
      Array.from({ length: 6 }, async () => {
        const { core } = await openRpc(ann.session);
        const { chats } = core.authenticate();
        return { core, chats };
      })
    );
    await Promise.all(
      connections
        .slice(0, 5)
        .flatMap(({ chats }) =>
          Array.from(
            { length: 10 },
            async () => await follow(chats, annChat.id)
          )
        )
    );
    await expect(
      outcome(follow(connections[5]?.chats ?? ann.chats, annChat.id))
    ).resolves.toBe("agent.too_many_watches");
    await runInDurableObject(objectOf(ann), (_instance, state) => {
      state.abort("Restarted by the test");
    }).catch(() => {
      // Aborting fails the call that aborted: that is the restart.
    });

    // Ben's chat is in an object of his own: he follows it, and his answer
    // goes on to its end.
    await expect(outcome(follow(ben.chats, benChat.id))).resolves.toBe("ok");
    release();
    await settled(benSees);
    expect(benSees.messages().at(-1)).toMatchObject({
      text: "Still answering Ben.",
    });
    for (const { core } of connections) {
      core[Symbol.dispose]();
    }
  });

  it("are kept to 500 a person", async () => {
    const ann = await person();
    const kept = objectOf(ann);
    for (let batch = 0; batch < maxChatsPerPerson / 50; batch += 1) {
      // oxlint-disable-next-line no-await-in-loop -- a batch at a time
      await Promise.all(
        Array.from(
          { length: 50 },
          async () => await kept.createChat("Old", ann.userId, chatAgentId)
        )
      );
    }
    await expect(outcome(ann.chats.create("One more"))).resolves.toBe(
      "agent.too_many_chats"
    );
    // Another person makes theirs as ever.
    const ben = await person();
    await expect(outcome(ben.chats.create("Mine"))).resolves.toBe("ok");
  });

  it("aren't deleted while a question is being taken, and take none while being deleted", async () => {
    const ann = await person();
    await answering(ann, says("Hi."));
    const chat = await ann.chats.create("Racing");
    const by = { type: "person" as const, userId: ann.userId };
    const annAsConnect = await personOf(env, await ann.api.whoami());
    // Deleted the moment a question is taken, before it awaits anything.
    const taken = await runInDurableObject(objectOf(ann), async (instance) => {
      const asked = instance.ask(chat.id, { text: "Hi.", model });
      const deleting = outcome(
        instance.deleteChat(chat.id, ann.userId, annAsConnect, by)
      );
      const answered = await asked;
      return { deleting: await deleting, answer: answered.answer };
    });
    expect(taken).toStrictEqual({ deleting: "agent.busy", answer: "Hi." });

    // A question racing a delete, asked while its writes are being
    // rejected, is refused: nothing is left held once it is gone.
    const heldId = crypto.randomUUID();
    await connectDb()
      .prepare(
        "INSERT INTO pending_actions (id, subject_type, subject_id, on_behalf_of, mode, connection_id, action, idempotency_key, input, input_hash, permission_id, context, restricted, created_at) VALUES (?, 'agent', ?, ?, 'interactive', ?, 'mail.send', ?, '{}', ?, ?, ?, 0, ?)"
      )
      .bind(
        heldId,
        chatAgentId,
        ann.userId,
        `connection-${crypto.randomUUID()}`,
        `chat:${heldId}`,
        "0".repeat(64),
        crypto.randomUUID(),
        JSON.stringify({
          type: "chat",
          workspaceId: personalWorkspaceId(ann.userId),
          chatId: chat.id,
        }),
        Date.now()
      )
      .run();
    const racing = await runInDurableObject(objectOf(ann), async (instance) => {
      const deleting = instance.deleteChat(
        chat.id,
        ann.userId,
        annAsConnect,
        by
      );
      const asking = outcome(
        instance.send(chat.id, ann.userId, { text: "Quick!", model })
      );
      return { asked: await asking, declined: await deleting };
    });
    expect(racing).toStrictEqual({
      asked: "agent.chat_not_found",
      declined: 1,
    });
    await expect(ann.api.pendingActions.list()).resolves.toStrictEqual([]);
    await expect(ann.chats.list()).resolves.toStrictEqual([]);
  });

  it("record chats made, renamed and deleted while the audit log is out, once it's back, exactly once", async () => {
    const ann = await person();
    const kept = objectOf(ann);
    // Objects may share the tests' env: this is the log to put back.
    const realLog = env.AUDIT_LOG;
    // The log refuses everything the object delivers, for now.
    const failing = {
      getByName: () => ({
        append: async () => {
          await Promise.resolve();
          throw new Error("The audit log is out");
        },
      }),
      jurisdiction: () => failing,
    };
    await runInDurableObject(kept, (instance) => {
      Object.assign(envOf(instance), { AUDIT_LOG: failing });
    });
    const waiting = async () =>
      await runInDurableObject(kept, (_instance, state) =>
        state.storage.sql
          .exec<{ count: number }>("SELECT count(*) AS count FROM audit_outbox")
          .one()
      );
    let chat = { id: "" };
    try {
      chat = await ann.chats.create("While it's out");
      await ann.chats.rename(chat.id, "Still out");
      await ann.chats.remove(chat.id);
      // The changes are made; their events wait in the object.
      await expect(ann.chats.list()).resolves.toStrictEqual([]);
      await vi.waitFor(
        async () => {
          await expect(waiting()).resolves.toStrictEqual({ count: 3 });
        },
        { timeout: 10_000 }
      );
    } finally {
      await runInDurableObject(kept, (instance) => {
        Object.assign(envOf(instance), { AUDIT_LOG: realLog });
      });
    }

    // The log is back: the alarm delivers them, and again finds none left.
    await runInDurableObject(kept, async (instance) => {
      await instance.alarm();
      await instance.alarm();
    });
    await expect(waiting()).resolves.toStrictEqual({ count: 0 });
    const events = await allEvents();
    expect(
      events
        .filter(({ target }) => target?.id === chat.id)
        .map(({ action }) => action)
    ).toStrictEqual(["chat.created", "chat.renamed", "chat.deleted"]);
  });

  it("free a watch's slot when the page's callback fails", async () => {
    const ann = await person();
    const chat = await ann.chats.create("Failing page");
    let failed = 0;
    /** Ten watches whose page fails every push, then a watch that works. */
    const failingRound = async (): Promise<void> => {
      const before = failed;
      await Promise.all(
        Array.from({ length: 10 }, async () => {
          await ann.chats.watch(chat.id, null, () => {
            failed += 1;
            throw new Error("The page failed");
          });
        })
      );
      await vi.waitFor(
        () => {
          expect(failed).toBe(before + 10);
        },
        { timeout: 10_000 }
      );
      // Their slots are free: another watch is taken.
      await vi.waitFor(
        async () => {
          const watch = await follow(ann.chats, chat.id);
          await watch.subscription.release();
        },
        { timeout: 10_000 }
      );
    };
    // More failing watches than a connection may keep at once.
    await failingRound();
    await failingRound();
    await failingRound();
  });

  it("stop streaming to a page whose session has ended", async () => {
    const ann = await person();
    const { reply, release } = pausedReply(says("Too late for you."), 3);
    await answering(ann, reply);
    const chat = await ann.chats.create("Signed out");
    const follower = await follow(ann.chats, chat.id);
    await ann.chats.send(chat.id, { text: "Tell me.", model });
    await vi.waitFor(
      () => {
        expect(follower.now()?.partial?.text).toBe("Too");
      },
      { timeout: 10_000 }
    );

    await callAuth("/sign-out", ann.session, {});
    // Past the few seconds one check of the session holds.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 10_000);
      release();
      await vi.waitFor(
        async () => {
          await expect(
            runInDurableObject(objectOf(ann), (instance) =>
              instance.chats(ann.userId)
            )
          ).resolves.toMatchObject([{ id: chat.id, running: false }]);
        },
        { timeout: 10_000 }
      );
    } finally {
      vi.useRealTimers();
    }
    // The answer was kept, and never pushed to the signed-out page.
    expect(follower.now()).toMatchObject({
      running: true,
      partial: { text: "Too" },
    });
    expect(follower.messages().at(-1)).toMatchObject({ role: "user" });
  });

  it("are followed by at most 10 watches per connection", async () => {
    const ann = await person();
    const chat = await ann.chats.create("Watched");
    const watches = await Promise.all(
      Array.from({ length: 10 }, async () => await follow(ann.chats, chat.id))
    );
    await expect(outcome(follow(ann.chats, chat.id))).resolves.toBe(
      "agent.too_many_watches"
    );
    // Releasing one frees its slot.
    await watches[0]?.subscription.release();
    await expect(outcome(follow(ann.chats, chat.id))).resolves.toBe("ok");
  });
});
