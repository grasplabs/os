import { Type } from "@earendil-works/pi-ai";
import { OPENAI_MODELS } from "@earendil-works/pi-ai/providers/openai.models";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import type { AuditEvent } from "@grasp-os/shared/audit";
import { defaultGatewayModels } from "@grasp-os/shared/deployment-config";
import { appIdSchema } from "@grasp-os/shared/ids";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { models } from "../src/models.ts";
import type { ModelCall, ModelsEnv } from "../src/models.ts";
import { fakeGateway } from "./ai-gateway.ts";
import type { GatewayReply } from "./ai-gateway.ts";
import { allEvents } from "./audit-events.ts";
import { runCron } from "./cron.ts";
import { mockIdp } from "./idp.ts";
import { outcome, signedInApi } from "./sign-in.ts";

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

/**
 * Core's env with the fake gateway and the given config, which sets no
 * rules beyond the allowlist: model-rules.test.ts tests them.
 */
const withGateway = (
  replies: GatewayReply[],
  modelGateway: unknown = config
) => {
  const gateway = fakeGateway(...replies);
  const gatewayEnv: ModelsEnv = {
    ...env,
    AI: gateway.binding,
    MODEL_GATEWAY: modelGateway,
  };
  return { gateway, gatewayEnv };
};

const idp = mockIdp();

/**
 * Where the calls here work: an App of their own, made before the first
 * test and kept for the rest, as every call's context must exist.
 */
let madeWork: ModelCall<undefined>["work"] | undefined;

/** Makes the calls' App, before the file's first test. */
const makeWork = async (): Promise<void> => {
  if (madeWork !== undefined) {
    return;
  }
  const builder = await signedInApi(idp, "builder");
  const { id } = await builder.api.apps.create({ name: "Models" });
  const appId = appIdSchema.parse(id);
  madeWork = {
    authority: {
      subject: { type: "app", appId },
      onBehalfOf: builder.userId,
      mode: "interactive",
      appVersion: 1,
    },
    context: { type: "app", appId },
  };
};

