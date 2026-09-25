/* oxlint-disable require-await -- fakes of async interfaces answer right away */
import { describe, expect, it } from "vite-plus/test";

import {
  number,
  person,
  schedule,
  text,
  workflow,
  z,
} from "../src/workflow.ts";
import type { Duration } from "../src/workflow.ts";
import { createFakeEngine } from "./fake-engine.ts";

const noParams = {};

describe("workflow definitions", () => {
  it("rejects an empty ID, a bad step name, bad retries and a bad default", () => {
    const exact = { kind: "exact", description: "Do it" } as const;
    const definitions = [
      () => workflow("", { params: noParams, steps: {} }, async () => null),
      () =>
        workflow(
          "bad-name",
          { params: noParams, steps: { "has:colon": exact } },
          async () => null
        ),
      () =>
        workflow(
          "bad-retries",
          { params: noParams, steps: { go: { ...exact, retries: -1 } } },
          async () => null
        ),
      () =>
        workflow(
          "bad-default",
          {
            params: { limit: number({ label: "Limit", default: Number.NaN }) },
            steps: {},
          },
          async () => null
        ),
    ];

    for (const define of definitions) {
      expect(define).toThrow(
        expect.objectContaining({ code: "workflow.invalid_definition" })
      );
    }
  });

  it("is started by hand unless it declares triggers", () => {
    const manual = workflow(
      "manual",
      { params: noParams, steps: {} },
      async () => null
    );
    const scheduled = workflow(
      "scheduled",
      {
        params: { every: schedule({ label: "Runs", default: "0 9 * * 1" }) },
        steps: {},
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
      {
        params: { greeting: text({ label: "Greeting", default: "Hi" }) },
        steps: {},
      },
      async () => null
    );

    expect(metadata.params[0]?.sensitive).toBeFalsy();
  });
});

describe("step.do", () => {
  it("gives only side-effect steps an idempotency key", async () => {
    const received: unknown[] = [];
    const definition = workflow(
      "keys",
      {
        params: noParams,
        steps: {
          read: { kind: "exact", description: "Read" },
          write: { kind: "exact", description: "Write", sideEffect: true },
        },
      },
      async (step) => {
        await step.do("read", async (...args: unknown[]) => {
          received.push(args);
        });
        await step.do("write", async (...args: unknown[]) => {
          received.push(args);
        });
      }
    );

    await definition.run(createFakeEngine().engine);

    expect(received).toStrictEqual([[], [{ idempotencyKey: "run-1:write" }]]);
  });

  it("retries a failing step as often as declared", async () => {
    let attempts = 0;
    const definition = workflow(
      "flaky",
      {
        params: noParams,
        steps: { call: { kind: "exact", description: "Call", retries: 2 } },
      },
      async (step) =>
        await step.do("call", async () => {
          attempts += 1;
          if (attempts < 3) {
            throw new Error("Flaky");
          }
          return attempts;
        })
    );

    await expect(definition.run(createFakeEngine().engine)).resolves.toBe(3);
  });

  it("refuses to run a step twice in one run", async () => {
    const definition = workflow(
      "twice",
      {
        params: noParams,
        steps: { once: { kind: "exact", description: "Once" } },
      },
      async (step) => {
        await step.do("once", async () => 1);
        await step.do("once", async () => 2);
      }
    );

    await expect(
      definition.run(createFakeEngine().engine)
    ).rejects.toMatchObject({ code: "workflow.invalid_step_call" });
  });

  it("refuses a step declared with another kind, and an undeclared one", async () => {
    const definition = workflow(
      "wrong-kind",
      {
        params: noParams,
        steps: { nap: { kind: "wait", description: "Nap" } },
        input: z.string(),
      },
      async (step, { input }) =>
        // @ts-expect-error -- only exact steps run as plain code
        await step.do(input, async () => 1)
    );
    const run = definition.run.bind(null, createFakeEngine().engine);

    await expect(run("nap")).rejects.toMatchObject({
      code: "workflow.invalid_step_call",
    });
    await expect(run("missing")).rejects.toMatchObject({
      code: "workflow.invalid_step_call",
    });
  });
});

const extraction = z.object({ total: z.number() });

const llmWorkflow = workflow(
  "llm",
  {
    params: noParams,
    steps: { read: { kind: "ai", description: "Read", retries: 1 } },
  },
  async (step) =>
    await step.llm("read", { input: "Total: 12", schema: extraction })
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
      input: "Total: 12",
      outputSchema: { type: "object", required: ["total"] },
    });
    expect(modelRequests[0]).not.toHaveProperty("model");
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
      {
        params: noParams,
        steps: { read: { kind: "ai", description: "Read the due date" } },
      },
      async (step) =>
        await step.llm("read", {
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
});

