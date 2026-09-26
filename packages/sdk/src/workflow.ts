import { workflowIdSchema } from "@grasp-os/shared/ids";
import type { RunId, WorkflowId } from "@grasp-os/shared/ids";
import type { Json } from "@grasp-os/shared/json";
import { stepIdempotencyKey } from "@grasp-os/shared/workflows";
import { z } from "zod";

import { decisionAnswerSchema } from "./engine.ts";
import type {
  Backoff,
  EngineEvent,
  WorkflowEngine,
  WorkflowEnv,
} from "./engine.ts";
import { currencySchema, paramValueSchemas } from "./params.ts";
import type { ParamDefault, ParamKind, ParamValue } from "./params.ts";
import { namePattern, nameRule, stepOptionSchemas } from "./steps.ts";

/**
 * Workflow SDK: the only API workflow code sees. A workflow declares its
 * parameters, then runs its steps in code, each with its options inline:
 *
 * ```ts
 * export default workflow("invoice-approval", {
 *   params: {
 *     threshold: money({ label: "Review invoices above", currency: "EUR", default: 500_000 }),
 *   },
 * }, async (step, { params }) => {
 *   await step.do("book",
 *     { description: "Book the invoice", sideEffect: true, input: { invoice: 7 } },
 *     async ({ idempotencyKey, input }) => ...);
 * });
 * ```
 *
 * The code is the only source of truth: `describeWorkflow` in
 * `@grasp-os/sdk/describe` reads the step list from it.
 */

// Workflow code imports only this module, so it gets Zod from here too.
export { z } from "zod";
export type { ParamKind, ParamValue } from "./params.ts";
export type { BindingMethod, WorkflowEnv } from "./engine.ts";

const workflowErrorCodes = [
  "workflow.invalid_definition",
  "workflow.invalid_step_call",
  "workflow.invalid_input",
  "workflow.invalid_param",
  "workflow.invalid_model_output",
  "workflow.invalid_event",
] as const;
export type WorkflowErrorCode = (typeof workflowErrorCodes)[number];

const isWorkflowErrorCode = (code: unknown): code is WorkflowErrorCode =>
  workflowErrorCodes.some((known) => known === code);

// The code rides in the name, which every engine keeps with the message.
const errorNamePattern = /^WorkflowError\((?<code>[\w.]+)\)$/u;

/**
 * Thrown for a workflow that is wrong: a bad definition, a bad step call, or
 * a value that doesn't match its schema.
 */
export class WorkflowError extends Error {
  /** Stable and machine-readable; branch on this, never on the message. */
  readonly code: WorkflowErrorCode;

  /**
   * Trying again can't fix one, so the engine doesn't retry the step it
   * failed; only a model's answer that doesn't fit is asked for again
   * (`isRetryable` in `@grasp-os/shared/workflows`).
   */
  constructor(code: WorkflowErrorCode, message: string) {
    super(message);
    // Not just the class name: the code rides in the name, which every
    // engine keeps with the message.
    // oxlint-disable-next-line unicorn/custom-error-definition -- see above
    this.name = `WorkflowError(${code})`;
    this.code = code;
  }

  /**
   * The workflow error `error` is, or was before an engine kept only its
   * name and message; undefined for any other error.
   */
  static from(error: unknown): WorkflowError | undefined {
    if (error instanceof WorkflowError) {
      return error;
    }
    if (!(error instanceof Error)) {
      return undefined;
    }
    const code = errorNamePattern.exec(error.name)?.groups?.code;
    return isWorkflowErrorCode(code)
      ? new WorkflowError(code, error.message)
      : undefined;
  }
}

const invalidCall = (message: string): WorkflowError =>
  new WorkflowError("workflow.invalid_step_call", message);

const parseOrThrow = <Schema extends z.ZodType>(
  schema: Schema,
  value: unknown,
  code: WorkflowErrorCode,
  what: string
): z.output<Schema> => {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new WorkflowError(code, `${what}: ${z.prettifyError(result.error)}`);
  }
  return result.data;
};

