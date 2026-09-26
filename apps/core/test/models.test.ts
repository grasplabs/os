import { Type } from "@earendil-works/pi-ai";
import { OPENAI_MODELS } from "@earendil-works/pi-ai/providers/openai.models";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import type { AuditEvent } from "@grasp-os/shared/audit";
import { modelErrors } from "@grasp-os/shared/models";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { sendAuditOutbox } from "../src/audit-outbox.ts";
import { models } from "../src/models.ts";
import type { ModelCall, ModelsEnv } from "../src/models.ts";
import { fakeGateway } from "./ai-gateway.ts";
import type { GatewayReply } from "./ai-gateway.ts";
import { allEvents } from "./audit-events.ts";

// AI Gateway is the outside system here: a fake behind the AI binding
// answers in each provider's own wire format. Everything else is real,
// down to the audit log.

const workersAi = "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const anthropic = "anthropic/claude-sonnet-4-5";
const openai = "openai/gpt-5.4";

const config = {
  gateway: "grasp-os-test",
  models: [workersAi, anthropic, openai],
};

const answer = (text: string): GatewayReply => ({
  text,
  inputTokens: 1000,
  outputTokens: 100,
});

/** Core's env with the fake gateway and the given config. */
const withGateway = (replies: GatewayReply[], ...modelGateway: unknown[]) => {
  const gateway = fakeGateway(...replies);
  const gatewayEnv: ModelsEnv = {
    ...env,
    AI: gateway.binding,
    // Only an explicit `undefined` leaves the deployment without config.
    MODEL_GATEWAY: modelGateway.length === 0 ? config : modelGateway[0],
  };
  return { gateway, gatewayEnv };
};

/** A person no other test uses, so their audit events are this test's. */
const newPerson = () =>
  ({ type: "person", userId: `person-${crypto.randomUUID()}` }) as const;

