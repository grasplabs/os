import { workflowIdSchema } from "@grasp-os/shared/ids";
import type { RunId, WorkflowId } from "@grasp-os/shared/ids";
import { z } from "zod";

import { decisionAnswerSchema } from "./engine.ts";
import type { EngineEvent, JsonValue, WorkflowEngine } from "./engine.ts";

/**
 * Workflow SDK: the only API workflow code sees. A workflow declares its
 * parameters and steps up front, then runs them in code:
 *
 * ```ts
 * export default workflow("invoice-approval", {
 *   params: { threshold: money({ label: "Review invoices above", default: 5000 }) },
 *   steps: { book: { kind: "exact", description: "Book the invoice", sideEffect: true } },
 * }, async (step, { params }) => {
 *   await step.do("book", async ({ idempotencyKey }) => ...);
 * });
 * ```
 *
 * Steps are declared rather than discovered by running the code, so the step
 * list (for the UI and for review) includes steps behind branches that a given
 * run never reaches. The types tie the two together: code can only run a
 * declared step, with the method for its kind.
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
 * Thrown for a workflow that is wrong: a bad definition, a step run twice or
 * with the wrong method, or a value that doesn't match its schema.
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

/**
 * How a step works: `exact` is plain code, `ai` asks a model for output of a
 * fixed shape, `decision` waits for a person, `wait` waits for time or an
 * event.
 */
export type StepKind = "exact" | "ai" | "decision" | "wait";

interface BaseStep<ParamName extends string> {
  /** What the step does, in plain language; shown to people. */
  description: string;
  /** Parameters the step depends on, shown next to it. */
  uses?: readonly ParamName[];
  /** Only a person may change or remove this step, never an agent. */
  locked?: boolean;
}

/** Declares a step. The kind decides which `step` method runs it. */
export type StepDeclaration<ParamName extends string = string> =
  | (BaseStep<ParamName> & {
      kind: "exact";
      /**
       * Changes something outside Grasp. The step gets an idempotency key to
       * pass to connector calls, so a retry never does the change twice.
       */
      sideEffect?: boolean;
      /** Extra attempts after a failure; the engine's default when missing. */
      retries?: number;
    })
  | (BaseStep<ParamName> & {
      kind: "ai";
      sideEffect?: never;
      /** Extra attempts after a failure or an answer that doesn't fit. */
      retries?: number;
    })
  | (BaseStep<ParamName> & {
      kind: "decision" | "wait";
      sideEffect?: never;
      retries?: never;
    });

type Steps<ParamName extends string> = Record<
  string,
  StepDeclaration<ParamName>
>;

type StepsOfKind<S, Kind extends StepKind> = {
  [Name in keyof S]: S[Name] extends { kind: Kind } ? Name : never;
}[keyof S] &
  string;

/** A time span: milliseconds, or e.g. `"30 minutes"` or `"3 days"`. */
export type Duration =
  | number
  | `${number} ${"second" | "minute" | "hour" | "day" | "week"}${"" | "s"}`;

/** Passed to a side-effect step: hand `idempotencyKey` to connector calls. */
export interface SideEffectContext {
  /** `runId:stepName`; the same on every retry and replay of the step. */
  idempotencyKey: string;
}

type ExactStepFn<Declaration, T> = Declaration extends { sideEffect: true }
  ? (context: SideEffectContext) => Promise<T>
  : () => Promise<T>;

/** How a person is asked to decide; `step.decision` calls it. */
export interface DecisionRequest extends SideEffectContext {
  /** Where the person answers. */
  link: string;
  /** False the first time, true when reminding. */
  reminder: boolean;
}

/** How a decision ended. */
export type Decision =
  | { outcome: "approved" | "rejected"; by: string; comment?: string }
  | { outcome: "timedOut" };

/** What `step.waitFor` ends with. */
export type WaitResult<T> =
  | { received: true; payload: T }
  | { received: false };

export interface LlmOptions<Output extends z.ZodType> {
  /** A model parameter; the deployment's default when missing. */
  model?: Model;
  /** What the model works on, e.g. the text of an invoice. */
  input: JsonValue;
  /** The shape the answer must have. */
  schema: Output;
}

