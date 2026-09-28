import { runActorOf } from "@grasp-os/shared/audit";
import { appIdSchema, runIdSchema } from "@grasp-os/shared/ids";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { models } from "../src/models.ts";
import type { ModelCall, ModelsEnv } from "../src/models.ts";
import { fakeGateway } from "./ai-gateway.ts";
import { mockIdp } from "./idp.ts";
import { finished } from "./runs.ts";
import { openRpc, outcome, signedInApi, signedInWithRole } from "./sign-in.ts";
import { appWith, workflowFiles } from "./workflow-apps.ts";

// Admins read the model gateway's settings: the allowlist, the client's
// rules, and this month's spend against each budget, which real model
// calls add to. AI Gateway is the outside system: a fake behind the AI
// binding.

const idp = mockIdp();

const workersAi = "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const anthropic = "anthropic/claude-sonnet-4-5";
const euModel = "openai/gpt-5.4";
const allowed = [workersAi, anthropic, euModel];

/**
 * An answer that costs $0.0045 from Claude Sonnet 4.5, at its list prices:
 * $3 per million tokens in, $15 out.
 */
const pricedAnswer = { text: "Hi.", inputTokens: 1000, outputTokens: 100 };

let monthsUsed = 0;

/** A month no other test counts spend in: from 2200, clear of other files. */
const newMonth = (): string => {
  monthsUsed += 1;
  return `${2200 + Math.floor(monthsUsed / 12)}-${String((monthsUsed % 12) + 1).padStart(2, "0")}`;
};

/** Core's env with `config` as the gateway's, counting in its own month. */
const envWith = (config?: unknown, features: unknown = env.FEATURES) => {
  const coreEnv: ModelsEnv & Env = {
    ...env,
    FEATURES: features,
    MODEL_GATEWAY: config,
    MODEL_BUDGET_MONTH: newMonth(),
  };
  return coreEnv;
};

/** The settings as an admin reads them from `coreEnv`. */
const settingsIn = async (
  coreEnv: Env,
  role: "admin" | "builder" = "admin"
) => {
  const { session } = await signedInWithRole(idp, role);
  const { core } = await openRpc(session, { coreEnv });
  return await core.authenticate().models.settings();
};

/** The test env's flags, as the object they are. */
const flagsOf = (features: unknown): Record<string, boolean> =>
  typeof features === "object" && features !== null
    ? Object.fromEntries(
        Object.entries(features).filter(
          (entry): entry is [string, boolean] => typeof entry[1] === "boolean"
        )
      )
    : {};

describe("model settings", { timeout: 60_000 }, () => {
  it("show admins the allowlist, the rules, and this month's spend against each budget, most first, with names", async () => {
    const coreEnv = envWith({
      gateway: "grasp-os-test",
      models: allowed,
      eu: {
        models: [euModel],
        connections: ["conn-eu"],
      },
      sensitive: { models: [euModel], connections: ["conn-hr"] },
      budgets: {
        deployment: { limit: 100 },
        workflow: { limit: 5, alertAt: 50 },
        user: { limit: 1 },
      },
    });
    const builder = await signedInApi(idp, "builder");
    const other = await signedInApi(idp, "builder");
    const [builderName, otherName] = await Promise.all([
      builder.api.whoami(),
      other.api.whoami(),
    ]);
    const app = await appWith(builder, workflowFiles("idle", "  return null;"));
    const run = await builder.api.workflows.start(app, "idle");
    await finished(run.id);
    const appId = appIdSchema.parse(app);
    const fake = fakeGateway(...Array.from({ length: 4 }, () => pricedAnswer));
    const { call } = models({ ...coreEnv, AI: fake.binding });
    const work = (userId: string): ModelCall<undefined>["work"] => ({
      authority: {
        subject: { type: "app", appId },
        onBehalfOf: userId,
        mode: "interactive",
      },
      context: { type: "app", appId },
    });
    const hello = (more: Partial<ModelCall<undefined>>) => ({
      model: anthropic,
      input: "Hello.",
      purpose: "chat.turn",
      trigger: { type: "person", userId: builder.userId } as const,
      work: work(builder.userId),
      ...more,
    });
    // The builder twice, the other builder once, and one workflow step the
    // builder's run makes for them.
    for (const made of [
      hello({}),
      hello({}),
      hello({
        trigger: { type: "person", userId: other.userId },
        work: work(other.userId),
      }),
      hello({
        purpose: "workflow.step",
        trigger: runActorOf({ runId: run.id, app, workflow: "idle" }),
        work: {
          authority: {
            subject: { type: "app", appId },
            onBehalfOf: builder.userId,
            mode: "workflow",
          },
          context: { type: "run", appId, runId: runIdSchema.parse(run.id) },
        },
      }),
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one after another
      await expect(outcome(call(made))).resolves.toBe("ok");
    }

    const settings = await settingsIn(coreEnv);
    expect(settings).toStrictEqual({
      models: allowed,
      rules: {
        state: "on",
        eu: {
          models: [euModel],
          deployment: false,
          workflows: [],
          connections: ["conn-eu"],
        },
        sensitive: { models: [euModel], connections: ["conn-hr"] },
        budgets: [
          {
            scope: "deployment",
            limit: 100,
            alertAt: 80,
            spent: [{ of: { type: "deployment" }, amount: 0.018 }],
          },
          {
            scope: "workflow",
            limit: 5,
            alertAt: 50,
            spent: [
              {
                of: {
                  type: "workflow",
                  appId: app,
                  appName: "Invoices",
                  workflowId: "idle",
                },
                amount: 0.0045,
              },
            ],
          },
          {
            scope: "user",
            limit: 1,
            alertAt: 80,
            spent: [
              {
                of: {
                  type: "user",
                  userId: builder.userId,
                  name: builderName.name,
                },
                amount: 0.0135,
              },
              {
                of: {
                  type: "user",
                  userId: other.userId,
                  name: otherName.name,
                },
                amount: 0.0045,
              },
            ],
          },
        ],
      },
      month: coreEnv.MODEL_BUDGET_MONTH,
    });
  });

  it("say when the rules are off, don't parse, or models aren't set up, and read to admins only", async () => {
    const config = {
      gateway: "grasp-os-test",
      models: [workersAi],
      budgets: { user: { limit: 1 } },
    };
    const rulesOff = { ...flagsOf(env.FEATURES), model_rules: false };
    await expect(settingsIn(envWith(config, rulesOff))).resolves.toMatchObject({
      models: [workersAi],
      rules: { state: "off" },
    });
    await expect(
      settingsIn(envWith({ ...config, budgets: { user: { limit: -1 } } }))
    ).resolves.toMatchObject({
      models: [workersAi],
      rules: { state: "invalid" },
    });
    await expect(settingsIn(envWith())).resolves.toMatchObject({
      models: [],
    });
    await expect(outcome(settingsIn(envWith(config), "builder"))).resolves.toBe(
      "role.forbidden"
    );
  });
});
