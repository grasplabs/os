import type { AiBinding } from "@earendil-works/pi-ai/api/cloudflare-ai-binding";
import { guestTurnsMax } from "@grasp-os/shared/guests";
import type { GuestView } from "@grasp-os/shared/guests";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { callApp } from "../src/app.ts";
import type { AppCallerInput } from "../src/app.ts";
import { sweepGuestChats } from "../src/guests.ts";
import { fakeGateway } from "./ai-gateway.ts";
import type { GatewayReply } from "./ai-gateway.ts";
import { release, requestGranted, serverBuilt } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { fullScan, planOf, recordedQueries } from "./query-plans.ts";
import { leave } from "./runs.ts";
import { outcome, routed, signedInApi, unique } from "./sign-in.ts";

// Guest chats (src/guests.ts): an App invites someone who isn't a member
// to a chat with a model through a link. The ways it can fail, each tried
// below before anything else:
//
// - A link that opens more than its one chat: a made-up or malformed
//   secret, another App reading the chat, a request in any other shape.
// - A link that outlives its purpose: past its expiry, revoked, finished,
//   its App's permission revoked, the member it was made for gone, or the
//   feature switched off.
// - A guest reaching anything but the model: the model is called with no
//   tools, only the chat's guide and the chat, and as the guest, for the
//   member, through the gateway.
// - A guest spending without bound: two messages at once, more than 20
//   turns, messages over 1,000 characters, a failed call taking a turn.
// - An App inviting without bound or for someone else: from a workflow
//   run, with a skill the release doesn't have, more than 50 open.
// - Nothing on record: every step audited, as whom.
// - Kept forever: chats deleted 30 days after they end.

const idp = mockIdp();

/** An App's server code that hands the guest chats stub's answers back. */
const server = `import { DurableObject } from "cloudflare:workers";

const codeOf = (error) => (error && typeof error.code === "string" ? error.code : "app.failed");

export class App extends DurableObject {
  async #run(call) {
    if (!this.env.GUESTS) {
      return { error: "permission.denied" };
    }
    try {
      return { ok: await call() };
    } catch (error) {
      return { error: codeOf(error) };
    }
  }
  invite(caller, input) { return this.#run(() => this.env.GUESTS.invite(caller, input)); }
  list(caller) { return this.#run(() => this.env.GUESTS.list(caller)); }
  read(caller, id) { return this.#run(() => this.env.GUESTS.read(caller, id)); }
  revoke(caller, id) { return this.#run(() => this.env.GUESTS.revoke(caller, id)); }
}
`;

type Person = Awaited<ReturnType<typeof signedInApi>>;

/** An App that may invite guests, its permission granted by an admin. */
const guestApp = async (
  builder: Person
): Promise<{ app: AppId; permission: string }> => {
  const { id } = await builder.api.apps.create({ name: `Guests ${unique()}` });
  const version = await release(builder, id, { "app/server.ts": server });
  await serverBuilt(id, version);
  const permission = await requestGranted(idp, builder, {
    subject: { type: "app", appId: id },
    object: { type: "platform" },
    actions: ["guests"],
    binding: "GUESTS",
  });
  return { app: appIdSchema.parse(id), permission };
};

const as = (
  userId: string,
  mode: "interactive" | "workflow" = "interactive"
): AppCallerInput => ({
  userId,
  mode,
});

const call = async (
  app: AppId,
  caller: AppCallerInput,
  method: string,
  ...args: unknown[]
): Promise<unknown> => await callApp(env, app, caller, method, args);

const invitedSchema = z.object({
  ok: z.object({ id: z.string(), link: z.string(), status: z.string() }),
});

/** Invites a guest in `app` for `userId`: the chat's ID and link secret. */
const invite = async (
  app: AppId,
  userId: string,
  input: Record<string, unknown> = {}
): Promise<{ id: string; token: string; link: string }> => {
  const { ok } = invitedSchema.parse(
    await call(app, as(userId), "invite", {
      name: "Anna",
      skill: "interview-a-stakeholder",
      ...input,
    })
  );
  return { id: ok.id, token: new URL(ok.link).hash.slice(1), link: ok.link };
};

/** What the guest's page sends, and what core answers. */
const guest = async (
  body: unknown,
  init: RequestInit = {},
  coreEnv: Env = env
): Promise<{ status: number; body: unknown }> => {
  const response = await routed(
    "/api/guest",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
      ...init,
    },
    coreEnv
  );
  return { status: response.status, body: await response.json() };
};

