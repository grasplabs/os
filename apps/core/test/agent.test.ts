import type { Message } from "@earendil-works/pi-ai";
import { agentErrors } from "@grasp-os/shared/agent";
import type { AuditEvent } from "@grasp-os/shared/audit";
import { featureErrors } from "@grasp-os/shared/errors";
import { workspaceIdSchema } from "@grasp-os/shared/ids";
import { modelErrors } from "@grasp-os/shared/models";
import { permissionErrors } from "@grasp-os/shared/permissions";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { maxSteps } from "../src/agent.ts";
import { workspace } from "../src/workspace.ts";
import { fakeGateway } from "./ai-gateway.ts";
import type { GatewayReply } from "./ai-gateway.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { signedInWithRole } from "./sign-in.ts";

// A chat's agent, through the Workspace object: the loop, the code it runs
// in isolates of their own, and the model gateway, all real. The outside
// system is the model provider behind AI Gateway: a fake behind the
// object's AI binding answers with scripted replies, in the provider's own
// wire format.

const model = "anthropic/claude-sonnet-4-5";

/** The model calls `executeCode` with `code`. */
const codeStep = (code: string): GatewayReply => ({
  text: "",
  toolCalls: [
    {
      id: `call_${crypto.randomUUID()}`,
      name: "executeCode",
      arguments: { code },
    },
  ],
  inputTokens: 200,
  outputTokens: 40,
});

/** The model answers. */
const says = (text: string): GatewayReply => ({
  text,
  inputTokens: 200,
  outputTokens: 20,
});

type WorkspaceStub = ReturnType<typeof workspace>;

/**
 * Points the object's model gateway at a fake AI Gateway, and sets the
 * feature flags. Objects may share their env, so every test sets both; a
 * restarted object may get a new one, so it is pointed again.
 */
const pointAtGateway = async (
  stub: WorkspaceStub,
  gateway: ReturnType<typeof fakeGateway>,
  agentOn = true
) => {
  await runInDurableObject(stub, (instance) => {
    const objectEnv: unknown = Reflect.get(instance, "env");
    if (typeof objectEnv !== "object" || objectEnv === null) {
      throw new TypeError("The Workspace object has no env");
    }
    Object.assign(objectEnv, {
      AI: gateway.binding,
      MODEL_GATEWAY: { gateway: "grasp-os-test", models: [model] },
      FEATURES: { agent: agentOn },
    });
  });
};

const idp = mockIdp();

/** A new chat for a person no other test uses, answered by `replies`. */
const newChat = async (...replies: GatewayReply[]) => {
  const id = workspaceIdSchema.parse(crypto.randomUUID());
  const stub = workspace(env, id);
  // A member of the organization, whom no other test uses.
  const { userId: personId } = await signedInWithRole(idp, "user");
  const chat = await stub.createChat("Questions", personId);
  const gateway = fakeGateway(...replies);
  await pointAtGateway(stub, gateway);
  const ask = async (text: string) => await stub.ask(chat.id, { text, model });
  return { id, stub, chat, personId, gateway, ask };
};

/** The chat's transcript, as the object keeps it. */
const transcript = async (
  stub: WorkspaceStub,
  chatId: string
): Promise<Message[]> =>
  await runInDurableObject(stub, (instance) => instance.messages(chatId));

/** What the code steps of the chat returned, or threw, as the model read it. */
const codeResults = async (stub: WorkspaceStub, chatId: string) => {
  const messages = await transcript(stub, chatId);
  return messages.flatMap((message) =>
    message.role === "toolResult"
      ? [
          {
            isError: message.isError,
            text: message.content
              .flatMap((part) => (part.type === "text" ? [part.text] : []))
              .join(""),
          },
        ]
      : []
  );
};

/** Runs `code` as the chat's only code step, and returns what it gave. */
const runStep = async (code: string) => {
  const { stub, chat, ask } = await newChat(codeStep(code), says("Done."));
  await ask("Run it.");
  const [result] = await codeResults(stub, chat.id);
  return result;
};

