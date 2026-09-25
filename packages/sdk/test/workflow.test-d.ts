// Compile-time guarantees of the workflow SDK. This file is type-checked by
// `vp check` and never run: every `@ts-expect-error` below must stay an error.
/* oxlint-disable require-await -- stand-in callbacks for interfaces that take async functions */
import type { RunId } from "@grasp-os/shared/ids";
import { expectTypeOf } from "vite-plus/test";

import {
  model,
  money,
  person,
  schedule,
  template,
  workflow,
  z,
} from "../src/workflow.ts";
import type {
  Model,
  Person,
  SideEffectContext,
  StepRunner,
  WaitResult,
  WorkflowContext,
} from "../src/workflow.ts";
import { extractionSchema, invoiceWorkflow } from "./invoice-workflow.ts";

const params = {
  threshold: money({ label: "Above", default: 5000 }),
  reviewer: person({ label: "Reviewer", default: "finance-team" }),
  extractionModel: model({ label: "Model", default: "mistral-large" }),
  reminder: template({ label: "Reminder", default: "invoice-reminder" }),
};
const steps = {
  match: { kind: "exact", description: "Match" },
  book: { kind: "exact", description: "Book", sideEffect: true },
  extract: { kind: "ai", description: "Extract" },
  review: { kind: "decision", description: "Review" },
  pause: { kind: "wait", description: "Pause" },
} as const;
declare const step: StepRunner<typeof steps>;
declare const context: WorkflowContext<typeof params, undefined>;
const { params: p } = context;

// Parameters are typed by their kind.
expectTypeOf(p.threshold).toExtend<number>();
expectTypeOf(p.reviewer).toEqualTypeOf<Person>();
expectTypeOf(p.extractionModel).toEqualTypeOf<Model>();
expectTypeOf(context.runId).toEqualTypeOf<RunId>();
expectTypeOf<string>().not.toExtend<Person>();

// A parameter of the wrong kind doesn't compile.
await step.llm("extract", {
  // @ts-expect-error -- a person isn't a model
  model: p.reviewer,
  input: "",
  schema: extractionSchema,
});
await step.llm("extract", {
  // @ts-expect-error -- models come from a model parameter, not a literal
  model: "mistral-large",
  input: "",
  schema: extractionSchema,
});
await step.decision("review", {
  // @ts-expect-error -- a template isn't a person
  from: p.reminder,
  ask: async () => {},
});
// @ts-expect-error -- a money parameter holds a number
money({ label: "Above", default: "5000" });

// step.llm needs a schema, and its answer is typed by it.
// @ts-expect-error -- the schema is required
await step.llm("extract", { input: "" });
expectTypeOf(
  await step.llm("extract", { input: "", schema: extractionSchema })
).toEqualTypeOf<{ total: number; currency: string }>();

// Code runs only declared steps, each with the method for its kind.
// @ts-expect-error -- not declared
await step.do("missing", async () => 1);
// @ts-expect-error -- an AI step runs through step.llm
await step.do("extract", async () => 1);
// @ts-expect-error -- a decision isn't a wait
await step.sleep("review", "1 day");
// @ts-expect-error -- durations need a unit
await step.sleep("pause", "1 fortnight");

// Only side-effect steps get an idempotency key.
expectTypeOf(
  await step.do("book", async ({ idempotencyKey }) => idempotencyKey)
).toEqualTypeOf<string>();
await step.do(
  "match",
  // @ts-expect-error -- a step without side effects gets no key
  async (sideEffect: SideEffectContext) => sideEffect.idempotencyKey
);

// An event's payload is typed by its schema, and unknown without one.
expectTypeOf(
  await step.waitFor("pause", {
    type: "document.signed",
    timeout: "1 day",
    schema: z.object({ signer: z.string() }),
  })
).toEqualTypeOf<WaitResult<{ signer: string }>>();
expectTypeOf(
  await step.waitFor("pause", { type: "document.signed", timeout: "1 day" })
).toEqualTypeOf<WaitResult<unknown>>();

// Declarations are checked against the parameters.
workflow(
  "typo",
  {
    params,
    steps: {
      // @ts-expect-error -- "treshold" isn't a parameter
      review: { kind: "decision", description: "Review", uses: ["treshold"] },
    },
  },
  async () => null
);
workflow(
  "no-side-effect",
  {
    params,
    steps: {
      // @ts-expect-error -- only exact steps have side effects of their own
      extract: { kind: "ai", description: "Extract", sideEffect: true },
    },
  },
  async () => null
);
workflow(
  "schedule-trigger",
  {
    params: {
      ...params,
      every: schedule({ label: "Runs", default: "0 9 * * *" }),
    },
    steps: {},
    // @ts-expect-error -- a schedule trigger needs a schedule parameter
    triggers: [{ type: "schedule", param: "threshold" }],
  },
  async () => null
);

// A run resolves to what the workflow returns.
expectTypeOf(
  invoiceWorkflow({
    findPurchaseOrder: async () => null,
    book: async () => "",
    askReviewer: async () => {},
  }).run
).returns.resolves.toExtend<{
  status: "unmatched" | "rejected" | "timedOut" | "booked";
}>();