const waitingWorkflow = workflow(
  "waiting",
  {
    params: noParams,
    steps: {
      pause: { kind: "wait", description: "Pause" },
      signed: { kind: "wait", description: "Wait for the signature" },
    },
  },
  async (step) => {
    await step.sleep("pause", "90 minutes");
    return await step.waitFor("signed", {
      type: "document.signed",
      timeout: "2 weeks",
      schema: z.object({ signer: z.string() }),
    });
  }
);

describe("step.sleep and step.waitFor", () => {
  it("hand the engine the wait in milliseconds", async () => {
    const { engine, sleeps, waits } = createFakeEngine();

    await waitingWorkflow.run(engine);

    expect(sleeps).toStrictEqual([{ name: "pause", milliseconds: 5_400_000 }]);
    expect(waits).toStrictEqual([
      { name: "signed", type: "document.signed", timeout: 1_209_600_000 },
    ]);
  });

  it("return the event's checked payload, or that none came", async () => {
    const signed = createFakeEngine({
      event: () => ({ received: true, payload: { signer: "anna" } }),
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
      event: () => ({ received: true, payload: { signer: 7 } }),
    });

    await expect(waitingWorkflow.run(engine)).rejects.toMatchObject({
      code: "workflow.invalid_event",
    });
  });

  it("reject a duration that isn't one", async () => {
    const definition = workflow(
      "bad-duration",
      {
        params: noParams,
        steps: { pause: { kind: "wait", description: "Pause" } },
        input: z.unknown(),
      },
      async (step, { input }) => {
        // @ts-expect-error -- durations are milliseconds or "<n> <unit>"
        await step.sleep("pause", input);
      }
    );
    const run = definition.run.bind(null, createFakeEngine().engine);

    for (const duration of ["soon", "-1 days", 0, Number.POSITIVE_INFINITY]) {
      // oxlint-disable-next-line no-await-in-loop -- each run is one case
      await expect(run(duration)).rejects.toMatchObject({
        code: "workflow.invalid_step_call",
      });
    }
  });
});

const decisionWorkflow = (limits: {
  timeout?: Duration;
  remindAfter?: Duration;
}) =>
  workflow(
    "decide",
    {
      params: { approver: person({ label: "Approver", default: "anna" }) },
      steps: { approve: { kind: "decision", description: "Approve" } },
    },
    async (step, { params }) =>
      await step.decision("approve", {
        from: params.approver,
        ask: async () => {},
        ...limits,
      })
  );

describe("step.decision", () => {
  it("waits as long as the engine allows without a timeout", async () => {
    const { engine, waits } = createFakeEngine();

    await expect(decisionWorkflow({}).run(engine)).resolves.toStrictEqual({
      outcome: "timedOut",
    });
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
      event: () => ({
        received: true,
        payload: { approved: true, by: "anna", comment: "Fine" },
      }),
    });

    await expect(decisionWorkflow({}).run(engine)).resolves.toStrictEqual({
      outcome: "approved",
      by: "anna",
      comment: "Fine",
    });
  });

  it("fails the run on an answer without who gave it", async () => {
    const { engine } = createFakeEngine({
      event: () => ({ received: true, payload: { approved: true } }),
    });

    await expect(decisionWorkflow({}).run(engine)).rejects.toMatchObject({
      code: "workflow.invalid_event",
    });
  });
});

describe("state", () => {
  const counter = workflow(
    "counter",
    { params: noParams, steps: {} },
    async (_step, { state }) => {
      const seen = await state.get("count");
      const count = typeof seen === "number" ? seen + 1 : 1;
      await state.set("count", count);
      return count;
    }
  );

  it("keeps values between runs of the workflow", async () => {
    const first = createFakeEngine();
    const second = createFakeEngine({ state: first.state });

    await expect(counter.run(first.engine)).resolves.toBe(1);
    await expect(counter.run(second.engine)).resolves.toBe(2);
  });

  it("replays what a run read, even when another run changed it since", async () => {
    const first = createFakeEngine();
    const other = createFakeEngine({ state: first.state });

    await counter.run(first.engine);
    await counter.run(other.engine);

    await expect(counter.run(first.engine)).resolves.toBe(1);
  });

  it("rejects a key that isn't a name", async () => {
    const definition = workflow(
      "bad-key",
      { params: noParams, steps: {} },
      async (_step, { state }) => await state.get("a:b")
    );

    await expect(
      definition.run(createFakeEngine().engine)
    ).rejects.toMatchObject({ code: "workflow.invalid_step_call" });
  });
});