// Parameters

export type Person = ParamValue<"person">;
export type Schedule = ParamValue<"schedule">;
export type Model = ParamValue<"model">;
export type Template = ParamValue<"template">;

/** A tunable value people see and can change without touching the code. */
export interface Param<Kind extends ParamKind = ParamKind> {
  kind: Kind;
  /** What people see next to the value, e.g. "Review invoices above". */
  label: string;
  default: ParamDefault<Kind>;
  /** Changing it needs a second person's approval. */
  sensitive: boolean;
  /** For money: the ISO 4217 currency its amounts are in, e.g. `EUR`. */
  currency?: string;
}

interface ParamOptions<Kind extends ParamKind> {
  label: string;
  default: ParamDefault<Kind>;
  /** Changing it needs a second person's approval; defaults to false. */
  sensitive?: boolean;
}

const param =
  <Kind extends ParamKind>(kind: Kind) =>
  (options: ParamOptions<Kind>): Param<Kind> => ({
    kind,
    label: options.label,
    default: options.default,
    sensitive: options.sensitive ?? false,
  });

/**
 * An amount of money in whole minor units of `currency` (cents for EUR):
 * `default: 500_000` is €5,000.00.
 */
export const money = (
  options: ParamOptions<"money"> & {
    /** ISO 4217, e.g. `EUR`. */
    currency: string;
  }
): Param<"money"> => ({
  ...param("money")(options),
  currency: options.currency,
});
/** A number. */
export const number = param("number");
/** A piece of text. */
export const text = param("text");
/** A person or group, e.g. who reviews; required by `step.decision`. */
export const person = param("person");
/** A schedule, as a cron expression; referenced by schedule triggers. */
export const schedule = param("schedule");
/** A model from the model gateway; required by `step.llm`. */
export const model = param("model");
/** A template, e.g. for an email. */
export const template = param("template");

type Params = Record<string, Param>;

/** Parameter values as workflow code reads them: `params.threshold`. */
export type ParamValues<P extends Params> = {
  readonly [Name in keyof P]: ParamValue<P[Name]["kind"]>;
};

// Steps

/**
 * A time span: whole milliseconds, or e.g. `"30 minutes"` or `"3 days"`; at
 * most 365 days.
 */
export type Duration =
  | number
  | `${number} ${"second" | "minute" | "hour" | "day" | "week"}${"" | "s"}`;

/** What a step returns: JSON, which the engine records, or nothing. */
// oxlint-disable-next-line typescript/no-invalid-void-type -- a step may return nothing
export type StepResult = Json | undefined | void;

/** Options every step takes. */
interface StepOptions {
  /** What the step does, in plain language; the UI shows it. */
  description: string;
  /**
   * Tells apart the runs of this step within one run, e.g. the ID of the
   * item a loop is on. Without it, a step runs once per run.
   */
  key?: string | number;
}

/**
 * How often to try a failing step again. `limit` counts retries, not
 * attempts (as in Cloudflare Workflows): `limit: 2` is three attempts in
 * all. Only failures trying again may fix are retried: a connection's
 * server that didn't take the call, a rate limit, a model or App that
 * failed or ran out of time. Any other error (a refusal, a tool's own
 * error, one the workflow throws) fails the step at once, and stops the
 * run unless the workflow catches it. Missing, the engine's defaults apply
 * (Cloudflare Workflows: 5 retries, 10 seconds apart, backing off
 * exponentially).
 */
export interface Retries {
  limit: number;
  /** Before the first retry. */
  delay?: Duration;
  /** How the delay grows. */
  backoff?: Backoff;
}

/** Options of a step that runs code, and so can fail and be tried again. */
interface AttemptOptions {
  retries?: Retries;
  /**
   * How long one attempt may take; the engine's default when missing
   * (Cloudflare Workflows: 10 minutes).
   */
  timeout?: Duration;
}

