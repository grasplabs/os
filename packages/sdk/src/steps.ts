// What the runtime and the describer agree on about steps. Internal to the
// SDK: neither workflow code nor the runtime imports this module.

import { z } from "zod";

import { paramValueSchemas } from "./params.ts";
import type { DecisionRequest } from "./workflow.ts";

/**
 * How a step works: `exact` is plain code, `ai` asks a model for output of a
 * fixed shape, `decision` waits for a person, `wait` waits for time or an
 * event.
 */
export type StepKind = "exact" | "ai" | "decision" | "wait";

// Step names become part of engine step names and idempotency keys
// (`runId:name`), so they never contain `:`, `#` or `$`, which the SDK uses
// for per-item keys and its own step names.
export const namePattern = /^[A-Za-z][\w-]{0,63}$/u;

/** What {@link namePattern} allows, for error messages. */
export const nameRule =
  'up to 64 letters, digits, "-" or "_", starting with a letter';

/**
 * The name the engine gets for a step: its name, `name:key` for a keyed step
 * (the key URI-encoded), plus `#part` for the parts of a decision
 * (`review#ask`). The SDK's own steps (parameters, state) start with `$`.
 */
export const engineStepPattern = new RegExp(
  // namePattern without its anchors.
  `^(?<name>${namePattern.source.slice(1, -1)})(?::(?<key>[^#]+))?(?:#(?<part>[\\w-]+))?$`,
  "u"
);

// Durations

/** The units a duration is written in, largest first, in milliseconds. */
export const durationUnits = [
  ["week", 604_800_000],
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
  ["second", 1000],
] as const;

const unitMilliseconds = new Map<string, number>(durationUnits);
const durationPattern =
  /^(?<amount>\d+(?:\.\d+)?) (?<unit>second|minute|hour|day|week)s?$/u;
/** The longest wait the SDK allows, which every engine it targets supports. */
const maxDuration = 365 * 86_400_000;

const millisecondsOf = (duration: number | string): number => {
  if (typeof duration === "number") {
    return duration;
  }
  const match = durationPattern.exec(duration);
  return match
    ? Number(match.groups?.amount) *
        (unitMilliseconds.get(match.groups?.unit ?? "") ?? Number.NaN)
    : Number.NaN;
};

/**
 * A time span, e.g. `"3 days"` or a number of milliseconds, as whole
 * milliseconds between 1 and 365 days' worth.
 */
export const durationSchema = z
  .union([z.number(), z.string()])
  .transform((duration, context) => {
    const milliseconds = millisecondsOf(duration);
    if (
      !Number.isInteger(milliseconds) ||
      milliseconds <= 0 ||
      milliseconds > maxDuration
    ) {
      context.issues.push({
        code: "custom",
        input: duration,
        message: `"${duration}" isn't a duration of whole milliseconds, up to 365 days, e.g. "3 days"`,
      });
      return z.NEVER;
    }
    return milliseconds;
  });

// Step options

/**
 * How the describer reads an option in the code: `literal` must be written
 * as a literal, `param` as a parameter (`params.reviewer`), `value` as
 * either (or an object of literals), and `code` as any expression.
 */
export type OptionForm = "literal" | "param" | "value" | "code";

/** The form of each option schema, for the describer. */
export const optionForms = z.registry<{ form: OptionForm }>();

const option = <Schema extends z.ZodType>(
  schema: Schema,
  form: OptionForm
): Schema => {
  const registered: z.ZodType = schema;
  optionForms.add(registered, { form });
  return schema;
};

const maxKeyLength = 128;
const text = z.string().trim().min(1);

const common = {
  description: option(text, "literal"),
  key: option(
    z
      .union([
        // Encoded into the engine's step name; ill-formed text can't be.
        z
          .string()
          .refine(
            (key) =>
              key !== "" &&
              key.isWellFormed() &&
              encodeURIComponent(key).length <= maxKeyLength
          ),
        z.number().refine(Number.isFinite),
      ])
      .optional(),
    "code"
  ),
};

const retries = option(
  z
    .strictObject({
      // Cloudflare Workflows allows at most this many.
      limit: z.int().min(0).max(10_000),
      delay: durationSchema.optional(),
      backoff: z.enum(["constant", "linear", "exponential"]).optional(),
    })
    .optional(),
  "value"
);
const attemptTimeout = option(durationSchema.optional(), "value");
const zodSchema = z.custom<z.ZodType>((value) => value instanceof z.ZodType);

/**
 * What each `step` method takes. One schema per method checks a call's
 * options at run time and tells the describer which options there are,
 * which are required and how each must be written.
 */
export const stepOptionSchemas = {
  do: z
    .strictObject({
      ...common,
      sideEffect: option(z.boolean().optional(), "literal"),
      locked: option(z.boolean().optional(), "literal"),
      retries,
      timeout: attemptTimeout,
      input: option(z.json().optional(), "code"),
    })
    .refine(
      (options) => options.sideEffect !== true || options.input !== undefined,
      {
        message:
          "A step that changes something needs `input`: what it writes, or null",
      }
    ),
  llm: z.strictObject({
    ...common,
    model: option(paramValueSchemas.model, "param"),
    instructions: option(text, "literal"),
    input: option(z.json(), "code"),
    schema: option(zodSchema, "code"),
    retries,
    timeout: attemptTimeout,
  }),
  decision: z
    .strictObject({
      ...common,
      from: option(paramValueSchemas.person, "param"),
      ask: option(
        z.custom<(request: DecisionRequest) => Promise<void>>(
          (value) => typeof value === "function"
        ),
        "code"
      ),
      timeout: option(durationSchema, "value"),
      remindAfter: option(durationSchema.optional(), "value"),
    })
    .refine(
      ({ timeout, remindAfter }) =>
        remindAfter === undefined || remindAfter < timeout,
      { message: "A decision must remind before it times out" }
    ),
  sleep: z.strictObject({
    ...common,
    duration: option(durationSchema, "value"),
  }),
  waitFor: z.strictObject({
    ...common,
    type: option(text, "literal"),
    timeout: option(durationSchema, "value"),
    schema: option(zodSchema.optional(), "code"),
  }),
};

export type StepMethod = keyof typeof stepOptionSchemas;

/** The kind of step each `step` method runs. */
export const stepKinds: Record<StepMethod, StepKind> = {
  do: "exact",
  llm: "ai",
  decision: "decision",
  sleep: "wait",
  waitFor: "wait",
};