/** The model.call events triggered by `userId`, once `count` have arrived. */
const modelCallsBy = async (
  userId: string,
  count: number
): Promise<AuditEvent[]> => {
  const mine = async () => {
    const events = await allEvents();
    return events.filter(
      ({ action, actor }) =>
        action === "model.call" &&
        actor.type === "person" &&
        actor.userId === userId
    );
  };
  await vi.waitFor(
    async () => {
      await expect(mine()).resolves.toHaveLength(count);
    },
    { timeout: 10_000, interval: 50 }
  );
  return await mine();
};

const codeOf = async (call: Promise<unknown>) => {
  try {
    await call;
  } catch (error) {
    return (
      agentErrors.codeOf(error) ??
      modelErrors.codeOf(error) ??
      featureErrors.codeOf(error) ??
      permissionErrors.codeOf(error) ??
      "failed"
    );
  }
  return "answered";
};

describe("chat agent", () => {
  it("answers a question with a code step against the chat's API", async () => {
    const { stub, chat, personId, gateway, ask } = await newChat(
      codeStep(
        "export default async (env) => (await env.chat.info()).personId;"
      ),
      says("You are the person this chat belongs to.")
    );

    const reply = await ask("Who am I?");

    expect(reply).toStrictEqual({
      outcome: "answered",
      answer: "You are the person this chat belongs to.",
    });
    // The code ran with the API core gave it, which knows whom it acts for.
    await expect(codeResults(stub, chat.id)).resolves.toStrictEqual([
      { isError: false, text: `Returned:\n${personId}` },
    ]);
    // The model saw the API declared, then the step's result.
    const [first, second] = gateway.requests.map(({ body }) =>
      JSON.stringify(body)
    );
    expect(first).toContain(
      "info(): Promise<{ chatId: string; personId: string; now: string }>"
    );
    expect(second).toContain(personId);
    const messages = await transcript(stub, chat.id);
    expect(messages.map(({ role }) => role)).toStrictEqual([
      "system",
      "user",
      "assistant",
      "toolResult",
      "assistant",
    ]);
  });

  it("audits every model request, with the chat's person as who asked", async () => {
    const { personId, ask } = await newChat(
      codeStep("export default async () => 1 + 1;"),
      says("Two.")
    );

    await ask("What is 1 + 1?");

    const events = await modelCallsBy(personId, 2);
    expect(events.map(({ detail }) => detail)).toStrictEqual([
      expect.objectContaining({ purpose: "chat.turn", outcome: "answered" }),
      expect.objectContaining({ purpose: "chat.turn", outcome: "answered" }),
    ]);
    // Metadata only: never the question or the code.
    expect(JSON.stringify(events)).not.toContain("1 + 1");
  });

  it("hands what the code throws back to the model, which goes on", async () => {
    const { stub, chat, ask } = await newChat(
      codeStep(
        'export default async () => { console.log("Looking."); throw new Error("No such invoice"); };'
      ),
      says("I couldn't find that invoice.")
    );

    const reply = await ask("Find invoice 42.");

    expect(reply.answer).toBe("I couldn't find that invoice.");
    const [result] = await codeResults(stub, chat.id);
    expect(result).toMatchObject({ isError: true });
    expect(result?.text).toMatch(/Looking\.[\s\S]*Error: No such invoice/u);
  });

  it("stops at the most steps a turn may take", async () => {
    const { gateway, ask } = await newChat(
      ...Array.from({ length: maxSteps }, () =>
        codeStep("export default async () => 'again';")
      )
    );

    const reply = await ask("Keep going.");

    expect(reply.outcome).toBe("max_steps");
    expect(gateway.requests).toHaveLength(maxSteps);
  });
});