export interface DecisionOptions {
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

export interface WaitForOptions<Payload extends z.ZodType> {
  /** The type of event to wait for, e.g. `document.signed`. */
  type: string;
  /** Stop waiting after this long. */
  timeout: Duration;
  /** Checks the event's payload; any payload is accepted when missing. */
  schema?: Payload;
}

/** Runs the declared steps. Each step runs at most once per run. */
export interface StepRunner<S extends Steps<string>> {
  /**
   * Runs plain code. Its result must be JSON: it's recorded, and a replay
   * returns the recorded result instead of running the code again.
   */
  do: <Name extends StepsOfKind<S, "exact">, T>(
    name: Name,
    fn: ExactStepFn<S[Name], T>
  ) => Promise<T>;
  /**
   * Asks a model through the model gateway. The answer must match `schema`;
   * an answer that doesn't counts as a failure and is retried.
   */
  llm: <Output extends z.ZodType>(
    name: StepsOfKind<S, "ai">,
    options: LlmOptions<Output>
  ) => Promise<z.output<Output>>;
  /**
   * Asks a person to decide and durably waits for the answer. How they are
   * asked is up to `ask`, which gets a link to where they answer.
   */
  decision: (
    name: StepsOfKind<S, "decision">,
    options: DecisionOptions
  ) => Promise<Decision>;
  /** Durably pauses the run. */
  sleep: (name: StepsOfKind<S, "wait">, duration: Duration) => Promise<void>;
  /** Durably waits for an event of `type`, e.g. from a connector. */
  waitFor: <Payload extends z.ZodType = z.ZodUnknown>(
    name: StepsOfKind<S, "wait">,
    options: WaitForOptions<Payload>
  ) => Promise<WaitResult<z.output<Payload>>>;
}

// What the runner implements: the same steps, checked at run time instead of
// by the types, which only narrow what code may pass.
interface UntypedStepRunner {
  do: (
    name: string,
    fn: (context?: SideEffectContext) => Promise<unknown>
  ) => Promise<unknown>;
  llm: (name: string, options: LlmOptions<z.ZodType>) => Promise<unknown>;
  decision: (name: string, options: DecisionOptions) => Promise<Decision>;
  sleep: (name: string, duration: Duration) => Promise<void>;
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

/** A step as the UI shows it. */
export interface StepMetadata {
  name: string;
  kind: StepKind;
  description: string;
  /** Names of the parameters the step uses. */
  params: string[];
  /** Changes something outside Grasp; a decision's `ask` always does. */
  sideEffect: boolean;
  locked: boolean;
}

/** Everything the UI shows about a workflow, as plain JSON. */
export interface WorkflowMetadata {
  id: WorkflowId;
  params: ParamMetadata[];
  /** In the order they are declared. */
  steps: StepMetadata[];
  triggers: Trigger[];
}

/** A workflow, ready for the runtime to run. */
export interface WorkflowDefinition<Output> {
  metadata: WorkflowMetadata;
  /** Runs (or replays) one run on `engine`; `input` is checked first. */
  run: (engine: WorkflowEngine, input?: unknown) => Promise<Output>;
}

// Names become part of engine step names and idempotency keys (`runId:name`),
// so they never contain a colon or start with `$`; the SDK's own step names
// always do one or the other.
const namePattern = /^[A-Za-z][\w-]{0,63}$/u;

const durationPattern =
  /^(?<amount>\d+(?:\.\d+)?) (?<unit>second|minute|hour|day|week)s?$/u;
const unitMilliseconds = new Map([
  ["second", 1000],
  ["minute", 60_000],
  ["hour", 3_600_000],
  ["day", 86_400_000],
  ["week", 604_800_000],
]);

const toMilliseconds = (duration: Duration): number => {
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
    throw new WorkflowError(
      "workflow.invalid_step_call",
      `"${duration}" is not a duration`
    );
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

const validateDefinition = (params: Params, steps: Steps<string>): void => {
  for (const [name, definition] of Object.entries(params)) {
    parseOrThrow(
      paramValueSchemas[definition.kind],
      definition.default,
      "workflow.invalid_definition",
      `Default of parameter "${name}"`
    );
  }
  for (const [name, { retries }] of Object.entries(steps)) {
    if (!namePattern.test(name)) {
      throw new WorkflowError(
        "workflow.invalid_definition",
        `Step "${name}" needs a name of up to 64 letters, digits, "-" or "_", starting with a letter`
      );
    }
    if (retries !== undefined && !(Number.isInteger(retries) && retries >= 0)) {
      throw new WorkflowError(
        "workflow.invalid_definition",
        `Step "${name}" needs a whole, non-negative number of retries`
      );
    }
  }
};

const describe = (
  id: WorkflowId,
  params: Params,
  steps: Steps<string>,
  triggers: Trigger[]
): WorkflowMetadata => ({
  id,
  params: Object.entries(params).map(([name, definition]) => ({
    name,
    kind: definition.kind,
    label: definition.label,
    default: definition.default,
    sensitive: definition.sensitive,
  })),
  steps: Object.entries(steps).map(([name, declaration]) => ({
    name,
    kind: declaration.kind,
    description: declaration.description,
    params: [...(declaration.uses ?? [])],
    sideEffect:
      declaration.kind === "decision" || declaration.sideEffect === true,
    locked: declaration.locked ?? false,
  })),
  triggers,
});

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

const createStepRunner = (
  engine: WorkflowEngine,
  steps: Steps<string>
): UntypedStepRunner => {
  const started = new Set<string>();
  const idempotencyKey = (name: string): string => `${engine.runId}:${name}`;

  // Types already stop code from running an undeclared step, a step with the
  // wrong method or a step twice; this catches code that got past them.
  const start = (name: string, kind: StepKind): StepDeclaration => {
    const declaration = steps[name];
    if (declaration?.kind !== kind) {
      throw new WorkflowError(
        "workflow.invalid_step_call",
        `Step "${name}" isn't declared as a ${kind} step`
      );
    }
    if (started.has(name)) {
      throw new WorkflowError(
        "workflow.invalid_step_call",
        `Step "${name}" already ran in this run; a step runs once per run`
      );
    }
    started.add(name);
    return declaration;
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
    do: async (name, fn) => {
      const declaration = start(name, "exact");
      return await engine.do(
        name,
        { retries: declaration.retries },
        async () =>
          declaration.sideEffect === true
            ? await fn({ idempotencyKey: idempotencyKey(name) })
            : await fn()
      );
    },

    llm: async (name, { model: modelName, input, schema }) => {
      const declaration = start(name, "ai");
      const request = {
        step: name,
        input,
        // The model writes what the schema accepts, so describe its input side.
        outputSchema: z.toJSONSchema(schema, { io: "input" }),
        ...(modelName === undefined ? {} : { model: modelName }),
      };
      // The raw answer is recorded, not the parsed one: parsed output may
      // hold values that don't survive being recorded (a transform to a Date,
      // say). Checking it inside the step makes an answer that doesn't fit a
      // retryable failure.
      const answer = await engine.do(
        name,
        { retries: declaration.retries },
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
    },

    decision: async (name, { from, ask, timeout, remindAfter }) => {
      start(name, "decision");
      const timeoutMs =
        timeout === undefined ? undefined : toMilliseconds(timeout);
      const remindMs =
        remindAfter === undefined ? undefined : toMilliseconds(remindAfter);
      if (
        remindMs !== undefined &&
        timeoutMs !== undefined &&
        remindMs >= timeoutMs
      ) {
        throw new WorkflowError(
          "workflow.invalid_step_call",
          `Decision "${name}" must remind before it times out`
        );
      }

      // Times are taken inside steps, so a replay computes the same waits.
      // The timeout counts from when the decision opened, so time spent
      // asking or reminding never pushes the deadline out.
      const { link, eventType, openedAt } = await engine.do(
        name,
        {},
        async () => ({
          ...(await engine.openDecision({ step: name, from })),
          openedAt: Date.now(),
        })
      );
      const deadline =
        timeoutMs === undefined ? undefined : openedAt + timeoutMs;
      const askPerson = async (reminder: boolean): Promise<number> => {
        const askStep = `${name}:${reminder ? "remind" : "ask"}`;
        return await engine.do(askStep, {}, async () => {
          await ask({
            link,
            reminder,
            idempotencyKey: idempotencyKey(askStep),
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
        `${name}:answer`,
        askedAt,
        reminds ? remindAt : deadline
      );
      if (!event.received && reminds) {
        const remindedAt = await askPerson(true);
        event = await waitForAnswer(
          `${name}:answer-after-reminder`,
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

    sleep: async (name, duration) => {
      start(name, "wait");
      await engine.sleep(name, toMilliseconds(duration));
    },

    waitFor: async (name, { type, timeout, schema }) => {
      start(name, "wait");
      const event = await waitForEvent(name, type, toMilliseconds(timeout));
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
    if (!namePattern.test(key)) {
      throw new WorkflowError(
        "workflow.invalid_step_call",
        `State key "${key}" needs letters, digits, "-" or "_", starting with a letter`
      );
    }
    const base = `$state:${operation}:${key}`;
    const count = (calls.get(base) ?? 0) + 1;
    calls.set(base, count);
    return `${base}:${count}`;
  };
  return {
    get: async (key) =>
      await engine.do(
        stepName("get", key),
        {},
        async () => await engine.getState(key)
      ),
    set: async (key, value) => {
      const step = stepName("set", key);
      await engine.do(step, {}, async () => {
        await engine.setState(key, value, `${engine.runId}:${step}`);
      });
    },
  };
};

/**
 * Defines a workflow. `params` are the tunable values, `steps` every step the
 * code may run, in the order they usually run; `run` is the workflow itself.
 * Checks the definition right away, so a bad one fails when it loads.
 */
export const workflow = <
  const P extends Params,
  const S extends Steps<keyof P & string>,
  Output,
  InputSchema extends z.ZodType = z.ZodUndefined,
>(
  id: string,
  config: {
    params: P;
    steps: S;
    /** The run's input, e.g. the invoice that started it. */
    input?: InputSchema;
    /** Manual only when missing. */
    triggers?: Trigger<ScheduleParams<P>>[];
  },
  run: (
    step: StepRunner<S>,
    context: WorkflowContext<P, z.output<InputSchema>>
  ) => Promise<Output>
): WorkflowDefinition<Output> => {
  const workflowId = parseOrThrow(
    workflowIdSchema,
    id,
    "workflow.invalid_definition",
    "Workflow ID"
  );
  validateDefinition(config.params, config.steps);
  const inputSchema: z.ZodType = config.input ?? z.undefined();

  return {
    metadata: describe(
      workflowId,
      config.params,
      config.steps,
      config.triggers ?? [{ type: "manual" }]
    ),
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
        // SAFETY: the runner checks each call against the declared steps at
        // run time; `S` only narrows which names and callbacks code may pass.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
        createStepRunner(engine, config.steps) as StepRunner<S>,
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
