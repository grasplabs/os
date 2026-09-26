import { runActorOf } from "@grasp-os/shared/audit";
import type { AuditActor } from "@grasp-os/shared/audit";
import { decidersSchema } from "@grasp-os/shared/decisions";
import { toHex } from "@grasp-os/shared/encoding";
import { isExpectedError } from "@grasp-os/shared/errors";
import { identifierSchema } from "@grasp-os/shared/ids";
import type { AppId, RunId, WorkflowId } from "@grasp-os/shared/ids";
import type { Json } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import { modelErrors } from "@grasp-os/shared/models";
import type { Authority } from "@grasp-os/shared/permissions";
import {
  isRetryable,
  stepIdempotencyKey,
  workflowErrors,
} from "@grasp-os/shared/workflows";
import type { InputShape } from "@grasp-os/shared/workflows";
import { RpcTarget } from "cloudflare:workers";
import type {
  WorkflowStepConfig,
  WorkflowTimeoutDuration,
} from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import type { AppAnswer, AppCallerInput } from "../app.ts";
import { auditedBatch, outboxed } from "../audit-outbox.ts";
import { forSandbox, requireStepKey, runStubCall } from "../bindings.ts";
import type { ConnectionGrant } from "../bindings.ts";
import {
  decisionDeadline,
  decisionEventType,
  decisionOutcome,
  decisionRecipients,
  openDecision,
} from "../decisions/decisions.ts";
import type {
  DecisionOutcome,
  DecisionRecipient,
} from "../decisions/decisions.ts";
import { appHost } from "../durable-objects.ts";
import { featureEnabled } from "../features.ts";
import type { Feature } from "../features.ts";
import { models } from "../models.ts";
import { requireActivePerson } from "../permissions.ts";
import type { Settled, StepError } from "./code.ts";

// The engine a run's workflow code runs on, as core's side of it: the SDK's
// `WorkflowEngine` (`@grasp-os/sdk/engine`) on Cloudflare's `step` API. The
// run's main module (code.ts) sends each engine call here over RPC. The
// isolate is untrusted, so everything it sends is checked, and what it can
// do is only this run's: steps, waits, model calls and state, all as this
// run and this workflow, for the person it acts for while they are there.
//
// Errors cross as plain data both ways (`Settled`). Cloudflare Workflows
// keeps only a failed step's name and message, and RPC carries errors'
// fields as the runtime sees fit; the SDK recovers its error codes from the
// name, so the name must come back as it was sent. Core's own errors reach
// the isolate as the sandbox sees them: expected ones as they are, anything
// else as `internal.unexpected`.

/** The run a host serves, as the dispatcher loaded it. */
export interface HostedRun {
  app: AppId;
  workflow: WorkflowId;
  version: number;
  runId: RunId;
  /** Who the run acts for in this execution. */
  authority: Authority;
  /** Its connection permissions, by binding name (`runBindingsFor`). */
  connections: Record<string, ConnectionGrant>;
}

/**
 * Cloudflare's `step`, as far as core uses it. Values are `unknown` here,
 * and checked as JSON where they are used: Workflows' own types for them
 * are more than the type checker can follow for recursive JSON.
 */
export interface RunStep {
  do: (
    name: string,
    config: WorkflowStepConfig,
    fn: () => Promise<unknown>
  ) => Promise<unknown>;
  sleep: (name: string, duration: number) => Promise<void>;
  waitForEvent: (
    name: string,
    options: { type: string; timeout: number | WorkflowTimeoutDuration }
  ) => Promise<{ payload: unknown }>;
}

/**
 * Core's own steps of a run start with this (dispatcher.ts), and a
 * workflow's never do, so workflow code can't replay one of them.
 */
export const coreStepPrefix = "$grasp:";

/** Core's own events start with this; a workflow can't wait for one. */
export const coreEventPrefix = "grasp-";

/**
 * One attempt of a step, while its function runs: whether connect held a
 * side effect of it (`held`), and whether it called its App's methods.
 */
interface StepAttempt {
  step: string;
  held: boolean;
  calledApp: boolean;
}

/** Why a run waits before a step. */
export type WaitReason =
  | { reason: "switched_off"; feature: Feature }
  | { reason: "held" };

/** The code a held side effect answers a run's call with (connect). */
const heldCode = "connect.held";

/**
 * What an attempt of a step answers when a side effect of it was held:
 * recorded as the step's result, so every execution replays it and waits
 * again. Workflow code can't return it (`do` refuses it).
 */
const heldMarker = { [`${coreStepPrefix}held`]: true };

const isHeldMarker = (value: unknown): boolean =>
  typeof value === "object" &&
  value !== null &&
  Object.hasOwn(value, `${coreStepPrefix}held`);

/** Longest step name taken: a key and a decision's part fit well within. */
const maxStepName = 256;

/** Control characters, which the engine refuses in a step's name. */
const controlCharacter = /\p{Cc}/u;

const stepNameSchema = z
  .string()
  .min(1)
  .max(maxStepName)
  .refine((name) => !name.startsWith(coreStepPrefix), {
    message: `Step names starting with "${coreStepPrefix}" are core's`,
  })
  .refine((name) => !controlCharacter.test(name), {
    message: "Step names can't hold control characters",
  });

