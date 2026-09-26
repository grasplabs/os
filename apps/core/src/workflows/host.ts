import type { AuditActor } from "@grasp-os/shared/audit";
import { isExpectedError } from "@grasp-os/shared/errors";
import type { AppId, RunId, WorkflowId } from "@grasp-os/shared/ids";
import { errorFields, log } from "@grasp-os/shared/log";
import { modelErrors } from "@grasp-os/shared/models";
import { permissionErrors } from "@grasp-os/shared/permissions";
import type { Authority } from "@grasp-os/shared/permissions";
import { workflowErrors } from "@grasp-os/shared/workflows";
import { RpcTarget } from "cloudflare:workers";
import type {
  WorkflowStepConfig,
  WorkflowTimeoutDuration,
} from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { auditedBatch, outboxed } from "../audit-outbox.ts";
import { forSandbox } from "../bindings.ts";
import { appHost } from "../durable-objects.ts";
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

/** Longest step name taken: a key and a decision's part fit well within. */
const maxStepName = 256;

const stepNameSchema = z
  .string()
  .min(1)
  .max(maxStepName)
  .refine((name) => !name.startsWith(coreStepPrefix), {
    message: `Step names starting with "${coreStepPrefix}" are core's`,
  });

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
});

const waitOptionsSchema = z.object({
  type: z
    .string()
    .min(1)
    .max(100)
    .refine((type) => !type.startsWith(coreEventPrefix)),
  timeout: milliseconds,
});

/** The largest output schema a model call takes, as JSON text. */
const maxSchemaLength = 32 * 1024;

/**
 * Whether a JSON Schema uses regular expressions, which the model gateway
 * would run on the model's answer: one that backtracks badly could hold
 * core's CPU, so workflows' schemas can't have them.
 */
const hasPattern = (schema: unknown): boolean => {
  if (Array.isArray(schema)) {
    return schema.some((item) => hasPattern(item));
  }
  if (typeof schema !== "object" || schema === null) {
    return false;
  }
  return Object.entries(schema).some(
    ([key, value]) =>
      key === "pattern" || key === "patternProperties" || hasPattern(value)
  );
};

const modelRequestSchema = z.object({
  step: stepNameSchema,
  model: z.string().min(1).max(200),
  instructions: z.string(),
  input: z.json(),
  outputSchema: z
    .record(z.string(), z.unknown())
    .refine(
      (schema) =>
        JSON.stringify(schema).length <= maxSchemaLength && !hasPattern(schema)
    ),
});

