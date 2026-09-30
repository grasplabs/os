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
  callReviewed,
  stepReviewed,
  isRetryable,
  stepIdempotencyKey,
  inboundEmailIndexSchema,
  storedEmailSchema,
  workflowErrors,
} from "@grasp-os/shared/workflows";
import type { InputShape, WorkflowCalls } from "@grasp-os/shared/workflows";
import { RpcTarget } from "cloudflare:workers";
import type {
  WorkflowStepConfig,
  WorkflowTimeoutDuration,
} from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { drizzle } from "drizzle-orm/d1";
import type { Email } from "postal-mime";
import { z } from "zod";

import { callExport } from "../app-calls.ts";
import type { AppAnswer, AppCallerInput } from "../app.ts";
import { auditedBatch, outboxed } from "../audit-outbox.ts";
import { forSandbox, requireStepKey, runStubCall } from "../bindings.ts";
import type { ConnectionGrant, ExportGrant } from "../bindings.ts";
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
import type { CollectionBinding } from "../knowledge/binding.ts";
import { models } from "../models.ts";
import { requireActivePerson, requireApprovedVersion } from "../permissions.ts";
import { commitStepStatistics } from "../statistic-steps.ts";
import type { Settled, StepError } from "./code.ts";
import { attachmentOf, keptMessage } from "./kept-email.ts";

// The engine a run's workflow code runs on, as core's side of it: the SDK's
// `WorkflowEngine` (`@grasp-os/sdk/engine`) on Cloudflare's `step` API. The
// run's main module (code.ts) sends each engine call here over RPC. The
// isolate is untrusted, so everything it sends is checked, and what it can
// do is only this run's: steps, waits and model calls, all as this
// run and this workflow, for the person it acts for while they are there.
//
// Errors cross as plain data both ways (`Settled`). Cloudflare Workflows
// keeps only a failed step's name and message, and RPC carries errors'
// fields as the runtime sees fit; the SDK recovers its error codes from the
// name, so the name must come back as it was sent. Core's own errors reach
// the isolate as the sandbox sees them: expected ones as they are, anything
// else as `internal.unexpected`.

/**
 * What a run may call of a collection it may read (`CollectionBinding`):
 * the isolate's stub of each has these methods, each a call through the
 * host (`callCollection`).
 */
export const collectionMethods = [
  "listDocuments",
  "getDocument",
  "history",
  "backlinks",
  "search",
  "read",
  "follow",
] as const satisfies readonly (keyof CollectionBinding)[];

const collectionMethodSchema = z.enum(collectionMethods);