const viewSchema = z.object({
  name: z.string(),
  status: z.string(),
  turnsLeft: z.number(),
  messages: z.array(z.object({ role: z.string(), text: z.string() })),
});

const viewOf = (answer: { body: unknown }): GuestView =>
  // SAFETY: checked by the schema; the rest is as core answers it.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  viewSchema.parse(answer.body) as GuestView;

const codeOf = ({ status, body }: { status: number; body: unknown }) => ({
  status,
  code: z.object({ code: z.string() }).parse(body).code,
});

/** A plan's step over rows the query itself gives: no table's. */
const literalRows = /^SCAN (?:\d+-ROW VALUES CLAUSE|CONSTANT ROW)$/u;

/** Core's read of a chat's messages. */
const readsMessages = /^select .* from "guest_messages"/iu;

/** A guest's message, "Hello", with the secret `token`. */
const send = (token: string) => ({ action: "send", token, text: "Hello" });

/** Core's env with guest chats switched off, and what they need on. */
const guestsOff = {
  ...env,
  FEATURES: { knowledge: true, apps: true, permissions: true },
};

/** The model answers with `replies`, in order, while `run` runs. */
const answering = async <T>(
  replies: GatewayReply[],
  run: (gateway: ReturnType<typeof fakeGateway>) => Promise<T>
): Promise<T> => {
  const gateway = fakeGateway(...replies);
  const ai: AiBinding = env.AI;
  const spy = vi.spyOn(ai, "fetch").mockImplementation(gateway.binding.fetch);
  try {
    return await run(gateway);
  } finally {
    spy.mockRestore();
  }
};

const reply = (text: string): GatewayReply => ({
  text,
  inputTokens: 50,
  outputTokens: 10,
});