/** The audit events triggered by `userId`, once `count` have arrived. */
const auditedFor = async (
  userId: string,
  count: number
): Promise<AuditEvent[]> => {
  const mine = async () => {
    const events = await allEvents();
    return events.filter(
      ({ actor }) => actor.type === "person" && actor.userId === userId
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

/** A queue or database that is down. */
const refuse = (): never => {
  throw new Error("Queue unavailable");
};

const codeOf = async (call: Promise<unknown>) => {
  try {
    await call;
  } catch (error) {
    return modelErrors.codeOf(error);
  }
  return "answered";
};

describe("model gateway", () => {
  it.each([
    [workersAi, "/workers-ai/v1/chat/completions"],
    [anthropic, "/anthropic/v1/messages"],
    [openai, "/openai/responses"],
  ])(
    "answers a chat call to %s through the deployment's AI Gateway",
    async (model, route) => {
      const { gateway, gatewayEnv } = withGateway([answer("Hello, Ada.")]);

      const result = await models(gatewayEnv).call({
        model,
        system: "Greet people by name.",
        messages: [
          { role: "user", content: "Hi, I'm Ada." },
          { role: "assistant", content: "Hi! What can I do?" },
          { role: "user", content: "Say hello." },
        ],
        purpose: "chat.turn",
        trigger: newPerson(),
      });

      expect(result).toMatchObject({
        text: "Hello, Ada.",
        output: undefined,
        usage: { inputTokens: 1000, outputTokens: 100 },
      });
      const routes = gateway.requests.map(({ url }) => {
        const { origin, pathname } = new URL(url);
        return `${origin}${pathname}`;
      });
      expect(routes).toStrictEqual([
        `https://workers-binding.ai/ai-gateway/gateways/grasp-os-test${route}`,
      ]);
      // The whole conversation went along, not only the last turn.
      const body = JSON.stringify(gateway.requests[0]?.body);
      for (const text of [
        "Greet people by name.",
        "Hi, I'm Ada.",
        "Say hello.",
      ]) {
        expect(body).toContain(text);
      }
    }
  );

  it("sends no provider key, so the gateway uses the keys it stores", async () => {
    const { gateway, gatewayEnv } = withGateway([
      answer("One"),
      answer("Two"),
      answer("Three"),
    ]);
    for (const model of [workersAi, anthropic, openai]) {
      // One model after another, as a person would.
      // oxlint-disable-next-line no-await-in-loop
      await models(gatewayEnv).call({
        model,
        input: "Count.",
        purpose: "chat.turn",
        trigger: newPerson(),
      });
    }

    for (const { headers } of gateway.requests) {
      expect(headers.get("authorization")).toBeNull();
      expect(headers.get("x-api-key")).toBeNull();
      expect(headers.get("cf-aig-authorization")).toBe(
        "Bearer cloudflare-gateway-binding"
      );
      // The gateway logs metadata only, never the prompt or the answer.
      expect(headers.get("cf-aig-collect-log-payload")).toBe("false");
      expect(
        JSON.parse(headers.get("cf-aig-metadata") ?? "null")
      ).toStrictEqual({ purpose: "chat.turn", actor: "person" });
    }
    // Nor could core send one: its env holds no provider key or gateway token.
    expect(
      Object.keys(env).filter((name) =>
        /API_KEY|API_TOKEN|ANTHROPIC|OPENAI|GEMINI|AI_GATEWAY/u.test(name)
      )
    ).toStrictEqual([]);
  });

  it("returns structured output parsed with the call's schema", async () => {
    const { gatewayEnv } = withGateway([
      answer('```json\n{ "vendor": "Acme", "total": 42.5 }\n```'),
    ]);

    const result = await models(gatewayEnv).call({
      model: anthropic,
      system: "Read the invoice.",
      input: { invoice: "Acme, total 42.50" },
      schema: z.object({ vendor: z.string(), total: z.number() }),
      purpose: "workflow.step",
      trigger: newPerson(),
    });

    expect(result.output).toStrictEqual({ vendor: "Acme", total: 42.5 });
  });

  it("asks once more when the answer doesn't match the schema", async () => {
    const trigger = newPerson();
    const { gateway, gatewayEnv } = withGateway([
      answer("The total is 42."),
      answer('{ "total": 42 }'),
    ]);

    const result = await models(gatewayEnv).call({
      model: workersAi,
      input: "What's the total?",
      schema: z.object({ total: z.number() }),
      purpose: "workflow.step",
      trigger,
    });

    // Both requests count.
    expect(result).toMatchObject({
      output: { total: 42 },
      usage: { inputTokens: 2000, outputTokens: 200 },
    });
    // The second request shows the model its answer and why it didn't fit.
    expect(gateway.requests).toHaveLength(2);
    expect(JSON.stringify(gateway.requests[1]?.body)).toMatch(
      /The total is 42\..*isn't JSON/u
    );
    const events = await auditedFor(trigger.userId, 2);
    expect(events.map(({ detail }) => detail)).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({ attempt: 1, outcome: "invalid_output" }),
        expect.objectContaining({ attempt: 2, outcome: "answered" }),
      ])
    );
  });

  it("fails when the answer doesn't match the schema the second time either", async () => {
    const trigger = newPerson();
    const { gateway, gatewayEnv } = withGateway([
      answer('{ "total": "forty-two" }'),
      answer('{ "total": "still forty-two" }'),
    ]);

    await expect(
      codeOf(
        models(gatewayEnv).call({
          model: workersAi,
          input: "What's the total?",
          schema: z.object({ total: z.number() }),
          purpose: "workflow.step",
          trigger,
        })
      )
    ).resolves.toBe("model.invalid_output");
    expect(gateway.requests).toHaveLength(2);
    // The feedback names what didn't fit.
    expect(JSON.stringify(gateway.requests[1]?.body)).toContain("total");
    await expect(auditedFor(trigger.userId, 2)).resolves.toHaveLength(2);
  });

  it("refuses a model the deployment doesn't allow, before anything is sent", async () => {
    const { gateway, gatewayEnv } = withGateway([], {
      gateway: "grasp-os-test",
      models: [workersAi],
    });
    const call = async (model: string) =>
      await models(gatewayEnv).call({
        model,
        input: "Hello.",
        purpose: "chat.turn",
        trigger: newPerson(),
      });

    // A model the gateway offers, but not this deployment.
    await expect(codeOf(call(anthropic))).resolves.toBe("model.not_allowed");
    // A provider the gateway doesn't offer at all.
    await expect(codeOf(call("google/gemini-3-pro"))).resolves.toBe(
      "model.not_allowed"
    );
    await expect(
      codeOf(call("@cf/meta/llama-3.3-70b-instruct-fp8-fast"))
    ).resolves.toBe("model.not_allowed");
    await expect(call(anthropic)).rejects.toMatchObject({
      message: "This deployment doesn't allow that model.",
      details: { model: anthropic },
    });
    expect(gateway.requests).toStrictEqual([]);
  });

  it.each([
    ["no config", undefined],
    ["config that isn't JSON", "{"],
    ["no gateway", { models: [workersAi] }],
    ["no models", { gateway: "grasp-os-test", models: [] }],
    [
      "a model pi doesn't know",
      { gateway: "grasp-os-test", models: ["anthropic/claude-9"] },
    ],
  ])(
    "refuses every call with %s: the gateway is off",
    async (_, modelGateway) => {
      const { gateway, gatewayEnv } = withGateway(
        [answer("Hi.")],
        modelGateway
      );

      await expect(
        codeOf(
          models(gatewayEnv).call({
            model: workersAi,
            input: "Hello.",
            purpose: "chat.turn",
            trigger: newPerson(),
          })
        )
      ).resolves.toBe("model.unconfigured");
      expect(gateway.requests).toStrictEqual([]);
    }
  );

  it("takes its config as the JSON text a .dev.vars file sets", async () => {
    const { gatewayEnv } = withGateway([answer("Hi.")], JSON.stringify(config));
    await expect(
      codeOf(
        models(gatewayEnv).call({
          model: workersAi,
          input: "Hello.",
          purpose: "chat.turn",
          trigger: newPerson(),
        })
      )
    ).resolves.toBe("answered");
  });

  it.each([
    [
      "both input and messages",
      { input: "Hi.", messages: [{ role: "user", content: "Hi." }] },
    ],
    ["neither input nor messages", {}],
    [
      "messages that end with the model's turn",
      { messages: [{ role: "assistant", content: "Hi." }] },
    ],
    [
      "a purpose that isn't a dotted name",
      { input: "Hi.", purpose: "Summarise this invoice" },
    ],
    [
      "a trigger the audit log doesn't know",
      { input: "Hi.", trigger: { type: "admin" } },
    ],
    [
      "too much provenance",
      {
        input: "Hi.",
        provenance: Array.from({ length: 101 }, (_, i) => `doc-${i}`),
      },
    ],
    [
      // Within every field's bound, but two bytes a character: the audit
      // event would be too large, and the call would go unrecorded.
      "provenance too large to record",
      {
        input: "Hi.",
        provenance: Array.from({ length: 100 }, (_, i) =>
          `${i}`.padEnd(256, "é")
        ),
      },
    ],
  ])("refuses a call with %s", async (_, fields) => {
    const { gateway, gatewayEnv } = withGateway([answer("Hi.")]);
    // SAFETY: invalid on purpose: what a caller that isn't type-checked (a
    // workflow isolate, say) could send, which the gateway must refuse.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    const call = {
      model: workersAi,
      purpose: "chat.turn",
      trigger: newPerson(),
      ...fields,
    } as ModelCall<undefined>;
    await expect(codeOf(models(gatewayEnv).call(call))).resolves.toBe(
      "model.invalid_call"
    );
    expect(gateway.requests).toStrictEqual([]);
  });

  it("audits every call as metadata: who asked, why, model, tokens, cost, provenance", async () => {
    const trigger = newPerson();
    const { gatewayEnv } = withGateway([
      {
        text: "It's due on 1 October.",
        inputTokens: 1_000_000,
        outputTokens: 100_000,
      },
    ]);

    await models(gatewayEnv).call({
      model: anthropic,
      input: "When is the Acme invoice due?",
      purpose: "chat.turn",
      trigger,
      provenance: ["doc-invoice-1", "mail-2"],
      requestId: "request-1",
    });

    const [event] = await auditedFor(trigger.userId, 1);
    expect(event).toMatchObject({
      source: "core",
      actor: trigger,
      action: "model.call",
      requestId: "request-1",
      provenance: ["doc-invoice-1", "mail-2"],
      model: {
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        inputTokens: 1_000_000,
        outputTokens: 100_000,
      },
      cost: { currency: "USD" },
      detail: {
        purpose: "chat.turn",
        outcome: "answered",
        attempt: 1,
        gatewayLogId: "log-1",
      },
    });
    // At Claude Sonnet 4.5's list prices: $3 per million tokens in, $15 out.
    expect(event?.cost?.amount).toBeCloseTo(4.5);
    // Never the prompt or the answer.
    const stored = JSON.stringify(event);
    expect(stored).not.toContain("Acme");
    expect(stored).not.toContain("October");
  });

  it("says when an answer stopped at the model's output limit", async () => {
    const trigger = newPerson();
    const { gatewayEnv } = withGateway([
      { ...answer("The first part of a long"), truncated: true },
    ]);

    const result = await models(gatewayEnv).call({
      model: workersAi,
      input: "Write a long essay.",
      purpose: "chat.turn",
      trigger,
    });

    expect(result).toMatchObject({
      text: "The first part of a long",
      truncated: true,
    });
    const [event] = await auditedFor(trigger.userId, 1);
    expect(event?.detail).toMatchObject({ outcome: "truncated" });
  });

  it.each([
    [anthropic, 401, "authentication_error", 1],
    [openai, 402, "insufficient_quota", 1],
    // Refused for a moment: tried twice more before it fails.
    [workersAi, 429, "rate_limit_error", 3],
    [anthropic, 503, "overloaded_error", 3],
  ])(
    "audits a call to %s the provider refuses with %i, with the status and error type only",
    async (model, status, errorType, requests) => {
      const trigger = newPerson();
      const { gateway, gatewayEnv } = withGateway(
        Array.from({ length: requests }, () => ({ status, errorType }))
      );

      await expect(
        codeOf(
          models(gatewayEnv).call({
            model,
            input: "Hello.",
            purpose: "chat.turn",
            trigger,
          })
        )
      ).resolves.toBe("model.failed");
      expect(gateway.requests).toHaveLength(requests);
      const [event] = await auditedFor(trigger.userId, 1);
      expect(event).toMatchObject({
        action: "model.call",
        detail: { outcome: "failed", attempt: 1, status, errorType },
      });
      // Never the provider's message, which may quote the prompt.
      expect(JSON.stringify(event)).not.toContain("Refused");
    }
  );

  it("answers when the provider refuses for a moment, then answers", async () => {
    const trigger = newPerson();
    const { gateway, gatewayEnv } = withGateway([
      { status: 429, errorType: "rate_limit_error" },
      answer("Hi."),
    ]);

    const result = await models(gatewayEnv).call({
      model: anthropic,
      input: "Hello.",
      purpose: "chat.turn",
      trigger,
    });

    expect(result.text).toBe("Hi.");
    expect(gateway.requests).toHaveLength(2);
    const [event] = await auditedFor(trigger.userId, 1);
    expect(event?.detail).toMatchObject({ outcome: "answered", status: 200 });
  });

  it("fails a call that takes longer than its timeout, and audits it", async () => {
    const trigger = newPerson();
    const { gatewayEnv } = withGateway([{ hang: true }]);

    await expect(
      codeOf(
        models(gatewayEnv).call({
          model: openai,
          input: "Hello.",
          timeoutMs: 100,
          purpose: "chat.turn",
          trigger,
        })
      )
    ).resolves.toBe("model.failed");
    const [event] = await auditedFor(trigger.userId, 1);
    expect(event?.detail).toMatchObject({
      outcome: "failed",
      errorType: "timeout",
    });
  });

  it("caps the answer's length at the call's limit, or a default, never above the model's", async () => {
    const { gateway, gatewayEnv } = withGateway([
      answer("One"),
      answer("Two"),
      answer("Three"),
    ]);
    for (const maxTokens of [500, undefined, 10_000_000]) {
      // One after another, as a person would.
      // oxlint-disable-next-line no-await-in-loop
      await models(gatewayEnv).call({
        model: openai,
        input: "Write something.",
        maxTokens,
        purpose: "chat.turn",
        trigger: newPerson(),
      });
    }

    const sentLimits = gateway.requests.map(
      ({ body }) =>
        z.object({ max_output_tokens: z.number() }).parse(body)
          .max_output_tokens
    );
    expect(sentLimits).toStrictEqual([
      500,
      16_384,
      OPENAI_MODELS["gpt-5.4"].maxTokens,
    ]);
  });

  it("keeps a paid answer when the audit queue is down, and delivers its event later", async () => {
    const trigger = newPerson();
    const { gatewayEnv } = withGateway([answer("Hello, Ada.")]);
    const queueDown: Env["AUDIT_QUEUE"] = {
      send: refuse,
      sendBatch: refuse,
      metrics: refuse,
    };

    const result = await models({ ...gatewayEnv, AUDIT_QUEUE: queueDown }).call(
      {
        model: anthropic,
        input: "Say hello.",
        purpose: "chat.turn",
        trigger,
      }
    );

    expect(result.text).toBe("Hello, Ada.");
    // The cron trigger sends what the queue refused.
    await sendAuditOutbox(env);
    const [event] = await auditedFor(trigger.userId, 1);
    expect(event).toMatchObject({ action: "model.call", actor: trigger });
  });

  it("keeps a paid answer when the database refuses its audit event, and sends the event straight to the queue", async () => {
    const trigger = newPerson();
    const { gatewayEnv } = withGateway([answer("Hello, Ada.")]);
    const databaseDown = new Proxy(env.DB, {
      get: () => refuse,
    });

    const result = await models({ ...gatewayEnv, DB: databaseDown }).call({
      model: anthropic,
      input: "Say hello.",
      purpose: "chat.turn",
      trigger,
    });

    expect(result.text).toBe("Hello, Ada.");
    const [event] = await auditedFor(trigger.userId, 1);
    expect(event).toMatchObject({ action: "model.call", actor: trigger });
  });

  it("refuses every call on a deployment without the AI binding, such as plain workerd", async () => {
    const { gatewayEnv } = withGateway([answer("Hi.")]);
    const { AI: _, ...withoutAi } = gatewayEnv;

    await expect(
      codeOf(
        models(withoutAi).call({
          model: workersAi,
          input: "Hello.",
          purpose: "chat.turn",
          trigger: newPerson(),
        })
      )
    ).resolves.toBe("model.unconfigured");
  });
});