/** The run a host serves, as the dispatcher loaded it. */
export interface HostedRun {
  app: AppId;
  workflow: WorkflowId;
  version: number;
  runId: RunId;
  /** Who the run acts for in this execution. */
  authority: Authority;
  /** Its collections' stubs, by binding name (`runBindingsFor`). */
  collections: Record<string, Fetcher<CollectionBinding>>;
  /** Its connection permissions, by binding name (`runBindingsFor`). */
  connections: Record<string, ConnectionGrant>;
  /** Its permissions on other Apps' exports, by binding name. */
  apps: Record<string, ExportGrant>;
  /**
   * The bindings its workflow calls, by step, as the review of its version
   * shows them (`app_versions.workflow_calls`).
   */
  calls: WorkflowCalls;
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

/**
 * One attempt of a step, while its function runs: whether connect held a
 * side effect of it (`held`), whether it called its App's methods, and
 * the kept messages it read attachments of, parsed, by their name
 * (`readAttachment`): each parsed once per attempt.
 */
interface StepAttempt {
  /**
   * Its own ID, which the isolate hands back with each App call the
   * attempt's code makes: the statistics points those calls record are
   * kept by it, and added up only if this attempt completes the step.
   */
  id: string;
  step: string;
  held: boolean;
  calledApp: boolean;
  /**
   * The first of its calls refused as one its review doesn't show, or
   * made from another attempt's code that had one refused: the attempt
   * fails with it, whatever its code made of the refusal.
   */
  refused?: Error;
  keptMessages?: Map<string, Email>;
}

/** Why a run waits before running a step again. */
export interface WaitReason {
  reason: "held";
}

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
 * would refuse core's end too. Core's steps that the run's code causes
 * without bound count as the run's own: the steps of a wait while a
 * side effect is held ({@link waitStepPrefix}).
 */
const coreStepReserve = 5;

/**
 * The steps a run waits in while a side effect is held. They are core's
 * (workflow code can't name one), but count as the run's own against the
 * reserve, so waiting can't use up the steps core's end needs.
 */
const waitStepPrefix = `${coreStepPrefix}wait:`;

/**
 * How long a run first waits before it checks a held side effect again;
 * each wait after doubles, up to {@link maxWaits} times this.
 */
const defaultWaitMs = 60_000;

/** The longest wait between checks, in first waits: 15 minutes. */
const maxWaits = 15;

/**
 * Tries of one check whether a held side effect still waits, after the
 * first: a connect that fails that often in a row fails the step.
 */
const heldCheckRetries = 5;

/**
 * A short, stable key for the step `name` a wait holds, as the wait's own
 * step names take it: a step's name can be as long as a step name may be.
 */
const waitKeyOf = async (name: unknown): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(String(name))
  );
  return toHex(new Uint8Array(digest)).slice(0, 16);
};