/**
 * The most a step may return, as JSON in UTF-8: the engine refuses to
 * record more than 1 MiB, and fails the whole run when it does.
 */
const maxStepResultBytes = 1024 * 1024;

const milliseconds = z
  .int()
  .positive()
  .max(365 * 86_400_000);

const doOptionsSchema = z.object({
  retries: z
    .object({
      limit: z.int().min(0).max(10_000),
      delay: milliseconds.optional(),
      backoff: z.enum(["constant", "linear", "exponential"]).optional(),
    })
    .optional(),
  timeout: milliseconds.optional(),
  sideEffect: z.boolean().optional(),
  input: z.json().optional(),
  decision: z.boolean().optional(),
});

const waitOptionsSchema = z.object({
  type: z
    .string()
    .min(1)
    .max(100)
    .refine((type) => !type.startsWith(coreEventPrefix)),
  timeout: milliseconds,
});

/**
 * The largest output schema a model call takes, as JSON text. Its regular
 * expressions (Zod writes them for `z.email()`, `z.iso.date()` and the
 * like) run on the model's answer; one that backtracks badly is bounded by
 * the Worker's CPU limit, like any other expensive request.
 */
const maxSchemaLength = 32 * 1024;

const modelRequestSchema = z.object({
  step: stepNameSchema,
  model: z.string().min(1).max(200),
  instructions: z.string(),
  input: z.json(),
  outputSchema: z
    .record(z.string(), z.unknown())
    .refine((schema) => JSON.stringify(schema).length <= maxSchemaLength),
});

const decisionSchema = z.object({
  step: stepNameSchema,
  from: decidersSchema,
  description: z.string().min(1),
  timeout: milliseconds,
});

const decisionWaitSchema = z.object({
  decision: identifierSchema,
  timeout: z
    .int()
    .min(0)
    .max(365 * 86_400_000),
  last: z.boolean(),
});

/** A state key, as the SDK allows one: never with the `:` storage uses. */
const stateKeySchema = z.string().regex(/^[A-Za-z][\w-]{0,63}$/u);
const idempotencyKeySchema = z
  .string()
  .min(1)
  .max(maxStepName * 2);

/**
 * An error code the audit log may name: shaped like the platform's
 * (`permission.denied`), and short. Workflow code can put anything in an
 * error's `code`, and the log keeps no free text.
 */
const codePattern = /^[a-z][a-z_]*(?:\.[a-z][a-z_]*)+$/u;
const maxCodeLength = 64;
export const auditableCode = (code: unknown): string | undefined =>
  typeof code === "string" &&
  code.length <= maxCodeLength &&
  codePattern.test(code)
    ? code
    : undefined;

/** The most of an isolate's error that is kept. */
const maxErrorName = 100;
const maxErrorMessage = 2000;

/** An error the isolate sent, cut to size, with only a well-formed code. */
const isolateErrorSchema = z
  .object({
    name: z.string(),
    message: z.string(),
    code: z.unknown().optional(),
  })
  .transform(({ name, message, code }): StepError => {
    const kept = auditableCode(code);
    return {
      name: name.slice(0, maxErrorName),
      message: message.slice(0, maxErrorMessage),
      ...(kept === undefined ? {} : { code: kept }),
    };
  });

/** How a step's function ended, as the isolate reports it. */
const settledSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: z.unknown() }),
  z.object({ ok: z.literal(false), error: isolateErrorSchema }),
]);

/**
 * What the isolate sent, as `schema` has it; `workflow.invalid` when it
 * doesn't fit (a step name of core's, say).
 */
const checked = <Schema extends z.ZodType>(
  schema: Schema,
  value: unknown
): z.output<Schema> => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw workflowErrors.create("workflow.invalid");
  }
  return parsed.data;
};

/**
 * How a call into the isolate ended, as it reports it; a report that isn't
 * one is a failure.
 */
export const fromIsolate = (value: unknown): Settled<unknown> => {
  const parsed = settledSchema.safeParse(value);
  return parsed.success
    ? parsed.data
    : {
        ok: false,
        error: {
          name: "Error",
          message: workflowErrors.create("workflow.invalid").message,
          code: "workflow.invalid",
        },
      };
};

/** Cloudflare Workflows' delay before a retry when the SDK names none. */
const defaultRetryDelayMs = 10_000;

/** The step config Cloudflare takes; its defaults where the SDK gave none. */
const stepConfig = ({
  retries,
  timeout,
}: z.output<typeof doOptionsSchema>): WorkflowStepConfig => ({
  ...(retries === undefined
    ? {}
    : {
        retries: {
          limit: retries.limit,
          delay: retries.delay ?? defaultRetryDelayMs,
          backoff: retries.backoff ?? "exponential",
        },
      }),
  ...(timeout === undefined ? {} : { timeout }),
});

/**
 * How a wait or an attempt that ran out of time ends in Cloudflare
 * Workflows: a `WorkflowTimeoutError`, whose name doesn't always survive
 * the way to core, but whose message does ("Execution timed out after
 * 500ms").
 */