const decisionSchema = z.object({ step: stepNameSchema, from: z.string() });

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
    nonRetryable: z.boolean().optional(),
  })
  .transform(({ name, message, code, nonRetryable }): StepError => {
    const kept = auditableCode(code);
    return {
      name: name.slice(0, maxErrorName),
      message: message.slice(0, maxErrorMessage),
      ...(kept === undefined ? {} : { code: kept }),
      ...(nonRetryable === true ? { nonRetryable } : {}),
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
 * Codes of errors trying again can't fix: a permission the run doesn't
 * have (any more), or a model the deployment doesn't allow. Failure classes
 * beyond these belong to the failure handling of workflows.
 */
const isPermanent = (code: string | undefined): boolean =>
  permissionErrors.codeOf({ code }) !== undefined ||
  code === "model.not_allowed" ||
  code === "model.unconfigured" ||
  code === "model.invalid_call";

/**
 * A step's error as the engine gets it: non-retryable when it is so. The
 * engine knows one by its name, so it keeps that name; the step's own
 * error is reported from what the isolate sent (`do`).
 */
const toStepError = (error: StepError): Error => {
  if (error.nonRetryable === true || isPermanent(error.code)) {
    return new NonRetryableError(error.message);
  }
  const thrown = new Error(error.message);
  thrown.name = error.name;
  return thrown;
};

/** How a host reaches back into the dispatcher (dispatcher.ts). */
export interface HostHooks {
  /**
   * Runs before each step: waits, or throws, while the person the run acts
   * for is gone.
   */
  acting: () => Promise<void>;
  /**
   * Hears of an engine call that failed on the engine's side: when the
   * engine is stopping the execution, the dispatcher ends it with that
   * error, which the engine knows as its own.
   */
  engineFailed: (error: unknown) => void;
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
  /** Whether a step's function runs now. */
  #inStep = false;

  constructor(env: Env, step: RunStep, run: HostedRun, hooks: HostHooks) {
    super();
    this.#env = env;
    this.#step = step;
    this.#run = run;
    this.#hooks = hooks;
  }

  /**
   * Runs one of the engine's own calls; a failure that is the engine's
   * (a pause, say), not the step's, is passed on to the dispatcher as is.
   */
  async #engine<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (!isTimeout(error)) {
        this.#hooks.engineFailed(error);
      }
      throw error;
    }
  }

  get #actor(): AuditActor {
    const { app, workflow, runId } = this.#run;
    return { type: "workflow", appId: app, workflowId: workflow, runId };
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

  /** The person the run acts for must still be there. */
  async #requirePerson(): Promise<void> {
    await requireActivePerson(this.#env, this.#run.authority);
  }

  /**
   * Runs `fn` (in the isolate) as a durable step, with the SDK's retries
   * and timeout. A replay answers the recorded result without calling it.
   * Its outcome is audited when it ran in this execution.
   */
  async do(
    name: unknown,
    options: unknown,
    fn: () => Promise<unknown>
  ): Promise<Settled<unknown>> {
    let failed: StepError | undefined;
    let ran = false;
    let step = "";
    let sideEffect = false;
    try {
      step = checked(stepNameSchema, name);
      const parsed = checked(doOptionsSchema, options);
      sideEffect = parsed.sideEffect === true;
      await this.#hooks.acting();
      const value = await this.#step.do(step, stepConfig(parsed), async () => {
        this.#inStep = true;
        let result: Settled<unknown>;
        try {
          result = fromIsolate(await fn());
        } finally {
          this.#inStep = false;
        }
        if (!result.ok) {
          failed = result.error;
          throw toStepError(result.error);
        }
        if (!z.json().optional().safeParse(result.value).success) {
          failed = {
            name: "Error",
            message: `Step "${step}" returned something that isn't JSON`,
            nonRetryable: true,
          };
          throw toStepError(failed);
        }
        ran = true;
        return result.value;
      });
      if (ran) {
        await this.#audited(step, "completed", { sideEffect });
      }
      return { ok: true, value };
    } catch (error) {
      // The last attempt's own error: the engine's copy of it has only
      // its message, with the name in front. Without one, the engine's.
      if (failed === undefined && step !== "" && !isTimeout(error)) {
        this.#hooks.engineFailed(error);
      }
      const reported = failed ?? forIsolate(error);
      if (step !== "") {
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
      await this.#engine(async () => {
        await this.#step.sleep(step, ms);
      });
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
      try {
        const event = await this.#engine(
          async () => await this.#step.waitForEvent(step, { type, timeout })
        );
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
      if (!this.#inStep) {
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
   * Where the person answers a decision, and the event their answer comes
   * as. Answering, and who may, is the decisions' part; the same step
   * always gets the same answer here, so opening it again opens nothing new.
   */
  openDecision(request: unknown): Settled<{ link: string; eventType: string }> {
    const parsed = decisionSchema.safeParse(request);
    if (!parsed.success) {
      return {
        ok: false,
        error: forIsolate(workflowErrors.create("workflow.invalid")),
      };
    }
    const { step } = parsed.data;
    const { runId } = this.#run;
    return {
      ok: true,
      value: {
        link: `/workflows/runs/${encodeURIComponent(runId)}/decisions/${encodeURIComponent(step)}`,
        eventType: `decision:${step}`,
      },
    };
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