/** What a step works on: JSON, or nothing. */
export type StepInput = Json | undefined;

export interface DoOptions<Input extends StepInput = StepInput>
  extends StepOptions, AttemptOptions {
  /**
   * Changes something outside Grasp. The step gets an idempotency key to
   * pass to connector calls, so a retry never does the change twice.
   */
  sideEffect?: boolean;
  /**
   * Deterministic, with no model involvement: totals, account numbers and
   * references always come from a locked step.
   */
  locked?: boolean;
  /**
   * What the step works on, as JSON; the function gets it back as `input`.
   * It's recorded with the step, and a dry run shows it for a side-effect
   * step it doesn't run, so a side-effect step must give it (`null` when it
   * writes nothing of its own) and take everything it writes from here.
   */
  input?: Input;
}

/** Passed to a side-effect step: hand `idempotencyKey` to connector calls. */
export interface SideEffectContext {
  /**
   * `runId:stepName` (`runId:stepName:key` for a keyed step, the run ID and
   * key URI-encoded); the same on every retry and replay of the step.
   */
  idempotencyKey: string;
}

export interface LlmOptions<Output extends z.ZodType>
  extends StepOptions, AttemptOptions {
  /** A model parameter, so people see and govern which model is used. */
  model: Model;
  /** What the model is asked to do: the prompt. */
  instructions: string;
  /** What the model works on, e.g. the text of an invoice. */
  input: Json;
  /** The shape the answer must have. */
  schema: Output;
  /** A model is involved, so an AI step is never locked. */
  locked?: never;
  sideEffect?: never;
}

/** How a person is asked to decide; `step.decision` calls it. */
export interface DecisionRequest extends SideEffectContext {
  /** Where the person answers. */
  link: string;
  /** False the first time, true when reminding. */
  reminder: boolean;
}

export interface DecisionOptions extends StepOptions {
  /** Who decides; only they can answer. */
  from: Person;
  /** Tells them there is something to decide, e.g. by email. */
  ask: (request: DecisionRequest) => Promise<void>;
  /** Stop waiting this long after the decision opened, however long asking took. */
  timeout: Duration;
  /** Ask once more when there is no answer this long after asking. */
  remindAfter?: Duration;
}

/** How a decision ended. */
export type Decision =
  | { outcome: "approved" | "rejected"; by: string; comment?: string }
  | { outcome: "timedOut" };

export interface SleepOptions extends StepOptions {
  duration: Duration;
}

export interface WaitForOptions<Payload extends z.ZodType> extends StepOptions {
  /** The type of event to wait for, e.g. `document.signed`. */
  type: string;
  /** Stop waiting after this long. */
  timeout: Duration;
  /** Checks the event's payload; any payload is accepted when missing. */
  schema?: Payload;
}

/** What `step.waitFor` ends with. */
export type WaitResult<T> =
  | { received: true; payload: T }
  | { received: false };

/**
 * Runs steps, one after another. Names and options are literals in the
 * code, so the step list can be read from it; a step name runs once per run
 * unless each run of it has its own `key`. A step never starts while another
 * step runs, e.g. from inside its function.
 */
export interface StepRunner {
  /**
   * Runs plain code. Its result must be JSON: it's recorded, and a replay
   * returns the recorded result instead of running the code again.
   */
  do: {
    <T extends StepResult, Input extends Json>(
      name: string,
      options: DoOptions<Input> & { sideEffect: true; input: Input },
      fn: (context: SideEffectContext & { input: Input }) => Promise<T>
    ): Promise<T>;
    <T extends StepResult, Input extends StepInput = undefined>(
      name: string,
      options: DoOptions<Input> & { sideEffect?: false },
      fn: (context: { input: Input }) => Promise<T>
    ): Promise<T>;
  };
  /**
   * Asks a model through the model gateway. The answer must match `schema`;
   * an answer that doesn't counts as a failure and is retried.
   */
  llm: <Output extends z.ZodType>(
    name: string,
    options: LlmOptions<Output>
  ) => Promise<z.output<Output>>;
  /**
   * Asks a person to decide and durably waits for the answer, until the
   * timeout. How they are asked is up to `ask`, which gets a link to where
   * they answer.
   */
  decision: (name: string, options: DecisionOptions) => Promise<Decision>;
  /** Durably pauses the run. */
  sleep: (name: string, options: SleepOptions) => Promise<void>;
  /** Durably waits for an event of `type`, e.g. from a connector. */
  waitFor: <Payload extends z.ZodType = z.ZodUnknown>(
    name: string,
    options: WaitForOptions<Payload>
  ) => Promise<WaitResult<z.output<Payload>>>;
}

