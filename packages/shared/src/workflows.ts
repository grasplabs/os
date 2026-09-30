import { Cron } from "croner";
import { z } from "zod";

import { defineErrorFamily } from "./errors.ts";
import { connectionIdSchema, identifierSchema } from "./ids.ts";
import type { AppId, RunId, WorkflowId } from "./ids.ts";
import type { Json } from "./json.ts";
import { permissionActionSchema } from "./permissions.ts";

// A workflow is code in an App (`workflows/<id>.ts`), written with the
// workflow SDK. Each run is pinned to the App version it started on, and
// acts for one person: the one who started it, or the App's owner for a
// run a trigger started.

/** A workflow parameter's value: a number, or text. */
export type ParamValue = string | number;

/** Why a workflow call was refused. */
export const workflowErrors = defineErrorFamily({
  "workflow.invalid": "That isn't a valid request for a workflow.",
  "workflow.not_found": "The App's current version has no such workflow.",
  "workflow.run_not_found": "There's no such workflow run.",
  "workflow.run_details_removed":
    "This run's details were removed when its retention ended, so there is nothing left to work out a fix from.",
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
  "workflow.trigger_gone":
    "The trigger belongs to a version of the App that is no longer current.",
  "workflow.start_pending":
    "The run this was delivered for is still starting. Try again shortly.",
  "workflow.email_taken":
    "Another App's workflow already receives mail at this address.",
  "workflow.attachment_not_found":
    "This App has no such attachment: the message isn't kept for it, or its 30 days have passed.",
  "workflow.attachment_unreadable":
    "The kept message can't be read any more, so none of its attachments can.",
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

/** Whether the runtime knows `timeZone`, an IANA name like `Europe/Amsterdam`. */
const isTimeZone = (timeZone: string): boolean => {
  try {
    // oxlint-disable-next-line no-new -- constructing it is the check
    new Intl.DateTimeFormat("en", { timeZone });
    return true;
  } catch {
    return false;
  }
};

/** The time zone of a schedule trigger that names none. */
export const defaultTimeZone = "UTC";

/** A schedule: a five-field cron expression, read in a time zone. */
export interface CronSchedule {
  cron: string;
  timeZone: string;
}

/**
 * When `schedule` next fires strictly after `after`, to the minute;
 * undefined for an expression that isn't five cron fields, a time zone the
 * runtime doesn't know, or an expression that names no time to come (the
 * 30th of February).
 */
export const nextScheduledRun = (
  { cron, timeZone }: CronSchedule,
  after: Date
): Date | undefined => {
  if (!isTimeZone(timeZone)) {
    return undefined;
  }
  try {
    return (
      new Cron(cron, { timezone: timeZone, mode: "5-part" }).nextRun(after) ??
      undefined
    );
  } catch {
    return undefined;
  }
};

/** Whether `cron` is five cron fields that name a time to come. */
export const isCronExpression = (cron: string): boolean =>
  nextScheduledRun({ cron, timeZone: defaultTimeZone }, new Date()) !==
  undefined;

/**
 * The part of an address before the `@` that an email trigger receives
 * mail at, e.g. `invoices`: lower case letters, digits, `.`, `_`, `+` and
 * `-`, with no dot first, last or twice in a row.
 */
export const emailLocalPartSchema = z
  .string()
  .regex(/^[a-z0-9_+-]+(?:\.[a-z0-9_+-]+)*$/u)
  .max(64);

/**
 * Where a message an email trigger received is kept while its attachments
 * can be read: the UTC day it was stored and its ID, `2026-09-29/<id>`. It
 * names no App: a run reads only what its own App received.
 */
export const storedEmailSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}\/[0-9a-f]{64}$/u);

/** The largest message an email trigger takes, in bytes; larger ones bounce. */
export const inboundEmailMaxBytes = 10 * 1024 * 1024;

/**
 * The most of each of To and Cc, and of attachments, a message's run input
 * lists; so the most attachments a run reads by index.
 */
export const inboundEmailMaxListed = 100;

/** An attachment's index in a message's run input. */
export const inboundEmailIndexSchema = z
  .int()
  .min(0)
  .max(inboundEmailMaxListed - 1);

/** A name and address, as a message's headers give them. */
const mailboxSchema = z.object({ name: z.string(), address: z.string() });

