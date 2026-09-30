import { messageOf } from "@grasp-os/shared/errors";
import { runIdSchema } from "@grasp-os/shared/ids";
import { canonicalJson } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";
import {
  inboundEmailIndexSchema,
  isRetryable,
  storedEmailSchema,
  workflowErrors,
} from "@grasp-os/shared/workflows";
import { z } from "zod";

import type {
  DecisionAnswer,
  EngineDecision,
  ModelRequest,
  WorkflowEngine,
  WorkflowEnv,
} from "./engine.ts";
import { durationUnits, engineStepPattern } from "./steps.ts";
import type { WorkflowDefinition } from "./workflow.ts";

/**
 * Test harness and dry runs for workflows. Runs a workflow in memory, with
 * the time-skipping and step-mocking of Temporal's test environment:
 *
 * - steps can be mocked by name, or made to fail;
 * - side-effect steps don't run: they're recorded with their input, so a
 *   test asserts what the workflow would change and a dry run reports it;
 * - decisions are answered up front, and a wait for one without an answer
 *   times out right away, as sleeps end right away.
 *
 * Every workflow ships with its tests next to it (`invoice.workflow-tests.ts`
 * beside `invoice.ts`), written with `workflowTests`, and `runWorkflowTests`
 * runs them, so a version whose tests fail is never activated. The suffix
 * isn't `.test.ts`: these aren't Vitest files. Only `workflows/<id>.ts`
 * (an id without dots) is a workflow: put shared code in a folder under
 * workflows/, such as workflows/lib/.
 */

/** A step's call, as a mock gets it. */
export interface StepCall {
  /** The step's name, with its key if it has one: `pay:inv-7`. */
  name: string;
  input?: Json;
}

/** A step's result instead of running it, or a function that computes it. */
export type StepMock = Json | ((call: StepCall) => Json | Promise<Json>);

/** What a step did in a test run. */
export type StepRecord =
  | {
      type: "step";
      /**
       * The step's name, with its key if it has one (`pay:inv-7`), or the
       * part of a decision (`review#ask`).
       */
      name: string;
      sideEffect: boolean;
      input?: Json;
      /**
       * `ran` for its function, `mocked` for a mocked result and `recorded`
       * for a side effect that didn't run, which has no result.
       */
      status: "ran" | "mocked" | "recorded";
      output: unknown;
    }
  | {
      type: "step";
      name: string;
      sideEffect: boolean;
      input?: Json;
      status: "failed";
      error: string;
    }
  | { type: "sleep"; name: string; milliseconds: number }
  | {
      type: "wait";
      name: string;
      eventType: string;
      timeout: number;
      /** What the wait ended with, or nothing before the timeout. */
      event: { received: true; payload: unknown } | { received: false };
    };

/** A side effect the run would have had, in the order it would happen. */
export interface SideEffect {
  name: string;
  input?: Json;
}

export interface TestEngineOptions {
  runId?: string;
  /** Parameter values people set, by name; missing ones use the default. */
  params?: Record<string, unknown>;
  /**
   * Stand-ins for the run's bindings (`env.OUTLOOK`), for steps that run;
   * none when missing, and mocked steps don't need them.
   */
  env?: WorkflowEnv;
  /**
   * Step results by step name, instead of running the step. A keyed step
   * takes the mock for `name:key` (the key as the workflow gives it), or
   * else the one for `name`. An AI step's mock is the model's answer, which
   * is still checked against its schema. A side-effect step that isn't
   * mocked has no result.
   */
  mocks?: Readonly<Record<string, StepMock>>;
  /** Steps that fail, by name (as for mocks), with this error message. */
  failures?: Readonly<Record<string, string>>;
  /** Answers the model gateway; an AI step without a mock fails without it. */
  model?: (request: ModelRequest) => unknown;
  /**
   * Answers to decisions by the decision's name (as for mocks). A decision
   * without an answer times out, after its reminder if it has one. Each
   * decision asks one stand-in person, `test-person`.
   */
  decisions?: Readonly<Record<string, DecisionAnswer>>;
  /**
   * The content of kept messages' attachments, by the message's `stored`
   * name, in the order its `attachments` lists them, for `readAttachment`.
   * Reading any other fails with `workflow.attachment_not_found`, as a
   * message another App received does.
   */
  attachments?: Readonly<Record<string, readonly Uint8Array[]>>;
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

interface StepName {
  /** With the key as the workflow gave it, not as the engine got it. */
  name: string;
  /** What a keyed step also answers to: its name without the key. */
  unkeyed?: string;
}

const stepNameOf = (engineName: string): StepName => {
  const groups = engineStepPattern.exec(engineName)?.groups;
  if (groups?.name === undefined || groups.key === undefined) {
    return { name: engineName };
  }
  const part = groups.part === undefined ? "" : `#${groups.part}`;
  return {
    name: `${groups.name}:${decodeURIComponent(groups.key)}${part}`,
    // The parts of a decision (`review#ask`) only match by their full name.
    ...(groups.part === undefined ? { unkeyed: groups.name } : {}),
  };
};

/** The value for a step: by its name and key, else by its name alone. */
const byStepName = <T>(
  values: Readonly<Record<string, T>> | undefined,
  { name, unkeyed }: StepName
): T | undefined => {
  if (values && Object.hasOwn(values, name)) {
    return values[name];
  }
  return values && unkeyed !== undefined && Object.hasOwn(values, unkeyed)
    ? values[unkeyed]
    : undefined;
};

/**
 * Runs `fn`, and again up to `retries` times while it fails with an error
 * that trying again may fix (`isRetryable`), as a real run does. Delays
 * and timeouts aren't simulated.
 */
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
      if (!isRetryable(error)) {
        break;
      }
    }
  }
  throw lastError;
};