// What the runner implements: the same steps, with their options checked at
// run time as well as by the types.
interface UntypedStepRunner {
  do: (
    name: string,
    options: unknown,
    fn: (
      context: Partial<SideEffectContext> & { input: StepInput }
    ) => Promise<unknown>
  ) => Promise<unknown>;
  llm: (name: string, options: unknown) => Promise<unknown>;
  decision: (name: string, options: unknown) => Promise<Decision>;
  sleep: (name: string, options: unknown) => Promise<void>;
  waitFor: (name: string, options: unknown) => Promise<WaitResult<unknown>>;
}

/**
 * Key-value state of the workflow, shared by all its runs. Read and write it
 * between steps, never while one runs.
 */
export interface StateStore {
  get: (key: string) => Promise<Json | undefined>;
  set: (key: string, value: Json) => Promise<void>;
}

/** Everything a workflow reads besides its steps. */
export interface WorkflowContext<P extends Params, Input> {
  runId: RunId;
  input: Input;
  params: ParamValues<P>;
  state: StateStore;
  /**
   * The App's connections and other permissions, and its own server
   * methods, by binding name; call them inside steps (see `WorkflowEnv`).
   */
  env: WorkflowEnv;
}

// Definition

/** What starts a run. */
export type Trigger<ScheduleParam extends string = string> =
  | { type: "manual" }
  /** On the schedule held by a schedule parameter. */
  | { type: "schedule"; param: ScheduleParam }
  /** When an event of this type arrives, e.g. from a connector. */
  | { type: "event"; event: string };

type ScheduleParams<P extends Params> = {
  [Name in keyof P]: P[Name]["kind"] extends "schedule" ? Name : never;
}[keyof P] &
  string;

/** A parameter as the UI shows it. */
export interface ParamMetadata {
  name: string;
  kind: ParamKind;
  label: string;
  default: string | number;
  sensitive: boolean;
  /** For money: its ISO 4217 currency; amounts are in its minor units. */
  currency?: string;
}

/**
 * What the UI shows about a workflow besides its steps, as plain JSON. The
 * steps come from the code, through `describeWorkflow`.
 */
export interface WorkflowMetadata {
  id: WorkflowId;
  params: ParamMetadata[];
  triggers: Trigger[];
}

/** A workflow, ready for the runtime to run. */
export interface WorkflowDefinition<Output> {
  metadata: WorkflowMetadata;
  /**
   * Runs (or replays) one run on `engine`; `input` is checked first. A
   * `WorkflowError` keeps its code even through an engine that keeps only a
   * failed step's error name and message.
   */
  run: (engine: WorkflowEngine, input?: unknown) => Promise<Output>;
}

const validateParams = (params: Params): void => {
  for (const [name, definition] of Object.entries(params)) {
    parseOrThrow(
      paramValueSchemas[definition.kind],
      definition.default,
      "workflow.invalid_definition",
      `Default of parameter "${name}"`
    );
    if (definition.kind === "money") {
      parseOrThrow(
        currencySchema,
        definition.currency,
        "workflow.invalid_definition",
        `Currency of parameter "${name}"`
      );
    }
  }
};

