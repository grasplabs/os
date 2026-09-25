import { workflowIdSchema } from "@grasp-os/shared/ids";
import type { RunId, WorkflowId } from "@grasp-os/shared/ids";
import { z } from "zod";

import { decisionAnswerSchema } from "./engine.ts";
import type { EngineEvent, JsonValue, WorkflowEngine } from "./engine.ts";
import { namePattern } from "./steps.ts";

/**
 * Workflow SDK: the only API workflow code sees. A workflow declares its
 * parameters, then runs its steps in code, each with its options inline:
 *
 * ```ts
 * export default workflow("invoice-approval", {
 *   params: { threshold: money({ label: "Review invoices above", default: 5000 }) },
 * }, async (step, { params }) => {
 *   await step.do("book", { description: "Book the invoice", sideEffect: true },
 *     async ({ idempotencyKey }) => ...);
 * });
 * ```
 *
 * The code is the only source of truth: `describeWorkflow` in
 * `@grasp-os/sdk/describe` reads the step list from it.
 */

// Workflow code imports only this module, so it gets Zod from here too.
export { z } from "zod";

export type WorkflowErrorCode =
  | "workflow.invalid_definition"
  | "workflow.invalid_step_call"
  | "workflow.invalid_input"
  | "workflow.invalid_param"
  | "workflow.invalid_model_output"
  | "workflow.invalid_event";

/**
 * Thrown for a workflow that is wrong: a bad definition, a bad step call, or
 * a value that doesn't match its schema.
 */
export class WorkflowError extends Error {
  /** Stable and machine-readable; branch on this, never on the message. */
  readonly code: WorkflowErrorCode;

  constructor(code: WorkflowErrorCode, message: string) {
    super(message);
    this.name = "WorkflowError";
    this.code = code;
  }
}

// Parameters

/**
 * The value each kind of parameter holds. References to people, models,
 * templates and schedules are branded, so a parameter of one kind can't be
 * passed where another is expected (a reviewer as the model, say).
 */
const paramValueSchemas = {
  /** An amount in the deployment's currency. */
  money: z.number(),
  number: z.number(),
  text: z.string(),
  /** A person or a group of people. */
  person: z.string().min(1).brand<"Person">(),
  /** When something happens, as a cron expression. */
  schedule: z.string().min(1).brand<"Schedule">(),
  /** A model offered by the model gateway. */
  model: z.string().min(1).brand<"Model">(),
  /** A template, e.g. for an email. */
  template: z.string().min(1).brand<"Template">(),
};

export type ParamKind = keyof typeof paramValueSchemas;
export type ParamValue<Kind extends ParamKind> = z.output<
  (typeof paramValueSchemas)[Kind]
>;
export type Person = ParamValue<"person">;
export type Schedule = ParamValue<"schedule">;
export type Model = ParamValue<"model">;
export type Template = ParamValue<"template">;

/** A tunable value people see and can change without touching the code. */
export interface Param<Kind extends ParamKind = ParamKind> {
  kind: Kind;
  /** What people see next to the value, e.g. "Review invoices above". */
  label: string;
  default: z.input<(typeof paramValueSchemas)[Kind]>;
  /** Changing it needs a second person's approval. */
  sensitive: boolean;
}

