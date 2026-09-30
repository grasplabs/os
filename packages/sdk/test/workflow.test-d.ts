// Compile-time guarantees of the workflow SDK. This file is type-checked by
// `vp check` and never run: every `@ts-expect-error` below must stay an error.
/* oxlint-disable require-await -- stand-in callbacks for interfaces that take async functions */
import type { RunId } from "@grasp-os/shared/ids";
import { expectTypeOf } from "vite-plus/test";

import type { stepOptionSchemas } from "../src/steps.ts";
import {
  appExports,
  appServer,
  model,
  money,
  person,
  schedule,
  template,
  workflow,
} from "../src/workflow.ts";
import type {
  AppExportsStub,
  AppServer,
  DecisionOptions,
  DoOptions,
  LlmOptions,
  Model,
  Person,
  SideEffectContext,
  SleepOptions,
  StepRunner,
  WorkflowContext,
  z,
} from "../src/workflow.ts";
import {
  extractionSchema,
  invoiceWorkflow,
} from "./workflows/invoice-approval.ts";

const params = {
  threshold: money({ label: "Above", currency: "EUR", default: 500_000 }),
  reviewer: person({ label: "Reviewer", default: "team:finance" }),
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
  timeout: "7 days",
});
// @ts-expect-error -- a money parameter holds a number
money({ label: "Above", currency: "EUR", default: "5000" });
// @ts-expect-error -- money is in a currency
money({ label: "Above", default: 500_000 });

// The SDK owns how long a decision waits.
// @ts-expect-error -- a decision needs a timeout
await step.decision("review", {
  description: "Review",
  from: p.reviewer,
  ask: async () => {},
});

// Retries say how many, and how far apart.
await step.do(
  "match",
  // @ts-expect-error -- retries are an object
  { description: "Match", retries: 2 },
  async () => 1
);
await step.do(
  "match",
  {
    description: "Match",
    retries: { limit: 2, delay: "30 seconds", backoff: "exponential" },
    timeout: "5 minutes",
  },
  async () => 1
);

// A step's result is JSON, which the engine records.
await step.do(
  "when",
  { description: "When" },
  // @ts-expect-error -- a Date isn't JSON
  async () => new Date(0)
);

// The typed options and the schemas that check them at run time take the
// same options.
expectTypeOf<keyof DoOptions>().toEqualTypeOf<
  keyof z.input<typeof stepOptionSchemas.do>
>();
expectTypeOf<
  Exclude<keyof LlmOptions<z.ZodType>, "locked" | "sideEffect">
>().toEqualTypeOf<keyof z.input<typeof stepOptionSchemas.llm>>();
expectTypeOf<keyof DecisionOptions>().toEqualTypeOf<
  keyof z.input<typeof stepOptionSchemas.decision>
>();
expectTypeOf<keyof SleepOptions>().toEqualTypeOf<
  keyof z.input<typeof stepOptionSchemas.sleep>
>();

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

// An App's server methods, typed by its class, without the caller core
// passes first; the runtime's own members aren't methods to call.
interface InvoiceServer {
  ctx: unknown;
  fetch: (request: Request) => Promise<Response>;
  setStatus: (caller: { userId: string }, id: string, status: "booked") => void;
  total: (caller: { userId: string }) => Promise<number>;
  set_status: (caller: { userId: string }) => void;
  "mark-paid": (caller: { userId: string }) => void;
  toJSON: (caller: { userId: string }) => string;
}
declare const invoices: AppServer<InvoiceServer>;
expectTypeOf(invoices.setStatus).toEqualTypeOf<
  (id: string, status: "booked") => Promise<void>
>();
expectTypeOf(invoices.total).toEqualTypeOf<() => Promise<number>>();
expectTypeOf(appServer<InvoiceServer>(context.env)).toEqualTypeOf<
  AppServer<InvoiceServer>
>();
// The runtime's own, and what isn't a method, aren't there.
expectTypeOf(invoices).not.toHaveProperty("fetch");
expectTypeOf(invoices).not.toHaveProperty("ctx");
// Nor names core refuses, and not `toJSON`, which serializing looks up.
expectTypeOf(invoices).not.toHaveProperty("set_status");
expectTypeOf(invoices).not.toHaveProperty("mark-paid");
expectTypeOf(invoices).not.toHaveProperty("toJSON");
// @ts-expect-error -- a status the method doesn't take
void invoices.setStatus("INV-7", "paid");

// Another App's exports, typed by what the workflow writes of them: each
// takes its one input and answers a promise; names core refuses aren't
// there.
interface CrmExports {
  findCustomers: (input: { query: string }) => { name: string }[];
  count: (input: null) => Promise<number>;
  find_customers: (input: null) => void;
  toJSON: (input: null) => string;
  read: (input: null) => string;
}
declare const crm: AppExportsStub<CrmExports>;
expectTypeOf(crm.findCustomers).toEqualTypeOf<
  (input: { query: string }) => Promise<{ name: string }[]>
>();
expectTypeOf(crm.count).toEqualTypeOf<(input: null) => Promise<number>>();
expectTypeOf(appExports<CrmExports>(context.env.CRM)).toEqualTypeOf<
  AppExportsStub<CrmExports>
>();
expectTypeOf(crm).not.toHaveProperty("find_customers");
expectTypeOf(crm).not.toHaveProperty("toJSON");
expectTypeOf(crm).not.toHaveProperty("read");
// @ts-expect-error -- an input the export doesn't take
void crm.findCustomers({ query: 7 });