const describeParams = (params: Params): ParamMetadata[] =>
  Object.entries(params).map(([name, definition]) => ({
    name,
    kind: definition.kind,
    label: definition.label,
    default: definition.default,
    sensitive: definition.sensitive,
    ...(definition.currency === undefined
      ? {}
      : { currency: definition.currency }),
  }));

const resolveParams = (
  params: Params,
  configured: Readonly<Record<string, unknown>>
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(params).map(([name, definition]) => [
      name,
      parseOrThrow(
        paramValueSchemas[definition.kind],
        // A value that is set but empty fails, rather than quietly falling
        // back to the default.
        Object.hasOwn(configured, name) ? configured[name] : definition.default,
        "workflow.invalid_param",
        `Parameter "${name}"`
      ),
    ])
  );

// Core requires exactly this key on the step's connection calls.
const idempotencyKeyOf = (engine: WorkflowEngine, step: string): string =>
  stepIdempotencyKey(engine.runId, step);

/** A step call's options, checked against its method's schema. */
const optionsOf = <Schema extends z.ZodType>(
  schema: Schema,
  name: string,
  options: unknown
): z.output<Schema> =>
  parseOrThrow(
    schema,
    options,
    "workflow.invalid_step_call",
    `Options of step "${name}"`
  );

const createRunner = (
  engine: WorkflowEngine
): { steps: UntypedStepRunner; state: StateStore } => {
  const started = new Set<string>();
  // The step or state call running now, if any. They run one after
  // another: one started from inside a step's function, or next to another,
  // would be recorded in an order a replay can't promise to repeat.
  let running: string | undefined;

  const exclusive = async <T>(what: string, run: () => Promise<T>) => {
    if (running !== undefined) {
      throw invalidCall(
        `${what} started while ${running} runs; run steps and state calls one after another, never inside a step`
      );
    }
    running = what;
    try {
      return await run();
    } finally {
      running = undefined;
    }
  };

  // Returns the step's engine name: its name, or `name:key` for a keyed
  // step. Types catch most bad calls; workflow code that got past them
  // still fails here, before anything runs.
  const start = (name: string, key: string | number | undefined): string => {
    if (typeof name !== "string" || !namePattern.test(name)) {
      throw invalidCall(`Step "${name}" needs a name of ${nameRule}`);
    }
    // Encoded, so a key never contains the separators of engine step names.
    const step =
      key === undefined ? name : `${name}:${encodeURIComponent(key)}`;
    if (started.has(step)) {
      throw invalidCall(
        key === undefined
          ? `Step "${name}" already ran in this run; give each run of it its own key`
          : `Step "${name}" already ran with key "${String(key)}" in this run`
      );
    }
    started.add(step);
    return step;
  };

  const steps: UntypedStepRunner = {
    do: async (name, rawOptions, fn) =>
      await exclusive(`Step "${name}"`, async () => {
        const options = optionsOf(stepOptionSchemas.do, name, rawOptions);
        const step = start(name, options.key);
        if (typeof fn !== "function") {
          throw invalidCall(`Step "${name}" needs a function to run`);
        }
        const { input, retries, timeout } = options;
        const sideEffect = options.sideEffect === true;
        return await engine.do(
          step,
          { retries, timeout, sideEffect, input },
          async () =>
            sideEffect
              ? await fn({
                  idempotencyKey: idempotencyKeyOf(engine, step),
                  input,
                })
              : await fn({ input })
        );
      }),

    llm: async (name, rawOptions) =>
      await exclusive(`Step "${name}"`, async () => {
        const options = optionsOf(stepOptionSchemas.llm, name, rawOptions);
        const step = start(name, options.key);
        const { instructions, input, schema, retries, timeout } = options;
        const request = {
          step,
          model: options.model,
          instructions,
          input,
          // The model writes what the schema accepts, so describe its input
          // side.
          outputSchema: z.toJSONSchema(schema, { io: "input" }),
        };
        // The raw answer is recorded, not the parsed one: parsed output may
        // hold values that don't survive being recorded (a transform to a
        // Date, say). Checking it inside the step makes an answer that
        // doesn't fit a failure the step's retries may fix.
        const answer = await engine.do(
          step,
          { retries, timeout, input },
          async () => {
            const raw = await engine.callModel(request);
            parseOrThrow(
              schema,
              raw,
              "workflow.invalid_model_output",
              `Answer to step "${name}"`
            );
            return raw;
          }
        );
        return parseOrThrow(
          schema,
          answer,
          "workflow.invalid_model_output",
          `Answer to step "${name}"`
        );
      }),

    decision: async (name, rawOptions) =>
      await exclusive(`Step "${name}"`, async () => {
        const { key, from, ask, timeout, remindAfter } = optionsOf(
          stepOptionSchemas.decision,
          name,
          rawOptions
        );
        const step = start(name, key);

        // Times are taken inside steps, so a replay computes the same waits.
        // The timeout counts from when the decision opened, so time spent
        // asking or reminding never pushes the deadline out.
        const { link, eventType, openedAt } = await engine.do(
          step,
          { input: { from } },
          async () => ({
            ...(await engine.openDecision({ step, from })),
            openedAt: Date.now(),
          })
        );
        const deadline = openedAt + timeout;
        // Asking is a side effect, which a dry run doesn't run, so when it
        // finished is a step of its own rather than the ask step's result.
        const askPerson = async (reminder: boolean): Promise<number> => {
          const askStep = `${step}#${reminder ? "remind" : "ask"}`;
          await engine.do(
            askStep,
            { sideEffect: true, input: { from, reminder } },
            async () => {
              await ask({
                link,
                reminder,
                idempotencyKey: idempotencyKeyOf(engine, askStep),
              });
            }
          );
          return await engine.do(
            `${step}#${reminder ? "reminded" : "asked"}`,
            {},
            async () => await Promise.resolve(Date.now())
          );
        };
        const waitForAnswer = async (
          waitStep: string,
          since: number,
          until: number
        ): Promise<EngineEvent> =>
          until > since
            ? await engine.waitForEvent(waitStep, {
                type: eventType,
                timeout: until - since,
              })
            : { received: false };

        const askedAt = await askPerson(false);
        const remindAt =
          remindAfter === undefined ? undefined : askedAt + remindAfter;
        const reminds = remindAt !== undefined && remindAt < deadline;
        let event = await waitForAnswer(
          `${step}#answer`,
          askedAt,
          reminds ? remindAt : deadline
        );
        if (!event.received && reminds) {
          const remindedAt = await askPerson(true);
          event = await waitForAnswer(
            `${step}#answer-after-reminder`,
            remindedAt,
            deadline
          );
        }
        if (!event.received) {
          return { outcome: "timedOut" };
        }
        const answer = parseOrThrow(
          decisionAnswerSchema,
          event.payload,
          "workflow.invalid_event",
          `Answer to decision "${name}"`
        );
        return {
          outcome: answer.approved ? "approved" : "rejected",
          by: answer.by,
          ...(answer.comment === undefined ? {} : { comment: answer.comment }),
        };
      }),

    sleep: async (name, rawOptions) => {
      await exclusive(`Step "${name}"`, async () => {
        const { key, duration } = optionsOf(
          stepOptionSchemas.sleep,
          name,
          rawOptions
        );
        await engine.sleep(start(name, key), duration);
      });
    },

    waitFor: async (name, rawOptions) =>
      await exclusive(`Step "${name}"`, async () => {
        const { key, type, timeout, schema } = optionsOf(
          stepOptionSchemas.waitFor,
          name,
          rawOptions
        );
        const event = await engine.waitForEvent(start(name, key), {
          type,
          timeout,
        });
        if (!event.received) {
          return { received: false };
        }
        return {
          received: true,
          payload: parseOrThrow(
            schema ?? z.unknown(),
            event.payload,
            "workflow.invalid_event",
            `Event for step "${name}"`
          ),
        };
      }),
  };

  // State is shared by all runs of a workflow, so another run can change it
  // between two replays of this one. Each read and write is its own step, so
  // a replay sees exactly what the first execution saw, and each write
  // carries an idempotency key, so a replayed write never lands twice.
  const calls = new Map<string, number>();
  const stateStep = (operation: "get" | "set", key: string): string => {
    if (typeof key !== "string" || !namePattern.test(key)) {
      throw invalidCall(`State key "${key}" needs ${nameRule}`);
    }
    const base = `$state:${operation}:${key}`;
    const count = (calls.get(base) ?? 0) + 1;
    calls.set(base, count);
    return `${base}:${count}`;
  };
  const state: StateStore = {
    get: async (key) =>
      await exclusive(`State "${key}"`, async () => {
        const name = stateStep("get", key);
        return await engine.do(
          name,
          {},
          async () => await engine.getState(key)
        );
      }),
    set: async (key, value) => {
      await exclusive(`State "${key}"`, async () => {
        const name = stateStep("set", key);
        const json = parseOrThrow(
          z.json(),
          value,
          "workflow.invalid_step_call",
          `Value for state "${key}"`
        );
        await engine.do(name, {}, async () => {
          await engine.setState(key, json, idempotencyKeyOf(engine, name));
        });
      });
    },
  };

  return { steps, state };
};