const timedOut = /^(?:WorkflowTimeoutError: )?Execution timed out\b/u;
const isTimeout = (error: unknown): boolean =>
  error instanceof Error &&
  (error.name === "WorkflowTimeoutError" || timedOut.test(error.message));

/**
 * How the engine stops an execution it will resume or end itself, when
 * someone pauses, terminates (cancels), restarts or deletes the run: in
 * the local runtime (Miniflare), an `Error` "Aborting engine: User called
 * pause" and so on, maybe with the name in front once it crossed to core.
 * The engine also aborts with "Aborting engine: …" when it fails a run
 * itself (a NonRetryableError, a value it can't serialise, the storage
 * limit): those, like any other error of the engine's (a step name it
 * refuses, the step limit, a storage failure), are real failures.
 * TODO(GRA-44): confirm that production's engine stops with these same
 * messages.
 */
const userStop =
  /^(?:\w+: )?Aborting engine: User called (?:pause|terminate|restart|delete)$/u;
export const isEngineStop = (error: unknown): boolean =>
  error instanceof Error && userStop.test(error.message);

/**
 * The engine's limit on steps in one execution: Cloudflare's default, as
 * wrangler.jsonc sets no `limits.steps`. Only tests lower it, the
 * engine's and this one alike (`WORKFLOW_STEP_LIMIT`, vite.config.ts).
 */
const defaultStepLimit = 10_000;

/**
 * Steps kept back for core's own (`$grasp:…`), so the step that records
 * how the run ended always fits, with room to spare. A run's own steps
 * are refused this far short of the limit; past the limit, the engine
 * would refuse core's end too.
 */
const coreStepReserve = 5;

/**
 * The sleeps a run waits in while a feature is switched off. They are
 * core's (workflow code can't name one), but count as the run's own
 * against the reserve, so waiting can't use up the steps core's end needs.
 */
const offStepPrefix = `${coreStepPrefix}off:`;

/**
 * How long a run first waits before it checks a switched-off feature
 * again; each wait after doubles, up to {@link maxOffWaits} times this.
 */
const defaultOffWaitMs = 60_000;

/** The longest wait between checks, in first waits: 15 minutes. */
const maxOffWaits = 15;

/**
 * Tries of one check whether a held side effect still waits, after the
 * first: a connect that fails that often in a row fails the step.
 */
const heldCheckRetries = 5;

/**
 * A short, stable key for the step `name` a wait holds, as the wait's own
 * step names take it: a step's name can be as long as a step name may be.
 */
const offKeyOf = async (name: unknown): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(String(name))
  );
  return toHex(new Uint8Array(digest)).slice(0, 16);
};

/** The first wait between checks for this deployment; tests shorten it. */
const offWaitOf = (env: Env): number => {
  const set = Number(env.WORKFLOW_OFF_WAIT_MS);
  return Number.isInteger(set) && set > 0 && set < defaultOffWaitMs
    ? set
    : defaultOffWaitMs;
};

/** The engine's step limit for this deployment. */
export const stepLimitOf = (env: Env): number => {
  const set = Number(env.WORKFLOW_STEP_LIMIT);
  return Number.isInteger(set) && set > 0 && set < defaultStepLimit
    ? set
    : defaultStepLimit;
};

/**
 * Whether the engine threw an attempt's own error back: that error, or
 * its copy, which has only the message, maybe with the name in front.
 */
const isAttemptError = (error: unknown, attempt: unknown): boolean =>
  error === attempt ||
  (error instanceof Error &&
    attempt instanceof Error &&
    (error.message === attempt.message ||
      error.message.endsWith(`: ${attempt.message}`)));

/**
 * `step`, telling `engineStopped` when one of its calls throws the error
 * the engine stops the execution with (`isEngineStop`): a pause or a
 * cancel, after which the run goes on, or ends, in the engine's hands.
 * The dispatcher hands that error back (dispatcher.ts). A step's own
 * error, from any of its attempts, never counts, even one shaped like a
 * stop: workflow code throws what it likes.
 *
 * It counts every call, as the engine may, and refuses the run's own
 * ones {@link coreStepReserve} short of `stepLimit`, as a failure of that
 * step.
 */
export const watchedStep = (
  step: RunStep,
  engineStopped: (error: unknown) => void,
  stepLimit: number
): RunStep => {
  let taken = 0;
  const take = (name: string): void => {
    taken += 1;
    const reserved =
      name.startsWith(coreStepPrefix) && !name.startsWith(offStepPrefix);
    if (!reserved && taken > stepLimit - coreStepReserve) {
      throw workflowErrors.create("workflow.too_many_steps");
    }
  };
  const heard = (error: unknown, attempts: ReadonlySet<unknown>): void => {
    const own = [...attempts].some((attempt) => isAttemptError(error, attempt));
    if (isEngineStop(error) && !own) {
      engineStopped(error);
    }
  };
  const none: ReadonlySet<unknown> = new Set();
  return {
    do: async (name, config, fn) => {
      // Every attempt's error: an attempt the engine gave up on may still
      // end, late, after the next one began.
      const attempts = new Set<unknown>();
      take(name);
      try {
        return await step.do(name, config, async () => {
          try {
            return await fn();
          } catch (error) {
            attempts.add(error);
            throw error;
          }
        });
      } catch (error) {
        heard(error, attempts);
        throw error;
      }
    },
    sleep: async (name, duration) => {
      take(name);
      try {
        await step.sleep(name, duration);
      } catch (error) {
        heard(error, none);
        throw error;
      }
    },
    waitForEvent: async (name, options) => {
      take(name);
      try {
        return await step.waitForEvent(name, options);
      } catch (error) {
        heard(error, none);
        throw error;
      }
    },
  };
};

