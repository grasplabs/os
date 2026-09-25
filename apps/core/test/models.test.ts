import type { AuditEvent } from "@grasp-os/shared/audit";
import { modelErrors } from "@grasp-os/shared/models";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

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

  it("audits a call the provider refuses, and fails it", async () => {
    const trigger = newPerson();
    const { gatewayEnv } = withGateway([{ status: 401 }]);

    await expect(
      codeOf(
        models(gatewayEnv).call({
          model: anthropic,
          input: "Hello.",
          purpose: "chat.turn",
          trigger,
        })
      )
    ).resolves.toBe("model.failed");
    const [event] = await auditedFor(trigger.userId, 1);
    expect(event).toMatchObject({
      action: "model.call",
      model: { provider: "anthropic", model: "claude-sonnet-4-5" },
      detail: { outcome: "failed", attempt: 1 },
    });
  });
});
