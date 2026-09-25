/* oxlint-disable require-await -- fakes of async interfaces answer right away */
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { createTestEngine, createTestState } from "../src/testing.ts";
import type { TestEngineOptions } from "../src/testing.ts";
import {
  model,
  number,
  person,
  schedule,
  text,
  workflow,
  z,
} from "../src/workflow.ts";
import type { DoOptions, Duration, StepRunner } from "../src/workflow.ts";

// These tests run the steps that change something, against fakes.
const createFakeEngine = (options: TestEngineOptions = {}) =>
  createTestEngine({ sideEffects: "run", ...options });

const noParams = {};

/** A workflow that runs `body` with the input it's given. */
const withStep = <Output>(
  body: (step: StepRunner, input: unknown) => Promise<Output>
) =>
  workflow(
    "sample",
    { params: noParams, input: z.unknown() },
    async (step, { input }) => await body(step, input)
  );

describe("workflow definitions", () => {
  it("rejects an empty ID and a default that doesn't fit its kind", () => {
    expect(() => workflow("", { params: noParams }, async () => null)).toThrow(
      expect.objectContaining({ code: "workflow.invalid_definition" })
    );
    expect(() =>
      workflow(
        "bad-default",
        { params: { limit: number({ label: "Limit", default: Number.NaN }) } },
        async () => null
      )
    ).toThrow(expect.objectContaining({ code: "workflow.invalid_definition" }));
  });

  it("is started by hand unless it declares triggers", () => {
    const manual = workflow("manual", { params: noParams }, async () => null);
    const scheduled = workflow(
      "scheduled",
      {
        params: { every: schedule({ label: "Runs", default: "0 9 * * 1" }) },
        triggers: [{ type: "schedule", param: "every" }],
      },
      async () => null
    );

    expect(manual.metadata.triggers).toStrictEqual([{ type: "manual" }]);
    expect(scheduled.metadata.triggers).toStrictEqual([
      { type: "schedule", param: "every" },
    ]);
  });

  it("treats parameters as not sensitive unless declared so", () => {
    const { metadata } = workflow(
      "greeting",
      { params: { greeting: text({ label: "Greeting", default: "Hi" }) } },
      async () => null
    );

    expect(metadata.params[0]?.sensitive).toBeFalsy();
  });
});

describe("step calls", () => {
  it("reject a bad name, a missing description, a bad key or bad retries", async () => {
    const calls: [string, DoOptions & { sideEffect?: false }][] = [
      ["has:colon", { description: "Go" }],
      ["go", { description: " " }],
      ["go", { description: "Go", key: "" }],
      ["go", { description: "Go", key: "x".repeat(200) }],
      ["go", { description: "Go", key: "\uD800" }],
      ["go", { description: "Go", retries: -1 }],
    ];

    for (const [name, options] of calls) {
      const definition = withStep(
        async (step) => await step.do(name, options, async () => 1)
      );
      // oxlint-disable-next-line no-await-in-loop -- each run is one case
      await expect(
        definition.run(createFakeEngine().engine)
      ).rejects.toMatchObject({ code: "workflow.invalid_step_call" });
    }
  });

  it("reject options of the wrong type before anything runs", async () => {
    const ran: string[] = [];
    const withoutAsk = { description: "Approve", from: "anna" };
    const calls: ((step: StepRunner) => Promise<unknown>)[] = [
      async (step) =>
        await step.do(
          "go",
          // @ts-expect-error -- sideEffect is true or false
          { description: "Go", sideEffect: "yes" },
          async () => ran.push("go")
        ),
      async (step) =>
        // @ts-expect-error -- a decision needs someone to ask, and how
        await step.decision("approve", withoutAsk),
      async (step) =>
        await step.waitFor("signed", {
          description: "Wait",
          type: "document.signed",
          timeout: "1 day",
          // @ts-expect-error -- the schema is a Zod schema
          schema: "signer",
        }),
    ];

    for (const call of calls) {
      // oxlint-disable-next-line no-await-in-loop -- each run is one case
      await expect(
        withStep(call).run(createFakeEngine().engine)
      ).rejects.toMatchObject({ code: "workflow.invalid_step_call" });
    }
    expect(ran).toStrictEqual([]);
  });

  it("run a step name once per run, or once per key", async () => {
    const once = { description: "Once" };
    const twice = withStep(async (step) => {
      await step.do("once", once, async () => 1);
      await step.do("once", once, async () => 2);
    });
    const perItem = withStep(async (step) => {
      for (const key of ["a", "b"]) {
        // oxlint-disable-next-line no-await-in-loop -- steps run in order
        await step.do("item", { ...once, key }, async () => key);
      }
      await step.do("item", { ...once, key: "a" }, async () => "again");
    });

    await expect(twice.run(createFakeEngine().engine)).rejects.toThrow(
      "give each run of it its own key"
    );
    await expect(perItem.run(createFakeEngine().engine)).rejects.toThrow(
      'already ran with key "a"'
    );
  });
});

