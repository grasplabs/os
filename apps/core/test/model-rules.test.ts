import type { AiBinding } from "@earendil-works/pi-ai/api/cloudflare-ai-binding";
import { runActorOf } from "@grasp-os/shared/audit";
import type { AuditEvent } from "@grasp-os/shared/audit";
import { appIdSchema, runIdSchema } from "@grasp-os/shared/ids";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { models } from "../src/models.ts";
import type { ModelCall, ModelsEnv } from "../src/models.ts";
import { fakeGateway } from "./ai-gateway.ts";
import type { GatewayReply } from "./ai-gateway.ts";
import { requestGranted } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { collectionWithNote, newTeam, readCollection } from "./knowledge.ts";
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

/** An answer that costs next to nothing. */
const cheapAnswer = { text: "Hi.", inputTokens: 10, outputTokens: 5 };

/**
 * An answer that costs $0.0045 from Claude Sonnet 4.5, at its list prices:
 * $3 per million tokens in, $15 out.
 */
const pricedAnswer = { text: "Hi.", inputTokens: 1000, outputTokens: 100 };

let monthsUsed = 0;

/**
 * A month no other test counts budgets in, so none depends on the real
 * month or another test's spend.
 */
const newMonth = (): string => {
  monthsUsed += 1;
  const year = 2100 + Math.floor(monthsUsed / 12);
  return `${year}-${String((monthsUsed % 12) + 1).padStart(2, "0")}`;
};

/**
 * Core's env with the fake gateway answering up to eight calls with
 * `answer`, the rules `config` adds, and `features`; budgets count in
 * `month`.
 */
const withRules = (
  config: Record<string, unknown>,
  features: unknown = env.FEATURES,
  answer: GatewayReply = cheapAnswer,
  month = newMonth()
) => {
  const fake = fakeGateway(...Array.from({ length: 8 }, () => answer));
  const rulesEnv: ModelsEnv = {
    ...env,
    AI: fake.binding,
    FEATURES: features,
    MODEL_GATEWAY: { gateway, models: allowed, ...config },
    MODEL_BUDGET_MONTH: month,
  };
  return { fake, call: models(rulesEnv).call };
};

/** A person no other test uses, so their audit events are this test's. */
const newPerson = () =>
  ({ type: "person", userId: `person-${crypto.randomUUID()}` }) as const;

/**
 * Where the calls here work unless a test says otherwise: an App of its
 * own, never restricted, made before the first test (once the IdP mock
 * is up) and kept for the rest.
 */
let appWork: ModelCall<undefined>["work"] | undefined;

const requireWork = (): ModelCall<undefined>["work"] => {
  if (appWork === undefined) {
    throw new Error("The tests' App isn't made yet");
  }
  return appWork;
};

const hello = (
  model: string,
  more: Partial<ModelCall<undefined>> = {}
): ModelCall<undefined> => ({
  model,
  input: "Hello.",
  purpose: "chat.turn",
  trigger: newPerson(),
  work: requireWork(),
  ...more,
});

/**
 * What `run` returns, with `config` as the deployment's gateway config for
 * the workflow runs it starts, and the fake gateway answering with
 * `replies`.
 */