/** The calls' work context, once made. */
const work = (): ModelCall<undefined>["work"] => {
  if (madeWork === undefined) {
    throw new Error("The tests' App isn't made yet");
  }
  return madeWork;
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

/** A database or audit log that is down. */
const refuse = (): never => {
  throw new Error("Unavailable");
};

// A test waits up to 10 seconds for a call's audit events (`auditedFor`),
// which reach the log through the audit outbox after the answer. Under
// the default five seconds a slow event would fail as a test timeout, not
// as the events that never came. No test waits more than once, so thirty
// seconds holds that wait and the calls around it on a slow runner.
describe("model gateway", { timeout: 30_000 }, () => {
  beforeEach(makeWork);

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
        work: work(),
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

  it("answers a call with the config the console gives a new deployment", async () => {
    const [model] = defaultGatewayModels;
    const { gateway, gatewayEnv } = withGateway([answer("Hello.")], {
      gateway: "grasp-os",
      models: defaultGatewayModels,
    });

    const result = await models(gatewayEnv).call({
      model,
      messages: [{ role: "user", content: "Say hello." }],
      purpose: "chat.turn",
      trigger: newPerson(),
      work: work(),
    });

    expect({
      text: result.text,
      gateways: gateway.requests.map(
        ({ url }) => new URL(url).pathname.split("/")[3]
      ),
    }).toStrictEqual({ text: "Hello.", gateways: ["grasp-os"] });
  });

  it("sends no provider key, so the gateway uses the keys it stores, and takes no answer from its cache", async () => {
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
        work: work(),
      });
    }

    for (const { headers } of gateway.requests) {
      expect(headers.get("authorization")).toBeNull();
      expect(headers.get("x-api-key")).toBeNull();
      expect(headers.get("cf-aig-authorization")).toBe(
        "Bearer cloudflare-gateway-binding"
      );
      expect({
        // The gateway logs metadata only, never the prompt or the answer.
        logsPayload: headers.get("cf-aig-collect-log-payload"),
        // Nor answers from its cache, however the gateway is set: an
        // answer it kept would be someone else's.
        skipsCache: headers.get("cf-aig-skip-cache"),
      }).toStrictEqual({ logsPayload: "false", skipsCache: "true" });
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
      work: work(),
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
      work: work(),
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
      outcome(
        models(gatewayEnv).call({
          model: workersAi,
          input: "What's the total?",
          schema: z.object({ total: z.number() }),
          purpose: "workflow.step",
          trigger,
          work: work(),
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
        work: work(),
      });

    // A model the gateway offers, but not this deployment.
    await expect(outcome(call(anthropic))).resolves.toBe("model.not_allowed");
    // A provider the gateway doesn't offer at all.
    await expect(outcome(call("google/gemini-3-pro"))).resolves.toBe(
      "model.not_allowed"
    );
    await expect(
      outcome(call("@cf/meta/llama-3.3-70b-instruct-fp8-fast"))
    ).resolves.toBe("model.not_allowed");
    await expect(call(anthropic)).rejects.toMatchObject({
      message: "This deployment doesn't allow that model.",
      details: { model: anthropic },
    });
    expect(gateway.requests).toStrictEqual([]);
  });

  it("answers through the account's default gateway with the default models while no config is set", async () => {
    const [model] = defaultGatewayModels;
    const { gateway, gatewayEnv } = withGateway([answer("Hello.")]);
    gatewayEnv.MODEL_GATEWAY = undefined;
    const call = async (to: string) =>
      await models(gatewayEnv).call({
        model: to,
        input: "Say hello.",
        purpose: "chat.turn",
        trigger: newPerson(),
        work: work(),
      });

    await expect(call(model)).resolves.toMatchObject({ text: "Hello." });
    await expect(outcome(call(anthropic))).resolves.toBe("model.not_allowed");
    expect(
      gateway.requests.map(({ url }) => new URL(url).pathname.split("/")[3])
    ).toStrictEqual(["default"]);
  });

  it.each([
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
        outcome(
          models(gatewayEnv).call({
            model: workersAi,
            input: "Hello.",
            purpose: "chat.turn",
            trigger: newPerson(),
            work: work(),
          })
        )
      ).resolves.toBe("model.unconfigured");
      expect(gateway.requests).toStrictEqual([]);
    }
  );

  it("takes its config as the JSON text a .dev.vars file sets", async () => {
    const { gatewayEnv } = withGateway([answer("Hi.")], JSON.stringify(config));
    await expect(
      outcome(
        models(gatewayEnv).call({
          model: workersAi,
          input: "Hello.",
          purpose: "chat.turn",
          trigger: newPerson(),
          work: work(),
        })
      )
    ).resolves.toBe("ok");
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
  ])("refuses a call with %s", async (_, fields) => {
    const { gateway, gatewayEnv } = withGateway([answer("Hi.")]);
    // SAFETY: invalid on purpose: what a caller that isn't type-checked (a
    // workflow isolate, say) could send, which the gateway must refuse.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    const call = {
      model: workersAi,
      purpose: "chat.turn",
      trigger: newPerson(),
      work: work(),
      ...fields,
    } as ModelCall<undefined>;
    await expect(outcome(models(gatewayEnv).call(call))).resolves.toBe(
      "model.invalid_call"
    );
    expect(gateway.requests).toStrictEqual([]);
  });

  it.each([
    [
      "more IDs than an event names",
      [
        ...Array.from({ length: 150 }, (_, i) => `doc-${i}`),
        // Each ID once.
        "doc-0",
      ],
      { kept: 100, dropped: 50 },
    ],
    [
      // Within the count, but two bytes a character: an event with all of
      // them would be too large for the audit log.
      "IDs too large to record together",
      Array.from({ length: 100 }, (_, i) => `${i}`.padEnd(256, "é")),
      { kept: 50, dropped: 50 },
    ],
  ])(
    "sends a call whose provenance has %s, and records as much of it as fits",
    async (_, provenance, { kept, dropped }) => {
      const trigger = newPerson();
      const { gateway, gatewayEnv } = withGateway([answer("Hi.")]);

      await expect(
        outcome(
          models(gatewayEnv).call({
            model: anthropic,
            input: "Hi.",
            purpose: "chat.turn",
            trigger,
            work: work(),
            provenance,
          })
        )
      ).resolves.toBe("ok");

      expect(gateway.requests).toHaveLength(1);
      const [event] = await auditedFor(trigger.userId, 1);
      expect({
        provenance: event?.provenance,
        dropped: event?.detail.provenanceDropped,
      }).toStrictEqual({
        provenance: [...new Set(provenance)].slice(0, kept),
        dropped,
      });
    }
  );

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
      work: work(),
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
      work: work(),
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
        outcome(
          models(gatewayEnv).call({
            model,
            input: "Hello.",
            purpose: "chat.turn",
            trigger,
            work: work(),
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
      work: work(),
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
      outcome(
        models(gatewayEnv).call({
          model: openai,
          input: "Hello.",
          timeoutMs: 100,
          purpose: "chat.turn",
          trigger,
          work: work(),
        })
      )
    ).resolves.toBe("model.failed");
    const [event] = await auditedFor(trigger.userId, 1);
    expect(event?.detail).toMatchObject({
      outcome: "failed",
      errorType: "timeout",
    });
  });

  it("leaves no timer behind once a call has answered", async () => {
    const { gatewayEnv } = withGateway([answer("Hello.")]);
    // Only the timers: everything else, the gateway's stream included,
    // runs as it would.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await models(gatewayEnv).call({
        model: anthropic,
        input: "Hello.",
        purpose: "chat.turn",
        trigger: newPerson(),
        work: work(),
      });

      // A timer left would keep a Durable Object awake for the timeout.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
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
        work: work(),
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

  it("keeps a paid answer when the audit log is down, and appends its event later", async () => {
    const trigger = newPerson();
    const { gatewayEnv } = withGateway([answer("Hello, Ada.")]);
    const logDown = new Proxy(env.AUDIT_LOG, {
      get: () => refuse,
    });

    const result = await models({ ...gatewayEnv, AUDIT_LOG: logDown }).call({
      model: anthropic,
      input: "Say hello.",
      purpose: "chat.turn",
      trigger,
      work: work(),
    });

    expect(result.text).toBe("Hello, Ada.");
    // The cron trigger drains what the log couldn't take.
    await runCron();
    const [event] = await auditedFor(trigger.userId, 1);
    expect(event).toMatchObject({ action: "model.call", actor: trigger });
  });

  it("keeps a paid answer when the database refuses its audit event, and appends the event straight to the log", async () => {
    const trigger = newPerson();
    const { gatewayEnv } = withGateway([answer("Hello, Ada.")]);
    // Reads still work, so the rules can check where the call works; every
    // write, the audit event's among them, is refused.
    const databaseDown = new Proxy(env.DB, {
      get: (target, key) => {
        if (key === "batch") {
          return refuse;
        }
        const value: unknown = Reflect.get(target, key);
        if (typeof value !== "function") {
          return value;
        }
        const bound: unknown = value.bind(target);
        return bound;
      },
    });

    const result = await models({ ...gatewayEnv, DB: databaseDown }).call({
      model: anthropic,
      input: "Say hello.",
      purpose: "chat.turn",
      trigger,
      work: work(),
    });

    expect(result.text).toBe("Hello, Ada.");
    const [event] = await auditedFor(trigger.userId, 1);
    expect(event).toMatchObject({ action: "model.call", actor: trigger });
  });

  it("refuses every call on a deployment without the AI binding, such as plain workerd", async () => {
    const { gatewayEnv } = withGateway([answer("Hi.")]);
    const { AI: _, ...withoutAi } = gatewayEnv;

    await expect(
      outcome(
        models(withoutAi).call({
          model: workersAi,
          input: "Hello.",
          purpose: "chat.turn",
          trigger: newPerson(),
          work: work(),
        })
      )
    ).resolves.toBe("model.unconfigured");
  });
});

