import { agentErrors } from "@grasp-os/shared/agent";
import type { AuditEvent } from "@grasp-os/shared/audit";
import { featureErrors } from "@grasp-os/shared/errors";
import { modelErrors } from "@grasp-os/shared/models";
import { permissionErrors } from "@grasp-os/shared/permissions";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import {
  historyChars,
  maxRunsPerResponse,
  maxRunsPerTurn,
  maxSteps,
} from "../src/agent.ts";
import { codeLimits } from "../src/code-mode.ts";
import {
  chatOf,
  codeResults,
  codeStep,
  gatewayConfig,
  model,
  pointAtGateway,
  says,
  transcript,
} from "./agent-chat.ts";
import { fakeGateway } from "./ai-gateway.ts";
import type { GatewayReply } from "./ai-gateway.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { signedInWithRole } from "./sign-in.ts";

// A chat's agent, through the Workspace object: the loop, the code it runs
// in isolates of their own, and the model gateway, all real (agent-chat.ts).

const idp = mockIdp();

/** A new chat for a person no other test uses, answered by `replies`. */
const newChat = async (...replies: GatewayReply[]) => {
  // A member of the organization, whom no other test uses.
  const { userId } = await signedInWithRole(idp, "user");
  return await chatOf(userId, ...replies);
};

/** Runs `code` as the chat's only code step, and returns what it gave. */
const runStep = async (code: string) => {
  const { stub, chat, ask } = await newChat(codeStep(code), says("Done."));
  await ask("Run it.");
  const [result] = await codeResults(stub, chat.id);
  return result;
};

