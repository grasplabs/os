import type { AiBinding } from "@earendil-works/pi-ai/api/cloudflare-ai-binding";
import { runActorOf } from "@grasp-os/shared/audit";
import type { AuditEvent } from "@grasp-os/shared/audit";
import { appIdSchema } from "@grasp-os/shared/ids";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
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
  const { MODEL_GATEWAY: before } = env;
  const fake = fakeGateway(...replies);
  const ai: AiBinding = env.AI;
  const sending = vi.spyOn(ai, "fetch").mockImplementation(fake.binding.fetch);
  try {
    env.MODEL_GATEWAY = config;
    return { fake, result: await run() };
  } finally {
    env.MODEL_GATEWAY = before;
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

  it("read the rules only while model_rules is on: a malformed rule refuses every call then, and none while it's off", async () => {
    const malformed = { eu: { models: "all of them" } };
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
    ).resolves.toStrictEqual(["ok", "model.not_allowed", "model.unconfigured"]);
    expect(on.fake.requests).toStrictEqual([]);
  });

  it("leave only the allowlist while model_rules is switched off: the kill switch", async () => {
    const { call } = withRules(
      {
        eu: { models: [euModel], deployment: true },
        sensitive: { models: [euModel], connections: ["connection-hr"] },
      },
      {
        ...z.record(z.string(), z.boolean()).parse(env.FEATURES),
        model_rules: false,
      }
    );
    const answered = hello(anthropic, { connections: ["connection-hr"] });

    await expect(outcome(call(answered))).resolves.toBe("ok");
    await expect(outcome(call(hello("openai/gpt-4o-mini")))).resolves.toBe(
      "model.not_allowed"
    );
    await expect(eventsOf(answered.trigger)).resolves.toMatchObject([
      { action: "model.call", detail: { euOnly: null, sensitive: null } },
    ]);
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

  it("refuse a call that claims to work in another App's context", async () => {
    const { fake, call } = withRules({ sensitive: { models: [euModel] } });
    const app = appIdSchema.parse(`app-${crypto.randomUUID()}`);
    const other = appIdSchema.parse(`app-${crypto.randomUUID()}`);

    await expect(
      outcome(
        call(
          hello(anthropic, {
            work: {
              authority: {
                subject: { type: "app", appId: app },
                onBehalfOf: "person-1",
                mode: "workflow",
              },
              context: { type: "app", appId: other },
            },
          })
        )
      )
    ).resolves.toBe("permission.context_invalid");
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
