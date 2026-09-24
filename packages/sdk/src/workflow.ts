/**
 * Workflow SDK. Workflow scripts import only this module, never the engine:
 * a small, typed, engine-agnostic API for durable steps plus governance
 * helpers (step.do, step.llm, step.decision, step.sleep, step.waitFor).
 */
import type { z } from "zod";

export interface StepOptions {
  /** Deterministic step: no model involvement. */
  locked?: boolean;
  /** Writes to an outside system; gets an idempotency key (runId:stepName). */
  sideEffect?: boolean;
}

export interface LlmOptions<T extends z.ZodType> {
  model: string;
  schema: T;
  from: unknown;
}

export interface Decision {
  approved: boolean;
  by: string;
}

export interface DecisionOptions {
  from: string;
  ask: (link: string) => Promise<unknown>;
}

export interface Step {
  do: <T>(
    name: string,
    options: StepOptions,
    fn: () => Promise<T>
  ) => Promise<T>;
  llm: <T extends z.ZodType>(
    name: string,
    options: LlmOptions<T>
  ) => Promise<z.infer<T>>;
  decision: (name: string, options: DecisionOptions) => Promise<Decision>;
  sleep: (name: string, duration: string | number) => Promise<void>;
  waitFor: <T>(name: string, event: string) => Promise<T>;
}

export type WorkflowFn<Input, Params> = (
  step: Step,
  input: Input,
  params: Params
) => Promise<unknown>;

export interface WorkflowDefinition<Input, Params> {
  name: string;
  run: WorkflowFn<Input, Params>;
}

export const workflow = <Input, Params>(
  name: string,
  run: WorkflowFn<Input, Params>
): WorkflowDefinition<Input, Params> => ({ name, run });