/**
 * Defines a workflow. `params` are the tunable values; `run` is the workflow
 * itself, with every step and its options written inline. Checks the
 * definition right away, so a bad one fails when it loads.
 */
export const workflow = <
  const P extends Params,
  Output,
  InputSchema extends z.ZodType = z.ZodUndefined,
>(
  id: string,
  config: {
    params: P;
    /** The run's input, e.g. the invoice that started it. */
    input?: InputSchema;
    /** Manual only when missing. */
    triggers?: Trigger<ScheduleParams<P>>[];
  },
  run: (
    step: StepRunner,
    context: WorkflowContext<P, z.output<InputSchema>>
  ) => Promise<Output>
): WorkflowDefinition<Output> => {
  const workflowId = parseOrThrow(
    workflowIdSchema,
    id,
    "workflow.invalid_definition",
    "Workflow ID"
  );
  validateParams(config.params);
  const inputSchema: z.ZodType = config.input ?? z.undefined();

  const runOnce = async (
    engine: WorkflowEngine,
    rawInput: unknown
  ): Promise<Output> => {
    // SAFETY: parsed by `config.input`, or checked to be undefined when
    // there is none, which is the default of `InputSchema`.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    const input = parseOrThrow(
      inputSchema,
      rawInput,
      "workflow.invalid_input",
      "Input"
    ) as z.output<InputSchema>;
    // Recorded, so a replay runs with the values the run started with. A
    // value that doesn't fit fails for good: the error is non-retryable.
    const params = await engine.do(
      "$params",
      {},
      async () =>
        await Promise.resolve(resolveParams(config.params, engine.params))
    );
    const runner = createRunner(engine);
    return await run(
      // SAFETY: the untyped runner takes every call the typed one allows
      // and checks each option at run time.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
      runner.steps as StepRunner,
      {
        runId: engine.runId,
        input,
        // SAFETY: resolveParams parses every declared parameter with the
        // schema of its kind, which is what ParamValues<P> describes.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
        params: Object.freeze(params) as ParamValues<P>,
        state: runner.state,
        env: engine.env,
      }
    );
  };

  return {
    metadata: {
      id: workflowId,
      params: describeParams(config.params),
      triggers: config.triggers ?? [{ type: "manual" }],
    },
    run: async (engine, rawInput) => {
      try {
        return await runOnce(engine, rawInput);
      } catch (error) {
        // Engines may keep only a failed step's error name and message;
        // the code is in the name, so the error comes back whole.
        throw WorkflowError.from(error) ?? error;
      }
    },
  };
};