describe("chat agent sandbox", () => {
  it.each([
    [
      "fetch",
      "export default async () => (await fetch('https://example.com')).status;",
    ],
    [
      "a raw socket",
      "import { connect } from 'cloudflare:sockets'; export default async () => { const socket = connect('example.com:443'); await socket.opened; return 'open'; };",
    ],
  ])("can't reach the network through %s", async (_, code) => {
    const result = await runStep(code);

    expect(result?.isError).toBeTruthy();
    expect(result?.text).toContain(
      "This worker is not permitted to access the internet"
    );
  });

  it("gets only its APIs in env, and can't import core's env or entrypoints", async () => {
    const result = await runStep(
      "import { env as imported, exports } from 'cloudflare:workers'; export default async (env) => ({ given: Object.keys(env), imported: Object.keys(imported ?? {}), exports: Object.keys(exports ?? {}) });"
    );

    expect(result).toStrictEqual({
      isError: false,
      text: `Returned:\n${JSON.stringify({ given: ["chat"], imported: [], exports: [] })}`,
    });
  });

  it("names the API it doesn't have, and the ones it does", async () => {
    const result = await runStep(
      "export default async (env) => await env.knowledge.search('policy');"
    );

    expect(result?.isError).toBeTruthy();
    expect(result?.text).toContain(
      "This chat has no API named env.knowledge. It has: env.chat."
    );
  });

  it("stops code that waits for something that never comes", async () => {
    const result = await runStep(
      "export default async () => { await new Promise(() => {}); return 'never'; };"
    );

    expect(result?.isError).toBeTruthy();
  });

  it("keeps what the code logs and returns to what the model can read", async () => {
    const result = await runStep(
      "export default async () => { for (let i = 0; i < 100_000; i++) console.log('x'.repeat(100)); return 'y'.repeat(1_000_000); };"
    );

    expect(result?.isError).toBeFalsy();
    expect(result?.text.length).toBeLessThan(33 * 1024);
    expect(result?.text).toMatch(/cut: longer than 32768 characters\)$/u);
  });

  it("shows a value too large to read as such, without building it all", async () => {
    const result = await runStep(
      "export default async () => Array.from({ length: 1_000_000 }, (_, i) => ({ i }));"
    );

    expect(result).toStrictEqual({
      isError: false,
      text: "Returned:\n(a value too large to show, over 65536 characters)",
    });
  });

  it("gets APIs that stop answering once its run has ended", async () => {
    const { id, chat, personId, ask } = await newChat(
      codeStep("export default async (env) => (await env.chat.info()).chatId;"),
      says("Done.")
    );
    await ask("Which chat?");

    // A stub for a run that is no longer open, as code still running after
    // its run was cancelled or timed out would hold it.
    const ended = exports.ChatApi({
      props: { workspaceId: id, chatId: chat.id, personId, runId: "ended" },
    });

    await expect(codeOf(ended.info())).resolves.toBe("agent.run_ended");
  });

  it("reports code that doesn't load", async () => {
    const result = await runStep("export default async () => {");

    expect(result?.isError).toBeTruthy();
    expect(result?.text).toMatch(/Syntax/iu);
  });
});