const withDeploymentRules = async <Result>(
  config: unknown,
  replies: GatewayReply[],
  run: () => Promise<Result>
) => {
  const { MODEL_GATEWAY: before, MODEL_BUDGET_MONTH: month } = env;
  const fake = fakeGateway(...replies);
  const ai: AiBinding = env.AI;
  const sending = vi.spyOn(ai, "fetch").mockImplementation(fake.binding.fetch);
  try {
    env.MODEL_GATEWAY = config;
    env.MODEL_BUDGET_MONTH = newMonth();
    return { fake, result: await run() };
  } finally {
    env.MODEL_GATEWAY = before;
    env.MODEL_BUDGET_MONTH = month;
    sending.mockRestore();
  }
};

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
  beforeEach(async () => {
    if (appWork !== undefined) {
      return;
    }
    const builder = await signedInApi(idp, "builder");
    const { id } = await builder.api.apps.create({ name: "Model rules" });
    const appId = appIdSchema.parse(id);
    appWork = {
      authority: {
        subject: { type: "app", appId },
        onBehalfOf: builder.userId,
        mode: "interactive",
      },
      context: { type: "app", appId },
    };
  });

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
          provenanceDropped: 0,
        },
      },
    ]);
  });

  it("record a refusal whose provenance is too large for the audit log, with as much of it as fits", async () => {
    const { call } = withRules({});
    // A hundred identifiers of 256 three-byte characters: 77 KB.
    const provenance = Array.from({ length: 100 }, (_, index) =>
      `${index}`.padEnd(256, "€")
    );
    const refused = hello("anthropic/claude-opus-4-1", { provenance });

    await expect(outcome(call(refused))).resolves.toBe("model.not_allowed");
    const [event, ...more] = await eventsOf(refused.trigger);
    const kept = event?.provenance.length ?? 0;
    expect({
      more: more.length,
      kept: kept > 0 && kept < 100,
      provenance: event?.provenance,
      dropped: event?.detail.provenanceDropped,
    }).toStrictEqual({
      more: 0,
      kept: true,
      provenance: provenance.slice(0, kept),
      dropped: 100 - kept,
    });
  });

  it.each([
    ["eu", { eu: { models: "all of them" } }],
    ["sensitive", { sensitive: { models: [euModel], connections: 7 } }],
    ["budgets", { budgets: { user: { limit: -5 } } }],
  ])(
    "read the rules only while model_rules is on: a malformed %s rule refuses every call then, and none while it's off",
    async (_, malformed) => {
      const off = withRules(malformed, {
        ...z.record(z.string(), z.boolean()).parse(env.FEATURES),
        model_rules: false,
      });
      const on = withRules(malformed);

      await expect(
        Promise.all([
          outcome(off.call(hello(anthropic))),
          outcome(off.call(hello("openai/gpt-4o-mini"))),
          outcome(on.call(hello(anthropic))),
        ])
      ).resolves.toStrictEqual([
        "ok",
        "model.not_allowed",
        "model.unconfigured",
      ]);
      expect(on.fake.requests).toStrictEqual([]);
    }
  );

  it("leave only the allowlist while model_rules is switched off: the kill switch", async () => {
    const { call } = withRules(
      {
        eu: { models: [euModel], deployment: true },
        sensitive: { models: [euModel], connections: ["connection-hr"] },
        // Used up by the third call, were it checked.
        budgets: { user: { limit: 0.01 } },
      },
      {
        ...z.record(z.string(), z.boolean()).parse(env.FEATURES),
        model_rules: false,
      },
      pricedAnswer
    );
    const answered = hello(anthropic, { connections: ["connection-hr"] });
    const outcomes: string[] = [];
    for (let count = 0; count < 4; count += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one after another, as a person would
      outcomes.push(await outcome(call(answered)));
    }

    expect(outcomes).toStrictEqual(["ok", "ok", "ok", "ok"]);
    await expect(outcome(call(hello("openai/gpt-4o-mini")))).resolves.toBe(
      "model.not_allowed"
    );
    await expect(eventsOf(answered.trigger)).resolves.toMatchObject(
      Array.from({ length: 4 }, () => ({
        action: "model.call",
        detail: { euOnly: null, sensitive: null },
      }))
    );
  });

  it.each([
    ["an EU model", { eu: { models: [euModel], deployment: true } }],
    ["a model for sensitive data", { sensitive: { models: [euModel] } }],
  ])(
    "refuse every call when %s isn't an allowed one: the config is invalid",
    async (_, rules) => {
      const { fake, call } = withRules({ models: [workersAi], ...rules });

      await expect(outcome(call(hello(workersAi)))).resolves.toBe(
        "model.unconfigured"
      );
      expect(fake.requests).toStrictEqual([]);
    }
  );

  it("send a prompt holding a sensitive collection's content only to a model the data rule lists, such as an EU one", async () => {
    const admin = await signedInApi(idp, "admin");
    const teamId = await newTeam(admin, []);
    const [payroll, handbook] = await Promise.all([
      collectionWithNote(admin.api, {
        name: "Payroll",
        access: "teams",
        teams: [teamId],
        sensitive: true,
      }),
      collectionWithNote(admin.api, { name: "Handbook", access: "everyone" }),
    ]);
    const { fake, call } = withRules({ sensitive: { models: [euModel] } });
    const refused = hello(anthropic, {
      provenance: [handbook.noteId, payroll.collectionId],
    });
    const answered = hello(euModel, { provenance: [payroll.noteId] });

    await expect(
      Promise.all([
        outcome(call(refused)),
        // Named by one of its documents.
        outcome(call(hello(anthropic, { provenance: [payroll.noteId] }))),
        outcome(call(answered)),
        // Nothing sensitive: any allowed model.
        outcome(call(hello(anthropic, { provenance: [handbook.noteId] }))),
      ])
    ).resolves.toStrictEqual([
      "model.sensitive_data",
      "model.sensitive_data",
      "ok",
      "ok",
    ]);
    expect(fake.requests).toHaveLength(2);
    await expect(eventsOf(refused.trigger)).resolves.toMatchObject([
      {
        action: "model.refused",
        detail: { reason: "model.sensitive_data", because: "collection" },
      },
    ]);
    await expect(eventsOf(answered.trigger)).resolves.toMatchObject([
      { action: "model.call", detail: { sensitive: "collection" } },
    ]);
  });

  it("send a sensitive connection's data only to a model the data rule lists", async () => {
    const { call } = withRules({
      sensitive: { models: [euModel], connections: ["connection-hr"] },
    });

    await expect(
      Promise.all([
        outcome(call(hello(anthropic, { connections: ["connection-hr"] }))),
        outcome(call(hello(anthropic, { provenance: ["connection-hr"] }))),
        outcome(call(hello(euModel, { connections: ["connection-hr"] }))),
        outcome(call(hello(anthropic, { connections: ["connection-crm"] }))),
      ])
    ).resolves.toStrictEqual([
      "model.sensitive_data",
      "model.sensitive_data",
      "ok",
      "ok",
    ]);
  });

  it.each([
    ["no data rule", {}, []],
    [
      "a data rule its connection alone would refuse it by",
      { sensitive: { models: [euModel], connections: ["connection-hr"] } },
      ["connection-hr"],
    ],
    [
      "a data rule its model is listed in",
      { sensitive: { models: [anthropic] } },
      [],
    ],
  ])(
    "refuse and audit a call that claims to work in another App's context, with %s",
    async (_, rules, connections) => {
      const { fake, call } = withRules(rules);
      const app = appIdSchema.parse(`app-${crypto.randomUUID()}`);
      const other = appIdSchema.parse(`app-${crypto.randomUUID()}`);
      const claimed = hello(anthropic, {
        connections,
        work: {
          authority: {
            subject: { type: "app", appId: app },
            onBehalfOf: "person-1",
            mode: "workflow",
          },
          context: { type: "app", appId: other },
        },
      });

      await expect(outcome(call(claimed))).resolves.toBe(
        "permission.context_invalid"
      );
      expect(fake.requests).toStrictEqual([]);
      await expect(eventsOf(claimed.trigger)).resolves.toMatchObject([
        {
          action: "model.refused",
          detail: { reason: "permission.context_invalid", because: null },
        },
      ]);
    }
  );

  it("refuse and audit a call that comes without a work context while the rules apply, and not while they're off", async () => {
    const { fake, call } = withRules({});
    const off = withRules(
      {},
      {
        ...z.record(z.string(), z.boolean()).parse(env.FEATURES),
        model_rules: false,
      }
    );
    const { work: _, ...withoutWork } = hello(anthropic);
    // SAFETY: missing on purpose, as from a caller that isn't type-checked;
    // every typed caller must pass `work`.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    const contextless = withoutWork as ModelCall<undefined>;

    await expect(
      Promise.all([outcome(call(contextless)), outcome(off.call(contextless))])
    ).resolves.toStrictEqual(["permission.context_invalid", "ok"]);
    expect(fake.requests).toStrictEqual([]);
    await expect(eventsOf(contextless.trigger)).resolves.toMatchObject([
      {
        action: "model.refused",
        detail: { reason: "permission.context_invalid", because: null },
      },
      { action: "model.call" },
    ]);
  });

  it("alert admins when a person's spend crosses the alert threshold and the limit, then stop their calls, and no one else's", async () => {
    const { call } = withRules(
      { budgets: { user: { limit: 0.01, alertAt: 40 } } },
      env.FEATURES,
      pricedAnswer
    );
    const trigger = newPerson();
    const ada = hello(anthropic, { trigger });
    const outcomes: string[] = [];
    for (let count = 0; count < 4; count += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one after another, as a person would
      outcomes.push(await outcome(call(ada)));
    }

    // $0.0045 a call: past 40% with the first, past the limit with the third.
    expect(outcomes).toStrictEqual(["ok", "ok", "ok", "model.over_budget"]);
    await expect(call(ada)).rejects.toMatchObject({
      message:
        "This month's model budget is used up, so no more model calls can be made for this. An admin can raise the budget.",
      details: { because: "user" },
    });
    await expect(outcome(call(hello(anthropic)))).resolves.toBe("ok");
    const events = await eventsOf(trigger);
    const { userId } = trigger;
    expect({
      alerts: events.filter(({ action }) => action.startsWith("model.budget.")),
      refused: events.filter(({ action }) => action === "model.refused"),
    }).toMatchObject({
      alerts: [
        {
          action: "model.budget.alert",
          detail: {
            scope: "user",
            user: userId,
            limit: 0.01,
            threshold: 0.004,
          },
        },
        {
          action: "model.budget.exhausted",
          detail: { scope: "user", user: userId, limit: 0.01, threshold: 0.01 },
        },
      ],
      refused: [
        { detail: { reason: "model.over_budget", because: "user" } },
        { detail: { reason: "model.over_budget", because: "user" } },
      ],
    });
  });

  it("count every one of many concurrent calls, and alert once per threshold", async () => {
    // Exactly four calls' worth: any call's cost lost would leave room.
    const { call } = withRules(
      { budgets: { user: { limit: 0.018, alertAt: 50 } } },
      env.FEATURES,
      pricedAnswer
    );
    const ada = hello(anthropic);

    await expect(
      Promise.all(
        Array.from({ length: 4 }, async () => await outcome(call(ada)))
      )
    ).resolves.toStrictEqual(["ok", "ok", "ok", "ok"]);
    await expect(outcome(call(ada))).resolves.toBe("model.over_budget");
    const events = await eventsOf(ada.trigger);
    expect(
      events
        .map(({ action }) => action)
        .filter((action) => action.startsWith("model.budget."))
        .toSorted()
    ).toStrictEqual(["model.budget.alert", "model.budget.exhausted"]);
  });

  it("count the calls an agent or a run makes for a person against that person's budget", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await appWith(builder, workflowFiles("idle", "  return null;"));
    const run = await builder.api.workflows.start(app, "idle");
    await finished(run.id);
    const appId = appIdSchema.parse(app);
    const { call } = withRules(
      { budgets: { user: { limit: 0.01 } } },
      env.FEATURES,
      pricedAnswer
    );
    const ada = { type: "person", userId: builder.userId } as const;
    const forAda = [
      hello(anthropic, {
        trigger: { type: "agent", agentId: "chat", onBehalfOf: ada.userId },
      }),
      hello(anthropic, {
        purpose: "workflow.step",
        trigger: runActorOf({ runId: run.id, app, workflow: "idle" }),
        work: {
          authority: {
            subject: { type: "app", appId },
            onBehalfOf: ada.userId,
            mode: "workflow",
          },
          context: { type: "run", appId, runId: runIdSchema.parse(run.id) },
        },
      }),
      hello(anthropic, { trigger: ada }),
    ];
    const outcomes: string[] = [];
    for (const made of [...forAda, hello(anthropic, { trigger: ada })]) {
      // oxlint-disable-next-line no-await-in-loop -- one after another
      outcomes.push(await outcome(call(made)));
    }

    expect(outcomes).toStrictEqual(["ok", "ok", "ok", "model.over_budget"]);
  });

  it("alert admins once for every limit lowered below what was spent, and count each month on its own", async () => {
    const month = newMonth();
    const spend = withRules(
      { budgets: { user: { limit: 0.02 }, deployment: { limit: 0.02 } } },
      env.FEATURES,
      pricedAnswer,
      month
    );
    const lowered = withRules(
      { budgets: { user: { limit: 0.01 }, deployment: { limit: 0.01 } } },
      env.FEATURES,
      pricedAnswer,
      month
    );
    const nextMonth = withRules(
      { budgets: { user: { limit: 0.01 } } },
      env.FEATURES,
      pricedAnswer
    );
    const ada = hello(anthropic);
    const outcomes: string[] = [];
    // $0.0135: under the first limit, over the lowered one.
    for (const call of [spend.call, spend.call, spend.call]) {
      // oxlint-disable-next-line no-await-in-loop -- one after another
      outcomes.push(await outcome(call(ada)));
    }
    for (const call of [lowered.call, lowered.call, nextMonth.call]) {
      // oxlint-disable-next-line no-await-in-loop -- one after another
      outcomes.push(await outcome(call(ada)));
    }

    expect(outcomes).toStrictEqual([
      "ok",
      "ok",
      "ok",
      "model.over_budget",
      "model.over_budget",
      "ok",
    ]);
    const events = await eventsOf(ada.trigger);
    // Both used up, both alerted, once each: not only the one that refused.
    expect(
      events
        .filter(({ action }) => action === "model.budget.exhausted")
        .map(({ detail }) => detail)
        .toSorted((one, other) =>
          String(one.scope).localeCompare(String(other.scope))
        )
    ).toMatchObject([
      { scope: "deployment", period: month, limit: 0.01, threshold: 0.01 },
      { scope: "user", period: month, limit: 0.01, threshold: 0.01 },
    ]);
  });

  it("alert admins once when the alert threshold is lowered below what was spent", async () => {
    const month = newMonth();
    const early = withRules(
      { budgets: { user: { limit: 0.02, alertAt: 90 } } },
      env.FEATURES,
      pricedAnswer,
      month
    );
    const lowered = withRules(
      { budgets: { user: { limit: 0.02, alertAt: 40 } } },
      env.FEATURES,
      pricedAnswer,
      month
    );
    const ada = hello(anthropic);
    const outcomes: string[] = [];
    // $0.009 spent, under 90% of $0.02; then 40% is $0.008, already passed.
    for (const call of [early.call, early.call, lowered.call, lowered.call]) {
      // oxlint-disable-next-line no-await-in-loop -- one after another
      outcomes.push(await outcome(call(ada)));
    }

    expect(outcomes).toStrictEqual(["ok", "ok", "ok", "ok"]);
    const events = await eventsOf(ada.trigger);
    expect(
      events.filter(({ action }) => action === "model.budget.alert")
    ).toMatchObject([
      {
        detail: { scope: "user", period: month, limit: 0.02, threshold: 0.008 },
      },
    ]);
  });

  it("check the budgets again before a retry: an attempt that used one up stops the call before anything more is sent", async () => {
    const { fake, call } = withRules(
      { budgets: { user: { limit: 0.01 } } },
      env.FEATURES,
      // An answer that doesn't fit, and costs $0.0105: past the limit.
      { text: "No JSON here.", inputTokens: 1000, outputTokens: 500 }
    );
    const ada = hello(anthropic);

    await expect(
      outcome(call({ ...ada, schema: z.object({ total: z.number() }) }))
    ).resolves.toBe("model.over_budget");
    expect(fake.requests).toHaveLength(1);
    const events = await eventsOf(ada.trigger);
    expect(events.map(({ action }) => action)).toStrictEqual([
      "model.call",
      "model.budget.alert",
      "model.budget.exhausted",
      "model.refused",
    ]);
  });

  it("keep a paid answer when its cost can't be counted", async () => {
    const fake = fakeGateway(pricedAnswer);
    const database: D1Database = env.DB;
    const refusingEnv: ModelsEnv = {
      ...env,
      AI: fake.binding,
      MODEL_GATEWAY: {
        gateway,
        models: allowed,
        budgets: { user: { limit: 0.01 } },
      },
      MODEL_BUDGET_MONTH: newMonth(),
      // Reads and single writes work; the batch that counts the cost fails.
      DB: new Proxy(database, {
        get: (target, name): unknown => {
          if (name === "batch") {
            return () => {
              throw new Error("Unavailable");
            };
          }
          const value: unknown = Reflect.get(target, name);
          return value;
        },
      }),
    };

    await expect(
      models(refusingEnv).call(hello(anthropic))
    ).resolves.toMatchObject({ text: "Hi." });
  });

  it("count a workflow's calls apart from other workflows', and the deployment's across every caller", async () => {
    const app = `app-${crypto.randomUUID()}`;
    const { call } = withRules(
      { budgets: { workflow: { limit: 0.01 } } },
      env.FEATURES,
      pricedAnswer
    );
    const step = async (workflow: string) =>
      await outcome(
        call(
          hello(anthropic, {
            purpose: "workflow.step",
            trigger: runOf(app, workflow),
          })
        )
      );
    const { call: anyone } = withRules(
      { budgets: { deployment: { limit: 0.01 } } },
      env.FEATURES,
      pricedAnswer
    );
    const outcomes: string[] = [];
    for (let count = 0; count < 4; count += 1) {
      // A new run each time: the workflow's budget counts all of its runs.
      // oxlint-disable-next-line no-await-in-loop -- one after another
      outcomes.push(await step("invoices"));
    }
    for (let count = 0; count < 4; count += 1) {
      // A new person each time: the deployment's budget counts them all.
      // oxlint-disable-next-line no-await-in-loop -- one after another
      outcomes.push(await outcome(anyone(hello(anthropic))));
    }

    expect({ outcomes, orders: await step("orders") }).toStrictEqual({
      outcomes: [
        "ok",
        "ok",
        "ok",
        "model.over_budget",
        "ok",
        "ok",
        "ok",
        "model.over_budget",
      ],
      orders: "ok",
    });
  });

  it("stop a workflow's AI steps with a readable error once its budget is used up, and alert admins", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await appWith(
      builder,
      workflowFiles(
        "reader",
        `  return await step.llm("extract", {
    description: "Read the total",
    model: "${anthropic}",
    instructions: "Read the total in cents.",
    input: "Total 12.34 EUR",
    schema: z.object({ total: z.int() }),
  });`,
        { extract: { total: 1234 } }
      )
    );

    // One answer of a million tokens in costs $3: well past the budget.
    const { result: runs } = await withDeploymentRules(
      {
        gateway,
        models: [workersAi, anthropic],
        budgets: { workflow: { limit: 1 } },
      },
      [{ text: '{ "total": 1234 }', inputTokens: 1_000_000, outputTokens: 10 }],
      async () => {
        const paid = await builder.api.workflows.start(app, "reader");
        await finished(paid.id);
        const stopped = await builder.api.workflows.start(app, "reader");
        await finished(stopped.id);
        return { paid: paid.id, stopped: stopped.id };
      }
    );

    await expect(
      Promise.all([
        builder.api.workflows.status(runs.paid),
        builder.api.workflows.status(runs.stopped),
      ])
    ).resolves.toMatchObject([
      { status: "completed", output: { total: 1234 } },
      {
        status: "failed",
        error: {
          message:
            "This month's model budget is used up, so no more model calls can be made for this. An admin can raise the budget.",
        },
      },
    ]);
    const alerts = await eventsOf(
      runActorOf({ runId: runs.paid, app, workflow: "reader" })
    );
    expect(
      alerts.filter(({ action }) => action.startsWith("model.budget."))
    ).toMatchObject([
      {
        action: "model.budget.alert",
        detail: { scope: "workflow", app, workflow: "reader", limit: 1 },
      },
      {
        action: "model.budget.exhausted",
        detail: { scope: "workflow", app, workflow: "reader", limit: 1 },
      },
    ]);
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

    const { fake, result: run } = await withDeploymentRules(
      {
        gateway,
        models: [workersAi, euModel],
        eu: { models: [euModel], connections: [mail.id] },
      },
      [],
      async () => {
        const started = await builder.api.workflows.start(app, "reader");
        await finished(started.id);
        return started;
      }
    );

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

  it("fail the AI steps of an App that read a sensitive collection, unless their model is one the data rule lists", async () => {
    const admin = await signedInApi(idp, "admin");
    const teamId = await newTeam(admin, []);
    const payroll = await collectionWithNote(admin.api, {
      name: "Payroll",
      access: "teams",
      teams: [teamId],
      sensitive: true,
    });
    // Reads the note, then asks a model about it: the prompt holds it.
    const summarizer = (id: string, model: string) =>
      workflowFiles(
        id,
        `  const note = await step.do("read", { description: "Read the note" }, async () => await env.HANDBOOK.getDocument("${payroll.noteId}"));
  return await step.llm("summarize", {
    description: "Summarize the note",
    model: "${model}",
    instructions: "Summarize the note.",
    input: note.version.text,
    schema: z.object({ summary: z.string() }),
  });`,
        {
          read: { version: { text: "Note" } },
          summarize: { summary: "A note." },
        }
      );
    const app = await appWith(admin, {
      ...summarizer("anywhere", workersAi),
      ...summarizer("eu", euModel),
    });
    await requestGranted(
      idp,
      admin,
      readCollection(
        { type: "app", appId: appIdSchema.parse(app) },
        payroll.collectionId
      )
    );

    const { fake, result: runs } = await withDeploymentRules(
      {
        gateway,
        models: [workersAi, euModel],
        sensitive: { models: [euModel] },
      },
      [{ text: '{ "summary": "A note." }', inputTokens: 10, outputTokens: 5 }],
      async () => {
        // One after another: the second starts restricted.
        const refused = await admin.api.workflows.start(app, "anywhere");
        await finished(refused.id);
        const answered = await admin.api.workflows.start(app, "eu");
        await finished(answered.id);
        return { refused: refused.id, answered: answered.id };
      }
    );

    await expect(
      Promise.all([
        admin.api.workflows.status(runs.refused),
        admin.api.workflows.status(runs.answered),
      ])
    ).resolves.toMatchObject([
      {
        status: "failed",
        error: {
          message:
            "This call carries sensitive data, and that model may not take it. Choose one this deployment allows for sensitive data.",
        },
      },
      { status: "completed", output: { summary: "A note." } },
    ]);
    // Only the EU model's call was sent, and it held the note.
    expect(fake.requests.map(({ url }) => new URL(url).pathname)).toStrictEqual(
      [`/ai-gateway/gateways/${gateway}/openai/responses`]
    );
    expect(JSON.stringify(fake.requests[0]?.body)).toContain("See [[note.md]]");
    // No provenance named the collection: the App's restricted mode did.
    const refusals = await eventsOf(
      runActorOf({ runId: runs.refused, app, workflow: "anywhere" })
    );
    expect(
      refusals.filter(({ action }) => action === "model.refused")
    ).toMatchObject([
      { detail: { reason: "model.sensitive_data", because: "restricted" } },
    ]);
  });
});
