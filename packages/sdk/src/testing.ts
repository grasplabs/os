import { runIdSchema } from "@grasp-os/shared/ids";

import type {
  DecisionAnswer,
  EngineEvent,
  JsonValue,
  ModelRequest,
  WorkflowEngine,
} from "./engine.ts";
import { engineStepPattern } from "./steps.ts";
import type { WorkflowDefinition } from "./workflow.ts";

/**
 * Test harness and dry runs for workflows. Runs a workflow in memory, with
 * the time-skipping and step-mocking of Temporal's test environment:
 *
 * - steps can be mocked by name, or made to fail;
 * - side-effect steps don't run: they're recorded with their input, so a
 *   test asserts what the workflow would change and a dry run reports it;
 * - decisions and events are answered up front, and waits for anything else
 *   time out right away, as sleeps end right away.
 *
 * Every workflow ships with its tests next to it (`invoice.test.ts` beside
 * `invoice.ts`), written with `workflowTests`, and `runWorkflowTests` runs
 * them, so a version whose tests fail is never activated.
 */

/** A step's call, as a mock gets it. */
export interface StepCall {
  /** The engine's name for the step: `pay:inv-7` for key `inv-7`. */
  name: string;
  input?: JsonValue;
}

/** A step's result instead of running it, or a function that computes it. */
export type StepMock =
  | JsonValue
  | ((call: StepCall) => JsonValue | Promise<JsonValue>);

/** What a step did in a test run. */
export type StepRecord =
  | {
      type: "step";
      /** The engine's name for the step, e.g. `pay:inv-7` or `review#ask`. */
      name: string;
      sideEffect: boolean;
      input?: JsonValue;
      /**
       * `ran` for its function, `mocked` for a mocked result and `recorded`
       * for a side effect that didn't run.
       */
      status: "ran" | "mocked" | "recorded";
      output: unknown;
    }
  | {
      type: "step";
      name: string;
      sideEffect: boolean;
      input?: JsonValue;
      status: "failed";
      error: string;
    }
  | { type: "sleep"; name: string; milliseconds: number }
  | {
      type: "wait";
      name: string;
      eventType: string;
      timeout?: number;
      event: EngineEvent;
    };

/** A side effect the run would have had, in the order it would happen. */
export interface SideEffect {
  name: string;
  input?: JsonValue;
}

/** A workflow's key-value state, shared by the engines given the same one. */
export interface TestState {
  values: Map<string, JsonValue>;
  appliedWrites: Set<string>;
}

export const createTestState = (
  initial: Readonly<Record<string, JsonValue>> = {}
): TestState => ({
  values: new Map(Object.entries(initial)),
  appliedWrites: new Set(),
});

/** An event sent to a run. */
export interface TestEvent {
  type: string;
  payload: unknown;
}

export interface TestEngineOptions {
  runId?: string;
  /** Parameter values people set, by name; missing ones use the default. */
  params?: Record<string, unknown>;
  /**
   * Step results by step name, instead of running the step. A keyed step
   * takes the mock for `name:key`, or else the one for `name`. An AI step's
   * mock is the model's answer, which is still checked against its schema.
   */
  mocks?: Readonly<Record<string, StepMock>>;
  /** Steps that fail, by name (as for mocks), with this error message. */
  failures?: Readonly<Record<string, string>>;
  /** Answers the model gateway; an AI step without a mock fails without it. */
  model?: (request: ModelRequest) => unknown;
  /**
   * Answers to decisions by the decision's name (as for mocks). A decision
   * without an answer times out, after its reminder if it has one. Answers
   * arrive as events of type `decision:<name>`.
   */
  decisions?: Readonly<Record<string, DecisionAnswer>>;
  /** Events sent to the run; each goes to the first wait for its type. */
  events?: readonly TestEvent[];
  state?: TestState;
  /**
   * `record` (the default) records side-effect steps without running them;
   * `run` runs them, e.g. against a fake of the system they change.
   */
  sideEffects?: "record" | "run";
  /**
   * Called with the time each sleep, and each wait that times out, would
   * have taken. The test engine skips it; move a fake clock with it.
   */
  skipTime?: (milliseconds: number) => void;
}

const decisionEventPrefix = "decision:";

