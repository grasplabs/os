import { z } from "zod";

import type { ParamValue } from "./approvals.ts";
import { defineErrorFamily } from "./errors.ts";
import type { AppId, RunId, WorkflowId } from "./ids.ts";
import type { Json } from "./json.ts";

// A workflow is code in an App (`workflows/<id>.ts`), written with the
// workflow SDK. Each run is pinned to the App version it started on, and
// acts for one person: the one who started it, or the App's owner for a
// run a trigger started.

/** Why a workflow call was refused. */
export const workflowErrors = defineErrorFamily({
  "workflow.invalid": "That isn't a valid request for a workflow.",
  "workflow.not_found": "The App's current version has no such workflow.",
  "workflow.run_not_found": "There's no such workflow run.",
  "workflow.build_failed": "The App's workflows don't build.",
  "workflow.tests_failed":
    "A workflow's tests fail, or it has none, so this version can't be made current.",
  "workflow.outside_step":
    "A workflow calls its connections only inside a step: code between steps runs again on every replay.",
  "workflow.too_many_steps":
    "This run has taken as many steps as a workflow run may: split the work over more runs.",
  "workflow.idempotency_key_invalid":
    "A workflow's connection calls take their step's own idempotency key (the `idempotencyKey` a side-effect step gets), or none: the platform keeps side effects to once per step and run.",
  "workflow.param_not_found":
    "The workflow has no such parameter in the App's current version.",
  "workflow.param_invalid": "That isn't a valid value for this parameter.",
  "workflow.param_conflict":
    "The App's current version changed while the value was set. Try again.",
  // What a step or run failed with when its error named no code of its
  // own: the audit log and failure reports carry these instead.
  "workflow.step_failed": "A step of the workflow failed.",
  "workflow.run_failed": "The workflow run failed.",
});

/**
 * A parameter as a workflow's code declares it (the SDK's
 * `ParamMetadata`), within the bounds core keeps and shows: the SDK
 * refuses a definition outside them, so a version whose declarations core
 * would refuse never passes its tests. Kinds, and whether a default fits
 * its kind, are the SDK's to check (`paramValueSchemas`).
 */
export const paramDeclarationSchema = z.object({
  name: z.string().regex(/^[A-Za-z_$][\w$]{0,63}$/u),
  kind: z.string(),
  label: z.string().max(200),
  default: z.union([z.string().max(4096), z.number()]),
  sensitive: z.boolean(),
  currency: z.string().max(3).optional(),
});

/** Most parameters one workflow declares. */
const maxParamDeclarations = 100;

/**
 * A workflow's parameter declarations, each as `item` has it: at most
 * {@link maxParamDeclarations}, and each name once: with two declarations
 * of one name, which one a read goes by would be anyone's guess.
 */
export const paramDeclarationsSchema = <
  Item extends z.ZodType<{ name: string }>,
>(
  item: Item
) =>
  z
    .array(item)
    .max(maxParamDeclarations)
    .refine(
      (params) =>
        new Set(params.map(({ name }) => name)).size === params.length,
      { message: "Each name once" }
    );

/**
 * The idempotency key of a run's step, as the SDK hands it to the step
 * and core requires it on the step's connection calls: the run ID
 * (encoded, so no run ID and step name make another's key) and the step's
 * engine name. The same on every attempt and replay of the step, and
 * never the same for two runs or two steps.
 */
export const stepIdempotencyKey = (runId: string, step: string): string =>
  `${encodeURIComponent(runId)}:${step}`;

/**
 * Codes of the failures trying again may fix, and can't make happen twice.
 * A connection's server that took nothing (it turned the call away, or its
 * native connector said nothing was done); a call with the same
 * idempotency key still running, whose answer a retry gets; a model call
 * that failed; something unplanned in the platform, where connect's
 * idempotency keys keep a retried side effect to once; and a model's answer
 * that didn't fit, which the SDK asks for again; and a feature switched
 * off (`feature.disabled`), so a run goes on once it's switched back on
 * within the step's retries. Any other failure stops
 * the run: a refusal, a tool's own error (it may have acted), a call whose
 * outcome is unknown (an App method that timed out, too), or an error the
 * workflow's code throws.
 */
const retryableCodes: ReadonlySet<unknown> = new Set([
  "connect.server_unavailable",
  "connect.call_in_progress",
  "model.failed",
  "internal.unexpected",
  "workflow.invalid_model_output",
  "feature.disabled",
]);