describe("model gateway for agents", () => {
  beforeEach(makeWork);

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
      const agent = await models(gatewayEnv).agent({
        model,
        purpose: "chat.turn",
        trigger,
        work: work(),
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
        // A loop's requests too: never an answer from the gateway's cache.
        skipsCache: request?.headers.get("cf-aig-skip-cache"),
      }).toStrictEqual({
        streamed: true,
        stopReason: "toolUse",
        toolCalls: [["executeCode", { code: "1 + 1" }]],
        gateway: "grasp-os-test",
        offered: true,
        skipsCache: "true",
      });
      const [event] = await auditedFor(trigger.userId, 1);
      expect(event).toMatchObject({
        action: "model.call",
        actor: trigger,
        detail: { purpose: "chat.turn", outcome: "answered", attempt: 1 },
      });
    }
  );

  it.each([workersAi, anthropic, openai])(
    "goes on after a tool call that came with no text, with its result, on %s",
    async (model) => {
      const { gateway, gatewayEnv } = withGateway([
        {
          text: "",
          toolCalls: [
            { id: "call_1", name: "executeCode", arguments: { code: "1 + 1" } },
          ],
          inputTokens: 1000,
          outputTokens: 100,
        },
        answer("It is 2."),
      ]);
      const agent = await models(gatewayEnv).agent({
        model,
        purpose: "chat.turn",
        trigger: newPerson(),
        work: work(),
      });
      const context = withTool("What is 1 + 1?");

      const called = await agent.stream(agent.model, context).result();
      const toolCall = called.content.find(
        (block) => block.type === "toolCall"
      );
      const followUp = normalizeContext({
        ...context,
        messages: [
          ...context.messages,
          called,
          {
            role: "toolResult",
            toolCallId: toolCall?.id ?? "",
            toolName: "executeCode",
            content: [{ type: "text", text: "2" }],
            isError: false,
            timestamp: Date.now(),
          },
        ],
      });
      const answered = await agent.stream(agent.model, followUp).result();

      expect({
        called: called.stopReason,
        answered: answered.stopReason,
        text: answered.content.flatMap((block) =>
          block.type === "text" ? [block.text] : []
        ),
        requests: gateway.requests.length,
      }).toStrictEqual({
        called: "toolUse",
        answered: "stop",
        text: ["It is 2."],
        requests: 2,
      });
    }
  );

  it("logs what a refusal says went wrong, and never its message, which may quote the prompt or a key", async () => {
    const prompt = "What is in the merger memo?";
    const key = "sk-live-4f9a8b7c6d5e4f3a";
    const problem = `AiError: Bad input: Type mismatch of '/messages/2/content', 'string' not in 'null', near '${prompt}' (key ${key})`;
    const { gatewayEnv } = withGateway([
      {
        status: 400,
        body: {
          name: "AiError",
          internalCode: 5006,
          httpCode: 400,
          message: problem,
          description: problem,
        },
      },
    ]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {
      // Kept for the test to read.
    });
    try {
      const agent = await models(gatewayEnv).agent({
        model: workersAi,
        purpose: "chat.turn",
        trigger: newPerson(),
        work: work(),
      });
      const failed = await agent.stream(agent.model, withTool(prompt)).result();

      const logged = warn.mock.calls
        .map(([fields]: unknown[]) => fields)
        .find(
          (fields) =>
            z.object({ event: z.literal("model.failed") }).safeParse(fields)
              .success
        );
      expect({ answer: failed.errorMessage, logged }).toMatchObject({
        answer: "The model call failed (400).",
        logged: {
          status: 400,
          providerErrorName: "AiError",
          providerInternalCode: 5006,
          providerErrorPaths: "/messages/2/content",
        },
      });
      const text = JSON.stringify(logged);
      expect({
        prompt: text.includes(prompt),
        key: text.includes(key),
      }).toStrictEqual({ prompt: false, key: false });
    } finally {
      warn.mockRestore();
    }
  });

  it("refuses a model the deployment doesn't allow before the loop sends anything", async () => {
    const { gateway, gatewayEnv } = withGateway([], {
      gateway: "grasp-os-test",
      models: [workersAi],
    });

    await expect(
      outcome(
        models(gatewayEnv).agent({
          model: anthropic,
          purpose: "chat.turn",
          trigger: newPerson(),
          work: work(),
        })
      )
    ).resolves.toBe("model.not_allowed");
    expect(gateway.requests).toStrictEqual([]);
  });

  it("admits each request by the rules as they stand then, and audits a refusal", async () => {
    const trigger = newPerson();
    const { gateway, gatewayEnv } = withGateway([answer("One.")]);
    const agent = await models(gatewayEnv).agent({
      model: anthropic,
      purpose: "chat.turn",
      trigger,
      work: work(),
    });

    await agent.stream(agent.model, withTool("First.")).result();
    // The deployment stops allowing the model while the loop runs.
    gatewayEnv.MODEL_GATEWAY = {
      gateway: "grasp-os-test",
      models: [workersAi],
    };
    const second = await agent
      .stream(agent.model, withTool("Second."))
      .result();

    expect(second).toMatchObject({
      stopReason: "error",
      errorMessage: "The model call was refused (model.not_allowed).",
    });
    expect(gateway.requests).toHaveLength(1);
    const events = await auditedFor(trigger.userId, 2);
    expect(events.map(({ action }) => action).toSorted()).toStrictEqual([
      "model.call",
      "model.refused",
    ]);
  });

  it("ends a refused request with a failure in its own words, and audits it", async () => {
    const trigger = newPerson();
    const { gatewayEnv } = withGateway([
      { status: 401, errorType: "authentication_error" },
    ]);
    const agent = await models(gatewayEnv).agent({
      model: anthropic,
      purpose: "chat.turn",
      trigger,
      work: work(),
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
    const agent = await models(gatewayEnv).agent(
      { model: anthropic, purpose: "chat.turn", trigger, work: work() },
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
    const agent = await models(gatewayEnv).agent({
      model: anthropic,
      purpose: "chat.turn",
      trigger: newPerson(),
      work: work(),
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
    const agent = await models(gatewayEnv).agent({
      model: openai,
      purpose: "chat.turn",
      trigger,
      work: work(),
    });
    const cancel = new AbortController();

    const stream = agent.stream(agent.model, withTool("Hello."), {
      signal: cancel.signal,
    });
    await vi.waitFor(
      () => {
        expect(gateway.requests).toHaveLength(1);
      },
      { timeout: 10_000 }
    );
    cancel.abort();

    await expect(stream.result()).resolves.toMatchObject({
      stopReason: "aborted",
      errorMessage: "The model call was cancelled.",
    });
    const [event] = await auditedFor(trigger.userId, 1);
    // The gateway never answered, so nothing was used that can be told:
    // no estimate, and no cost.
    expect(event).toMatchObject({
      detail: {
        outcome: "cancelled",
        errorType: "cancelled",
        estimated: false,
      },
      cost: { amount: 0 },
    });
  });
});