/**
 * A message an email trigger received, as its run gets it as input. `id`
 * is the SHA-256 of its bytes. `from` is what the message's header says,
 * which its sender can write anything in: nothing vouches for it. Bounded
 * to fit a run's input (128 KiB of JSON): at most 100 each of `to`, `cc` and
 * `attachments` (listed, their content never included), names, addresses and file names
 * cut at 256 characters and the subject at 1,000, and as much of its
 * plain text as fits (for a message with only HTML, its text),
 * `truncated` when cut.
 *
 * `stored` is where the message is kept for 30 days, so the run can read
 * its attachments (`readAttachment` in `@grasp-os/sdk/workflow`); null
 * when it has none but inline ones, or while keeping messages is switched
 * off.
 */
export const inboundEmailSchema = z.object({
  id: z.string(),
  stored: storedEmailSchema.nullable(),
  from: mailboxSchema,
  to: z.array(mailboxSchema),
  cc: z.array(mailboxSchema),
  subject: z.string(),
  /** ISO 8601, as the message dates itself; null without a date. */
  date: z.string().nullable(),
  text: z.string(),
  truncated: z.boolean(),
  attachments: z.array(
    z.object({
      filename: z.string().nullable(),
      mimeType: z.string(),
      size: z.int(),
    })
  ),
});

/** A message an email trigger received. */
export type InboundEmail = z.infer<typeof inboundEmailSchema>;

/** An event's type, e.g. `m365.mail.received`. */
export const eventTypeSchema = z.string().min(1).max(200);

/** Most fields an event trigger's filter names. */
const maxFilterFields = 20;

/**
 * An event trigger's filter: each field it names must hold that value at
 * the top of the event's payload, compared as is.
 */
export const eventFilterSchema = z
  .record(
    z.string().min(1).max(64),
    z.union([z.string().max(200), z.number(), z.boolean(), z.null()])
  )
  .refine((filter) => Object.keys(filter).length <= maxFilterFields, {
    message: `At most ${maxFilterFields} fields`,
  });

/** An event trigger's filter. */
export type EventFilter = z.infer<typeof eventFilterSchema>;

/** Whether `payload` holds every value `filter` names, at its top. */
export const matchesFilter = (
  filter: EventFilter | null | undefined,
  payload: Json
): boolean => {
  const isObject =
    typeof payload === "object" && payload !== null && !Array.isArray(payload);
  const fields = new Map(isObject ? Object.entries(payload) : []);
  return Object.entries(filter ?? {}).every(
    ([field, value]) => fields.has(field) && fields.get(field) === value
  );
};

/** The most JSON text an event's payload takes. */
const maxEventPayloadLength = 64 * 1024;

/**
 * An event a connection reported, as core takes it from connect and
 * delivers it, and as the run an event trigger starts gets it as input (the SDK's
 * `connectorEvent`). `id` is the source's own ID of the event, the same
 * for the same event delivered again; for an ID longer than 200
 * characters it is `sha256:` and the ID's SHA-256 instead, and the payload
 * has the ID in full. `resource` narrows it to a part of
 * the connection (a mailbox, a drive), when the source says. `action` is
 * the connector's read action whose data the event carries (such as
 * `mail.list`): an App hears the event only through a permission that
 * allows it, as it could only read the data with one. `owner` is a
 * personal connection's owner (their user ID), whom only their own Apps
 * hear from; null for a shared connection.
 */
export const connectorEventSchema = z.object({
  id: z.string().min(1).max(200),
  connection: connectionIdSchema,
  owner: identifierSchema.nullable(),
  resource: identifierSchema.optional(),
  action: permissionActionSchema,
  type: eventTypeSchema,
  payload: z
    .json()
    .refine(
      (payload) => JSON.stringify(payload).length <= maxEventPayloadLength,
      { message: `At most ${maxEventPayloadLength} characters of JSON` }
    ),
});

/** An event a connection reported. */
export type ConnectorEvent = z.infer<typeof connectorEventSchema>;

/** Most triggers one workflow declares. */
const maxTriggerDeclarations = 20;

/**
 * A trigger as a workflow's code declares it (the SDK's `Trigger`), within
 * the bounds core keeps: the SDK refuses a definition outside them, so a
 * version whose triggers core would refuse never passes its tests. Which
 * parameter a schedule names, and whether it is a schedule, is the SDK's
 * to check.
 */