describe("guest chats", { timeout: 60_000 }, () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("let a guest chat through the link with a model that has only the guide and the chat, all of it on record", async () => {
    const builder = await signedInApi(idp, "builder");
    const { app } = await guestApp(builder);
    const { id, token, link } = await invite(app, builder.userId);

    const [opened, again] = [
      await guest({ action: "open", token }),
      await guest({ action: "open", token }),
    ];
    const { first, second, requests } = await answering(
      [reply("What do you do most weeks?"), reply("How long does that take?")],
      async (gateway) => ({
        first: await guest({
          action: "send",
          token,
          text: "I close the month.",
        }),
        second: await guest({ action: "send", token, text: "  Three days.  " }),
        requests: gateway.requests,
      })
    );
    const read = z
      .object({
        ok: z.object({
          messages: z.array(z.object({ role: z.string(), text: z.string() })),
        }),
      })
      .parse(await call(app, as(builder.userId), "read", id));
    const bodies = requests.map(({ body }) => JSON.stringify(body));
    const logged = await allEvents();
    const events = logged.filter(
      ({ target, provenance }) => target?.id === id || provenance.includes(id)
    );

    expect({
      link: new URL(link).pathname,
      secret: token.length,
      opened: viewOf(opened),
      again: again.status,
      first: viewOf(first).turnsLeft,
      second: viewOf(second).messages,
      read: read.ok.messages,
      // Only the guide, the bounds and the chat; no tools, nothing else.
      guide: bodies.every((body) => body.includes("Interview a stakeholder")),
      bounds: bodies.every((body) => body.includes("You have no tools")),
      tools: bodies.some((body) => body.includes('"tools"')),
      history: [
        bodies[0]?.includes("I close the month.") === true,
        bodies[1]?.includes("What do you do most weeks?") === true,
      ],
      audited: events.map(({ action, actor }) => [action, actor.type]),
    }).toStrictEqual({
      link: "/guest",
      secret: 43,
      opened: {
        name: "Anna",
        status: "open",
        turnsLeft: guestTurnsMax,
        messages: [],
      },
      again: 200,
      first: guestTurnsMax - 1,
      second: [
        expect.objectContaining({ role: "guest", text: "I close the month." }),
        expect.objectContaining({
          role: "agent",
          text: "What do you do most weeks?",
        }),
        expect.objectContaining({ role: "guest", text: "Three days." }),
        expect.objectContaining({
          role: "agent",
          text: "How long does that take?",
        }),
      ],
      read: [
        expect.objectContaining({ role: "guest", text: "I close the month." }),
        expect.objectContaining({ role: "agent" }),
        expect.objectContaining({ role: "guest", text: "Three days." }),
        expect.objectContaining({ role: "agent" }),
      ],
      guide: true,
      bounds: true,
      tools: false,
      history: [true, true],
      // Opened once however often it opens; each turn by the guest, each
      // model call as the guest, reading back by the App.
      audited: [
        ["guest.invited", "app"],
        ["guest.opened", "guest"],
        ["model.call", "guest"],
        ["guest.message", "guest"],
        ["model.call", "guest"],
        ["guest.message", "guest"],
        ["guest.read", "app"],
      ],
    });
  });

  it("open nothing with a made-up, malformed or unshaped secret, and never another App's chat", async () => {
    const builder = await signedInApi(idp, "builder");
    const { app } = await guestApp(builder);
    const { app: other } = await guestApp(builder);
    const { id } = await invite(app, builder.userId);
    const madeUp = "A".repeat(43);
    const got = await routed("/api/guest");
    // A body streamed without a length: read no further than the bound.
    const streamed = await routed("/api/guest", {
      method: "POST",
      body: new Blob(["x".repeat(20_000)]).stream(),
    });
    const streamedBody: unknown = await streamed.json();
    expect({
      madeUp: codeOf(await guest({ action: "open", token: madeUp })),
      short: codeOf(await guest({ action: "open", token: "abc" })),
      unknownAction: codeOf(await guest({ action: "read", token: madeUp })),
      notJson: codeOf(await guest("{")),
      tooLarge: codeOf(
        await guest({ action: "send", token: madeUp, text: "x".repeat(20_000) })
      ),
      get: got.status,
      streamed: codeOf({ status: streamed.status, body: streamedBody }),
      otherApp: await call(other, as(builder.userId), "read", id),
      otherRevoke: await call(other, as(builder.userId), "revoke", id),
    }).toStrictEqual({
      madeUp: { status: 404, code: "guest.link_invalid" },
      short: { status: 400, code: "guest.invalid" },
      unknownAction: { status: 400, code: "guest.invalid" },
      notJson: { status: 400, code: "guest.invalid" },
      tooLarge: { status: 400, code: "guest.invalid" },
      streamed: { status: 400, code: "guest.invalid" },
      get: 405,
      otherApp: { error: "guest.not_found" },
      otherRevoke: { error: "guest.not_found" },
    });
  });

  it("stop a link once it expires, is revoked or finished, or its App's permission, its member, their use of the App or the feature is gone", async () => {
    const builder = await signedInApi(idp, "builder");
    const admin = await signedInApi(idp, "admin");
    const user = await signedInApi(idp, "user");
    const { app, permission } = await guestApp(builder);
    const revoked = await invite(app, builder.userId);
    const revokedChat = await call(
      app,
      as(builder.userId),
      "revoke",
      revoked.id
    );
    const afterRevoke = {
      chat: z
        .object({ ok: z.object({ status: z.string() }) })
        .parse(revokedChat).ok.status,
      // Nothing opens, what was written neither.
      open: codeOf(await guest({ action: "open", token: revoked.token })),
      send: codeOf(await guest(send(revoked.token))),
      finish: codeOf(await guest({ action: "finish", token: revoked.token })),
    };
    const finished = await invite(app, builder.userId);
    const finishing = await guest({ action: "finish", token: finished.token });
    const afterFinish = {
      answer: viewOf(finishing).status,
      send: codeOf(await guest(send(finished.token))),
      again: codeOf(await guest({ action: "finish", token: finished.token })),
      // Finished, it still shows what was written, until it is revoked.
      open: viewOf(await guest({ action: "open", token: finished.token }))
        .status,
      revoked: z
        .object({ ok: z.object({ status: z.string() }) })
        .parse(await call(app, as(builder.userId), "revoke", finished.id)).ok
        .status,
      afterRevoke: codeOf(
        await guest({ action: "open", token: finished.token })
      ),
    };

    const expiring = await invite(app, builder.userId, { days: 1 });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 24 * 60 * 60 * 1000 + 1000);
    const expired = {
      open: viewOf(await guest({ action: "open", token: expiring.token }))
        .status,
      send: codeOf(await guest(send(expiring.token))),
    };
    vi.useRealTimers();

    const switchedOff = await invite(app, builder.userId);
    const off = codeOf(
      await guest({ action: "open", token: switchedOff.token }, {}, guestsOff)
    );

    const memberGone = await invite(app, builder.userId);
    const rejoin = await leave(builder.userId);
    const whileGone = codeOf(
      await guest({ action: "open", token: memberGone.token })
    );
    await rejoin();
    const reopened = await guest({ action: "open", token: memberGone.token });
    const back = reopened.status;

    // Someone the App is shared with invites; unshared, their link is gone.
    const member = { type: "person", id: user.userId } as const;
    await builder.api.apps.members.add(app, { ...member, role: "user" });
    const unshared = await invite(app, user.userId);
    const sharedOpen = await guest({ action: "open", token: unshared.token });
    const whileShared = sharedOpen.status;
    await builder.api.apps.members.remove(app, member);
    const afterUnshared = codeOf(
      await guest({ action: "open", token: unshared.token })
    );

    const permissionGone = await invite(app, builder.userId);
    await admin.api.permissions.revoke(permission);

    expect({
      revoked: afterRevoke,
      finished: afterFinish,
      expired,
      off,
      whileGone,
      back,
      whileShared,
      afterUnshared,
      permissionGone: codeOf(
        await guest({ action: "open", token: permissionGone.token })
      ),
      // And the App no longer invites or reads.
      appAfter: await call(app, as(builder.userId), "list"),
    }).toStrictEqual({
      revoked: {
        chat: "revoked",
        open: { status: 404, code: "guest.link_invalid" },
        send: { status: 404, code: "guest.link_invalid" },
        finish: { status: 404, code: "guest.link_invalid" },
      },
      finished: {
        answer: "finished",
        send: { status: 410, code: "guest.ended" },
        again: { status: 410, code: "guest.ended" },
        open: "finished",
        revoked: "revoked",
        afterRevoke: { status: 404, code: "guest.link_invalid" },
      },
      expired: { open: "expired", send: { status: 410, code: "guest.ended" } },
      off: { status: 404, code: "guest.link_invalid" },
      whileGone: { status: 404, code: "guest.link_invalid" },
      back: 200,
      whileShared: 200,
      afterUnshared: { status: 404, code: "guest.link_invalid" },
      permissionGone: { status: 404, code: "guest.link_invalid" },
      appAfter: { error: "permission.denied" },
    });
  });

  it("take one message at a time, and none once the chat ended under it", async () => {
    const builder = await signedInApi(idp, "builder");
    const { app } = await guestApp(builder);
    const { id, token } = await invite(app, builder.userId);

    // The first message's model call waits until the second has been
    // refused, and the guest has finished the chat.
    const gate = Promise.withResolvers<null>();
    const gateway = fakeGateway(reply("Question 1"));
    const ai: AiBinding = env.AI;
    const spy = vi.spyOn(ai, "fetch").mockImplementation(async (...args) => {
      await gate.promise;
      return await gateway.binding.fetch(...args);
    });
    let busy: { status: number; code: string };
    let finished: GuestView;
    let first: { status: number; body: unknown };
    try {
      const sending = guest({ action: "send", token, text: "First" });
      await vi.waitFor(
        () => {
          expect(spy.mock.calls.length).toBeGreaterThan(0);
        },
        { timeout: 10_000, interval: 20 }
      );
      busy = codeOf(await guest({ action: "send", token, text: "Second" }));
      finished = viewOf(await guest({ action: "finish", token }));
      gate.resolve(null);
      first = await sending;
    } finally {
      spy.mockRestore();
    }
    const after = viewOf(await guest({ action: "open", token }));
    const logged = await allEvents();
    expect({
      busy,
      finished: finished.status,
      // The turn ran, and landed nothing: the chat had ended.
      first: viewOf(first).messages,
      after: after.messages,
      audited: logged
        .filter(({ target }) => target?.id === id)
        .map(({ action }) => action),
    }).toStrictEqual({
      busy: { status: 429, code: "guest.busy" },
      finished: "finished",
      first: [],
      after: [],
      audited: ["guest.invited", "guest.finished", "guest.opened"],
    });
  });

  it("make at most 20 model calls a chat, failed ones too, of at most 1,000 characters", async () => {
    const builder = await signedInApi(idp, "builder");
    const { app } = await guestApp(builder);
    const { token } = await invite(app, builder.userId);
    // Refused by the provider, as the gateway may bill: never asked again.
    const refusals = Array.from({ length: guestTurnsMax + 1 }, () => ({
      status: 400,
      errorType: "invalid_request_error",
    }));
    const { sent, calls } = await answering(refusals, async (gateway) => {
      const answers: { status: number; code: string }[] = [];
      for (let turn = 0; turn <= guestTurnsMax; turn += 1) {
        // oxlint-disable-next-line no-await-in-loop -- one turn at a time
        answers.push(codeOf(await guest(send(token))));
      }
      return { sent: answers, calls: gateway.requests.length };
    });
    const after = viewOf(await guest({ action: "open", token }));
    expect({
      failed: sent
        .slice(0, guestTurnsMax)
        .every(({ code }) => code === "guest.unavailable"),
      last: sent.at(-1),
      calls,
      after: { turnsLeft: after.turnsLeft, messages: after.messages.length },
      tooLong: codeOf(
        await guest({ action: "send", token, text: "x".repeat(1001) })
      ),
    }).toStrictEqual({
      failed: true,
      last: { status: 409, code: "guest.no_turns_left" },
      calls: guestTurnsMax,
      after: { turnsLeft: 0, messages: 0 },
      tooLong: { status: 400, code: "guest.invalid" },
    });
  });

  it("show nothing of a chat revoked after its link was checked, before what was written is read", async () => {
    const builder = await signedInApi(idp, "builder");
    const { app } = await guestApp(builder);
    const { id, token } = await invite(app, builder.userId);
    await answering([reply("What do you do?")], async () => {
      await guest({ action: "open", token });
      await guest({ action: "send", token, text: "I close the month." });
    });
    // The open's read of the messages waits until the chat is revoked.
    const real = env.DB;
    const held = Promise.withResolvers<null>();
    const resume = Promise.withResolvers<null>();
    let reads = false;
    let holding = true;
    env.DB = new Proxy(real, {
      get: (target, key) => {
        if (key === "prepare") {
          return (query: string) => {
            reads ||= readsMessages.test(query);
            return target.prepare(query);
          };
        }
        if (key === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            if (reads && holding) {
              holding = false;
              held.resolve(null);
              await resume.promise;
            }
            return await target.batch(statements);
          };
        }
        const value: unknown = Reflect.get(target, key);
        if (typeof value !== "function") {
          return value;
        }
        const bound: unknown = value.bind(target);
        return bound;
      },
    });
    let opened: { status: number; body: unknown };
    let revoked: unknown;
    try {
      const opening = guest({ action: "open", token });
      await held.promise;
      revoked = await call(app, as(builder.userId), "revoke", id);
      resume.resolve(null);
      opened = await opening;
    } finally {
      resume.resolve(null);
      env.DB = real;
    }
    expect({
      revoked: z.object({ ok: z.object({ status: z.string() }) }).parse(revoked)
        .ok.status,
      opened: codeOf(opened),
      // Nothing of what was written is in the answer.
      leaked: JSON.stringify(opened.body).includes("I close the month."),
    }).toStrictEqual({
      revoked: "revoked",
      opened: { status: 404, code: "guest.link_invalid" },
      leaked: false,
    });
  });

  it("list an App's open chats first, however many ended since, so each can be revoked", async () => {
    const builder = await signedInApi(idp, "builder");
    const { app } = await guestApp(builder);
    const oldest = await invite(app, builder.userId, { name: "Still open" });
    for (let chat = 0; chat < 101; chat += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one chat at a time
      const made = await invite(app, builder.userId);
      // oxlint-disable-next-line no-await-in-loop -- finished before the next
      await guest({ action: "finish", token: made.token });
    }
    const newest = await invite(app, builder.userId, { name: "Newest open" });
    const { ok: listed } = z
      .object({
        ok: z.array(z.object({ id: z.string(), status: z.string() })),
      })
      .parse(await call(app, as(builder.userId), "list"));
    expect({
      listed: listed.length,
      first: listed.slice(0, 2),
      rest: [...new Set(listed.slice(2).map(({ status }) => status))],
    }).toStrictEqual({
      listed: 100,
      first: [
        { id: newest.id, status: "open" },
        { id: oldest.id, status: "open" },
      ],
      rest: ["finished"],
    });
  });

  it("are invited only by a person using the App, with a Grasp skill, at most 50 open at once", async () => {
    const builder = await signedInApi(idp, "builder");
    const { app } = await guestApp(builder);
    const ask = async (
      caller: AppCallerInput,
      input: Record<string, unknown>
    ) =>
      await call(app, caller, "invite", {
        name: "Anna",
        skill: "interview-a-stakeholder",
        ...input,
      });
    const refusals = {
      fromRun: await ask(as(builder.userId, "workflow"), {}),
      unknownSkill: await ask(as(builder.userId), { skill: "run-anything" }),
      tooLong: await ask(as(builder.userId), { days: 15 }),
      noName: await ask(as(builder.userId), { name: " " }),
    };
    const open: string[] = [];
    for (let chat = 0; chat < 50; chat += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one invitation at a time
      const made = await invite(app, builder.userId);
      open.push(made.id);
    }
    const fiftyFirst = await ask(as(builder.userId), {});
    await call(app, as(builder.userId), "revoke", open[0]);
    const afterRevoke = invitedSchema.safeParse(
      await ask(as(builder.userId), {})
    ).success;
    expect({ ...refusals, fiftyFirst, afterRevoke }).toStrictEqual({
      fromRun: { error: "guest.invalid" },
      unknownSkill: { error: "guest.invalid" },
      tooLong: { error: "guest.invalid" },
      noName: { error: "guest.invalid" },
      fiftyFirst: { error: "guest.too_many_open" },
      afterRevoke: true,
    });
  });

  it("need a permission of their own: a platform permission does one thing, and only an App asks for it", async () => {
    const builder = await signedInApi(idp, "builder");
    const { id: app } = await builder.api.apps.create({
      name: `Asks ${unique()}`,
    });
    const ask = async (
      request: Parameters<typeof builder.api.permissions.request>[0]
    ) => await outcome(builder.api.permissions.request(request));
    expect({
      both: await ask({
        subject: { type: "app", appId: app },
        object: { type: "platform" },
        actions: ["statistics", "guests"],
        binding: "PLATFORM",
      }),
      agent: await ask({
        subject: { type: "agent", agentId: "organization" },
        object: { type: "platform" },
        actions: ["guests"],
        binding: "GUESTS",
      }),
      app: await ask({
        subject: { type: "app", appId: app },
        object: { type: "platform" },
        actions: ["guests"],
        binding: "GUESTS",
      }),
    }).toStrictEqual({
      both: "permission.invalid",
      agent: "permission.invalid",
      app: "ok",
    });
  });

  it("find chats and their messages by index, reading no table whole", async () => {
    const builder = await signedInApi(idp, "builder");
    const { app } = await guestApp(builder);
    const { id, token } = await invite(app, builder.userId);
    const recorded = await recordedQueries(async () => {
      await answering([reply("What do you do?")], async () => {
        await guest({ action: "open", token });
        await guest({ action: "send", token, text: "I close the month." });
      });
      await call(app, as(builder.userId), "list");
      await call(app, as(builder.userId), "read", id);
      await invite(app, builder.userId);
      await guest({ action: "finish", token });
      await sweepGuestChats(env, new Date());
    });
    const ofGuests = recorded.filter(({ query }) => query.includes("guest_"));
    const plans = await Promise.all(
      ofGuests.map(async (query) => await planOf(query))
    );
    const steps = plans.flat();
    expect({
      open: steps.some((step) => step.includes("guest_chats_open_idx")),
      read: ofGuests.length > 0,
      scans: steps.filter(
        (step) => fullScan.test(step) && !literalRows.test(step)
      ),
      sorts: steps.filter((step) => step.includes("TEMP B-TREE")),
    }).toStrictEqual({ open: true, read: true, scans: [], sorts: [] });
  });

  it("are deleted with what was written 30 days after they end, and not before", async () => {
    const builder = await signedInApi(idp, "builder");
    const { app } = await guestApp(builder);
    const ended = await invite(app, builder.userId);
    await guest({ action: "finish", token: ended.token });
    const open = await invite(app, builder.userId, { days: 14 });
    const day = 24 * 60 * 60 * 1000;
    const readable = async (id: string): Promise<boolean> =>
      "ok" in
      z
        .record(z.string(), z.unknown())
        .parse(await call(app, as(builder.userId), "read", id));
    await sweepGuestChats(env, new Date(Date.now() + 29 * day));
    const before = [await readable(ended.id), await readable(open.id)];
    // A sweep deletes 100 at most, the oldest first, and the file's other
    // tests left more than that: the cron's next runs take the rest.
    const later = new Date(Date.now() + 31 * day);
    for (let run = 0; run < 4; run += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one run after another
      await sweepGuestChats(env, later);
    }
    expect({
      before,
      ended: await call(app, as(builder.userId), "read", ended.id),
      open: await readable(open.id),
    }).toStrictEqual({
      before: [true, true],
      ended: { error: "guest.not_found" },
      open: true,
    });
  });
});