/**
 * One of core's errors as the isolate, and the run's own record, may see
 * it: an expected error as it is, a timeout as one, anything else as
 * `internal.unexpected`, with the cause only in the log.
 */
export const forIsolate = (error: unknown): StepError => {
  if (isTimeout(error)) {
    return { name: "TimeoutError", message: "The step ran out of time." };
  }
  const seen = forSandbox(error);
  return {
    name: "Error",
    message: seen.message,
    ...(isExpectedError(seen) ? { code: seen.code } : {}),
  };
};

/** How `run` ended, as plain data. */
export const settle = async <T>(run: () => Promise<T>): Promise<Settled<T>> => {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, error: forIsolate(error) };
  }
};

/**
 * A step's error as the engine gets it: retried, with the step's retry
 * settings, only when trying again may fix it (`isRetryable`: a rate
 * limit, a server that took nothing, a timeout); anything else is
 * non-retryable, and stops the run. The engine knows a non-retryable error
 * by its name, so it keeps that name; the step's own error is reported
 * from what the isolate sent (`do`).
 */
const toStepError = (error: StepError): Error => {
  if (!isRetryable(error)) {
    return new NonRetryableError(error.message);
  }
  const thrown = new Error(error.message);
  thrown.name = error.name;
  return thrown;
};

/**
 * Runs `call` for the step attempt `attempt`, noting when it answered that
 * a side effect was held, whatever the workflow code does with the error.
 */
const heldNoted = async <T>(
  attempt: { held: boolean },
  call: () => Promise<T>
): Promise<T> => {
  try {
    return await call();
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === heldCode
    ) {
      attempt.held = true;
    }
    throw error;
  }
};

/** Most fields of a step's input a failure report names. */
const maxShapeFields = 20;

/**
 * A field name a failure report may show: letters, `_` and `-` only, and
 * short, like the names code gives fields; so never an email address, an
 * ID or other data used as a key.
 */
const fieldNamePattern = /^[A-Za-z_][A-Za-z_-]{0,31}$/u;

const typeOf = (value: Json | undefined): string => {
  if (value === null) {
    return "null";
  }
  return Array.isArray(value) ? "array" : typeof value;
};

/**
 * What a failure report keeps of a step's input (`InputShape`): its type,
 * and for an object the names and types of the fields `fieldNamePattern`
 * lets through, no values. The input can hold anything the run read (a
 * message's text, a person's details), and the report outlives the run.
 */
const inputShape = (input: Json | undefined): InputShape | null => {
  if (input === undefined) {
    return null;
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return typeOf(input);
  }
  const shape: Record<string, string> = {};
  let shown = 0;
  let others = 0;
  for (const [field, value] of Object.entries(input)) {
    if (shown < maxShapeFields && fieldNamePattern.test(field)) {
      shape[field] = typeOf(value);
      shown += 1;
    } else {
      others += 1;
    }
  }
  // No field name takes this form, so it can't stand for a field.
  if (others > 0) {
    shape["…"] = `${others} more`;
  }
  return shape;
};

/** A step that failed in an execution, as its failure report names it. */
export interface FailedStep {
  step: string;
  input: InputShape | null;
  error: StepError;
}

/** How a host reaches back into the dispatcher (dispatcher.ts). */
export interface HostHooks {
  /** Hears of each step that failed, with the error it failed with. */
  stepFailed: (failure: FailedStep) => void;
  /**
   * Records that the run waits: while a feature is switched off, or while
   * a side effect of a step is held for the person it acts for.
   */
  waiting: (why: WaitReason) => Promise<void>;
  /** Calls a method of the run's App for `caller` (`callApp`). */
  callApp: (
    caller: AppCallerInput,
    method: string,
    args: unknown[]
  ) => Promise<AppAnswer>;
}

/**
 * One execution of a run, as its workflow code's engine. Every method
 * answers `Settled`, never throws, so the error the isolate sees is the
 * one sent.
 */
export class RunHost extends RpcTarget {
  readonly #env: Env;
  readonly #step: RunStep;
  readonly #run: HostedRun;
  readonly #hooks: HostHooks;
  /**
   * The step whose function runs now, one object per attempt, so an
   * abandoned attempt that ends late can't clear a newer one's.
   */
  #running: StepAttempt | undefined;

  constructor(env: Env, step: RunStep, run: HostedRun, hooks: HostHooks) {
    super();
    this.#env = env;
    this.#step = step;
    this.#run = run;
    this.#hooks = hooks;
  }

  get #actor(): AuditActor {
    return runActorOf(this.#run);
  }