export const triggerDeclarationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("manual") }),
  z.object({
    type: z.literal("schedule"),
    param: paramDeclarationSchema.shape.name,
    timeZone: z
      .string()
      .max(64)
      .refine(isTimeZone, "Not a time zone the runtime knows")
      .optional(),
  }),
  z.object({
    type: z.literal("event"),
    event: eventTypeSchema,
    filter: eventFilterSchema.optional(),
  }),
  z.object({ type: z.literal("email"), address: emailLocalPartSchema }),
]);

/** A trigger as a workflow's code declares it. */
export type TriggerDeclaration = z.infer<typeof triggerDeclarationSchema>;

/** A workflow's triggers: at most {@link maxTriggerDeclarations}. */
export const triggerDeclarationsSchema = z
  .array(triggerDeclarationSchema)
  .max(maxTriggerDeclarations);

/**
 * The idempotency key of a run's step, as the SDK hands it to the step
 * and core requires it on the step's connection calls: the run ID
 * (encoded, so no run ID and step name make another's key) and the step's
 * engine name. The same on every attempt and replay of the step, and
 * never the same for two runs or two steps.
 */
export const stepIdempotencyKey = (runId: string, step: string): string =>
  `${encodeURIComponent(runId)}:${step}`;

/** The run a step's idempotency key (`stepIdempotencyKey`) belongs to. */
export const runOfStepKey = (key: string): string | undefined => {
  const end = key.indexOf(":");
  if (end <= 0) {
    return undefined;
  }
  try {
    return decodeURIComponent(key.slice(0, end));
  } catch {
    return undefined;
  }
};

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
 * decision, paused (its engine instance is), or ended.
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
  /**
   * What it returned, once completed; only from `status`, and gone once
   * its details are removed.
   */
  output?: Json;
  /**
   * Why it failed; only from `status`, and gone once its details are
   * removed.
   */
  error?: { name: string; message: string };
  /**
   * Why it stopped, once failed: for admins and the person the run acts
   * for (who started it, or the App's owner for a triggered run). Once
   * its details are removed, its message says only that, and its step is
   * named without its key.
   */
  failure?: RunFailure;
  /**
   * Set once its details are removed, its retention over: an ended run
   * keeps them for the deployment's `RUN_RETENTION_DAYS`, 30 days unless
   * set, counted from when it ended. The same wherever the run is read.
   * The run itself stays: what it was, how it ended, when and for whom.
   */
  detailsRemoved?: true;
}

/**
 * How a step works: `exact` is plain code, `ai` asks a model for output of a
 * fixed shape, `decision` waits for a person, `wait` waits for time or an
 * event.
 */
export type StepKind = "exact" | "ai" | "decision" | "wait";

/** An option written as a literal, or an object of literals. */
export type OptionValue =
  | string
  | number
  | boolean
  | { [key: string]: OptionValue };

/** A step as the UI shows it. */
export interface StepOutline {
  type: "step";
  name: string;
  kind: StepKind;
  description: string;
  /** Source of the per-item key, e.g. `invoice.id`; only on keyed steps. */
  key?: string;
  /** Changes something outside Grasp; a decision's `ask` always does. */
  sideEffect: boolean;
  /** Deterministic, with no model involvement. */
  locked: boolean;
  /** Parameters the call reads (options and callback), in source order. */
  params: string[];
  /** Other options written as literals, e.g. `retries` or `instructions`. */
  options: Record<string, OptionValue>;
  /**
   * The App's bindings the step's code calls (`env.NAME`): its own server
   * (`APP`), a connection, another App's exports, each of which may change
   * things; `env` itself when the code passes `env` around. Absent when it
   * calls none.
   */
  env?: string[];
  /**
   * The step's call as written, its function included, which the review
   * of a version compares whole: any change to its code shows. Only for
   * the App's builders; empty for anyone else.
   */
  code: string;
  line: number;
}

/** Steps that run only when a condition holds. */
export interface BranchOutline {
  type: "branch";
  /** The condition as written, e.g. `extracted.total > params.threshold`. */
  condition: string;
  /** Parameters the condition reads. */
  params: string[];
  /** Steps when the condition holds. */
  steps: OutlineNode[];
  /** Steps when it doesn't (the `else`). */
  otherwise: OutlineNode[];
  line: number;
}

/** Steps that run once per item. */
export interface LoopOutline {
  type: "loop";
  /** The loop's head as written, e.g. `for (const invoice of input.invoices)`. */
  header: string;
  /** Parameters the head reads. */
  params: string[];
  steps: OutlineNode[];
  line: number;
}

