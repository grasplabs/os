import type { AiBinding } from "@earendil-works/pi-ai/api/cloudflare-ai-binding";
import { runActorOf } from "@grasp-os/shared/audit";
import type { AuditEvent } from "@grasp-os/shared/audit";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { models } from "../src/models.ts";
import type { ModelCall, ModelsEnv } from "../src/models.ts";
import { fakeGateway } from "./ai-gateway.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { mailConnection } from "./mail-connection.ts";
import { finished } from "./runs.ts";
import { outcome, signedInApi } from "./sign-in.ts";
import { appWith, grantMail, workflowFiles } from "./workflow-apps.ts";

// The client's rules for model calls, checked on every call before
// anything is sent. AI Gateway is the outside system: a fake behind the AI
// binding. Everything else is real, down to the audit log and, for the
// rules a workflow run meets, the run.

const idp = mockIdp();

const workersAi = "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const anthropic = "anthropic/claude-sonnet-4-5";
/** Hosted in the EU, as the tests' config says: its provider's EU region. */
const euModel = "openai/gpt-5.4";

const gateway = "grasp-os-test";
const allowed = [workersAi, anthropic, euModel];

/** Core's env with the fake gateway, the rules `config` adds, and `features`. */
const withRules = (
  config: Record<string, unknown>,
  features: unknown = env.FEATURES
) => {
  const fake = fakeGateway(
    ...Array.from({ length: 4 }, () => ({
      text: "Hi.",
      inputTokens: 10,
      outputTokens: 5,
    }))
  );
  const rulesEnv: ModelsEnv = {
    ...env,
    AI: fake.binding,
    FEATURES: features,
    MODEL_GATEWAY: { gateway, models: allowed, ...config },
  };
  return { fake, call: models(rulesEnv).call };
};

/** A person no other test uses, so their audit events are this test's. */
const newPerson = () =>
  ({ type: "person", userId: `person-${crypto.randomUUID()}` }) as const;

const hello = (
  model: string,
  more: Partial<ModelCall<undefined>> = {}
): ModelCall<undefined> => ({
  model,
  input: "Hello.",
  purpose: "chat.turn",
  trigger: newPerson(),
  ...more,
});

/** A run of `workflow` in `app` no other test uses. */
const runOf = (app: string, workflow: string) =>
  runActorOf({ runId: `run-${crypto.randomUUID()}`, app, workflow });

/** The audit events `actor` triggered. */
const eventsOf = async (actor: unknown): Promise<AuditEvent[]> => {
  const events = await allEvents();
  return events.filter(
    (event) => JSON.stringify(event.actor) === JSON.stringify(actor)
  );
};