/** The value for an engine step: by its exact name, else its written name. */
const byStepName = <T>(
  values: Readonly<Record<string, T>> | undefined,
  engineName: string
): T | undefined => {
  if (!values) {
    return undefined;
  }
  if (Object.hasOwn(values, engineName)) {
    return values[engineName];
  }
  // A keyed step falls back to its written name; the parts of a decision
  // (`review#ask`) and the SDK's own steps only match exactly.
  const groups = engineStepPattern.exec(engineName)?.groups;
  const name = groups?.name;
  return name !== undefined &&
    groups?.part === undefined &&
    Object.hasOwn(values, name)
    ? values[name]
    : undefined;
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Runs `fn`, and again up to `retries` times while it fails. */
const attempt = async <T>(
  retries: number,
  fn: () => Promise<T>
): Promise<T> => {
  let lastError: unknown;
  for (let attempts = 0; attempts <= retries; attempts += 1) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- attempts are sequential by design
      return await fn();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
};

/**
 * An in-memory engine with the durable semantics workflows rely on: a step's
 * result is recorded under its name, and running the workflow again on the
 * same engine replays it (completed steps return their recorded result), as
 * a resume after a crash does.
 */
export const createTestEngine = (options: TestEngineOptions = {}) => {
  const recorded = new Map<string, unknown>();
  const steps: StepRecord[] = [];
  const modelRequests: ModelRequest[] = [];
  const events = [...(options.events ?? [])];
  const state = options.state ?? createTestState();
  const runSideEffects = options.sideEffects === "run";
  // The SDK's own steps (parameters, state) aren't the workflow's.
  const log = (record: StepRecord): void => {
    if (!record.name.startsWith("$")) {
      steps.push(record);
    }
  };

  const receive = (type: string): EngineEvent => {
    const index = events.findIndex((event) => event.type === type);
    if (index !== -1) {
      const [event] = events.splice(index, 1);
      return { received: true, payload: event?.payload };
    }
    const answer = type.startsWith(decisionEventPrefix)
      ? byStepName(options.decisions, type.slice(decisionEventPrefix.length))
      : undefined;
    return answer ? { received: true, payload: answer } : { received: false };
  };

  const engine: WorkflowEngine = {
    runId: runIdSchema.parse(options.runId ?? "run-1"),
    params: options.params ?? {},
    do: async (name, { retries, sideEffect = false, input }, fn) => {
      if (recorded.has(name)) {
        // SAFETY: only `do` records under a name, with the result of the
        // same step, which a deterministic workflow asks for with the same T.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
        return recorded.get(name) as Awaited<ReturnType<typeof fn>>;
      }
      const call = { name, ...(input === undefined ? {} : { input }) };
      const failure = byStepName(options.failures, name);
      const mock = byStepName(options.mocks, name);
      try {
        if (failure !== undefined) {
          throw new Error(failure);
        }
        let status: "ran" | "mocked" | "recorded" = "ran";
        let output: unknown;
        if (mock !== undefined) {
          status = "mocked";
          output = typeof mock === "function" ? await mock(call) : mock;
        } else if (sideEffect && !runSideEffects) {
          status = "recorded";
        } else {
          output = await attempt(retries ?? 0, fn);
        }
        recorded.set(name, output);
        log({ type: "step", ...call, sideEffect, status, output });
        // SAFETY: a mock stands in for the step's result, and a side effect
        // that isn't run has none; the test decides what the step returns.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
        return output as Awaited<ReturnType<typeof fn>>;
      } catch (error) {
        log({
          type: "step",
          ...call,
          sideEffect,
          status: "failed",
          error: errorMessage(error),
        });
        throw error;
      }
    },
    sleep: async (name, milliseconds) => {
      if (!recorded.has(name)) {
        recorded.set(name, null);
        log({ type: "sleep", name, milliseconds });
        options.skipTime?.(milliseconds);
      }
      await Promise.resolve();
    },
    waitForEvent: async (name, { type, timeout }) => {
      const replayed = recorded.get(name);
      if (replayed !== undefined) {
        // SAFETY: only this method records under a wait's name.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
        return replayed as EngineEvent;
      }
      const event = receive(type);
      recorded.set(name, event);
      log({
        type: "wait",
        name,
        eventType: type,
        ...(timeout === undefined ? {} : { timeout }),
        event,
      });
      if (!event.received && timeout !== undefined) {
        options.skipTime?.(timeout);
      }
      return await Promise.resolve(event);
    },
    callModel: async (request) => {
      modelRequests.push(request);
      if (!options.model) {
        throw new Error(
          `Step "${request.step}" asks a model: mock it, or give the test a model`
        );
      }
      return await options.model(request);
    },
    openDecision: async ({ step }) =>
      await Promise.resolve({
        link: `https://grasp.test/decisions/${step}`,
        eventType: `${decisionEventPrefix}${step}`,
      }),
    getState: async (key) => await Promise.resolve(state.values.get(key)),
    setState: async (key, value, idempotencyKey) => {
      if (!state.appliedWrites.has(idempotencyKey)) {
        state.appliedWrites.add(idempotencyKey);
        state.values.set(key, value);
      }
      await Promise.resolve();
    },
  };

  return { engine, steps, modelRequests, state };
};

/** What a test run or dry run needs besides the workflow. */
export interface TestRunOptions extends Omit<
  TestEngineOptions,
  "state" | "sideEffects" | "skipTime"
> {
  /** The run's input, e.g. the invoice that started it. */
  input?: unknown;
  /** The workflow's state when the run starts. */
  state?: Readonly<Record<string, JsonValue>>;
}

/** How a test run or dry run went. */
export type TestRun<Output = unknown> = (
  | { status: "completed"; output: Output }
  | { status: "failed"; error: Error }
) & {
  /** What each step did, in order. */
  steps: StepRecord[];
  /** The side effects the run would have had, and their input. */
  sideEffects: SideEffect[];
  /** The workflow's state after the run. */
  state: Record<string, JsonValue>;
};

/**
 * Runs a workflow once in memory. Side-effect steps are recorded, never run;
 * every other step runs unless it's mocked. Never throws for the workflow:
 * a run that fails comes back with its error.
 */
export const testRun = async <Output>(
  definition: WorkflowDefinition<Output>,
  { input, state: initialState, ...options }: TestRunOptions = {}
): Promise<TestRun<Output>> => {
  const { engine, steps, state } = createTestEngine({
    ...options,
    state: createTestState(initialState),
  });
  let outcome:
    | { status: "completed"; output: Output }
    | { status: "failed"; error: Error };
  try {
    outcome = {
      status: "completed",
      output: await definition.run(engine, input),
    };
  } catch (error) {
    outcome = {
      status: "failed",
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
  return {
    ...outcome,
    steps,
    sideEffects: steps.flatMap((record) =>
      record.type === "step" && record.sideEffect && record.status !== "failed"
        ? [
            {
              name: record.name,
              ...(record.input === undefined ? {} : { input: record.input }),
            },
          ]
        : []
    ),
    state: Object.fromEntries(state.values),
  };
};

// Reports

const describeValue = (value: unknown): string =>
  JSON.stringify(value) ?? "nothing";

const durationUnits = [
  ["week", 604_800_000],
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
  ["second", 1000],
] as const;

/** `3 days` for 259200000, in the largest unit that divides it. */
const describeDuration = (milliseconds: number): string => {
  const [unit, size] = durationUnits.find(
    ([, unitSize]) => milliseconds % unitSize === 0
  ) ?? ["millisecond", 1];
  const amount = milliseconds / size;
  return `${amount} ${unit}${amount === 1 ? "" : "s"}`;
};

const describeRecord = (record: StepRecord): string => {
  if (record.type === "sleep") {
    return `${record.name}: sleeps ${describeDuration(record.milliseconds)} (skipped)`;
  }
  if (record.type === "wait") {
    const waited = `${record.name}: waited for ${record.eventType}`;
    if (record.event.received) {
      return `${waited}, received ${describeValue(record.event.payload)}`;
    }
    return record.timeout === undefined
      ? `${waited}, none came`
      : `${waited}, none came within ${describeDuration(record.timeout)}`;
  }
  const input =
    record.input === undefined ? "" : ` ${describeValue(record.input)}`;
  if (record.status === "failed") {
    return `${record.name}${input}: failed: ${record.error}`;
  }
  if (record.status === "recorded") {
    return `${record.name}${input}: would change something, not run`;
  }
  return `${record.name}${input}: ${record.status}, returned ${describeValue(record.output)}`;
};

/** A dry run and its report. */
export type DryRun<Output = unknown> = TestRun<Output> & {
  /** What the run did and would have changed, for a person to read. */
  report: string;
};

/**
 * Runs a workflow without changing anything: every step that only reads
 * runs, and every side-effect step is recorded with its input instead.
 * Reports the steps, their input and output, and what would have been
 * written. What the read steps call (connectors, stand-ins) is up to the
 * definition; the runtime gives it read-only connectors.
 */
export const dryRun = async <Output>(
  definition: WorkflowDefinition<Output>,
  options: TestRunOptions = {}
): Promise<DryRun<Output>> => {
  const run = await testRun(definition, options);
  const writes = run.sideEffects.map(
    ({ name, input }) =>
      `- ${name}${input === undefined ? "" : ` ${describeValue(input)}`}`
  );
  const report = [
    `Dry run of ${definition.metadata.id}`,
    run.status === "completed"
      ? `Completed with ${describeValue(run.output)}`
      : `Failed: ${run.error.message}`,
    "",
    "Steps:",
    ...run.steps.map((record) => `- ${describeRecord(record)}`),
    "",
    "Would have changed:",
    ...(writes.length === 0 ? ["- nothing"] : writes),
  ].join("\n");
  return { ...run, report };
};

// Tests

/** One test of a workflow: a run, and what must come of it. */
export interface WorkflowTest extends TestRunOptions {
  name: string;
  expect: {
    /** The run completes with this output. */
    output?: unknown;
    /** The run fails with an error whose message contains this. */
    error?: string;
    /** Exactly these side effects, in this order, with this input. */
    sideEffects?: SideEffect[];
  };
}

/** A workflow and the tests that ship with it. */
export interface WorkflowTests<Output = unknown> {
  definition: WorkflowDefinition<Output>;
  tests: WorkflowTest[];
}

/**
 * Declares a workflow's tests; the default export of the `*.test.ts` file
 * next to the workflow. A test expects the run to complete unless it names
 * an `error`.
 */
export const workflowTests = <Output>(
  definition: WorkflowDefinition<Output>,
  tests: WorkflowTest[]
): WorkflowTests<Output> => ({ definition, tests });

/** How one test went. */
export interface TestResult {
  name: string;
  passed: boolean;
  /** Why it failed, one line per expectation it missed. */
  failures: string[];
}

/** How a workflow's tests went. */
export interface TestReport {
  /** Every test passed, and there is at least one. */
  passed: boolean;
  results: TestResult[];
}

// JSON with sorted keys, so equal values compare equal whatever the order.
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, nested: unknown) =>
    typeof nested === "object" && nested !== null && !Array.isArray(nested)
      ? Object.fromEntries(
          Object.entries(nested).toSorted(([a], [b]) => a.localeCompare(b))
        )
      : nested
  ) ?? "undefined";

const missedExpectations = (test: WorkflowTest, run: TestRun): string[] => {
  const { expect } = test;
  const missed: string[] = [];
  if (expect.error === undefined && run.status === "failed") {
    missed.push(
      `Expected the run to complete; it failed: ${run.error.message}`
    );
  }
  if (expect.error !== undefined) {
    if (run.status === "completed") {
      missed.push(
        `Expected the run to fail with "${expect.error}"; it completed`
      );
    } else if (!run.error.message.includes(expect.error)) {
      missed.push(
        `Expected the run to fail with "${expect.error}"; it failed with "${run.error.message}"`
      );
    }
  }
  if (
    Object.hasOwn(expect, "output") &&
    run.status === "completed" &&
    canonical(run.output) !== canonical(expect.output)
  ) {
    missed.push(
      `Expected output ${canonical(expect.output)}; got ${canonical(run.output)}`
    );
  }
  if (
    expect.sideEffects !== undefined &&
    canonical(run.sideEffects) !== canonical(expect.sideEffects)
  ) {
    missed.push(
      `Expected side effects ${canonical(expect.sideEffects)}; got ${canonical(run.sideEffects)}`
    );
  }
  return missed;
};

/**
 * Runs a workflow's tests, one after another. Activation refuses a version
 * whose report hasn't `passed`; a workflow without tests doesn't pass.
 */
export const runWorkflowTests = async <Output>({
  definition,
  tests,
}: WorkflowTests<Output>): Promise<TestReport> => {
  const results: TestResult[] = [];
  for (const test of tests) {
    const { name, expect: _expect, ...options } = test;
    // oxlint-disable-next-line no-await-in-loop -- tests run one at a time
    const run = await testRun(definition, options);
    const failures = missedExpectations(test, run);
    results.push({ name, passed: failures.length === 0, failures });
  }
  return {
    passed: results.length > 0 && results.every(({ passed }) => passed),
    results,
  };
};