interface ParamOptions<Kind extends ParamKind> {
  label: string;
  default: z.input<(typeof paramValueSchemas)[Kind]>;
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

/** An amount of money, in the deployment's currency. */
export const money = param("money");
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

/** A time span: milliseconds, or e.g. `"30 minutes"` or `"3 days"`. */
export type Duration =
  | number
  | `${number} ${"second" | "minute" | "hour" | "day" | "week"}${"" | "s"}`;

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

export interface DoOptions extends StepOptions {
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
  /** Extra attempts after a failure; the engine's default when missing. */
  retries?: number;
}

/** Passed to a side-effect step: hand `idempotencyKey` to connector calls. */
export interface SideEffectContext {
  /**
   * `runId:stepName` (`runId:stepName:key` for a keyed step); the same on
   * every retry and replay of the step.
   */
  idempotencyKey: string;
}

export interface LlmOptions<Output extends z.ZodType> extends StepOptions {
  /** A model parameter, so people see and govern which model is used. */
  model: Model;
  /** What the model is asked to do: the prompt. */
  instructions: string;
  /** What the model works on, e.g. the text of an invoice. */
  input: JsonValue;
  /** The shape the answer must have. */
  schema: Output;
  /** Extra attempts after a failure or an answer that doesn't fit. */
  retries?: number;
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
  /**
   * Stop waiting this long after the decision opened, however long asking
   * took; the engine's limit when missing.
   */
  timeout?: Duration;
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
 * Runs steps. Names and options are literals in the code, so the step list
 * can be read from it; a step name runs once per run unless each run of it
 * has its own `key`.
 */
export interface StepRunner {
  /**
   * Runs plain code. Its result must be JSON: it's recorded, and a replay
   * returns the recorded result instead of running the code again.
   */
  do: {
    <T>(
      name: string,
      options: DoOptions & { sideEffect: true },
      fn: (context: SideEffectContext) => Promise<T>
    ): Promise<T>;
    <T>(
      name: string,
      options: DoOptions & { sideEffect?: false },
      fn: () => Promise<T>
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
   * Asks a person to decide and durably waits for the answer. How they are
   * asked is up to `ask`, which gets a link to where they answer.
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
    options: DoOptions,
    fn: (context?: SideEffectContext) => Promise<unknown>
  ) => Promise<unknown>;
  llm: (name: string, options: LlmOptions<z.ZodType>) => Promise<unknown>;
  decision: (name: string, options: DecisionOptions) => Promise<Decision>;
  sleep: (name: string, options: SleepOptions) => Promise<void>;
  waitFor: (
    name: string,
    options: WaitForOptions<z.ZodType>
  ) => Promise<WaitResult<unknown>>;
}

/** Key-value state of the workflow, shared by all its runs. */
export interface StateStore {
  get: (key: string) => Promise<JsonValue | undefined>;
  set: (key: string, value: JsonValue) => Promise<void>;
}

/** Everything a workflow reads besides its steps. */
export interface WorkflowContext<P extends Params, Input> {
  runId: RunId;
  input: Input;
  params: ParamValues<P>;
  state: StateStore;
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
  /** Runs (or replays) one run on `engine`; `input` is checked first. */
  run: (engine: WorkflowEngine, input?: unknown) => Promise<Output>;
}

const durationPattern =
  /^(?<amount>\d+(?:\.\d+)?) (?<unit>second|minute|hour|day|week)s?$/u;
const unitMilliseconds = new Map([
  ["second", 1000],
  ["minute", 60_000],
  ["hour", 3_600_000],
  ["day", 86_400_000],
  ["week", 604_800_000],
]);
const maxKeyLength = 128;

const invalidCall = (message: string): WorkflowError =>
  new WorkflowError("workflow.invalid_step_call", message);

const toMilliseconds = (duration: unknown): number => {
  const match =
    typeof duration === "string" ? durationPattern.exec(duration) : null;
  const milliseconds = match
    ? Number(match.groups?.amount) *
      (unitMilliseconds.get(match.groups?.unit ?? "") ?? Number.NaN)
    : duration;
  if (
    typeof milliseconds !== "number" ||
    !Number.isFinite(milliseconds) ||
    milliseconds <= 0
  ) {
    throw invalidCall(`"${String(duration)}" is not a duration`);
  }
  return milliseconds;
};

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

const validateParams = (params: Params): void => {
  for (const [name, definition] of Object.entries(params)) {
    parseOrThrow(
      paramValueSchemas[definition.kind],
      definition.default,
      "workflow.invalid_definition",
      `Default of parameter "${name}"`
    );
  }
};

const describeParams = (params: Params): ParamMetadata[] =>
  Object.entries(params).map(([name, definition]) => ({
    name,
    kind: definition.kind,
    label: definition.label,
    default: definition.default,
    sensitive: definition.sensitive,
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

const idempotencyKeyOf = (engine: WorkflowEngine, step: string): string =>
  `${engine.runId}:${step}`;

/** Fails the step call with `message` unless `condition` holds. */
const check = (condition: boolean, message: string): void => {
  if (!condition) {
    throw invalidCall(message);
  }
};

const isOptionalBoolean = (value: unknown): boolean =>
  value === undefined || typeof value === "boolean";

const isRetries = (retries: unknown): retries is number | undefined =>
  retries === undefined ||
  (typeof retries === "number" && Number.isInteger(retries) && retries >= 0);

const createStepRunner = (engine: WorkflowEngine): UntypedStepRunner => {
  const started = new Set<string>();

  // Checks what every step takes and returns the step's engine name: its
  // name, or `name:key` for a keyed step. Types catch most of this; workflow
  // code that got past them still fails here, before anything runs.
  const start = (name: string, options: StepOptions): string => {
    if (typeof name !== "string" || !namePattern.test(name)) {
      throw invalidCall(
        `Step "${name}" needs a name of up to 64 letters, digits, "-" or "_", starting with a letter`
      );
    }
    if (
      typeof options.description !== "string" ||
      options.description.trim() === ""
    ) {
      throw invalidCall(`Step "${name}" needs a description`);
    }
    const { key } = options;
    const keyIsValid =
      key === undefined ||
      // Well formed, or encoding it throws.
      (typeof key === "string" && key !== "" && key.isWellFormed()) ||
      (typeof key === "number" && Number.isFinite(key));
    // Encoded, so a key never contains the separators of engine step names.
    const encodedKey =
      key === undefined || !keyIsValid ? "" : encodeURIComponent(key);
    if (!keyIsValid || encodedKey.length > maxKeyLength) {
      throw invalidCall(
        `Step "${name}" needs a key that is a non-empty string or a number, of up to ${maxKeyLength} characters`
      );
    }
    const step = key === undefined ? name : `${name}:${encodedKey}`;
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

  const retriesOf = (name: string, retries: unknown): number | undefined => {
    if (!isRetries(retries)) {
      throw invalidCall(
        `Step "${name}" needs a whole, non-negative number of retries`
      );
    }
    return retries;
  };

  const waitForEvent = async (
    name: string,
    type: string,
    timeout?: number
  ): Promise<EngineEvent> =>
    await engine.waitForEvent(name, {
      type,
      ...(timeout === undefined ? {} : { timeout }),
    });

  return {
    do: async (name, options, fn) => {
      const step = start(name, options);
      const retries = retriesOf(name, options.retries);
      check(
        isOptionalBoolean(options.sideEffect) &&
          isOptionalBoolean(options.locked),
        `Step "${name}" needs \`sideEffect\` and \`locked\` to be true or false`
      );
      check(typeof fn === "function", `Step "${name}" needs a function to run`);
      return await engine.do(step, { retries }, async () =>
        options.sideEffect === true
          ? await fn({ idempotencyKey: idempotencyKeyOf(engine, step) })
          : await fn()
      );
    },

    llm: async (name, options) => {
      const step = start(name, options);
      const retries = retriesOf(name, options.retries);
      const { model: modelName, instructions, input, schema } = options;
      check(
        typeof instructions === "string" && instructions.trim() !== "",
        `Step "${name}" needs instructions for the model`
      );
      check(
        schema instanceof z.ZodType,
        `Step "${name}" needs a Zod schema for the answer`
      );
      check(
        z.json().safeParse(input).success,
        `Step "${name}" needs input the model gateway can take: JSON`
      );
      const request = {
        step,
        model: parseOrThrow(
          paramValueSchemas.model,
          modelName,
          "workflow.invalid_step_call",
          `Model of step "${name}"`
        ),
        instructions,
        input,
        // The model writes what the schema accepts, so describe its input side.
        outputSchema: z.toJSONSchema(schema, { io: "input" }),
      };
      // The raw answer is recorded, not the parsed one: parsed output may
      // hold values that don't survive being recorded (a transform to a Date,
      // say). Checking it inside the step makes an answer that doesn't fit a
      // retryable failure.
      const answer = await engine.do(step, { retries }, async () => {
        const raw = await engine.callModel(request);
        parseOrThrow(
          schema,
          raw,
          "workflow.invalid_model_output",
          `Answer to step "${name}"`
        );
        return raw;
      });
      return parseOrThrow(
        schema,
        answer,
        "workflow.invalid_model_output",
        `Answer to step "${name}"`
      );
    },

    decision: async (name, options) => {
      const step = start(name, options);
      const { from, ask, timeout, remindAfter } = options;
      check(
        typeof ask === "function",
        `Decision "${name}" needs an \`ask\` function`
      );
      const timeoutMs =
        timeout === undefined ? undefined : toMilliseconds(timeout);
      const remindMs =
        remindAfter === undefined ? undefined : toMilliseconds(remindAfter);
      if (
        remindMs !== undefined &&
        timeoutMs !== undefined &&
        remindMs >= timeoutMs
      ) {
        throw invalidCall(`Decision "${name}" must remind before it times out`);
      }
      const decider = parseOrThrow(
        paramValueSchemas.person,
        from,
        "workflow.invalid_step_call",
        `Who decides on "${name}"`
      );

      // Times are taken inside steps, so a replay computes the same waits.
      // The timeout counts from when the decision opened, so time spent
      // asking or reminding never pushes the deadline out.
      const { link, eventType, openedAt } = await engine.do(
        step,
        {},
        async () => ({
          ...(await engine.openDecision({ step, from: decider })),
          openedAt: Date.now(),
        })
      );
      const deadline =
        timeoutMs === undefined ? undefined : openedAt + timeoutMs;
      const askPerson = async (reminder: boolean): Promise<number> => {
        const askStep = `${step}#${reminder ? "remind" : "ask"}`;
        return await engine.do(askStep, {}, async () => {
          await ask({
            link,
            reminder,
            idempotencyKey: idempotencyKeyOf(engine, askStep),
          });
          return Date.now();
        });
      };
      const waitForAnswer = async (
        waitStep: string,
        since: number,
        until: number | undefined
      ): Promise<EngineEvent> => {
        if (until === undefined) {
          return await waitForEvent(waitStep, eventType);
        }
        return until > since
          ? await waitForEvent(waitStep, eventType, until - since)
          : { received: false };
      };

      const askedAt = await askPerson(false);
      const remindAt = remindMs === undefined ? undefined : askedAt + remindMs;
      const reminds =
        remindAt !== undefined &&
        (deadline === undefined || remindAt < deadline);
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
    },

    sleep: async (name, options) => {
      const step = start(name, options);
      await engine.sleep(step, toMilliseconds(options.duration));
    },

    waitFor: async (name, options) => {
      const step = start(name, options);
      const { type, timeout, schema } = options;
      check(
        typeof type === "string" && type !== "",
        `Step "${name}" needs an event type`
      );
      check(
        schema === undefined || schema instanceof z.ZodType,
        `Step "${name}" needs a Zod schema for the event, or none`
      );
      const event = await waitForEvent(step, type, toMilliseconds(timeout));
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
    },
  };
};

// State is shared by all runs of a workflow, so another run can change it
// between two replays of this one. Each read and write is its own step, so a
// replay sees exactly what the first execution saw, and each write carries an
// idempotency key, so a replayed write never lands twice.
const createStateStore = (engine: WorkflowEngine): StateStore => {
  const calls = new Map<string, number>();
  const stepName = (operation: "get" | "set", key: string): string => {
    if (typeof key !== "string" || !namePattern.test(key)) {
      throw invalidCall(
        `State key "${key}" needs up to 64 letters, digits, "-" or "_", starting with a letter`
      );
    }
    const base = `$state:${operation}:${key}`;
    const count = (calls.get(base) ?? 0) + 1;
    calls.set(base, count);
    return `${base}:${count}`;
  };
  return {
    get: async (key) => {
      const step = stepName("get", key);
      return await engine.do(step, {}, async () => await engine.getState(key));
    },
    set: async (key, value) => {
      const step = stepName("set", key);
      const json = parseOrThrow(
        z.json(),
        value,
        "workflow.invalid_step_call",
        `Value for state "${key}"`
      );
      await engine.do(step, {}, async () => {
        await engine.setState(key, json, idempotencyKeyOf(engine, step));
      });
    },
  };
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

  return {
    metadata: {
      id: workflowId,
      params: describeParams(config.params),
      triggers: config.triggers ?? [{ type: "manual" }],
    },
    run: async (engine, rawInput) => {
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
      // value that doesn't fit won't fit on a retry either.
      const params = await engine.do(
        "$params",
        { retries: 0 },
        async () =>
          await Promise.resolve(resolveParams(config.params, engine.params))
      );
      return await run(
        // SAFETY: the untyped runner takes every call the typed one allows
        // and checks each option at run time.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
        createStepRunner(engine) as StepRunner,
        {
          runId: engine.runId,
          input,
          // SAFETY: resolveParams parses every declared parameter with the
          // schema of its kind, which is what ParamValues<P> describes.
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
          params: Object.freeze(params) as ParamValues<P>,
          state: createStateStore(engine),
        }
      );
    },
  };
};