/**
 * A failed step's error as some engines keep it: only its name and message
 * (Cloudflare Workflows does), so tests catch anything that relies on more.
 */
const asKept = (error: unknown): Error => {
  const kept = new Error(messageOf(error));
  if (error instanceof Error) {
    kept.name = error.name;
  }
  return kept;
};

/**
 * A step's result as an engine stores it: JSON text, or nothing. A result
 * that isn't JSON (a Date, a class) fails the step here, as it would when a
 * real engine stores it.
 */
const toStored = (step: string, result: unknown): string | undefined => {
  if (result === undefined) {
    return undefined;
  }
  if (!z.json().safeParse(result).success) {
    throw new Error(
      `Step "${step}" returned something that isn't JSON, which an engine can't store`
    );
  }
  return JSON.stringify(result);
};

// A fresh copy every time, so changing a result never changes its replays.
const fromStored = (stored: string | undefined): unknown =>
  stored === undefined ? undefined : JSON.parse(stored);

/**
 * An in-memory engine with the durable semantics workflows rely on: a step's
 * result is stored as JSON under its name, and running the workflow again on
 * the same engine replays it (completed steps return their stored result), as
 * a resume after a crash does.
 */
export const createTestEngine = (options: TestEngineOptions = {}) => {
  const recorded = new Map<string, unknown>();
  const results = new Map<string, string | undefined>();
  const steps: StepRecord[] = [];
  const modelRequests: ModelRequest[] = [];
  /** The decisions opened, once each. */
  const decisions: { step: string; from: string; deadline: number }[] = [];
  const runSideEffects = options.sideEffects === "run";
  // The SDK's own step (parameters) isn't the workflow's.
  const log = (record: StepRecord): void => {
    if (!record.name.startsWith("$")) {
      steps.push(record);
    }
  };

  // How many steps' functions run now: `readAttachment` works only inside one.
  let stepsRunning = 0;

  const engine: WorkflowEngine = {
    runId: runIdSchema.parse(options.runId ?? "run-1"),
    params: options.params ?? {},
    env: options.env ?? {},
    do: async (name, { retries, sideEffect = false, input }, fn) => {
      if (results.has(name)) {
        // SAFETY: only `do` stores under a name, with the result of the same
        // step, which a deterministic workflow asks for with the same T.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
        return fromStored(results.get(name)) as Awaited<ReturnType<typeof fn>>;
      }
      const step = stepNameOf(name);
      const call = {
        name: step.name,
        ...(input === undefined ? {} : { input }),
      };
      const failure = byStepName(options.failures, step);
      const mock = byStepName(options.mocks, step);
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
          stepsRunning += 1;
          try {
            output = await attempt(retries?.limit ?? 0, fn);
          } finally {
            stepsRunning -= 1;
          }
        }
        const stored = toStored(step.name, output);
        results.set(name, stored);
        log({
          type: "step",
          ...call,
          sideEffect,
          status,
          output: fromStored(stored),
        });
        // A copy of its own: the workflow may change what it gets back,
        // which must not change the record above.
        // SAFETY: a mock stands in for the step's result, and a side effect
        // that isn't run has none; the test decides what the step returns.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
        return fromStored(stored) as Awaited<ReturnType<typeof fn>>;
      } catch (error) {
        log({
          type: "step",
          ...call,
          sideEffect,
          status: "failed",
          error: messageOf(error),
        });
        throw asKept(error);
      }
    },
    sleep: async (name, milliseconds) => {
      if (!recorded.has(name)) {
        recorded.set(name, null);
        log({ type: "sleep", name: stepNameOf(name).name, milliseconds });
        options.skipTime?.(milliseconds);
      }
      await Promise.resolve();
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
    // Idempotent per step, as the engine contract asks: opening a decision
    // again (a crash before its step was recorded) opens nothing new. A
    // decision's ID here is its step.
    openDecision: async ({ step, from, timeout }) => {
      let opened = decisions.find((decision) => decision.step === step);
      if (!opened) {
        opened = { step, from, deadline: Date.now() + timeout };
        decisions.push(opened);
      }
      return await Promise.resolve({
        decision: step,
        deadline: opened.deadline,
      });
    },
    decisionRecipients: async (decision) =>
      await Promise.resolve([
        {
          userId: "test-person",
          name: "Test Person",
          email: "test-person@grasp.test",
          link: `https://grasp.test/decisions/${decision}`,
        },
      ]),
    waitForDecision: async (name, { decision, timeout }) => {
      const replayed = recorded.get(name);
      if (replayed !== undefined) {
        // SAFETY: only this method records under a decision wait's name.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
        return replayed as EngineDecision;
      }
      const answer = byStepName(options.decisions, stepNameOf(decision));
      const outcome: EngineDecision = answer
        ? {
            answered: true,
            approved: answer.approved,
            by: answer.by,
            payload: answer.payload ?? null,
          }
        : { answered: false };
      recorded.set(name, outcome);
      log({
        type: "wait",
        name: stepNameOf(name).name,
        eventType: `decision:${stepNameOf(decision).name}`,
        timeout,
        event: answer
          ? { received: true, payload: outcome }
          : { received: false },
      });
      if (!answer) {
        options.skipTime?.(timeout);
      }
      return await Promise.resolve(outcome);
    },
    // Refuses as the platform does, but records nothing.
    readAttachment: async (stored, index) => {
      if (stepsRunning === 0) {
        throw workflowErrors.create("workflow.outside_step");
      }
      if (stored === null) {
        throw workflowErrors.create("workflow.attachment_not_found");
      }
      if (
        !storedEmailSchema.safeParse(stored).success ||
        !inboundEmailIndexSchema.safeParse(index).success
      ) {
        throw workflowErrors.create("workflow.invalid");
      }
      const content =
        stored !== undefined &&
        index !== undefined &&
        options.attachments &&
        Object.hasOwn(options.attachments, stored)
          ? options.attachments[stored]?.[index]
          : undefined;
      if (content === undefined) {
        throw workflowErrors.create("workflow.attachment_not_found");
      }
      // A copy of its own, as each read on the platform is.
      return await Promise.resolve(new Uint8Array(content));
    },
  };

  return { engine, steps, modelRequests, decisions };
};