/** The first wait between checks for this deployment; tests shorten it. */
const waitMsOf = (env: Env): number => {
  const set = Number(env.WORKFLOW_OFF_WAIT_MS);
  return Number.isInteger(set) && set > 0 && set < defaultWaitMs
    ? set
    : defaultWaitMs;
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
      name.startsWith(coreStepPrefix) && !name.startsWith(waitStepPrefix);
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
  /** Whether the engine has stopped this execution (`watchedStep`). */
  engineStopped: () => boolean;
  /**
   * Records that the run waits while a side effect of a step is held for
   * the person it acts for.
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
  /** Every attempt of a step this execution started, by its ID. */
  readonly #attempts = new Map<string, StepAttempt>();

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
   * is recorded, the SDK's own (`$params`) too: the isolate
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
   * Waits, before running the step `step` again, while a side effect it
   * asked for is held for the person the run acts for: each check a step
   * of its own (retried, and replayed without asking connect again), then
   * a durable sleep, a minute first (`waitMsOf`), doubling up to 15
   * minutes, in steps named after `prefix`. The wait is recorded once, in
   * a step of its own. Each check and sleep is a step of the run's budget,
   * so a run waits about 52 days at the default limit. A decline or a drop
   * ends the wait too: the step's next run fails with `connect.declined`.
   */
  async #waitWhileHeld(step: string, prefix: string): Promise<void> {
    const first = waitMsOf(this.#env);
    for (let checks = 0; ; checks += 1) {
      // Its answer is recorded, so a replay asks connect nothing, and a
      // failing connect is tried again rather than failing the step.
      // oxlint-disable-next-line no-await-in-loop -- one check at a time
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
      if (held !== true) {
        return;
      }
      if (checks === 0) {
        // oxlint-disable-next-line no-await-in-loop -- once per wait
        await this.#recordWaiting(`${prefix}:waiting:held`, {
          reason: "held",
        });
      }
      // oxlint-disable-next-line no-await-in-loop -- one check at a time
      await this.#step.sleep(
        `${prefix}:${checks}`,
        Math.min(first * 2 ** checks, first * maxWaits)
      );
    }
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
   * step, and inside one (a model call, an App call). One who has
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
   * execution and the engine didn't stop the execution: a failure workflow
   * code caught is replayed on every later execution, and was recorded
   * when it happened; a step the engine stopped (a pause, a cancel) runs,
   * or replays, in the execution that goes on, if any. A step that fails
   * before it starts (options that don't parse, a person who has left) is
   * neither: the run's own failure records it. When a side effect of the
   * step is held for the person the run acts for, the step ends as held,
   * not failed, uses no retries, and the run waits until the person
   * decided, then runs the step again under the same key
   * (`#waitWhileHeld`): confirmed, it gets the answer; declined or
   * dropped, it fails with `connect.declined`.
   */
  async do(
    name: unknown,
    options: unknown,
    fn: (attempt: string) => Promise<unknown>
  ): Promise<Settled<unknown>> {
    let failed: StepError | undefined;
    let attempted = false;
    let step = "";
    let sideEffect = false;
    let input: InputShape | null = null;
    try {
      step = checked(stepNameSchema, name);
      // The step's name is the isolate's to say: one its review doesn't
      // show can't run, so no code runs under a name of its own making.
      if (!stepReviewed(this.#run.calls, step)) {
        const error = workflowErrors.create("workflow.step_not_reviewed");
        error.message = `Step "${step}" isn't one the review of this version shows: run steps only as the workflow's function writes them.`;
        throw error;
      }
      const parsed = checked(doOptionsSchema, options);
      sideEffect = parsed.sideEffect === true;
      input = inputShape(parsed.input);
      await this.#requirePerson();
      const attemptStep = async (): Promise<unknown> => {
        attempted = true;
        // Only the last attempt's error counts: an earlier one was retried.
        failed = undefined;
        const attempt: StepAttempt = {
          id: crypto.randomUUID(),
          step,
          held: false,
          calledApp: false,
        };
        this.#attempts.set(attempt.id, attempt);
        this.#running = attempt;
        let result: Settled<unknown>;
        // Whether no newer attempt began, and the step didn't end, while
        // this one ran: an abandoned attempt's result is thrown away.
        let current = false;
        try {
          result = fromIsolate(await fn(attempt.id));
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
        // A call its review doesn't show fails the step for good, even
        // when its code caught the refusal and carried on.
        if (attempt.refused !== undefined) {
          failed = forIsolate(attempt.refused);
          throw toStepError(failed);
        }
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
          // The step completes with this attempt: the statistics points
          // its App calls recorded are added up, once (a step run again
          // after this adds nothing), and no other attempt's.
          if (attempt.calledApp) {
            await commitStepStatistics(
              this.#env,
              stepIdempotencyKey(this.#run.runId, step),
              attempt.id
            );
          }
          await this.#audited(step, "completed", { sideEffect });
        }
        return result.value;
      };
      let value = await this.#step.do(step, stepConfig(parsed), attemptStep);
      // Held: wait until the person decided, then run the step again under the same key, in a step of its own
      // each time, so every execution replays the same steps.
      for (let round = 1; isHeldMarker(value); round += 1) {
        // oxlint-disable-next-line no-await-in-loop -- one round at a time
        const prefix = `${waitStepPrefix}${await waitKeyOf(step)}:held:${round}`;
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
      if (attempted && !this.#hooks.engineStopped()) {
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
      await this.#step.sleep(step, ms);
      return null;
    });
  }

  /**
   * Asks the model gateway for an AI step, from inside the step only: the
   * model must be one the deployment allows and its rules let this call
   * use (model-rules.ts), and its answer must match the step's schema (a JSON Schema from the SDK, checked here as Zod, and
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
        // The step may have read any of them into its input.
        connections: [
          ...new Set(
            Object.values(this.#run.connections).map(
              ({ connection }) => connection.connectionId
            )
          ),
        ],
        // The run's restricted mode, which is its App's.
        work: {
          authority: this.#run.authority,
          context: {
            type: "run",
            appId: this.#run.app,
            runId: this.#run.runId,
          },
        },
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

  /**
   * The attempt an App call comes from, as the isolate says (`from`, the
   * ID the attempt's function was started with): the one running now, or
   * one the engine gave up on, whose code still runs, of any step this
   * execution ran; an ID of none is refused. Without one, the one running
   * now. The statistics points the call records are kept by it, so a late
   * call of an abandoned attempt never counts with the attempt that
   * replaced it, and its step's review must show the call too.
   */
  #attemptOf(from: unknown): StepAttempt {
    const id = checked(z.uuid().optional(), from);
    if (id === undefined) {
      return this.#requireStep();
    }
    const attempt = this.#attempts.get(id);
    if (attempt === undefined) {
      throw workflowErrors.create("workflow.invalid");
    }
    return attempt;
  }

  /**
   * Refuses a call of `binding` (`APP` for the App's own server) that the
   * review of the run's version doesn't show: the step running now, and
   * the step whose attempt's code makes it (`from`), must both be ones
   * whose code, as the review reads it, calls that binding. What the
   * review reads is only what the source says, and code can move a call
   * as it runs: a binding kept when a module loads, or a stub made in one
   * step and called in another. Each refusal is audited, and fails the
   * step it was made in (`StepAttempt.refused`).
   */
  async #requireReviewed(
    running: StepAttempt,
    from: StepAttempt,
    binding: string
  ): Promise<void> {
    // Once an attempt had a call refused, every later call of it fails
    // at once, allowed or not, and none is audited again: a loop of
    // refused calls can't flood the audit log.
    const refused = running.refused ?? from.refused;
    if (refused !== undefined) {
      throw refused;
    }
    const unreviewed = [running, from].find(
      ({ step }) => !callReviewed(this.#run.calls, step, binding)
    );
    if (unreviewed === undefined) {
      return;
    }
    const error = workflowErrors.create("workflow.call_not_reviewed");
    error.message = `Step "${unreviewed.step}" called ${binding}, which the review of this version doesn't show it calling: call each binding only in the step's own function, where the review shows it.`;
    running.refused = error;
    from.refused = error;
    const { app, workflow, version, runId } = this.#run;
    const db = drizzle(this.#env.DB);
    try {
      await auditedBatch(this.#env, db, [
        outboxed(db, {
          actor: this.#actor,
          action: "workflow.call.refused",
          target: { type: "workflow_run", id: runId },
          detail: {
            app,
            workflow,
            version,
            step: unreviewed.step,
            call: binding,
            errorCode: "workflow.call_not_reviewed",
          },
        }),
      ]);
    } catch (auditError) {
      // Refused all the same; the step fails with it, which is audited.
      log.error("workflow.call.audit_failed", {
        runId,
        step: unreviewed.step,
        call: binding,
        ...errorFields(auditError),
      });
    }
    throw error;
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
   * Calls `method` of a collection the run may read (`binding`, e.g.
   * `env.HANDBOOK.search(query)`) with `args`, only inside a step whose
   * code its review shows calling it (`#requireReviewed`). The collection's
   * stub checks and records the read as it does for any reader.
   */
  async callCollection(
    binding: unknown,
    method: unknown,
    args: unknown,
    from?: unknown
  ): Promise<Settled<unknown>> {
    return await settle(async () => {
      const attempt = this.#requireStep();
      const { collections } = this.#run;
      const name = checked(z.string(), binding);
      const stub = Object.hasOwn(collections, name)
        ? collections[name]
        : undefined;
      if (stub === undefined) {
        throw workflowErrors.create("workflow.invalid");
      }
      const read = checked(collectionMethodSchema, method);
      const [first, second] = checked(z.array(z.unknown()).max(2), args);
      await this.#requireReviewed(attempt, this.#attemptOf(from), name);
      // The stub checks every argument, as it does one from an App.
      switch (read) {
        case "listDocuments": {
          return await stub.listDocuments(first);
        }
        case "getDocument": {
          return await stub.getDocument(first, second);
        }
        case "history": {
          return await stub.history(first, second);
        }
        case "backlinks": {
          return await stub.backlinks(first, second);
        }
        case "search": {
          return await stub.search(first, second);
        }
        case "read": {
          return await stub.read(first, second);
        }
        case "follow": {
          return await stub.follow(first);
        }
        default: {
          throw workflowErrors.create("workflow.invalid");
        }
      }
    });
  }

  /**
   * Calls an action on one of the run's connections (`binding`), with
   * `call` as a connection stub takes it: `[action, input, options]`, only
   * inside a step, and with that step's key or none, from a step whose
   * code its review shows calling it (`#requireReviewed`), as the attempt
   * `from` does (see `#attemptOf`).
   */
  async callConnection(
    binding: unknown,
    call: unknown,
    from?: unknown
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
      await this.#requireReviewed(attempt, this.#attemptOf(from), name);
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
   * for the person the run acts for, in workflow mode, only inside a step
   * whose code its review shows calling it (`#requireReviewed`, as `APP`).
   * The caller the method gets carries the step's key, the only one its
   * connection calls take (app-bindings.ts). Within one App no permission
   * is needed, but the person must still be there, and the run's version
   * must be one an admin approved: the method runs the App's current
   * version, as the person, whatever version the run is on
   * (`requireApprovedVersion`). The answer is plain
   * data (`callApp`), and whatever it holds of the App's data is covered by
   * the run's restricted mode, which is the App's (restricted.ts).
   */
  async callApp(
    method: unknown,
    args: unknown,
    from?: unknown
  ): Promise<Settled<unknown>> {
    return await settle(async () => {
      const attempt = this.#requireStep();
      const calling = this.#attemptOf(from);
      await this.#requireReviewed(attempt, calling, "APP");
      attempt.calledApp = true;
      const idempotencyKey = this.#stepKey();
      const caller: AppCallerInput = {
        userId: this.#run.authority.onBehalfOf,
        mode: "workflow",
        idempotencyKey,
        attempt: calling.id,
      };
      await this.#requirePerson();
      await requireApprovedVersion(this.#env, this.#run.app, this.#run.version);
      // The App's own connection calls take the step's key: held, they
      // hold the step as the run's own do (`do` asks connect too).
      return await heldNoted(
        attempt,
        async () =>
          await this.#hooks.callApp(
            caller,
            String(method),
            checked(z.array(z.unknown()), args)
          )
      );
    });
  }

  /**
   * Calls export `method` of another App, by the run's permission on its
   * exports (`binding`), with `input` (`env.CRM.call(method, input)`),
   * only inside a step whose code its review shows calling that binding
   * (`#requireReviewed`), for the person the run acts for (app-calls.ts).
   * The called App's method gets the step's key on its caller, the only
   * one its connection calls take, so a side effect it holds holds the
   * step as the run's own would.
   */
  async callExport(
    binding: unknown,
    method: unknown,
    input: unknown,
    calling?: unknown
  ): Promise<Settled<unknown>> {
    return await settle(async () => {
      const attempt = this.#requireStep();
      const idempotencyKey = this.#stepKey();
      const { apps, authority, app } = this.#run;
      const name = checked(z.string(), binding);
      const grant = Object.hasOwn(apps, name) ? apps[name] : undefined;
      if (grant === undefined) {
        throw workflowErrors.create("workflow.invalid");
      }
      const from = this.#attemptOf(calling);
      await this.#requireReviewed(attempt, from, name);
      attempt.calledApp = true;
      return await heldNoted(
        attempt,
        async () =>
          await callExport(
            this.#env,
            {
              authority,
              idempotencyKey,
              attempt: from.id,
              // A run's call ends by the called App's own limit.
              path: {
                chain: [app],
                deadline: Number.POSITIVE_INFINITY,
                readOnly: false,
              },
              actor: this.#actor,
            },
            grant,
            method,
            input
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
   */
  async waitForDecision(
    name: unknown,
    options: unknown
  ): Promise<Settled<DecisionOutcome>> {
    return await settle(async () => {
      const step = checked(stepNameSchema, name);
      const { decision, timeout, last } = checked(decisionWaitSchema, options);
      const before = await decisionOutcome(
        this.#env,
        this.#run,
        decision,
        false
      );
      if (before.answered) {
        return before;
      }
      // The SDK worked `timeout` out from when it asked, but a pause or a
      // restart may have outlasted that: so never wait past the decision's
      // deadline, as its row has it. Once
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

  /**
   * The content of attachment `index` of a message an email trigger kept
   * for the run's App (`stored`, as the run's input names it), only inside
   * a step, for a person who is still there (kept-email.ts). Checked
   * against the run's own App, never one the isolate names: another App's
   * message is found as none. Every call is audited as a read, whatever
   * refuses it (outside a step, a name or index that isn't
   * one), with the name and index as sent. An attachment is handed on,
   * and a refusal answered, only once it's recorded: one that can't be
   * recorded fails as `internal.unexpected`, to be tried again. A step
   * attempt parses each message it reads once, however many of its
   * attachments it reads; a fetch that fails is tried again on its next
   * read. `stored: null` (a message that isn't kept) is refused with
   * `workflow.attachment_not_found`.
   */
  async readAttachment(
    stored: unknown,
    index: unknown
  ): Promise<Settled<Uint8Array>> {
    return await settle(async () => {
      const step = this.#running?.step ?? null;
      const sent = {
        step,
        message: typeof stored === "string" ? stored.slice(0, 256) : null,
        index:
          typeof index === "number" && Number.isFinite(index) ? index : null,
      };
      let content: Uint8Array;
      try {
        const attempt = this.#requireStep();
        await this.#requirePerson();
        // A message that isn't kept names nothing to read.
        if (stored === null) {
          throw workflowErrors.create("workflow.attachment_not_found");
        }
        const message = checked(storedEmailSchema, stored);
        const at = checked(inboundEmailIndexSchema, index);
        // Only a message read and parsed is kept for the attempt's next
        // read: a fetch that failed is tried again.
        attempt.keptMessages ??= new Map();
        let kept = attempt.keptMessages.get(message);
        if (kept === undefined) {
          kept = await keptMessage(this.#env, this.#run.app, message);
          attempt.keptMessages.set(message, kept);
        }
        content = attachmentOf(kept, at);
      } catch (error) {
        const errorCode = isExpectedError(error)
          ? error.code
          : "internal.unexpected";
        try {
          await this.#auditRead({ ...sent, errorCode });
        } catch (auditError) {
          // No refusal goes unrecorded: the call fails as one that can be
          // tried again, and the refusal it would have been is logged.
          log.error("workflow.email.audit_failed", {
            runId: this.#run.runId,
            refusedWith: errorCode,
            ...errorFields(auditError),
          });
          throw auditError;
        }
        throw error;
      }
      await this.#auditRead({ ...sent, bytes: content.byteLength });
      return content;
    });
  }

  /** Records a read of a kept message's attachment, through the outbox. */
  async #auditRead(read: {
    step: string | null;
    message: string | null;
    index: number | null;
    bytes?: number;
    errorCode?: string;
  }): Promise<void> {
    const { app, workflow, version, runId } = this.#run;
    const db = drizzle(this.#env.DB);
    await auditedBatch(this.#env, db, [
      outboxed(db, {
        actor: this.#actor,
        action: "workflow.email.read",
        target: { type: "workflow_run", id: runId },
        detail: {
          app,
          workflow,
          version,
          step: read.step,
          message: read.message,
          attachment: read.index,
          ...(read.bytes === undefined ? {} : { bytes: read.bytes }),
          ...(read.errorCode === undefined
            ? {}
            : { errorCode: read.errorCode }),
        },
      }),
    ]);
  }
}