describe("chat agent turns", () => {
  it("can be cancelled while its code runs", async () => {
    const { stub, chat, gateway, ask } = await newChat(
      codeStep(
        "export default async () => { await scheduler.wait(10_000); return 'late'; };"
      )
    );

    const reply = ask("Wait a minute.");
    await vi.waitFor(async () => {
      expect(gateway.requests).toHaveLength(1);
      // The step has started once its call is kept.
      await expect(transcript(stub, chat.id)).resolves.toHaveLength(3);
    });
    await stub.cancel(chat.id);

    await expect(reply).resolves.toMatchObject({ outcome: "cancelled" });
    await expect(codeResults(stub, chat.id)).resolves.toStrictEqual([
      { isError: true, text: "Error:\nThe run was cancelled." },
    ]);
    // No request after the cancelled step.
    expect(gateway.requests).toHaveLength(1);
  });

  it("can be cancelled while the model answers", async () => {
    const { stub, chat, personId, gateway, ask } = await newChat({
      hang: true,
    });

    const reply = ask("Take your time.");
    await vi.waitFor(() => {
      expect(gateway.requests).toHaveLength(1);
    });
    await expect(stub.cancel(chat.id)).resolves.toBeTruthy();

    await expect(reply).resolves.toMatchObject({ outcome: "cancelled" });
    const [event] = await modelCallsBy(personId, 1);
    expect(event?.detail).toMatchObject({ outcome: "cancelled" });
  });

  it("takes one question at a time per chat", async () => {
    const { stub, chat, gateway, ask } = await newChat({ hang: true });

    const first = ask("First.");
    await vi.waitFor(() => {
      expect(gateway.requests).toHaveLength(1);
    });

    await expect(codeOf(ask("Second."))).resolves.toBe("agent.busy");
    await stub.cancel(chat.id);
    await expect(first).resolves.toMatchObject({ outcome: "cancelled" });
  });

  it("refuses a model the deployment doesn't allow, before anything is kept", async () => {
    const { stub, chat } = await newChat();

    await expect(
      codeOf(stub.ask(chat.id, { text: "Hi.", model: "openai/gpt-5.4" }))
    ).resolves.toBe("model.not_allowed");
    await expect(transcript(stub, chat.id)).resolves.toStrictEqual([]);
  });

  it("refuses every question while the agent is switched off", async () => {
    const { stub, chat, gateway, ask } = await newChat(says("Hi."));
    await pointAtGateway(stub, gateway, false);

    await expect(codeOf(ask("Hi."))).resolves.toBe("feature.disabled");
    expect(gateway.requests).toStrictEqual([]);
    await expect(transcript(stub, chat.id)).resolves.toStrictEqual([]);
  });

  it("stops acting for a person who has left", async () => {
    const { personId, gateway, ask } = await newChat(says("Hi."));
    await env.DB.prepare("DELETE FROM members WHERE user_id = ?")
      .bind(personId)
      .run();

    await expect(codeOf(ask("Hi."))).resolves.toBe(
      "permission.person_inactive"
    );
    expect(gateway.requests).toStrictEqual([]);
  });

  it.each([
    ["a chat that doesn't exist", "missing", "Hi.", "agent.chat_not_found"],
    ["an empty question", undefined, "   ", "agent.invalid_question"],
  ])("refuses %s", async (_, chatId, text, code) => {
    const { stub, chat } = await newChat();

    await expect(
      codeOf(stub.ask(chatId ?? chat.id, { text, model }))
    ).resolves.toBe(code);
  });
});

describe("chat agent after a restart", () => {
  it("continues the conversation with everything before it", async () => {
    const { stub, chat, ask } = await newChat(
      codeStep("export default async (env) => (await env.chat.info()).chatId;"),
      says("This chat's ID is known.")
    );
    await ask("Which chat is this?");

    await evictDurableObject(stub);
    const gateway = fakeGateway(says("You asked which chat this is."));
    await pointAtGateway(stub, gateway);
    const reply = await ask("What did I ask before?");

    expect(reply.answer).toBe("You asked which chat this is.");
    const sent = JSON.stringify(gateway.requests[0]?.body);
    for (const earlier of [
      "Which chat is this?",
      "env.chat.info()",
      chat.id,
      "This chat's ID is known.",
      "What did I ask before?",
    ]) {
      expect(sent).toContain(earlier);
    }
  });

  it("goes on from a turn a restart cut short", async () => {
    const { stub, ask } = await newChat(
      codeStep("export default async () => 6 * 7;"),
      says("42.")
    );
    await ask("What is 6 * 7?");
    // The object died while the step ran: the step's call was kept, as the
    // loop keeps each message it finishes, but its result and the answer
    // weren't.
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "DELETE FROM chat_messages WHERE id IN (SELECT id FROM chat_messages ORDER BY id DESC LIMIT 2)"
      );
    });

    await evictDurableObject(stub);
    const after = fakeGateway(says("It was 42."));
    await pointAtGateway(stub, after);
    const reply = await ask("So?");

    const sent = JSON.stringify(after.requests[0]?.body);
    expect({
      answer: reply.answer,
      // The first question, its step's call (closed as having no result)
      // and the new question.
      sent: ["What is 6 * 7?", "6 * 7;", "No result provided", "So?"].map(
        (text) => sent.includes(text)
      ),
    }).toStrictEqual({
      answer: "It was 42.",
      sent: [true, true, true, true],
    });
  });
});