describe("step.do", () => {
  it("gives each step its input, and only side-effect steps an idempotency key", async () => {
    const received: unknown[] = [];
    const definition = withStep(async (step) => {
      await step.do(
        "read",
        { description: "Read", input: { id: 7 } },
        async (context) => {
          received.push(context);
        }
      );
      await step.do(
        "write",
        { description: "Write", sideEffect: true, key: 7, input: null },
        async (context) => {
          received.push(context);
        }
      );
    });

    await definition.run(createFakeEngine().engine);

    expect(received).toStrictEqual([
      { input: { id: 7 } },
      { idempotencyKey: "run-1:write:7", input: null },
    ]);
  });

  it("rejects a side effect without input, or input that isn't JSON, before it runs", async () => {
    const ran: string[] = [];
    const definitions = [
      withStep(
        async (step) =>
          await step.do(
            "write",
            // @ts-expect-error -- input is JSON
            { description: "Write", sideEffect: true, input: new Date(0) },
            async () => ran.push("write")
          )
      ),
      withStep(
        async (step) =>
          await step.do(
            "write",
            // @ts-expect-error -- a side-effect step says what it writes
            { description: "Write", sideEffect: true },
            async () => ran.push("write")
          )
      ),
    ];

    for (const definition of definitions) {
      // oxlint-disable-next-line no-await-in-loop -- each run is one case
      await expect(
        definition.run(createFakeEngine().engine)
      ).rejects.toMatchObject({ code: "workflow.invalid_step_call" });
    }
    expect(ran).toStrictEqual([]);
  });

  it("retries a failing step as often as asked", async () => {
    let attempts = 0;
    const definition = withStep(
      async (step) =>
        await step.do("call", { description: "Call", retries: 2 }, async () => {
          attempts += 1;
          if (attempts < 3) {
            throw new Error("Flaky");
          }
          return attempts;
        })
    );

    await expect(definition.run(createFakeEngine().engine)).resolves.toBe(3);
  });

  it("fails a step whose result isn't JSON, which an engine can't store", async () => {
    const definition = withStep(
      async (step) =>
        await step.do("when", { description: "When" }, async () => new Date(0))
    );

    await expect(definition.run(createFakeEngine().engine)).rejects.toThrow(
      "isn't JSON"
    );
  });

  it("replays a step's stored result, whatever the run did to it since", async () => {
    const definition = withStep(async (step) => {
      const list = await step.do("list", { description: "List" }, async () => ({
        items: ["a"],
      }));
      list.items.push("added by the run");
      return list.items;
    });
    const { engine } = createFakeEngine();

    await definition.run(engine);

    await expect(definition.run(engine)).resolves.toStrictEqual([
      "a",
      "added by the run",
    ]);
  });
});

const extraction = z.object({ total: z.number() });
const modelParams = {
  reader: model({ label: "Model", default: "small-model" }),
};

const llmWorkflow = workflow(
  "llm",
  { params: modelParams },
  async (step, { params }) =>
    await step.llm("read", {
      description: "Read the total",
      model: params.reader,
      instructions: "Read the total.",
      input: "Total: 12",
      schema: extraction,
      retries: 1,
    })
);