describe("model gateway for agents", () => {
  const codeTool = {
    name: "executeCode",
    description: "Runs code.",
    parameters: Type.Object({ code: Type.String() }),
  };

  /** A conversation that offers the model the code tool. */
  const withTool = (question: string) =>
    normalizeContext({
      systemPrompt: "Use the tools.",
      messages: [{ role: "user", content: question, timestamp: Date.now() }],
      tools: [codeTool],
    });

  it.each([workersAi, anthropic, openai])(
    "streams a tool call from %s through the gateway, and audits the request",
    async (model) => {
      const trigger = newPerson();
      const { gateway, gatewayEnv } = withGateway([
        {
          text: "Let me check.",
          toolCalls: [
            { id: "call_1", name: "executeCode", arguments: { code: "1 + 1" } },
          ],
          inputTokens: 1000,
          outputTokens: 100,
        },
      ]);
      const agent = models(gatewayEnv).agent({
        model,
        purpose: "chat.turn",
        trigger,
      });

      const stream = agent.stream(agent.model, withTool("What is 1 + 1?"));
      const types = new Set<string>();
      for await (const event of stream) {
        types.add(event.type);
      }
      const final = await stream.result();

      const [request] = gateway.requests;
      expect({
        streamed: types.has("toolcall_end"),
        stopReason: final.stopReason,
        toolCalls: final.content.flatMap((block) =>
          block.type === "toolCall" ? [[block.name, block.arguments]] : []
        ),
        // The tool went along, to the deployment's gateway.
        gateway: new URL(request?.url ?? "").pathname.split("/")[3],
        offered: JSON.stringify(request?.body).includes("Runs code."),
      }).toStrictEqual({
        streamed: true,
        stopReason: "toolUse",
        toolCalls: [["executeCode", { code: "1 + 1" }]],
        gateway: "grasp-os-test",
        offered: true,
      });
      const [event] = await auditedFor(trigger.userId, 1);
      expect(event).toMatchObject({
        action: "model.call",
        actor: trigger,
        detail: { purpose: "chat.turn", outcome: "answered", attempt: 1 },
      });
    }
  );

  it("refuses a model the deployment doesn't allow before the loop sends anything", () => {
    const { gateway, gatewayEnv } = withGateway([], {
      gateway: "grasp-os-test",
      models: [workersAi],
    });

    expect(() =>
      models(gatewayEnv).agent({
        model: anthropic,
        purpose: "chat.turn",
        trigger: newPerson(),
      })
    ).toThrow(expect.objectContaining({ code: "model.not_allowed" }));
    expect(gateway.requests).toStrictEqual([]);
  });

  it("ends a refused request with a failure in its own words, and audits it", async () => {
    const trigger = newPerson();
    const { gatewayEnv } = withGateway([
      { status: 401, errorType: "authentication_error" },
    ]);
    const agent = models(gatewayEnv).agent({
      model: anthropic,
      purpose: "chat.turn",
      trigger,
    });

    const final = await agent.stream(agent.model, withTool("Hello.")).result();

    expect(final).toMatchObject({
      stopReason: "error",
      errorMessage: "The model call failed (401 authentication_error).",
    });
    const [event] = await auditedFor(trigger.userId, 1);
    expect(event?.detail).toMatchObject({
      outcome: "failed",
      status: 401,
      errorType: "authentication_error",
    });
  });

  it("records what fed each request, as the loop has read it by then", async () => {
    const trigger = newPerson();
    const { gatewayEnv } = withGateway([answer("One."), answer("Two.")]);
    const read: string[] = [];
    const agent = models(gatewayEnv).agent(
      { model: anthropic, purpose: "chat.turn", trigger },
      () => read
    );

    await agent.stream(agent.model, withTool("First.")).result();
    read.push("doc-policy");
    await agent.stream(agent.model, withTool("Second.")).result();

    const events = await auditedFor(trigger.userId, 2);
    expect(events.map(({ provenance }) => provenance)).toStrictEqual(
      expect.arrayContaining([[], ["doc-policy"]])
    );
  });

  it("sends nothing for a request cancelled before it starts", async () => {
    const { gateway, gatewayEnv } = withGateway([answer("Hi.")]);
    const agent = models(gatewayEnv).agent({
      model: anthropic,
      purpose: "chat.turn",
      trigger: newPerson(),
    });

    const final = await agent
      .stream(agent.model, withTool("Hello."), {
        signal: AbortSignal.abort(),
      })
      .result();

    expect(final.stopReason).toBe("aborted");
    expect(gateway.requests).toStrictEqual([]);
  });

  it("stops a request its caller cancels, and audits it as cancelled", async () => {
    const trigger = newPerson();
    const { gateway, gatewayEnv } = withGateway([{ hang: true }]);
    const agent = models(gatewayEnv).agent({
      model: openai,
      purpose: "chat.turn",
      trigger,
    });
    const cancel = new AbortController();

    const stream = agent.stream(agent.model, withTool("Hello."), {
      signal: cancel.signal,
    });
    await vi.waitFor(() => {
      expect(gateway.requests).toHaveLength(1);
    });
    cancel.abort();

    await expect(stream.result()).resolves.toMatchObject({
      stopReason: "aborted",
      errorMessage: "The model call was cancelled.",
    });
    const [event] = await auditedFor(trigger.userId, 1);
    expect(event?.detail).toMatchObject({
      outcome: "cancelled",
      errorType: "cancelled",
    });
  });
});
