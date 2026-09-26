import type { AuditActor } from "@grasp-os/shared/audit";
import { decidersSchema } from "@grasp-os/shared/decisions";
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
  input: z.json().optional(),
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
  /** Hears of each step that failed, with the error it failed with. */
  stepFailed: (failure: FailedStep) => void;
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
  #running: { step: string } | undefined;

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
    let input: InputShape | null = null;
    try {
      step = checked(stepNameSchema, name);
      const parsed = checked(doOptionsSchema, options);
      sideEffect = parsed.sideEffect === true;
      input = inputShape(parsed.input);
      await this.#hooks.acting();
      const value = await this.#step.do(step, stepConfig(parsed), async () => {
        // Only the last attempt's error counts: an earlier one was retried.
        failed = undefined;
        const attempt = { step };
        this.#running = attempt;
        let result: Settled<unknown>;
        try {
          result = fromIsolate(await fn());
        } finally {
          if (this.#running === attempt) {
            this.#running = undefined;
          }
        }
        if (!result.ok) {
          failed = result.error;
          throw toStepError(result.error);
        }
        if (!z.json().optional().safeParse(result.value).success) {
          failed = {
            name: "Error",
            message: `Step "${step}" returned something that isn't JSON`,
          };
          throw toStepError(failed);
        }
        ran = true;
        return result.value;
      });
      this.#stepEnded(step);
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
      this.#stepEnded(step);
      const reported = failed ?? forIsolate(error);
      if (step !== "") {
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
  #requireStep(): { step: string } {
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
      const stepKey = this.#stepKey();
      const { connections, authority } = this.#run;
      const name = checked(z.string(), binding);
      const grant = Object.hasOwn(connections, name)
        ? connections[name]
        : undefined;
      if (grant === undefined) {
        throw workflowErrors.create("workflow.invalid");
      }
      return await runStubCall(
        this.#env,
        async (key) => {
          requireStepKey(key, stepKey);
          return await Promise.resolve(authority);
        },
        grant,
        checked(z.array(z.unknown()), call)
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
      const idempotencyKey = this.#stepKey();
      await this.#requirePerson();
      const { authority } = this.#run;
      return await this.#hooks.callApp(
        { userId: authority.onBehalfOf, mode: "workflow", idempotencyKey },
        String(method),
        checked(z.array(z.unknown()), args)
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
   * The people one of this run's open decisions asks now, each with a
   * link of their own, inside a step (the one that asks them).
   */
  async decisionRecipients(
    decision: unknown
  ): Promise<Settled<DecisionRecipient[]>> {
    return await settle(async () => {
      this.#requireStep();
      return await decisionRecipients(
        this.#env,
        this.#run,
        checked(identifierSchema, decision)
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
      if (timeout > 0) {
        try {
          await this.#engine(
            async () =>
              await this.#step.waitForEvent(step, {
                type: decisionEventType(decision),
                timeout,
              })
          );
        } catch (error) {
          if (!isTimeout(error)) {
            throw error;
          }
        }
      }
      return await decisionOutcome(this.#env, this.#run, decision, last);
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
