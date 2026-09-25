// What the runtime and the describer agree on about steps. Internal to the
// SDK: neither workflow code nor the runtime imports this module.

/**
 * How a step works: `exact` is plain code, `ai` asks a model for output of a
 * fixed shape, `decision` waits for a person, `wait` waits for time or an
 * event.
 */
export type StepKind = "exact" | "ai" | "decision" | "wait";

/** The kind of step each `step` method runs. */
export const stepKinds = {
  do: "exact",
  llm: "ai",
  decision: "decision",
  sleep: "wait",
  waitFor: "wait",
} as const satisfies Record<string, StepKind>;

export type StepMethod = keyof typeof stepKinds;

// Step names become part of engine step names and idempotency keys
// (`runId:name`), so they never contain `:`, `#` or `$`, which the SDK uses
// for per-item keys and its own step names.
export const namePattern = /^[A-Za-z][\w-]{0,63}$/u;

/**
 * The name the engine gets for a step: its name, `name:key` for a keyed step
 * (the key URI-encoded), plus `#part` for the parts of a decision
 * (`review#ask`). The SDK's own steps (parameters, state) start with `$`.
 */
export const engineStepPattern =
  /^(?<name>[A-Za-z][\w-]{0,63})(?::(?<key>[^#]+))?(?:#(?<part>[\w-]+))?$/u;