export type OutlineNode = StepOutline | BranchOutline | LoopOutline;

/**
 * A workflow's steps, as its code runs them: read from the code by the
 * SDK's describer (`@grasp-os/sdk/describe`), never kept apart from it.
 */
export interface WorkflowOutline {
  steps: OutlineNode[];
}

/**
 * What the Runs list is filtered by: runs waiting for a decision, running
 * otherwise (paused ones too), failed, or done (completed or cancelled).
 */
export const runFilterStatuses = [
  "waiting",
  "running",
  "failed",
  "done",
] as const;

export type RunFilterStatus = (typeof runFilterStatuses)[number];

/** Which runs `WorkflowsApi.runs` lists; each field narrows it. */
export interface RunFilter {
  app?: string;
  workflow?: string;
  status?: RunFilterStatus;
}

/**
 * A run as the Runs list has it, with its App's name. While it waits for
 * a decision its `status` is `waiting`.
 */
export interface ListedRun extends WorkflowRun {
  appName: string;
  /**
   * An open decision it waits for that the person may answer now (the
   * latest such), answered on its own page (`/decisions/<id>`); none when
   * they may answer none of them.
   */
  decision?: string;
}

/** Most runs one `runs` call returns. */
export const runsPageSize = 100;

/** A page of runs, and whether more matched than it holds. */
export interface RunsPage {
  runs: ListedRun[];
  more: boolean;
}

/** How many days back a workflow's failed runs are counted. */
export const failedRunDays = 7;

/** A workflow of an App's current version, as the Workflows page lists it. */
export interface WorkflowSummary {
  app: AppId;
  appName: string;
  workflow: WorkflowId;
  /** The App's current version, which new runs run. */
  version: number;
  /** The App's owner: whom a run no person started acts for. */
  owner: { userId: string; name: string | null };
  /**
   * Its latest run, of any version, `waiting` while it waits for a
   * decision; null before its first.
   */
  lastRun: { id: RunId; status: RunStatus; createdAt: string } | null;
  /** Its runs waiting for a decision now. */
  waiting: number;
  /** Its runs that failed in the last {@link failedRunDays} days. */
  failed: number;
}

/**
 * One workflow, as its view shows it: its summary, its steps as its code
 * reads (or why they can't be read), and, for the App's builders, its
 * parameters.
 */
export interface WorkflowDetail {
  summary: WorkflowSummary;
  /**
   * For anyone who doesn't build the App, the outline without its code:
   * no conditions, loop heads, per-item keys, parameters read or literal
   * options, only each step's description, name and kind.
   */
  steps:
    | { ok: true; outline: WorkflowOutline }
    | { ok: false; message: string };
  /**
   * Its parameters, for those who build the App; null for anyone else,
   * who neither sees nor sets them.
   */
  params: WorkflowParam[] | null;
  /** Whether the person sets its parameters: a builder, not Grasp staff. */
  setsParams: boolean;
}

/**
 * A dry run of each of a workflow's tests, with the parameter values
 * people set now over the test's own: what each run did and would have
 * changed, as the test harness reports it (`dryRun`). It makes no state
 * changes: side effects are recorded, never made.
 */
export interface WorkflowDryRun {
  /** The App version whose code ran. */
  version: number;
  runs: {
    /** The test the run is of. */
    name: string;
    status: "completed" | "failed";
    report: string;
  }[];
}

/**
 * A signed-in person's workflows. Anyone with a role in the App
 * (`AppsApi`) starts and follows its runs, and its builders cancel them;
 * every call checks the session and the person's role again.
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
  /**
   * Every workflow of the current version of every App the person can
   * open, with its latest run and its waiting and failed runs, by App
   * name and workflow.
   */
  overview: () => Promise<WorkflowSummary[]>;
  /**
   * Runs of the Apps the person can open, as `filter` narrows them:
   * waiting first (latest to wait first), then failed (latest ended
   * first), then the rest, newest first; at most {@link runsPageSize},
   * with `more` when more matched.
   */
  runs: (filter?: RunFilter) => Promise<RunsPage>;
  /** One workflow of an App's current version. */
  get: (app: string, workflow: string) => Promise<WorkflowDetail>;
  /**
   * Dry-runs a workflow's tests at the App's current version, with the
   * parameter values set now; for the App's builders.
   */
  test: (app: string, workflow: string) => Promise<WorkflowDryRun>;
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
 * The values of workflows' parameters. The App's builders set them
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
