import type { RunId } from "@grasp-os/shared/ids";
import { z } from "zod";

/** A value that survives being recorded by the engine and read back. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** What a durable wait ends with: the event, or nothing before the timeout. */
export type EngineEvent =
  | { received: true; payload: unknown }
  | { received: false };

/** One call to the model gateway, made on behalf of an AI step. */
export interface ModelRequest {
  /** The step the call is made for, for the audit log and cost reporting. */
  step: string;
  /** Model to use; the deployment's default when missing. */
  model?: string;
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
 * The SDK calls `callModel`, `openDecision`, `getState` and `setState` only
 * inside `do`, so they need not be durable themselves.
 */
export interface WorkflowEngine {
  readonly runId: RunId;
  /** Parameter values people set, by name; missing ones use the default. */
  readonly params: Readonly<Record<string, unknown>>;
  /**
   * Runs `fn` as a durable step and records its result. Retries a failing
   * `fn` up to `retries` more times (the engine's default when missing) and
   * then fails the run with the last error.
   */
  do: <T>(
    name: string,
    options: { retries?: number },
    fn: () => Promise<T>
  ) => Promise<T>;
  /** Durably pauses the run. */
  sleep: (name: string, milliseconds: number) => Promise<void>;
  /**
   * Durably waits for the first event of `type` sent to this run. Without a
   * timeout, waits as long as the engine allows.
   */
  waitForEvent: (
    name: string,
    options: { type: string; timeout?: number }
  ) => Promise<EngineEvent>;
  /** Calls the model gateway and returns the model's JSON answer. */
  callModel: (request: ModelRequest) => Promise<unknown>;
  /**
   * Records that `from` is asked to decide on `step` in this run. Returns
   * where they answer, and the event type their answer arrives as.
   */
  openDecision: (request: {
    step: string;
    from: string;
  }) => Promise<{ link: string; eventType: string }>;
  /** Reads the workflow's key-value state, shared by all its runs. */
  getState: (key: string) => Promise<JsonValue | undefined>;
  /** Writes the workflow's key-value state, shared by all its runs. */
  setState: (key: string, value: JsonValue) => Promise<void>;
}