describe("step.llm", () => {
  it("sends the schema to the model gateway and returns the typed answer", async () => {
    const { engine, modelRequests } = createFakeEngine({
      model: () => ({ total: 12 }),
    });

    await expect(llmWorkflow.run(engine)).resolves.toStrictEqual({
      total: 12,
    });
    expect(modelRequests[0]).toMatchObject({
      step: "read",
      model: "small-model",
      instructions: "Read the total.",
      input: "Total: 12",
      outputSchema: { type: "object", required: ["total"] },
    });
  });

  it("retries an answer that doesn't fit the schema", async () => {
    const answers = [{ total: "twelve" }, { total: 12 }];
    const { engine } = createFakeEngine({ model: () => answers.shift() });

    await expect(llmWorkflow.run(engine)).resolves.toStrictEqual({
      total: 12,
    });
  });

  it("fails the run when no answer fits the schema", async () => {
    const { engine, modelRequests } = createFakeEngine({
      model: () => ({ total: "twelve" }),
    });

    await expect(llmWorkflow.run(engine)).rejects.toMatchObject({
      code: "workflow.invalid_model_output",
    });
    expect(modelRequests).toHaveLength(2);
  });

  it("replays the recorded answer instead of asking the model again", async () => {
    const { engine, modelRequests } = createFakeEngine({
      model: () => ({ total: 12 }),
    });

    await llmWorkflow.run(engine);
    await expect(llmWorkflow.run(engine)).resolves.toStrictEqual({
      total: 12,
    });
    expect(modelRequests).toHaveLength(1);
  });

  it("asks for what the schema accepts and returns what it makes of it", async () => {
    const dueDate = workflow(
      "due-date",
      { params: modelParams },
      async (step, { params }) =>
        await step.llm("read", {
          description: "Read the due date",
          model: params.reader,
          instructions: "Read the due date.",
          input: "Due on 1 March 2026",
          schema: z.object({
            due: z.iso.date().transform((day) => new Date(day)),
          }),
        })
    );
    const { engine, modelRequests } = createFakeEngine({
      model: () => ({ due: "2026-03-01" }),
    });

    const first = await dueDate.run(engine);
    const replayed = await dueDate.run(engine);

    expect(modelRequests[0]?.outputSchema).toMatchObject({
      properties: { due: { type: "string", format: "date" } },
    });
    expect(first.due).toStrictEqual(new Date("2026-03-01"));
    expect(replayed.due).toStrictEqual(new Date("2026-03-01"));
  });

  it("refuses a call without instructions, a schema or a model before asking", async () => {
    const { engine, modelRequests } = createFakeEngine({
      model: () => ({ total: 12 }),
    });
    const options = {
      description: "Read",
      model: "small-model",
      instructions: "Read the total.",
      input: "",
      schema: extraction,
    };
    const broken = [
      { ...options, instructions: "" },
      { ...options, schema: undefined },
      { ...options, model: 42 },
      { ...options, input: new Date(0) },
    ];

    for (const [index, brokenOptions] of broken.entries()) {
      const definition = withStep(
        async (step) =>
          // @ts-expect-error -- each case breaks one required option
          await step.llm(`read-${index}`, brokenOptions)
      );
      // oxlint-disable-next-line no-await-in-loop -- each run is one case
      await expect(definition.run(engine)).rejects.toMatchObject({
        code: "workflow.invalid_step_call",
      });
    }
    expect(modelRequests).toStrictEqual([]);
  });
});

const waitingWorkflow = withStep(async (step) => {
  await step.sleep("pause", { description: "Pause", duration: "90 minutes" });
  return await step.waitFor("signed", {
    description: "Wait for the signature",
    type: "document.signed",
    timeout: "2 weeks",
    schema: z.object({ signer: z.string() }),
  });
});

describe("step.sleep and step.waitFor", () => {
  it("hand the engine the wait in milliseconds", async () => {
    const { engine, steps } = createFakeEngine();

    await waitingWorkflow.run(engine);

    expect(steps).toStrictEqual([
      { type: "sleep", name: "pause", milliseconds: 5_400_000 },
      {
        type: "wait",
        name: "signed",
        eventType: "document.signed",
        timeout: 1_209_600_000,
        event: { received: false },
      },
    ]);
  });

  it("return the event's checked payload, or that none came", async () => {
    const signed = createFakeEngine({
      events: [{ type: "document.signed", payload: { signer: "anna" } }],
    });
    const silent = createFakeEngine();

    await expect(waitingWorkflow.run(signed.engine)).resolves.toStrictEqual({
      received: true,
      payload: { signer: "anna" },
    });
    await expect(waitingWorkflow.run(silent.engine)).resolves.toStrictEqual({
      received: false,
    });
  });

  it("fail the run on an event that doesn't match the schema", async () => {
    const { engine } = createFakeEngine({
      events: [{ type: "document.signed", payload: { signer: 7 } }],
    });

    await expect(waitingWorkflow.run(engine)).rejects.toMatchObject({
      code: "workflow.invalid_event",
    });
  });

  it("reject a duration that isn't one", async () => {
    const definition = withStep(async (step, duration) => {
      // @ts-expect-error -- durations are milliseconds or "<n> <unit>"
      await step.sleep("pause", { description: "Pause", duration });
    });
    const run = definition.run.bind(null, createFakeEngine().engine);

    for (const duration of ["soon", "-1 days", 0, Number.POSITIVE_INFINITY]) {
      // oxlint-disable-next-line no-await-in-loop -- each run is one case
      await expect(run(duration)).rejects.toMatchObject({
        code: "workflow.invalid_step_call",
      });
    }
  });
});

const decisionWorkflow = (
  limits: { timeout?: Duration; remindAfter?: Duration },
  ask: () => Promise<void> = async () => {}
) =>
  workflow(
    "decide",
    { params: { approver: person({ label: "Approver", default: "anna" }) } },
    async (step, { params }) =>
      await step.decision("approve", {
        description: "Approve",
        from: params.approver,
        ask,
        ...limits,
      })
  );