  /**
   * Records how a step went, through the outbox. Every step the host ran
   * is recorded, the SDK's own (`$params`, `$state:…`) too: the isolate
   * names them, so a name is no reason to leave one out. A record that
   * can't be stored is logged, and the run goes on: the step happened.
   */
  async #audited(
    step: string,
    outcome: "completed" | "failed",
    detail: { sideEffect: boolean; errorCode?: string }
  ): Promise<void> {
    const { app, workflow, version, runId } = this.#run;
    const db = drizzle(this.#env.DB);
    try {
      await auditedBatch(this.#env, db, [
        outboxed(db, {
          actor: this.#actor,
          action: `workflow.step.${outcome}`,
          target: { type: "workflow_run", id: runId },
          detail: {
            app,
            workflow,
            version,
            step,
            sideEffect: detail.sideEffect,
            ...(detail.errorCode === undefined
              ? {}
              : { errorCode: detail.errorCode }),
          },
        }),
      ]);
    } catch (error) {
      log.error("workflow.step.audit_failed", {
        runId,
        step,
        ...errorFields(error),
      });
    }
  }

  /**
   * Waits, before the step `name`, while any of `features` is switched
   * off, then lets the run go on: a kill switch holds a run without
   * failing or pausing it, and nobody has to resume it.
   *
   * Each check is a durable sleep: a minute first (`offWaitOf`), doubling
   * up to 15 minutes. Each is one step of the run's budget, so a run waits
   * a long time (days at the default step limit), and past that its next
   * step fails with `workflow.too_many_steps`.
   *
   * The wait's steps are named after the step it holds, so they are the
   * same on every execution: a new execution replays the sleeps it already
   * slept (each returns at once) and goes on waiting. The wait is recorded
   * in a step of its own per feature waited on (`waiting`), so each
   * stretch is audited once for each, whatever the executions. That step's retries cover a failing audit
   * write; one that still fails is logged, and the run keeps waiting.
   */
  async #waitWhileOff(
    name: unknown,
    features: readonly Feature[]
  ): Promise<void> {
    await this.#waitWhile(
      async () => `${offStepPrefix}${await offKeyOf(name)}`,
      async () => {
        const off = features.find(
          (feature) => !featureEnabled(this.#env, feature)
        );
        return await Promise.resolve(
          off === undefined
            ? undefined
            : { reason: "switched_off" as const, feature: off }
        );
      }
    );
  }

  /**
   * Waits, before running the step `step` again, while a side effect it
   * asked for is held for the person the run acts for, as `#waitWhileOff`
   * waits: the same sleeps, recorded once per hold. But each check is a
   * step of its own (retried, and replayed without asking connect again),
   * so the wait takes about twice the step budget per check: about 52 days
   * at the default limit, against about 104 for a switched-off feature. A
   * decline or a drop ends the wait too: the step's next run fails with
   * `connect.declined`.
   */
  async #waitWhileHeld(step: string, prefix: string): Promise<void> {
    await this.#waitWhile(
      async () => await Promise.resolve(prefix),
      async (checks) => {
        // Each check is a step of its own, with retries of its own: its
        // answer is recorded, so a replay asks connect nothing, and a
        // failing connect is tried again rather than failing the step.
        const first = offWaitOf(this.#env);
        const held = await this.#step.do(
          `${prefix}:${checks}:check`,
          {
            retries: {
              limit: heldCheckRetries,
              delay: first,
              backoff: "exponential",
            },
          },
          async () => await this.#stillHeld(step)
        );
        return held === true ? { reason: "held" as const } : undefined;
      }
    );
  }

  /**
   * `#stillHeld`, or `true` when connect can't say: the step then waits,
   * and the wait's own checks, which retry, ask again.
   */
  async #stillHeldOrUnknown(step: string): Promise<boolean> {
    try {
      return await this.#stillHeld(step);
    } catch (error) {
      log.warn("workflow.held_check_failed", {
        runId: this.#run.runId,
        step,
        ...errorFields(error),
      });
      return true;
    }
  }

  /** Whether a side effect of the step `step` waits for the run's person. */
  async #stillHeld(step: string): Promise<boolean> {
    return await this.#env.CONNECT.anyPending({
      onBehalfOf: this.#run.authority.onBehalfOf,
      idempotencyKey: stepIdempotencyKey(this.#run.runId, step),
    });
  }

  /**
   * Waits while `waitingFor` names a reason: each check a durable sleep, a
   * minute first (`offWaitOf`), doubling up to 15 minutes, in steps named
   * after `prefixOf` (asked only once there is a wait). Each reason is
   * recorded once per wait, in a step of its own.
   */
  async #waitWhile(
    prefixOf: () => Promise<string>,
    waitingFor: (checks: number) => Promise<WaitReason | undefined>
  ): Promise<void> {
    let prefix: string | undefined;
    // Each reason the run waits on is recorded once: with two features
    // off, the run waits on the first, then on the other once the first
    // is on.
    const recorded = new Set<string>();
    for (let checks = 0; ; checks += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one check at a time
      const why = await waitingFor(checks);
      if (why === undefined) {
        return;
      }
      // oxlint-disable-next-line no-await-in-loop -- once per wait
      prefix ??= await prefixOf();
      const name = why.reason === "held" ? "held" : why.feature;
      if (!recorded.has(name)) {
        recorded.add(name);
        // oxlint-disable-next-line no-await-in-loop -- once per reason
        await this.#recordWaiting(`${prefix}:waiting:${name}`, why);
      }
      const first = offWaitOf(this.#env);
      // oxlint-disable-next-line no-await-in-loop -- one check at a time
      await this.#step.sleep(
        `${prefix}:${checks}`,
        Math.min(first * 2 ** checks, first * maxOffWaits)
      );
    }
  }

  /** Records, once in step `step`, that the run waits, and why. */
  async #recordWaiting(step: string, why: WaitReason): Promise<void> {
    try {
      await this.#step.do(step, {}, async () => {
        await this.#hooks.waiting(why);
        return null;
      });
    } catch (error) {
      if (isEngineStop(error)) {
        throw error;
      }
      log.error("workflow.waiting.audit_failed", {
        runId: this.#run.runId,
        ...why,
        ...errorFields(error),
      });
    }
  }

  /**
   * The person the run acts for must still be there: checked before every
   * step, and inside one (a model call, an App call, state). One who has
   * left fails the step, and with it the run.
   */
  async #requirePerson(): Promise<void> {
    await requireActivePerson(this.#env, this.#run.authority);
  }

  /**
   * Runs `fn` (in the isolate) as a durable step, with the SDK's retries
   * and timeout. A replay answers the recorded result, or throws the
   * recorded error, without calling it. Its outcome is audited, and a
   * failure reported (`stepFailed`), only when it was attempted in this
   * execution: a failure workflow code caught is replayed on every later
   * execution, and was recorded when it happened. A step that fails
   * before it starts (options that don't parse, a person who has left) is
   * neither: the run's own failure records it. While `workflows` is
   * switched off, or `decisions` for a step that opens or asks a
   * decision, the run waits before the step (`#waitWhileOff`). When a side
   * effect of the step is held for the person the run acts for, the step
   * ends as held, not failed, uses no retries, and the run waits the same
   * way until the person decided, then runs the step again under the same
   * key (`#waitWhileHeld`): confirmed, it gets the answer; declined or
   * dropped, it fails with `connect.declined`.
   */
  async do(
    name: unknown,
    options: unknown,
    fn: () => Promise<unknown>
  ): Promise<Settled<unknown>> {
    // Before the step's name and options are checked, which fail the step:
    // waiting mustn't. Options that don't parse wait for `workflows` only,
    // and fail below.
    const waited = await settle(async () => {
      const decision = doOptionsSchema.safeParse(options).data?.decision;
      await this.#waitWhileOff(
        name,
        decision === true ? ["workflows", "decisions"] : ["workflows"]
      );
    });
    if (!waited.ok) {
      return waited;
    }
    let failed: StepError | undefined;
    let attempted = false;
    let step = "";
    let sideEffect = false;
    let input: InputShape | null = null;
    try {
      step = checked(stepNameSchema, name);
      const parsed = checked(doOptionsSchema, options);
      sideEffect = parsed.sideEffect === true;
      input = inputShape(parsed.input);
      await this.#requirePerson();
      const attemptStep = async (): Promise<unknown> => {
        attempted = true;
        // Only the last attempt's error counts: an earlier one was retried.
        failed = undefined;
        const attempt: StepAttempt = { step, held: false, calledApp: false };
        this.#running = attempt;
        let result: Settled<unknown>;
        // Whether no newer attempt began, and the step didn't end, while
        // this one ran: an abandoned attempt's result is thrown away.
        let current = false;
        try {
          result = fromIsolate(await fn());
        } finally {
          current = this.#running === attempt;
          if (current) {
            this.#running = undefined;
          }
        }
        // Connect held a side effect of it for the person the run acts
        // for: the step ends as held, not failed, whatever the workflow
        // code made of the answer, and runs again once they decided. The
        // run's own calls say so; for its App's methods, which may keep
        // the answer to themselves, connect is asked about the step's key.
        // (Core can't see whether an App method called out: its calls run
        // in the App's own object.) Once decided, the rerun's call answers
        // for good: a decline (`connect.declined`) is an error like any
        // other, which workflow or App code may catch and carry on from;
        // it is audited in connect whatever the code does with it.
        const held =
          current &&
          (attempt.held ||
            (attempt.calledApp && (await this.#stillHeldOrUnknown(step))));
        if (held) {
          return heldMarker;
        }
        if (!result.ok) {
          failed = result.error;
          throw toStepError(result.error);
        }
        if (isHeldMarker(result.value)) {
          failed = {
            name: "Error",
            message: `Step "${step}" returned a value core keeps for itself`,
          };
          throw toStepError(failed);
        }
        if (!z.json().optional().safeParse(result.value).success) {
          failed = {
            name: "Error",
            message: `Step "${step}" returned something that isn't JSON`,
          };
          throw toStepError(failed);
        }
        const recorded = JSON.stringify(result.value) ?? "";
        if (
          new TextEncoder().encode(recorded).byteLength > maxStepResultBytes
        ) {
          failed = {
            name: "Error",
            message: `Step "${step}" returned more than 1 MiB`,
          };
          throw toStepError(failed);
        }
        // Recorded here, before the engine stores the result, so a stop
        // between the two can't lose it: at least once, as a stop before
        // the result is stored runs the step, and records it, again.
        if (current) {
          await this.#audited(step, "completed", { sideEffect });
        }
        return result.value;
      };
      let value = await this.#step.do(step, stepConfig(parsed), attemptStep);
      // Held: wait, as for a switched-off feature, until the person decided,
      // then run the step again under the same key, in a step of its own
      // each time, so every execution replays the same steps.
      for (let round = 1; isHeldMarker(value); round += 1) {
        // oxlint-disable-next-line no-await-in-loop -- one round at a time
        const prefix = `${offStepPrefix}${await offKeyOf(step)}:held:${round}`;
        // oxlint-disable-next-line no-await-in-loop -- one round at a time
        await this.#waitWhileHeld(step, prefix);
        // oxlint-disable-next-line no-await-in-loop -- one round at a time
        value = await this.#step.do(
          `${prefix}:run`,
          stepConfig(parsed),
          attemptStep
        );
      }
      this.#stepEnded(step);
      return { ok: true, value };
    } catch (error) {
      this.#stepEnded(step);
      const reported = failed ?? forIsolate(error);
      if (attempted) {
        this.#hooks.stepFailed({ step, input, error: reported });
        await this.#audited(step, "failed", {
          sideEffect,
          errorCode: reported.code ?? "workflow.step_failed",
        });
      }
      return { ok: false, error: reported };
    }
  }

  async sleep(name: unknown, duration: unknown): Promise<Settled<null>> {
    return await settle(async () => {
      const step = checked(stepNameSchema, name);
      const ms = checked(milliseconds, duration);
      await this.#waitWhileOff(step, ["workflows"]);
      await this.#step.sleep(step, ms);
      return null;
    });
  }

  /** The first event of `type` for this run, or `received: false` at the timeout. */
  async waitForEvent(
    name: unknown,
    options: unknown
  ): Promise<
    Settled<{ received: true; payload: unknown } | { received: false }>
  > {
    return await settle(async () => {
      const step = checked(stepNameSchema, name);
      const { type, timeout } = checked(waitOptionsSchema, options);
      // Held before it begins, so it neither takes an event nor times out
      // while workflows are off: an event sent meanwhile waits for it.
      await this.#waitWhileOff(step, ["workflows"]);
      try {
        const event = await this.#step.waitForEvent(step, { type, timeout });
        return { received: true, payload: event.payload };
      } catch (error) {
        if (isTimeout(error)) {
          return { received: false };
        }
        throw error;
      }
    });
  }

  /**
   * Asks the model gateway for an AI step, from inside the step only: the
   * model must be one the deployment allows, and its answer must match the
   * step's schema (a JSON Schema from the SDK, checked here as Zod, and
   * again by the SDK). The audit log records the call under this run.
   */
  async callModel(request: unknown): Promise<Settled<unknown>> {
    return await settle(async () => {
      if (this.#running === undefined) {
        throw workflowErrors.create("workflow.invalid");
      }
      await this.#requirePerson();
      const { model, instructions, input, outputSchema } = checked(
        modelRequestSchema,
        request
      );
      let schema: z.ZodType;
      try {
        schema = z.fromJSONSchema(outputSchema);
      } catch {
        throw modelErrors.create("model.invalid_call");
      }
      const answer = await models(this.#env).call({
        model,
        system: instructions,
        input,
        schema,
        purpose: "workflow.step",
        trigger: this.#actor,
      });
      return answer.output;
    });
  }

  /**
   * Once a step has settled, no attempt of it runs any more, one that hung
   * too: calls between steps are refused again.
   */
  #stepEnded(step: string): void {
    if (this.#running?.step === step) {
      this.#running = undefined;
    }
  }

  /**
   * The idempotency key of the step whose function runs now; refuses a
   * call outside a step. Core holds the key to a run's side effects: its
   * connection calls, and those of its App's methods it calls, take this
   * key or none (`requireStepKey`).
   */
  #stepKey(): string {
    return stepIdempotencyKey(this.#run.runId, this.#requireStep().step);
  }

  /** The step whose function runs now; refuses a call outside a step. */
  #requireStep(): StepAttempt {
    const running = this.#running;
    if (running === undefined) {
      throw workflowErrors.create("workflow.outside_step");
    }
    return running;
  }

  /**
   * Calls an action on one of the run's connections (`binding`), with
   * `call` as a connection stub takes it: `[action, input, options]`, only
   * inside a step, and with that step's key or none.
   */
  async callConnection(
    binding: unknown,
    call: unknown
  ): Promise<Settled<unknown>> {
    return await settle(async () => {
      const attempt = this.#requireStep();
      const stepKey = this.#stepKey();
      const { connections, authority } = this.#run;
      const name = checked(z.string(), binding);
      const grant = Object.hasOwn(connections, name)
        ? connections[name]
        : undefined;
      if (grant === undefined) {
        throw workflowErrors.create("workflow.invalid");
      }
      return await heldNoted(
        attempt,
        async () =>
          await runStubCall(
            this.#env,
            async (key) => {
              requireStepKey(key, stepKey);
              return await Promise.resolve(authority);
            },
            grant,
            checked(z.array(z.unknown()), call)
          )
      );
    });
  }

  /**
   * Calls a method of the run's own App (`env.APP.call(method, ...args)`)
   * for the person the run acts for, in workflow mode, only inside a step.
   * The caller the method gets carries the step's key, the only one its
   * connection calls take (app-bindings.ts). Within one App no permission
   * is needed, but the person must still be there. The answer is plain
   * data (`callApp`), and whatever it holds of the App's data is covered by
   * the run's restricted mode, which is the App's (restricted.ts).
   */
  async callApp(method: unknown, args: unknown): Promise<Settled<unknown>> {
    return await settle(async () => {
      const attempt = this.#requireStep();
      attempt.calledApp = true;
      const idempotencyKey = this.#stepKey();
      await this.#requirePerson();
      const { authority } = this.#run;
      // The App's own connection calls take the step's key: held, they
      // hold the step as the run's own do (`do` asks connect too).
      return await heldNoted(
        attempt,
        async () =>
          await this.#hooks.callApp(
            { userId: authority.onBehalfOf, mode: "workflow", idempotencyKey },
            String(method),
            checked(z.array(z.unknown()), args)
          )
      );
    });
  }

  /**
   * Opens this run's decision for a step, inside that step, and answers
   * its ID and deadline; the same step gets the same decision again, so
   * opening it again opens nothing new (src/decisions/).
   */
  async openDecision(
    request: unknown
  ): Promise<Settled<{ decision: string; deadline: number }>> {
    return await settle(async () => {
      this.#requireStep();
      const { step, from, description, timeout } = checked(
        decisionSchema,
        request
      );
      return await openDecision(this.#env, this.#run, {
        step,
        from,
        description,
        timeout,
      });
    });
  }

  /**
   * The people one of this run's open decisions asks now, each with the
   * decision's link, inside a step (the one that asks them).
   */
  async decisionRecipients(
    decision: unknown,
    reminder: unknown
  ): Promise<Settled<DecisionRecipient[]>> {
    return await settle(async () => {
      this.#requireStep();
      return await decisionRecipients(
        this.#env,
        this.#run,
        checked(identifierSchema, decision),
        checked(z.boolean(), reminder)
      );
    });
  }

  /**
   * Waits up to `timeout` for an answer to one of this run's decisions,
   * and answers how it stands then, read from the decision itself: the
   * event that wakes the run carries nothing it takes. With `last`, a
   * decision still open is closed, timed out, unless an answer lands
   * first. An answer that came before the wait began is taken at once.
   * Switching decisions off stops only answering (decisions/rpc.ts): a wait
   * that runs out meanwhile ends timed out, never approved.
   */
  async waitForDecision(
    name: unknown,
    options: unknown
  ): Promise<Settled<DecisionOutcome>> {
    return await settle(async () => {
      const step = checked(stepNameSchema, name);
      const { decision, timeout, last } = checked(decisionWaitSchema, options);
      await this.#waitWhileOff(step, ["workflows"]);
      const before = await decisionOutcome(
        this.#env,
        this.#run,
        decision,
        false
      );
      if (before.answered) {
        return before;
      }
      // The SDK worked `timeout` out from when it asked, but a hold for
      // switched-off workflows (just above) may have outlasted that: so
      // never wait past the decision's deadline, as its row has it. Once
      // that has passed, the decision is closed as timed out at once, so a
      // reminder that follows asks nobody.
      const deadline = await decisionDeadline(this.#env, this.#run, decision);
      const left = Math.min(timeout, deadline - Date.now());
      if (left > 0) {
        try {
          await this.#step.waitForEvent(step, {
            type: decisionEventType(decision),
            timeout: left,
          });
        } catch (error) {
          if (!isTimeout(error)) {
            throw error;
          }
        }
      }
      return await decisionOutcome(
        this.#env,
        this.#run,
        decision,
        last || Date.now() >= deadline
      );
    });
  }

  /** A value of the workflow's state, shared by all its runs. */
  async getState(key: unknown): Promise<Settled<unknown>> {
    return await settle(async () => {
      await this.#requirePerson();
      const stored = await appHost(this.#env, this.#run.app).workflowState(
        this.#run.workflow,
        checked(stateKeySchema, key)
      );
      const value: unknown =
        stored === undefined ? undefined : JSON.parse(stored);
      return value;
    });
  }

  /** Writes a value of the workflow's state, once per idempotency key. */
  async setState(
    key: unknown,
    value: unknown,
    idempotencyKey: unknown
  ): Promise<Settled<null>> {
    return await settle(async () => {
      await this.#requirePerson();
      await appHost(this.#env, this.#run.app).setWorkflowState(
        this.#run.workflow,
        this.#run.runId,
        checked(stateKeySchema, key),
        JSON.stringify(checked(z.json(), value)),
        checked(idempotencyKeySchema, idempotencyKey)
      );
      return null;
    });
  }
}
