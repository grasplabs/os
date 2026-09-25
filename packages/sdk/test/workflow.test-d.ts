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
import {
  extractionSchema,
  invoiceWorkflow,
} from "./workflows/invoice-approval.ts";

const params = {
  threshold: money({ label: "Above", default: 5000 }),
  reviewer: person({ label: "Reviewer", default: "finance-team" }),
  extractionModel: model({ label: "Model", default: "mistral-large" }),
  reminder: template({ label: "Reminder", default: "invoice-reminder" }),
};
declare const step: StepRunner;
declare const context: WorkflowContext<typeof params, undefined>;
const { params: p } = context;
const llm = {
  description: "Extract",
  model: p.extractionModel,
  instructions: "Read the total.",
  input: "",
  schema: extractionSchema,
};

// Parameters are typed by their kind.
expectTypeOf(p.threshold).toExtend<number>();
expectTypeOf(p.reviewer).toEqualTypeOf<Person>();
expectTypeOf(p.extractionModel).toEqualTypeOf<Model>();
expectTypeOf(context.runId).toEqualTypeOf<RunId>();
expectTypeOf<string>().not.toExtend<Person>();

// A parameter of the wrong kind doesn't compile.
// @ts-expect-error -- a person isn't a model
await step.llm("extract", { ...llm, model: p.reviewer });
// @ts-expect-error -- models come from a model parameter, not a literal
await step.llm("extract", { ...llm, model: "mistral-large" });
await step.decision("review", {
  description: "Review",
  // @ts-expect-error -- a template isn't a person
  from: p.reminder,
  ask: async () => {},
});
// @ts-expect-error -- a money parameter holds a number
money({ label: "Above", default: "5000" });

// step.llm needs instructions and a schema, can't be locked, and its answer
// is typed by the schema.
const { instructions: _instructions, ...withoutInstructions } = llm;
// @ts-expect-error -- the instructions are required
await step.llm("extract", withoutInstructions);
const { schema: _schema, ...withoutSchema } = llm;
// @ts-expect-error -- the schema is required
await step.llm("extract", withoutSchema);
// @ts-expect-error -- a model is involved, so an AI step is never locked
await step.llm("extract", { ...llm, locked: true });
expectTypeOf(await step.llm("extract", llm)).toEqualTypeOf<{
  total: number;
  currency: string;
}>();

// Every step needs a description.
// @ts-expect-error -- the description is required
await step.do("match", {}, async () => 1);
// @ts-expect-error -- the description is required
await step.sleep("pause", { duration: "1 day" });
// @ts-expect-error -- durations need a unit
await step.sleep("pause", { description: "Pause", duration: "1 fortnight" });

// Only side-effect steps get an idempotency key.
expectTypeOf(
  await step.do(
    "book",
    { description: "Book", sideEffect: true, input: null },
    async ({ idempotencyKey }) => idempotencyKey
  )
).toEqualTypeOf<string>();
await step.do(
  "book",
  // @ts-expect-error -- a side-effect step says what it writes
  { description: "Book", sideEffect: true },
  async () => 1
);
await step.do(
  "match",
  { description: "Match" },
  // @ts-expect-error -- a step without side effects gets no key
  async (sideEffect: SideEffectContext) => sideEffect.idempotencyKey
);

// A step gets back the input it's given, as typed, and input is JSON.
await step.do(
  "notify",
  { description: "Notify", sideEffect: true, input: { to: "anna", count: 2 } },
  async ({ input }) => {
    expectTypeOf(input).toEqualTypeOf<{ to: string; count: number }>();
  }
);
await step.do("match", { description: "Match" }, async ({ input }) => {
  expectTypeOf(input).toBeUndefined();
});
await step.do(
  "match",
  // @ts-expect-error -- input is JSON
  { description: "Match", input: { at: new Date(0) } },
  async () => 1
);

// An event's payload is typed by its schema, and unknown without one.
expectTypeOf(
  await step.waitFor("signed", {
    description: "Wait for the signature",
    type: "document.signed",
    timeout: "1 day",
    schema: z.object({ signer: z.string() }),
  })
).toEqualTypeOf<WaitResult<{ signer: string }>>();
expectTypeOf(
  await step.waitFor("signed", {
    description: "Wait for the signature",
    type: "document.signed",
    timeout: "1 day",
  })
).toEqualTypeOf<WaitResult<unknown>>();

// Schedule triggers refer to schedule parameters.
workflow(
  "schedule-trigger",
  {
    params: {
      ...params,
      every: schedule({ label: "Runs", default: "0 9 * * *" }),
    },
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