/**
 * Whether a step that failed with `error` may be tried again, as far as its
 * retries allow: a failure of a class trying again may fix, or an attempt
 * that ran out of time. Engines decide by this alone, so a step is retried
 * the same in tests (`@grasp-os/sdk/testing`) as in a real run.
 */
export const isRetryable = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  (("code" in error && retryableCodes.has(error.code)) ||
    ("name" in error && error.name === "TimeoutError"));

/**
 * What a failure report keeps of a step's input: its type, and for an
 * object the names of fields shaped like code's own (letters, `_` and
 * `-`, at most 32) with their types. No values, which can hold anything
 * the run read.
 */
export type InputShape = string | Record<string, string>;

/**
 * Why a run stopped, as its owner sees it: self-contained, so a chat can
 * attach it as it is. It holds nothing the run read, but for what the
 * workflow's code put in the error's message.
 *
 * That message is untrusted text, written by workflow code (which the
 * agent writes, and which may quote what the run read): whatever passes it
 * to an agent must pass it as data, never as instructions.
 */
export interface RunFailure {
  run: RunId;
  app: AppId;
  workflow: WorkflowId;
  /** The App version the run ran. */
  version: number;
  /**
   * The step it stopped at; null when it stopped outside any step
   * (loading its code, say, or in code between steps).
   */
  step: string | null;
  /** The shape of the step's input; null without one. */
  input: InputShape | null;
  error: {
    /** Such as `connect.action_failed`; `workflow.run_failed` without one. */
    code: string;
    message: string;
  };
  /** ISO 8601. */
  failedAt: string;
}

/**
 * Where a run is: running (a step, or a sleep), waiting for an event or a
 * decision, paused until its App has an owner again, or ended.
 */
export type RunStatus =
  | "running"
  | "waiting"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

/** One run of a workflow. */
export interface WorkflowRun {
  id: RunId;
  app: AppId;
  workflow: WorkflowId;
  /** The App version it runs, whatever version is current now. */
  version: number;
  /** A person started it (and it acts for them), or a trigger did. */
  startedBy: { type: "person"; userId: string } | { type: "trigger" };
  status: RunStatus;
  createdAt: string;
  endedAt: string | null;
  /** What it returned, once completed; only from `status`. */
  output?: Json;
  /** Why it failed; only from `status`. */
  error?: { name: string; message: string };
  /**
   * Why it stopped, once failed: for admins and the person the run acts
   * for (who started it, or the App's owner for a triggered run).
   */
  failure?: RunFailure;
}

/**
 * A signed-in person's workflows. Admins and builders; every call checks
 * the session and the person's role again.
 */
export interface WorkflowsApi {
  /**
   * Starts a run of an App's workflow on the App's current version, acting
   * for the person who starts it.
   */
  start: (
    app: string,
    workflow: string,
    input?: unknown
  ) => Promise<WorkflowRun>;
  /** A run as it is now. */
  status: (run: string) => Promise<WorkflowRun>;
  /**
   * An App's runs, newest first; a failed one with its report for those
   * `status` shows it to.
   */
  list: (app: string) => Promise<WorkflowRun[]>;
  /** Stops a run for good; a run that ended stays as it ended. */
  cancel: (run: string) => Promise<WorkflowRun>;
  /** The values people set for a workflow's parameters. */
  readonly params: WorkflowParamsApi;
}

/**
 * A parameter of a workflow in its App's current version, as its code
 * declares it, with the value people set.
 */
export interface WorkflowParam {
  name: string;
  /** `money`, `number`, `text`, `person`, `schedule`, `model` or `template`. */
  kind: string;
  label: string;
  /**
   * Its value needs care where it's shown. It's set like any other, and,
   * like any other, never goes in an audit event.
   */
  sensitive: boolean;
  default: ParamValue;
  /** For money: its ISO 4217 currency; amounts are in its minor units. */
  currency?: string;
  /** The value people set; null while the code's default applies. */
  value: ParamValue | null;
}

/**
 * The values of workflows' parameters. Admins and builders set them
 * directly, sensitive or not, audited without the value.
 */
export interface WorkflowParamsApi {
  /** A workflow's parameters, in the order its code declares them. */
  list: (app: string, workflow: string) => Promise<WorkflowParam[]>;
  /** Sets a parameter's value, audited without the value. */
  set: (
    app: string,
    workflow: string,
    param: string,
    value: ParamValue
  ) => Promise<WorkflowParam>;
}