describe("model rules", () => {
  it("keep every call of an EU-only deployment with a model hosted in the EU, still through AI Gateway, and audit each refusal", async () => {
    const { fake, call } = withRules({
      eu: { models: [euModel], deployment: true },
    });
    const refused = hello(anthropic, { provenance: ["doc-1"] });
    const answered = hello(euModel);

    await expect(call(refused)).rejects.toMatchObject({
      code: "model.eu_only",
      message:
        "This call must stay in the EU, and that model isn't hosted in the EU. Choose one that is.",
      details: { model: anthropic, because: "deployment" },
    });
    await expect(
      Promise.all([outcome(call(hello(workersAi))), outcome(call(answered))])
    ).resolves.toStrictEqual(["model.eu_only", "ok"]);

    // Only the EU model's call was sent, to the deployment's gateway.
    expect(fake.requests.map(({ url }) => new URL(url).pathname)).toStrictEqual(
      [`/ai-gateway/gateways/${gateway}/openai/responses`]
    );
    await expect(eventsOf(refused.trigger)).resolves.toMatchObject([
      {
        action: "model.refused",
        provenance: ["doc-1"],
        detail: {
          purpose: "chat.turn",
          reason: "model.eu_only",
          because: "deployment",
          model: anthropic,
        },
      },
    ]);
    await expect(eventsOf(answered.trigger)).resolves.toMatchObject([
      { action: "model.call", detail: { euOnly: "deployment" } },
    ]);
  });

  it("keep a listed workflow's AI steps in the EU, and no other caller's", async () => {
    const eu = {
      models: [euModel],
      workflows: [{ app: "app-1", workflow: "invoices" }],
    };
    const { call } = withRules({ eu });
    const step = async (
      model: string,
      trigger: ModelCall<undefined>["trigger"]
    ) =>
      await outcome(call(hello(model, { purpose: "workflow.step", trigger })));

    await expect(
      Promise.all([
        step(anthropic, runOf("app-1", "invoices")),
        step(euModel, runOf("app-1", "invoices")),
        // The same workflow name in another App, and another workflow.
        step(anthropic, runOf("app-2", "invoices")),
        step(anthropic, runOf("app-1", "orders")),
      ])
    ).resolves.toStrictEqual(["model.eu_only", "ok", "ok", "ok"]);
  });

  it("keep a call in the EU when an EU-only connection's data fed it or may have", async () => {
    const { call } = withRules({
      eu: { models: [euModel], connections: ["connection-eu"] },
    });

    await expect(
      Promise.all([
        outcome(call(hello(anthropic, { provenance: ["connection-eu"] }))),
        outcome(call(hello(anthropic, { connections: ["connection-eu"] }))),
        outcome(call(hello(euModel, { connections: ["connection-eu"] }))),
        outcome(
          call(
            hello(anthropic, {
              provenance: ["doc-1"],
              connections: ["connection-other"],
            })
          )
        ),
      ])
    ).resolves.toStrictEqual(["model.eu_only", "model.eu_only", "ok", "ok"]);
  });

  it("audit a model the deployment doesn't allow as refused", async () => {
    const { call } = withRules({});
    const refused = hello("anthropic/claude-opus-4-1");

    await expect(outcome(call(refused))).resolves.toBe("model.not_allowed");
    await expect(eventsOf(refused.trigger)).resolves.toMatchObject([
      {
        action: "model.refused",
        detail: {
          reason: "model.not_allowed",
          because: null,
          model: "anthropic/claude-opus-4-1",
        },
      },
    ]);
  });

  it("leave only the allowlist while model_rules is switched off: the kill switch", async () => {
    const { call } = withRules(
      { eu: { models: [euModel], deployment: true } },
      {
        ...z.record(z.string(), z.boolean()).parse(env.FEATURES),
        model_rules: false,
      }
    );
    const answered = hello(anthropic);

    await expect(outcome(call(answered))).resolves.toBe("ok");
    await expect(outcome(call(hello("openai/gpt-4o-mini")))).resolves.toBe(
      "model.not_allowed"
    );
    await expect(eventsOf(answered.trigger)).resolves.toMatchObject([
      { action: "model.call", detail: { euOnly: null } },
    ]);
  });

  it("refuse every call when an EU model isn't an allowed one: the config is invalid", async () => {
    const { fake, call } = withRules({
      models: [workersAi],
      eu: { models: [euModel], deployment: true },
    });

    await expect(outcome(call(hello(workersAi)))).resolves.toBe(
      "model.unconfigured"
    );
    expect(fake.requests).toStrictEqual([]);
  });

  it("fail a run's AI step with the reason when its App has an EU-only connection, once: it isn't retried", async () => {
    const builder = await signedInApi(idp, "builder");
    const mail = await mailConnection();
    const app = await appWith(
      builder,
      workflowFiles(
        "reader",
        `  return await step.llm("extract", {
    description: "Read the total",
    model: "${workersAi}",
    instructions: "Read the total in cents.",
    input: "Total 12.34 EUR",
    schema: z.object({ total: z.int() }),
  });`,
        { extract: { total: 1234 } }
      )
    );
    await grantMail(idp, builder, app, mail.id);
    const { MODEL_GATEWAY: config } = env;
    const fake = fakeGateway();
    const ai: AiBinding = env.AI;
    const sending = vi
      .spyOn(ai, "fetch")
      .mockImplementation(fake.binding.fetch);
    let run: { id: string };
    try {
      env.MODEL_GATEWAY = {
        gateway,
        models: [workersAi, euModel],
        eu: { models: [euModel], connections: [mail.id] },
      };
      run = await builder.api.workflows.start(app, "reader");
      await finished(run.id);
    } finally {
      env.MODEL_GATEWAY = config;
      sending.mockRestore();
    }

    await expect(builder.api.workflows.status(run.id)).resolves.toMatchObject({
      status: "failed",
      error: {
        message:
          "This call must stay in the EU, and that model isn't hosted in the EU. Choose one that is.",
      },
    });
    expect(fake.requests).toStrictEqual([]);
    const events = await eventsOf(
      runActorOf({ runId: run.id, app, workflow: "reader" })
    );
    expect(
      events.filter(({ action }) => action === "model.refused")
    ).toMatchObject([
      { detail: { reason: "model.eu_only", because: "connection" } },
    ]);
  });
});