/** The agent's model.call events for `userId`, once `count` have arrived. */
const modelCallsBy = async (
  userId: string,
  count: number
): Promise<AuditEvent[]> => {
  const mine = async () => {
    const events = await allEvents();
    return events.filter(
      ({ action, actor }) =>
        action === "model.call" &&
        actor.type === "agent" &&
        actor.onBehalfOf === userId
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

/** The one warning a call from an ended run logs. */
const runEndedSchema = z.object({
  event: z.literal("agent.run_ended"),
  runId: z.string(),
});

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

  it("audits every model request as the workspace's agent, acting for the chat's person, in the chat", async () => {
    const { id, chat, personId, ask } = await newChat(
      codeStep("export default async () => 1 + 1;"),
      says("Two.")
    );

    await ask("What is 1 + 1?");

    const events = await modelCallsBy(personId, 2);
    expect(events.map(({ actor }) => actor)).toStrictEqual([
      { type: "agent", agentId: id, onBehalfOf: personId },
      { type: "agent", agentId: id, onBehalfOf: personId },
    ]);
    expect(events.map(({ detail }) => detail)).toStrictEqual([
      expect.objectContaining({
        purpose: "chat.turn",
        outcome: "answered",
        chat: chat.id,
      }),
      expect.objectContaining({
        purpose: "chat.turn",
        outcome: "answered",
        chat: chat.id,
      }),
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
    const { stub, chat, gateway, ask } = await newChat(
      ...Array.from({ length: maxSteps }, () =>
        codeStep("export default async () => 'again';")
      )
    );

    const reply = await ask("Keep going.");

    expect(reply.outcome).toBe("max_steps");
    expect(gateway.requests).toHaveLength(maxSteps);
    // The last step's code isn't run: nobody would read its result.
    const results = await codeResults(stub, chat.id);
    expect(results.at(-1)).toStrictEqual({
      isError: true,
      text: "Not run: this turn has reached its last step. Answer with what you have.",
    });
    expect(results.filter(({ isError }) => !isError)).toHaveLength(
      maxSteps - 1
    );
  });

  it("runs code at most 5 times per response", async () => {
    const { stub, chat, ask } = await newChat(
      codeStep("export default async () => 'ran';", 30),
      says("Done.")
    );

    await ask("Run it all.");

    const results = await codeResults(stub, chat.id);
    expect(results.filter(({ isError }) => !isError)).toHaveLength(
      maxRunsPerResponse
    );
    expect(results.filter(({ isError }) => isError)).toHaveLength(
      30 - maxRunsPerResponse
    );
    expect(results.at(-1)?.text).toMatch(/at most 5 times/u);
  });

  it("runs code at most 30 times per turn", async () => {
    const { stub, chat, ask } = await newChat(
      ...Array.from({ length: 7 }, () =>
        codeStep("export default async () => 'ran';", maxRunsPerResponse)
      ),
      says("Done.")
    );

    await ask("Run it all.");

    const results = await codeResults(stub, chat.id);
    expect(results.filter(({ isError }) => !isError)).toHaveLength(
      maxRunsPerTurn
    );
    expect(results.at(-1)?.text).toMatch(/30 times, the most it may/u);
  });

  it("stops the turn when the person leaves during it", async () => {
    // Long enough that they always leave while the code runs, however slow
    // the runner.
    const { stub, chat, personId, gateway, ask } = await newChat(
      codeStep(
        "export default async () => { await scheduler.wait(5_000); return 'done'; };"
      ),
      says("Never asked.")
    );

    const turn = codeOf(ask("Wait."));
    await vi.waitFor(async () => {
      await expect(transcript(stub, chat.id)).resolves.toHaveLength(3);
    });
    await env.DB.prepare("DELETE FROM members WHERE user_id = ?")
      .bind(personId)
      .run();

    await expect(turn).resolves.toBe("permission.person_inactive");
    // No request for them after they left.
    expect(gateway.requests).toHaveLength(1);
  });

  it("stops the turn when the agent is switched off during it", async () => {
    const { stub, chat, gateway, ask } = await newChat(
      codeStep(
        "export default async () => { await scheduler.wait(5_000); return 'done'; };"
      ),
      says("Never asked.")
    );

    const turn = codeOf(ask("Wait."));
    await vi.waitFor(async () => {
      await expect(transcript(stub, chat.id)).resolves.toHaveLength(3);
    });
    await pointAtGateway(stub, gateway, { agentOn: false });

    await expect(turn).resolves.toBe("feature.disabled");
    expect(gateway.requests).toHaveLength(1);
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
      text: `Returned:\n${JSON.stringify({ given: ["chat", "knowledge"], imported: [], exports: [] })}`,
    });
  });

  it("names the API it doesn't have, and the ones it does", async () => {
    const result = await runStep(
      "export default async (env) => await env.mailbox.send('hi');"
    );

    expect(result?.isError).toBeTruthy();
    expect(result?.text).toContain(
      "This chat has no API named env.mailbox. It has: env.chat, env.knowledge."
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

  it("gets APIs that stop answering once its run was cancelled", async () => {
    const warned = vi.spyOn(console, "warn");
    // Long enough that the cancel always comes first, however slow the
    // runner: the cancel ends the run, not the wait.
    const { stub, chat, ask } = await newChat(
      codeStep(
        "export default async (env) => { await scheduler.wait(5_000); await env.chat.info(); await env.chat.info(); };"
      )
    );

    const reply = ask("Wait, then look.");
    await vi.waitFor(async () => {
      await expect(transcript(stub, chat.id)).resolves.toHaveLength(3);
    });
    await stub.cancel(chat.id);
    await expect(reply).resolves.toMatchObject({ outcome: "cancelled" });

    // The code goes on after its run was cancelled; its API refuses it,
    // and the call after its end is logged once, not for every call.
    await vi.waitFor(
      () => {
        expect(warned).toHaveBeenCalledWith(
          expect.objectContaining({ event: "agent.run_ended", chatId: chat.id })
        );
      },
      { timeout: 15_000, interval: 100 }
    );
    await expect(
      runInDurableObject(stub, (instance) =>
        instance.callFromCodeRun(chat.id, "not-a-run")
      )
    ).resolves.toBe("ended");
    const { runId } = runEndedSchema.parse(
      warned.mock.calls
        .map(([entry]: unknown[]) => entry)
        .find((entry) => runEndedSchema.safeParse(entry).success)
    );
    // More calls from the same ended run: still refused, not logged again.
    await expect(
      Promise.all(
        [1, 2].map(
          async () =>
            await runInDurableObject(stub, (instance) =>
              instance.callFromCodeRun(chat.id, runId)
            )
        )
      )
    ).resolves.toStrictEqual(["ended", "ended"]);
    expect(
      warned.mock.calls.filter(([entry]) =>
        JSON.stringify(entry).includes(chat.id)
      )
    ).toHaveLength(1);
    warned.mockRestore();
  });

  it("stops a run's API calls at the most one run may make", async () => {
    const result = await runStep(
      "export default async (env) => { let answered = 0; for (let i = 0; i < 150; i++) { try { await env.chat.info(); answered += 1; } catch (error) { return { answered, refused: String(error.message) }; } } return { answered }; };"
    );

    expect(result?.isError).toBeFalsy();
    expect(
      JSON.parse(result?.text.replace("Returned:\n", "") ?? "")
    ).toStrictEqual({
      answered: codeLimits.subRequests,
      refused: agentErrors.create("agent.run_calls_spent").message,
    });
  });

  it("has no Cache API to hand data to another chat", async () => {
    await expect(
      runStep("export default async () => typeof caches;")
    ).resolves.toStrictEqual({ isError: false, text: "Returned:\nundefined" });
  });

  it.each([
    [
      "patched string and array methods",
      "String.prototype.slice = function () { return String(this); }; Array.prototype.push = function (...items) { for (const item of items) this[this.length] = item; return this.length; }; export default async () => { for (let i = 0; i < 5000; i++) console.log('x'.repeat(1000)); return 'y'.repeat(5_000_000); };",
      /^Logs:\nx+/u,
    ],
    [
      "a value that makes itself huge text",
      "export default async () => { const value = () => {}; value.toString = () => 'z'.repeat(30_000_000); return value; };",
      /^Returned:\nz{32000,}\n… \(cut: longer than 32768 characters\)$/u,
    ],
    [
      "a forged result through Object.prototype.then",
      "Object.prototype.then = function (resolve) { delete Object.prototype.then; resolve({ ok: true, logs: Array.from({ length: 1000 }, () => 'q'.repeat(31_000)), result: 'forged' }); }; export default async () => 'mine';",
      /^Returned:\nmine$/u,
    ],
  ])(
    "can't store more than the model reads, even with %s",
    async (_, code, read) => {
      const { stub, chat, ask } = await newChat(codeStep(code), says("Done."));

      await ask("Flood it.");

      // What the model read is the run's own output, cut to what it reads.
      const [result] = await codeResults(stub, chat.id);
      expect(result?.text).toMatch(read);
      const [row] = await runInDurableObject(stub, (_instance, state) =>
        state.storage.sql
          .exec<{ longest: number }>(
            "SELECT max(length(message)) AS longest FROM chat_messages WHERE chat_id = ?",
            chat.id
          )
          .toArray()
      );
      expect(row?.longest).toBeLessThan(40_000);
    }
  );

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

  it("keeps a chat in restricted mode to the models the client's data rule allows", async () => {
    const { stub, chat, personId, gateway, ask } = await newChat(says("Hi."));
    const euModel = "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast";
    await pointAtGateway(stub, gateway, {
      config: {
        gateway: gatewayConfig.gateway,
        models: [model, euModel],
        sensitive: { models: [euModel] },
      },
    });
    // The chat has read restricted data: everything it sends is sensitive.
    await stub.restrictChat(chat.id);

    await expect(codeOf(ask("Hi."))).resolves.toBe("model.sensitive_data");
    expect(gateway.requests).toStrictEqual([]);
    await expect(transcript(stub, chat.id)).resolves.toStrictEqual([]);
    await vi.waitFor(
      async () => {
        const events = await allEvents();
        expect(
          events.filter(
            ({ action, actor }) =>
              action === "model.refused" &&
              actor.type === "agent" &&
              actor.onBehalfOf === personId
          )
        ).toMatchObject([
          { detail: { reason: "model.sensitive_data", because: "restricted" } },
        ]);
      },
      { timeout: 10_000, interval: 50 }
    );
  });

  it("refuses every question while the agent is switched off", async () => {
    const { stub, chat, gateway, ask } = await newChat(says("Hi."));
    await pointAtGateway(stub, gateway, { agentOn: false });

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

  it("shortens a long turn's oldest code results to fit, keeping its latest and every call's result", async () => {
    const { stub, chat, gateway, ask } = await newChat(
      // 30 code runs of a result the model reads cut to 32 KiB each.
      ...Array.from({ length: maxRunsPerTurn / maxRunsPerResponse }, () =>
        codeStep(
          "export default async () => 'r'.repeat(40_000);",
          maxRunsPerResponse
        )
      ),
      says("Done.")
    );

    await expect(ask("Run it all.")).resolves.toMatchObject({
      outcome: "answered",
    });

    // What the last request sent, in Anthropic's wire format.
    const blockSchema = z.looseObject({
      type: z.string(),
      id: z.string().optional(),
      tool_use_id: z.string().optional(),
    });
    const bodySchema = z.looseObject({
      messages: z.array(
        z.looseObject({
          content: z.union([z.string(), z.array(blockSchema)]),
        })
      ),
    });
    const last = gateway.requests.at(-1)?.body;
    const blocks = bodySchema
      .parse(last)
      .messages.flatMap(({ content }) =>
        typeof content === "string" ? [] : content
      );
    const calls = blocks.flatMap(({ type, id }) =>
      type === "tool_use" ? [id] : []
    );
    const results = blocks.filter(({ type }) => type === "tool_result");
    const stored = await codeResults(stub, chat.id);
    const shortened = results.filter((result) =>
      JSON.stringify(result).includes("(output left out to fit;")
    );
    const latest = results.at(-1);
    expect({
      calls: calls.length,
      withinWindow: JSON.stringify(last).length < historyChars + 50_000,
      // Every call still has its result, in the same order.
      pairs: results.map(({ tool_use_id: id }) => id),
      someShortened: shortened.length > 0,
      latestWhole:
        latest !== undefined &&
        !shortened.includes(latest) &&
        JSON.stringify(latest).includes(
          JSON.stringify(stored.at(-1)?.text ?? "missing").slice(1, -1)
        ),
    }).toStrictEqual({
      calls: maxRunsPerTurn,
      withinWindow: true,
      pairs: calls,
      someShortened: true,
      latestWhole: true,
    });
  });

  it("sends only a long chat's recent turns, and stops a chat that is too long", async () => {
    const { stub, chat, gateway, ask } = await newChat(
      codeStep("export default async () => 'early' + '-result';"),
      says("Noted."),
      says("Still here.")
    );
    await ask("Remember this.");
    // A long chat since: questions of 30,000 characters, each answered.
    const answer = JSON.stringify({
      role: "assistant",
      content: [{ type: "text", text: "Answered." }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 1,
    });
    const addTurns = async (count: number) => {
      await runInDurableObject(stub, (_instance, state) => {
        const question = JSON.stringify({
          role: "user",
          content: "q".repeat(30_000),
          timestamp: 1,
        });
        for (let i = 0; i < count; i += 1) {
          for (const message of [question, answer]) {
            state.storage.sql.exec(
              "INSERT INTO chat_messages (chat_id, message, created_at) VALUES (?, ?, ?)",
              chat.id,
              message,
              Date.now()
            );
          }
        }
      });
    };
    await addTurns(40);

    await expect(ask("And now?")).resolves.toMatchObject({
      outcome: "answered",
      answer: "Still here.",
    });
    const sent = JSON.stringify(gateway.requests.at(-1)?.body);
    expect({
      early: sent.includes("Remember this.") || sent.includes("early-result"),
      note: sent.includes("Earlier messages of this chat are left out"),
      question: sent.includes("And now?"),
      // The instructions always go along.
      instructions: sent.includes("You are the Grasp assistant"),
      withinWindow: sent.length < historyChars + 50_000,
    }).toStrictEqual({
      early: false,
      note: true,
      question: true,
      instructions: true,
      withinWindow: true,
    });

    await addTurns(100);
    await expect(codeOf(ask("More?"))).resolves.toBe("agent.chat_full");
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