/** What a test run or dry run needs besides the workflow. */
export interface TestRunOptions extends Omit<
  TestEngineOptions,
  "sideEffects" | "skipTime"
> {
  /** The run's input, e.g. the invoice that started it. */
  input?: unknown;
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
};

/**
 * Runs a workflow once in memory. Side-effect steps are recorded, never run,
 * whatever the options say: a test's options come from the App's code, and
 * a dry run (`dryRun`) runs on them too. Every other step runs unless it's
 * mocked. Never throws for the workflow: a run that fails comes back with
 * its error.
 */
export const testRun = async <Output>(
  definition: WorkflowDefinition<Output>,
  { input, ...options }: TestRunOptions = {}
): Promise<TestRun<Output>> => {
  const { engine, steps } = createTestEngine({
    ...options,
    // Last, so no option sets it: `TestRunOptions` has no `sideEffects`,
    // but untyped options (a test file's, sent to core) may.
    sideEffects: "record",
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
  };
};

// Reports

// Values as an engine stores them (through JSON), in canonical JSON, so
// equal values compare equal whatever order their keys are in.
const canonical = (value: unknown): string => {
  const stored = JSON.stringify(value);
  if (stored === undefined) {
    return "undefined";
  }
  // SAFETY: parsing JSON text always gives a JSON value.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  const parsed = JSON.parse(stored) as Json;
  return canonicalJson(parsed);
};

const describeValue = (value: unknown): string =>
  JSON.stringify(value) ?? "nothing";

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
    return `${waited}, none came within ${describeDuration(record.timeout)}`;
  }
  const input =
    record.input === undefined ? "" : ` ${describeValue(record.input)}`;
  if (record.status === "failed") {
    return `${record.name}${input}: failed: ${record.error}`;
  }
  if (record.status === "recorded") {
    return `${record.name}${input}: would change something, not run, so it has no result`;
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
  // Whatever the run did after a side effect without a result may differ
  // from a real run, where that side effect returns something.
  const withoutResult = run.steps.flatMap((record) =>
    record.type === "step" && record.status === "recorded" ? [record.name] : []
  );
  const report = [
    `Dry run of ${definition.metadata.id}`,
    run.status === "completed"
      ? `Completed with ${describeValue(run.output)}`
      : `Failed: ${run.error.message}`,
    ...(withoutResult.length === 0
      ? []
      : [
          `Side effects that didn't run have no result, which a real run may use: ${withoutResult.join(", ")}`,
        ]),
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
 * Declares a workflow's tests; the default export of the
 * `*.workflow-tests.ts` file next to the workflow. A test expects the run to
 * complete unless it names an `error`.
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