describe("step.decision", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("times out without reminding when asking outlasts the timeout", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const asked: boolean[] = [];
    const slowAsk = async () => {
      asked.push(true);
      vi.setSystemTime(Date.now() + 2 * 86_400_000);
    };
    const { engine, steps } = createFakeEngine();

    await expect(
      decisionWorkflow(
        { timeout: "1 day", remindAfter: "12 hours" },
        slowAsk
      ).run(engine)
    ).resolves.toStrictEqual({ outcome: "timedOut" });
    expect(asked).toHaveLength(1);
    expect(steps.filter(({ type }) => type === "wait")).toStrictEqual([]);
  });

  it("waits as long as the engine allows without a timeout", async () => {
    const { engine, steps } = createFakeEngine();

    await expect(decisionWorkflow({}).run(engine)).resolves.toStrictEqual({
      outcome: "timedOut",
    });
    const waits = steps.filter(({ type }) => type === "wait");
    expect(waits).toHaveLength(1);
    expect(waits[0]).not.toHaveProperty("timeout");
  });

  it("refuses a reminder that comes after the timeout", async () => {
    const { engine } = createFakeEngine();

    await expect(
      decisionWorkflow({ timeout: "1 day", remindAfter: "2 days" }).run(engine)
    ).rejects.toMatchObject({ code: "workflow.invalid_step_call" });
  });

  it("passes on the comment with the answer", async () => {
    const { engine } = createFakeEngine({
      decisions: { approve: { approved: true, by: "anna", comment: "Fine" } },
    });

    await expect(decisionWorkflow({}).run(engine)).resolves.toStrictEqual({
      outcome: "approved",
      by: "anna",
      comment: "Fine",
    });
  });

  it("fails the run on an answer without who gave it", async () => {
    const { engine } = createFakeEngine({
      events: [{ type: "decision:approve", payload: { approved: true } }],
    });

    await expect(decisionWorkflow({}).run(engine)).rejects.toMatchObject({
      code: "workflow.invalid_event",
    });
  });
});

describe("state", () => {
  const counter = workflow(
    "counter",
    { params: noParams },
    async (_step, { state }) => {
      const seen = await state.get("count");
      const count = typeof seen === "number" ? seen + 1 : 1;
      await state.set("count", count);
      return count;
    }
  );

  it("keeps values between runs of the workflow", async () => {
    const state = createTestState();
    const first = createFakeEngine({ runId: "run-1", state });
    const second = createFakeEngine({ runId: "run-2", state });

    await expect(counter.run(first.engine)).resolves.toBe(1);
    await expect(counter.run(second.engine)).resolves.toBe(2);
  });

  it("replays what a run read, even when another run changed it since", async () => {
    const state = createTestState();
    const first = createFakeEngine({ runId: "run-1", state });
    const other = createFakeEngine({ runId: "run-2", state });

    await counter.run(first.engine);
    await counter.run(other.engine);

    await expect(counter.run(first.engine)).resolves.toBe(1);
  });

  it("doesn't write again when a run resumes after a crash mid-write", async () => {
    const state = createTestState();
    const { engine } = createFakeEngine({ runId: "run-1", state });
    let crashed = false;
    // The first write lands, then the engine dies before it records the
    // step, as a crash between the two would.
    const crashing = {
      ...engine,
      setState: async (...write: Parameters<typeof engine.setState>) => {
        await engine.setState(...write);
        if (!crashed) {
          crashed = true;
          throw new Error("Engine died before recording the step");
        }
      },
    };
    const other = createFakeEngine({ runId: "run-2", state });

    await expect(counter.run(crashing)).rejects.toThrow("Engine died");
    await counter.run(other.engine);
    await counter.run(crashing);

    expect(state.values.get("count")).toBe(2);
  });

  it("rejects a key that isn't a name, and a value that isn't JSON", async () => {
    const keyWorkflow = workflow(
      "bad-key",
      { params: noParams },
      async (_step, { state }) => await state.get("a:b")
    );
    const valueWorkflow = workflow(
      "bad-value",
      { params: noParams },
      async (_step, { state }) => {
        // @ts-expect-error -- state holds JSON only
        await state.set("when", new Date(0));
      }
    );

    await expect(
      keyWorkflow.run(createFakeEngine().engine)
    ).rejects.toMatchObject({ code: "workflow.invalid_step_call" });
    await expect(
      valueWorkflow.run(createFakeEngine().engine)
    ).rejects.toMatchObject({ code: "workflow.invalid_step_call" });
  });
});
