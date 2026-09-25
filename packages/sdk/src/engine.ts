// The engine adapter's entry point (`@grasp-os/sdk/engine`); workflow code never imports it.
import type { RunId } from "@grasp-os/shared/ids";
import type { Json } from "@grasp-os/shared/json";
import { z } from "zod";

/** A value that survives being recorded by the engine and read back. */
export type JsonValue = Json;

/** What a durable wait ends with: the event, or nothing before the timeout. */
export type EngineEvent =
  | { received: true; payload: unknown }
  | { received: false };

/** One call to the model gateway, made on behalf of an AI step. */
export interface ModelRequest {
  /** The step the call is made for, for the audit log and cost reporting. */
  step: string;
  model: string;
  /** What the model is asked to do. */
  instructions: string;
  /** What it works on. */
  input: JsonValue;
  /** The model must answer with JSON that matches this schema. */
  outputSchema: z.core.JSONSchema.JSONSchema;
}

/**
 * A decision is answered with an event carrying this payload. The runtime
 * checks that the person answering is allowed to before it sends the event.
 */
export const decisionAnswerSchema = z.object({
  approved: z.boolean(),
  /** The person who answered. */
  by: z.string().min(1),
  comment: z.string().optional(),
});
export type DecisionAnswer = z.infer<typeof decisionAnswerSchema>;

/** How the delay between attempts grows. */
export type Backoff = "constant" | "linear" | "exponential";

/**
 * How often to try a failing step again. `limit` counts retries, not
 * attempts: `limit: 2` is three attempts in all.
 */
export interface EngineRetries {
  limit: number;
  /** Before the first retry, in milliseconds; the engine's when missing. */
  delay?: number;
  /** The engine's when missing. */
  backoff?: Backoff;
}

/** What the SDK tells the engine about a step it runs. */
export interface EngineStepOptions {
  /** The engine's defaults when missing. */
  retries?: EngineRetries;
  /** How long one attempt may take, in milliseconds; the engine's when missing. */
  timeout?: number;
  /**
   * The step changes something outside Grasp. A dry run records it with its
   * input instead of running it.
   */
  sideEffect?: boolean;
  /** What the step works on, for run history and dry-run reports. */
  input?: JsonValue;
}

/**
 * What a durable runtime implements to run workflows written with
 * `@grasp-os/sdk/workflow`. Workflow code never sees it, so the engine
 * underneath (the cloud runtime now, on-prem later) can change without
 * touching a single workflow. It stays close to the common durable-execution
 * primitives (a named step whose result is recorded, a durable sleep, a
 * durable wait for an event), so any durable runtime maps onto it directly.
 *
 * Implemented once per run execution. A run can be replayed
 * from the start at any time: every method that takes a step name must return
 * the recorded outcome when that name already completed in this run.
 *
 * The SDK reads `params` and calls `callModel`, `openDecision`, `getState`
 * and `setState` only inside `do`, so they need not be durable themselves.
 *
 * Engines may keep only a failed step's error name and message (Cloudflare
 * Workflows does); the SDK puts what it needs to recover into both.
 */
export interface WorkflowEngine {
  readonly runId: RunId;
  /**
   * Parameter values people set, by name; missing ones use the default. The
   * SDK records them in the run's first step, so a run keeps the values it
   * started with even when people change them before it resumes.
   */
  readonly params: Readonly<Record<string, unknown>>;
  /**
   * Runs `fn` as a durable step and records its result. Retries a failing
   * `fn` as `retries` says and then fails the run with the last error. An
   * error for which `isNonRetryable` holds is a deterministic failure: fail
   * at once, without retrying (the Cloudflare adapter throws it on as a
   * `NonRetryableError`).
   */
  do: <T>(
    name: string,
    options: EngineStepOptions,
    fn: () => Promise<T>
  ) => Promise<T>;
  /** Durably pauses the run. */
  sleep: (name: string, milliseconds: number) => Promise<void>;
  /**
   * Durably waits for the first event of `type` sent to this run, for at
   * most `timeout` milliseconds (the SDK keeps it within 365 days).
   */
  waitForEvent: (
    name: string,
    options: { type: string; timeout: number }
  ) => Promise<EngineEvent>;
  /** Calls the model gateway and returns the model's JSON answer. */
  callModel: (request: ModelRequest) => Promise<unknown>;
  /**
   * Records that `from` is asked to decide on `step` in this run. Returns
   * where they answer, and the event type their answer arrives as.
   *
   * Idempotent per run and step: the SDK calls it inside a step, which a
   * crash before the step is recorded runs again, so a second call for the
   * same `step` returns what the first did and opens nothing new. (Closing a
   * decision once it's answered or times out belongs to the decisions work.)
   */
  openDecision: (request: {
    step: string;
    from: string;
  }) => Promise<{ link: string; eventType: string }>;
  /** Reads the workflow's key-value state, shared by all its runs. */
  getState: (key: string) => Promise<JsonValue | undefined>;
  /**
   * Writes the workflow's key-value state, shared by all its runs. Applies
   * each idempotency key once and ignores a repeat, so a step that wrote but
   * crashed before it was recorded can't overwrite a newer value on replay.
   */
  setState: (
    key: string,
    value: JsonValue,
    idempotencyKey: string
  ) => Promise<void>;
}

/**
 * Whether an error is a deterministic failure that trying again can't fix:
 * a bad parameter value, say. The SDK marks these with `nonRetryable: true`.
 */
export const isNonRetryable = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "nonRetryable" in error &&
  error.nonRetryable === true;
