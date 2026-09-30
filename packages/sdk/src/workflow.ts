import {
  appMethodPattern,
  isExportName,
  reservedAppMethods,
} from "@grasp-os/shared/apps";
import type { ReservedAppMethod } from "@grasp-os/shared/apps";
import { workflowIdSchema } from "@grasp-os/shared/ids";
import type { RunId, WorkflowId } from "@grasp-os/shared/ids";
import type { Json } from "@grasp-os/shared/json";
import {
  paramDeclarationSchema,
  paramDeclarationsSchema,
  stepIdempotencyKey,
  triggerDeclarationsSchema,
} from "@grasp-os/shared/workflows";
import type { InboundEmail } from "@grasp-os/shared/workflows";
import { z } from "zod";

import type {
  Backoff,
  BindingMethod,
  DecisionRecipient,
  EngineDecision,
  WorkflowEngine,
  WorkflowEnv,
} from "./engine.ts";
import { currencySchema, paramValueSchemas } from "./params.ts";
import type { ParamDefault, ParamKind, ParamValue } from "./params.ts";
import { namePattern, nameRule, stepOptionSchemas } from "./steps.ts";

/**
 * Workflow SDK: the only API workflow code sees. A workflow declares its
 * parameters, then runs its steps in code, each with its options inline:
 *
 * ```ts
 * export default workflow("invoice-approval", {
 *   params: {
 *     threshold: money({ label: "Review invoices above", currency: "EUR", default: 500_000 }),
 *   },
 * }, async (step, { params }) => {
 *   await step.do("book",
 *     { description: "Book the invoice", sideEffect: true, input: { invoice: 7 } },
 *     async ({ idempotencyKey, input }) => ...);
 * });
 * ```
 *
 * The code is the only source of truth: `describeWorkflow` in
 * `@grasp-os/sdk/describe` reads the step list from it.
 */

// Workflow code imports only this module, so it gets Zod from here too.
export { z } from "zod";
export type { ParamKind, ParamValue } from "./params.ts";
// The input schemas of runs an email trigger (`input: emailMessage`) and an
// event trigger (`input: connectorEvent`) start, and what they parse to.
export {
  connectorEventSchema as connectorEvent,
  inboundEmailSchema as emailMessage,
  type ConnectorEvent,
  type InboundEmail as EmailMessage,
} from "@grasp-os/shared/workflows";
export type {
  BindingMethod,
  DecisionRecipient,
  WorkflowEnv,
} from "./engine.ts";

/**
 * The runtime's `Object.freeze`, kept as this module loads: a run's main
 * module (core's workflows/code.ts) loads it before any of the App's code,
 * which could otherwise put its own in its place.
 */
const { freeze } = Object;

const workflowErrorCodes = [
  "workflow.invalid_definition",
  "workflow.invalid_step_call",
  "workflow.invalid_input",
  "workflow.invalid_param",
  "workflow.invalid_model_output",
] as const;
export type WorkflowErrorCode = (typeof workflowErrorCodes)[number];

const isWorkflowErrorCode = (code: unknown): code is WorkflowErrorCode =>
  workflowErrorCodes.some((known) => known === code);

// The code rides in the name, which every engine keeps with the message.
const errorNamePattern = /^WorkflowError\((?<code>[\w.]+)\)$/u;

/**
 * Thrown for a workflow that is wrong: a bad definition, a bad step call, or
 * a value that doesn't match its schema.
 */
export class WorkflowError extends Error {
  /** Stable and machine-readable; branch on this, never on the message. */
  readonly code: WorkflowErrorCode;

  /**
   * Trying again can't fix one, so the engine doesn't retry the step it
   * failed; only a model's answer that doesn't fit is asked for again
   * (`isRetryable` in `@grasp-os/shared/workflows`).
   */
  constructor(code: WorkflowErrorCode, message: string) {
    super(message);
    // Not just the class name: the code rides in the name, which every
    // engine keeps with the message.
    // oxlint-disable-next-line unicorn/custom-error-definition -- see above
    this.name = `WorkflowError(${code})`;
    this.code = code;
  }

  /**
   * The workflow error `error` is, or was before an engine kept only its
   * name and message; undefined for any other error.
   */
  static from(error: unknown): WorkflowError | undefined {
    if (error instanceof WorkflowError) {
      return error;
    }
    if (!(error instanceof Error)) {
      return undefined;
    }
    const code = errorNamePattern.exec(error.name)?.groups?.code;
    return isWorkflowErrorCode(code)
      ? new WorkflowError(code, error.message)
      : undefined;
  }
}

const invalidCall = (message: string): WorkflowError =>
  new WorkflowError("workflow.invalid_step_call", message);

const parseOrThrow = <Schema extends z.ZodType>(
  schema: Schema,
  value: unknown,
  code: WorkflowErrorCode,
  what: string
): z.output<Schema> => {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new WorkflowError(code, `${what}: ${z.prettifyError(result.error)}`);
  }
  return result.data;
};

// Parameters

export type Person = ParamValue<"person">;
export type Schedule = ParamValue<"schedule">;
export type Model = ParamValue<"model">;
export type Template = ParamValue<"template">;

/** A tunable value people see and can change without touching the code. */
export interface Param<Kind extends ParamKind = ParamKind> {
  kind: Kind;
  /** What people see next to the value, e.g. "Review invoices above". */
  label: string;
  default: ParamDefault<Kind>;
  /**
   * Its value needs care where it's shown. People set it like any other,
   * and no value ever goes in the audit log.
   */
  sensitive: boolean;
  /** For money: the ISO 4217 currency its amounts are in, e.g. `EUR`. */
  currency?: string;
}

interface ParamOptions<Kind extends ParamKind> {
  label: string;
  default: ParamDefault<Kind>;
  /** Its value needs care where it's shown; defaults to false. */
  sensitive?: boolean;
}

const param =
  <Kind extends ParamKind>(kind: Kind) =>
  (options: ParamOptions<Kind>): Param<Kind> => ({
    kind,
    label: options.label,
    default: options.default,
    sensitive: options.sensitive ?? false,
  });

/**
 * An amount of money in whole minor units of `currency` (cents for EUR):
 * `default: 500_000` is €5,000.00.
 */
export const money = (
  options: ParamOptions<"money"> & {
    /** ISO 4217, e.g. `EUR`. */
    currency: string;
  }
): Param<"money"> => ({
  ...param("money")(options),
  currency: options.currency,
});
/** A number. */
export const number = param("number");
/** A piece of text. */
export const text = param("text");
/** A person or group, e.g. who reviews; required by `step.decision`. */
export const person = param("person");
/** A schedule, as five cron fields; what a schedule trigger runs on. */
export const schedule = param("schedule");
/** A model from the model gateway; required by `step.llm`. */
export const model = param("model");
/** A template, e.g. for an email. */
export const template = param("template");

type Params = Record<string, Param>;

/** Parameter values as workflow code reads them: `params.threshold`. */
export type ParamValues<P extends Params> = {
  readonly [Name in keyof P]: ParamValue<P[Name]["kind"]>;
};

// Steps

/**
 * A time span: whole milliseconds, or e.g. `"30 minutes"` or `"3 days"`; at
 * most 365 days.
 */
export type Duration =
  | number
  | `${number} ${"second" | "minute" | "hour" | "day" | "week"}${"" | "s"}`;

/** What a step returns: JSON, which the engine records, or nothing. */
// oxlint-disable-next-line typescript/no-invalid-void-type -- a step may return nothing
export type StepResult = Json | undefined | void;

/** Options every step takes. */
interface StepOptions {
  /** What the step does, in plain language; the UI shows it. */
  description: string;
  /**
   * Tells apart the runs of this step within one run, e.g. the ID of the
   * item a loop is on. Without it, a step runs once per run.
   */
  key?: string | number;
}

/**
 * How often to try a failing step again. `limit` counts retries, not
 * attempts (as in Cloudflare Workflows): `limit: 2` is three attempts in
 * all. Only failures trying again may fix are retried: a connection's
 * server that didn't take the call, a rate limit, a model or App that
 * failed or ran out of time. Any other error (a refusal, a tool's own
 * error, one the workflow throws) fails the step at once, and stops the
 * run unless the workflow catches it. Missing, the engine's defaults apply
 * (Cloudflare Workflows: 5 retries, 10 seconds apart, backing off
 * exponentially).
 */
export interface Retries {
  limit: number;
  /** Before the first retry. */
  delay?: Duration;
  /** How the delay grows. */
  backoff?: Backoff;
}

/** Options of a step that runs code, and so can fail and be tried again. */
interface AttemptOptions {
  retries?: Retries;
  /**
   * How long one attempt may take; the engine's default when missing
   * (Cloudflare Workflows: 10 minutes).
   */
  timeout?: Duration;
}

/** What a step works on: JSON, or nothing. */
export type StepInput = Json | undefined;

export interface DoOptions<Input extends StepInput = StepInput>
  extends StepOptions, AttemptOptions {
  /**
   * Changes something outside Grasp. The step gets an idempotency key to
   * pass to connector calls, so a retry never does the change twice.
   */
  sideEffect?: boolean;
  /**
   * Deterministic, with no model involvement: totals, account numbers and
   * references always come from a locked step.
   */
  locked?: boolean;
  /**
   * What the step works on, as JSON; the function gets it back as `input`.
   * It's recorded with the step, and a dry run shows it for a side-effect
   * step it doesn't run, so a side-effect step must give it (`null` when it
   * writes nothing of its own) and take everything it writes from here.
   */
  input?: Input;
}

/** Passed to a side-effect step: hand `idempotencyKey` to connector calls. */
export interface SideEffectContext {
  /**
   * `runId:stepName` (`runId:stepName:key` for a keyed step, the run ID and
   * key URI-encoded); the same on every retry and replay of the step.
   */
  idempotencyKey: string;
}

export interface LlmOptions<Output extends z.ZodType>
  extends StepOptions, AttemptOptions {
  /** A model parameter, so people see and govern which model is used. */
  model: Model;
  /** What the model is asked to do: the prompt. */
  instructions: string;
  /** What the model works on, e.g. the text of an invoice. */
  input: Json;
  /** The shape the answer must have. */
  schema: Output;
  /** A model is involved, so an AI step is never locked. */
  locked?: never;
  sideEffect?: never;
}

/**
 * How a person is asked to decide; `step.decision` calls it inside a
 * side-effect step.
 */
export interface DecisionRequest extends SideEffectContext {
  /**
   * The people who may answer now, each with the decision's link. It
   * leads to where they answer once signed in, and grants nothing: only
   * the people the decision is from can answer, never the run's starter
   * unless `from` is exactly `person:<them>` (see `DecisionOptions.from`).
   * Empty when nobody fits `from`, or the decision was answered meanwhile.
   */
  recipients: DecisionRecipient[];
  /** False the first time, true when reminding. */
  reminder: boolean;
}

export interface DecisionOptions extends StepOptions {
  /**
   * Who decides; only they can answer, signed in, as they are then: a
   * person (`person:<user ID>`), a role (`role:admin`) or a team
   * (`team:<team ID>`). Whoever started the run never answers it, and
   * isn't asked, unless `from` names exactly them; a triggered run has no
   * starter. Every answer is audited under who gave it.
   */
  from: Person;
  /** Tells them there is something to decide, e.g. by email. */
  ask: (request: DecisionRequest) => Promise<void>;
  /** Stop waiting this long after the decision opened, however long asking took. */
  timeout: Duration;
  /** Ask once more when there is no answer this long after asking. */
  remindAfter?: Duration;
}

/**
 * How a decision ended: answered, by whom (their user ID) and with what
 * `payload` they sent (untrusted input, e.g. `{ comment }`), or timed out.
 * A timeout never means approval: nobody decided, so treat it as a no, or
 * ask again.
 */
export type Decision =
  | { timedOut: false; approved: boolean; by: string; payload: Json | null }
  | { timedOut: true };

export interface SleepOptions extends StepOptions {
  duration: Duration;
}

/**
 * Runs steps, one after another. Names and options are literals in the
 * code, so the step list can be read from it; a step name runs once per run
 * unless each run of it has its own `key`. A step never starts while another
 * step runs, e.g. from inside its function.
 */
export interface StepRunner {
  /**
   * Runs plain code. Its result must be JSON: it's recorded, and a replay
   * returns the recorded result instead of running the code again.
   */
  do: {
    <T extends StepResult, Input extends Json>(
      name: string,
      options: DoOptions<Input> & { sideEffect: true; input: Input },
      fn: (context: SideEffectContext & { input: Input }) => Promise<T>
    ): Promise<T>;
    <T extends StepResult, Input extends StepInput = undefined>(
      name: string,
      options: DoOptions<Input> & { sideEffect?: false },
      fn: (context: { input: Input }) => Promise<T>
    ): Promise<T>;
  };
  /**
   * Asks a model through the model gateway. The answer must match `schema`;
   * an answer that doesn't counts as a failure and is retried. The
   * deployment's rules may refuse the call, say because it must stay in the
   * EU, its App has read sensitive data, or this month's model budget is
   * used up; the step then fails with the reason, and isn't retried.
   */
  llm: <Output extends z.ZodType>(
    name: string,
    options: LlmOptions<Output>
  ) => Promise<z.output<Output>>;
  /**
   * Asks a person to decide and durably waits for the answer, until the
   * timeout. How they are asked is up to `ask`, which gets a link to where
   * they answer.
   */
  decision: (name: string, options: DecisionOptions) => Promise<Decision>;
  /** Durably pauses the run. */
  sleep: (name: string, options: SleepOptions) => Promise<void>;
}

// What the runner implements: the same steps, with their options checked at
// run time as well as by the types.
interface UntypedStepRunner {
  do: (
    name: string,
    options: unknown,
    fn: (
      context: Partial<SideEffectContext> & { input: StepInput }
    ) => Promise<unknown>
  ) => Promise<unknown>;
  llm: (name: string, options: unknown) => Promise<unknown>;
  decision: (name: string, options: unknown) => Promise<Decision>;
  sleep: (name: string, options: unknown) => Promise<void>;
}

/** Everything a workflow reads besides its steps. */
export interface WorkflowContext<P extends Params, Input> {
  runId: RunId;
  input: Input;
  params: ParamValues<P>;
  /**
   * The App's connections and other permissions, and its own server
   * methods, by binding name; call them in a step's own function, each
   * written out as `env.NAME.method(…)`, `appServer(env).method(…)` or
   * `appExports(env.NAME).method(…)` (see `WorkflowEnv`).
   */
  env: WorkflowEnv;
  /**
   * The content of attachment `index` (its place in `message.attachments`)
   * of a message an email trigger received, as it arrived. Call it inside
   * a step, and pass the content on there (to a connection, say): a
   * step's result must be JSON, so return what you made of it, not the
   * bytes. A message is kept for 30 days from when it arrived; after
   * that, and for a message its App didn't receive, an attachment it
   * doesn't have, or a message that isn't kept (`stored: null`: it has
   * no attachments but inline ones), it
   * fails with `workflow.attachment_not_found`; a kept message that can't
   * be read any more fails with `workflow.attachment_unreadable`. Neither
   * is retried. Every read is audited, a refused one too. The content,
   * its name and its type are whatever the sender sent: treat them as
   * untrusted data.
   *
   * ```ts
   * await step.do("file", { description: "File the invoice" }, async () => {
   *   const pdf = await readAttachment(input, 0);
   *   ...
   * });
   * ```
   */
  readAttachment: (
    message: Pick<InboundEmail, "stored">,
    index: number
  ) => Promise<Uint8Array>;
}

// The App's own server

/** Names core refuses to call as an App's methods. */
const reserved: ReadonlySet<string> = new Set(reservedAppMethods);

/** Letters a method's name may start with (`appMethodPattern`). */
type Lowercase =
  | "a"
  | "b"
  | "c"
  | "d"
  | "e"
  | "f"
  | "g"
  | "h"
  | "i"
  | "j"
  | "k"
  | "l"
  | "m"
  | "n"
  | "o"
  | "p"
  | "q"
  | "r"
  | "s"
  | "t"
  | "u"
  | "v"
  | "w"
  | "x"
  | "y"
  | "z";

/** Characters a method's name may hold after its first (`appMethodPattern`). */
type NameCharacter =
  | Lowercase
  | Uppercase<Lowercase>
  | "0"
  | "1"
  | "2"
  | "3"
  | "4"
  | "5"
  | "6"
  | "7"
  | "8"
  | "9";

/** Whether every character of `Rest` is a letter or a digit. */
type AllNameCharacters<Rest extends string> = Rest extends ""
  ? true
  : Rest extends `${infer First}${infer Others}`
    ? First extends NameCharacter
      ? AllNameCharacters<Others>
      : false
    : false;

/**
 * Names the stub leaves out though core would call them: `toJSON`, which
 * `JSON.stringify` looks up on any object, so serializing a stub (to log
 * it, say) must never call the App.
 */
type StubOnlyName = "toJSON";

/**
 * Whether core calls `Name` as a method of an App's server, and the stub
 * offers it: it starts with a lowercase letter, holds only letters and
 * digits, and is neither reserved (`reservedAppMethods`) nor `toJSON`.
 * Names such as `__DURABLE_OBJECT_BRAND`, which a class that extends
 * `DurableObject` has, or `set_status`, aren't. Types don't count, so a
 * name longer than `appMethodPattern`'s 64 characters still types, and
 * core refuses it with `app.method_invalid`.
 */
type IsAppMethod<Name> = Name extends `${Lowercase}${infer Rest}`
  ? Name extends ReservedAppMethod | StubOnlyName
    ? false
    : AllNameCharacters<Rest>
  : false;

/**
 * The methods of an App's server class `Server` as a workflow calls them:
 * without the caller, which core passes first, answering what each
 * answers. Only names core calls (`IsAppMethod`) and only functions.
 */
export type AppServer<Server> = {
  readonly [
    Name in keyof Server as IsAppMethod<Name> extends true
      ? Server[Name] extends (...args: never[]) => unknown
        ? Name
        : never
      : never
  ]: Server[Name] extends (caller: never, ...args: infer Args) => infer Answer
    ? (...args: Args) => Promise<Awaited<Answer>>
    : never;
};

/**
 * A typed stub whose every name `isName` accepts is `method(name)`, and
 * any other name, a symbol too, is `undefined`: nothing for `then` (so a
 * stub can be awaited as a value), `toJSON` (so serializing it calls
 * nothing), or any name core refuses. For `appServer` and `appExports`.
 */
const methodsOf = (
  isName: (name: string) => boolean,
  method: (name: string) => BindingMethod
): Readonly<Record<string, BindingMethod | undefined>> =>
  new Proxy(
    {},
    {
      get: (_target, name): BindingMethod | undefined =>
        typeof name === "string" && isName(name) ? method(name) : undefined,
    }
  );

/**
 * A typed stub of the run's own App's server methods (`app/server.ts`):
 * `appServer<App>(env).setStatus("INV-7", "booked")` is
 * `env.APP.call("setStatus", "INV-7", "booked")`, typed by the App's
 * class, which a workflow imports as a type only:
 *
 * ```ts
 * import type { App } from "../app/server.ts";
 *
 * await step.do("book", { description: "Book it", sideEffect: true }, async () => {
 *   await appServer<App>(env).setStatus(input.invoice, "booked");
 * });
 * ```
 *
 * Like `env.APP`, it works only inside a step, and acts for the person the
 * run acts for. Within one App no permission is needed. What the method
 * writes reaches the App's open screens as the App tells them (the
 * live updates of `@grasp-os/sdk/screen`).
 */
export const appServer = <Server = Record<string, BindingMethod>>(
  env: WorkflowEnv
): AppServer<Server> => {
  const method =
    (name: string): BindingMethod =>
    async (...args) => {
      const app = env.APP;
      if (app?.call === undefined) {
        throw invalidCall("The run has no App to call (env.APP)");
      }
      return await app.call(name, ...args);
    };
  // SAFETY: every name `AppServer` has is one this accepts (the type keeps
  // only those), a method that calls the App's method of that name; core
  // checks the name again, and refuses one the App doesn't have.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  return methodsOf(
    (name) =>
      appMethodPattern.test(name) && !reserved.has(name) && name !== "toJSON",
    method
  ) as AppServer<Server>;
};

/**
 * The exports of another App as a workflow calls them, typed by
 * `Exports`, which the workflow writes from what that App's
 * `app/exports.json` declares: each export's one input, answering what it
 * answers. Only names core calls (`IsAppMethod`) and only functions.
 */
export type AppExportsStub<Exports> = {
  readonly [
    Name in keyof Exports as Name extends "read" | "write"
      ? never
      : IsAppMethod<Name> extends true
        ? Exports[Name] extends (input: never) => unknown
          ? Name
          : never
        : never
  ]: Exports[Name] extends (input: infer Input) => infer Answer
    ? (input: Input) => Promise<Awaited<Answer>>
    : never;
};

/**
 * A typed stub of another App's exports, by the run's permission on them
 * (its binding): `appExports<Crm>(env.CRM).findCustomers({ query: "Acme" })`
 * is `env.CRM.call("findCustomers", { query: "Acme" })`:
 *
 * ```ts
 * type Crm = {
 *   findCustomers: (input: { query: string }) => { id: string; name: string }[];
 * };
 *
 * const found = await step.do("find", { description: "Find the customer" }, async () =>
 *   await appExports<Crm>(env.CRM).findCustomers({ query: input.customer })
 * );
 * ```
 *
 * Like any binding, it works only inside a step, and acts for the person
 * the run acts for, under the run's App's permission; the called App's
 * method runs in its own sandbox. Core checks each call: the export must
 * be in that App's current version (`app.export_not_found` otherwise),
 * allowed by the permission (one marked `write` only from a version of
 * this App an admin approved), and its input and answer JSON within
 * `appCallLimits` and its schemas (`app.call_invalid`, `app.call_too_large`,
 * `app.answer_invalid`). If either App has read restricted data, both are
 * restricted from then on.
 *
 * Make one call of an export that writes per step, as with `appServer`:
 * the called App's own connection calls take the step's idempotency key,
 * so a second such call in the same step repeats the first one's side
 * effects' answers instead of making its own. A `sideEffect: true` step
 * gets the key.
 */
export const appExports = <Exports = Record<string, (input: Json) => unknown>>(
  binding: Readonly<Record<string, BindingMethod>> | undefined
): AppExportsStub<Exports> => {
  const method =
    (name: string): BindingMethod =>
    async (input) => {
      if (binding?.call === undefined) {
        throw invalidCall("The run has no permission to call that App");
      }
      return await binding.call(name, input ?? null);
    };
  // SAFETY: every name `AppExportsStub` has is an export's name (the type
  // keeps only those), a method that calls the export of that name; core
  // checks the name again, and refuses one the App doesn't export.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  return methodsOf(isExportName, method) as AppExportsStub<Exports>;
};

// Definition

/**
 * What starts a run, besides a person starting it by hand. Triggers only
 * ever start workflows: screens can't declare them. They take effect when
 * the App's version is made current, and stop when another version that
 * doesn't declare them is. A run a trigger starts acts for the App's
 * owner, and fails if the owner has left the organization.
 *
 * ```ts
 * workflow("weekly-report", {
 *   params: { every: schedule({ label: "Runs", default: "0 8 * * 1" }) },
 *   triggers: [{ type: "schedule", param: "every", timeZone: "Europe/Amsterdam" }],
 * }, async (step) => ...);
 * ```
 */
export type Trigger<ScheduleParam extends string = string> =
  | { type: "manual" }
  /**
   * On the schedule a schedule parameter holds, so people can change when
   * it runs without changing the code. Its cron expression is read in
   * `timeZone` (an IANA name, e.g. `Europe/Amsterdam`; UTC when missing),
   * so `0 8 * * 1` is 8:00 on Mondays there, summer time or not. A time
   * the change to summer time skips runs an hour later (2:30 at 3:30); in
   * the hour the change back repeats, times run once, in its first pass. A
   * scheduled run starts with no input. A time missed (an outage, say)
   * starts one run late, however many times were
   * missed; a schedule set or made current starts from the next time
   * after, never one already past.
   */
  | { type: "schedule"; param: ScheduleParam; timeZone?: string }
  /**
   * When a connection reports an event of this type, e.g.
   * `m365.mail.received`, and only what the App could read: through a
   * permission on the connection (or on the part of it the event is
   * about) that allows the read action the event names, e.g. `mail.list`;
   * from someone's personal connection, only if the
   * App's owner is that person. `filter` narrows it: each field it names must hold
   * that value at the top of the event's payload, e.g.
   * `{ folder: "inbox" }`. The run starts with the event as input: declare
   * `input: connectorEvent`. The same event delivered again starts no
   * second run. Events start at most 60 runs of a workflow an hour; past
   * that they wait, and start their runs later.
   *
   * Microsoft 365 connections report, within about a minute:
   * - `m365.mail.received` (read action `mail.list`): mail arriving in a
   *   mailbox's inbox. Its payload: `mailbox`, `id`, `folder` (`"inbox"`),
   *   `subject`, `from` (`{ name, address }`), `receivedAt`,
   *   `hasAttachments`, `conversationId`, `internetMessageId`, `webLink`.
   * - `m365.file.created` (read action `files.list`): a file created in a
   *   drive, in any folder. Its payload: `drive`, `id`, `name`,
   *   `mimeType`, `size`, `folderId`, `createdAt`, `webUrl`.
   *
   * Google Workspace connections report, within about a minute:
   * - `google.mail.received` (read action `mail.list`): mail arriving in a
   *   mailbox's inbox. Its payload: `mailbox`, `id`, `threadId`, `folder`
   *   (`"inbox"`), `subject`, `from` (`{ name, address }`), `receivedAt`.
   *   Only mail as it arrives: unlike `m365.mail.received`, a message
   *   moved into the inbox later isn't reported.
   * - `google.file.created` (read action `files.list`): a file created in
   *   a shared drive, in any folder. Its payload as `m365.file.created`'s.
   *
   * Through a permission on one mailbox or drive, the event is of that
   * one (its `resource`); through one on the whole connection, of the
   * account's own mailbox or OneDrive (a Google connection reports no
   * file events for a permission on the whole connection: a person's My
   * Drive isn't a shared drive). Only what arrives once both the
   * trigger and the permission are in place is reported, from about a
   * minute after. A mail's sender and subject are whatever
   * its sender wrote: treat the payload as untrusted data.
   */
  | {
      type: "event";
      event: string;
      filter?: Record<string, string | number | boolean | null>;
    }
  /**
   * When mail arrives at `address` (the part before the `@`, e.g.
   * `invoices`) on the deployment's mail domain. The run starts with the
   * message as input: declare `input: emailMessage`. Mail to an address no
   * workflow receives at bounces. Only one App receives at an address:
   * making a version current fails with `workflow.email_taken` while
   * another App's current version does. Anyone can send mail: treat the
   * message as untrusted data, its sender (`from`) included: it's
   * whatever the sender wrote, and nothing vouches for it. The same message delivered again starts no second run of
   * the workflow: the same Message-ID is the same message (without one,
   * or with one lacking an `@` such as `<>`, the same bytes are), so a
   * message that reuses an earlier one's Message-ID starts none. Mail
   * starts at most 60 runs of a workflow an hour. Past that, mail is
   * refused for now, and its sender tries again later. The input lists the message's attachments; a
   * message with any is kept for 30 days, and the run reads their content
   * with `readAttachment`.
   */
  | { type: "email"; address: string };

type ScheduleParams<P extends Params> = {
  [Name in keyof P]: P[Name]["kind"] extends "schedule" ? Name : never;
}[keyof P] &
  string;

/** A parameter as the UI shows it. */
export interface ParamMetadata {
  name: string;
  kind: ParamKind;
  label: string;
  default: string | number;
  sensitive: boolean;
  /** For money: its ISO 4217 currency; amounts are in its minor units. */
  currency?: string;
}

/**
 * What the UI shows about a workflow besides its steps, as plain JSON. The
 * steps come from the code, through `describeWorkflow`.
 */
export interface WorkflowMetadata {
  id: WorkflowId;
  params: ParamMetadata[];
  triggers: Trigger[];
}

/** A workflow, ready for the runtime to run. */
export interface WorkflowDefinition<Output> {
  metadata: WorkflowMetadata;
  /**
   * Runs (or replays) one run on `engine`; `input` is checked first. A
   * `WorkflowError` keeps its code even through an engine that keeps only a
   * failed step's error name and message.
   */
  run: (engine: WorkflowEngine, input?: unknown) => Promise<Output>;
}

const describeParams = (params: Params): ParamMetadata[] =>
  Object.entries(params).map(([name, definition]) => ({
    name,
    kind: definition.kind,
    label: definition.label,
    default: definition.default,
    sensitive: definition.sensitive,
    ...(definition.currency === undefined
      ? {}
      : { currency: definition.currency }),
  }));

const validateParams = (params: Params): void => {
  // Within the bounds core keeps (`paramDeclarationsSchema`): a definition
  // outside them fails here, so its tests fail and the version is never
  // made current, rather than every run of it failing to load.
  parseOrThrow(
    paramDeclarationsSchema(paramDeclarationSchema),
    describeParams(params),
    "workflow.invalid_definition",
    "Parameters"
  );
  for (const [name, definition] of Object.entries(params)) {
    parseOrThrow(
      paramValueSchemas[definition.kind],
      definition.default,
      "workflow.invalid_definition",
      `Default of parameter "${name}"`
    );
    if (definition.kind === "money") {
      parseOrThrow(
        currencySchema,
        definition.currency,
        "workflow.invalid_definition",
        `Currency of parameter "${name}"`
      );
    }
  }
};

const validateTriggers = (params: Params, triggers: Trigger[]): void => {
  parseOrThrow(
    triggerDeclarationsSchema,
    triggers,
    "workflow.invalid_definition",
    "Triggers"
  );
  for (const trigger of triggers) {
    if (
      trigger.type === "schedule" &&
      params[trigger.param]?.kind !== "schedule"
    ) {
      throw new WorkflowError(
        "workflow.invalid_definition",
        `Schedule trigger: "${trigger.param}" isn't a schedule parameter`
      );
    }
  }
};

const resolveParams = (
  params: Params,
  configured: Readonly<Record<string, unknown>>
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(params).map(([name, definition]) => [
      name,
      parseOrThrow(
        paramValueSchemas[definition.kind],
        // A value that is set but empty fails, rather than quietly falling
        // back to the default.
        Object.hasOwn(configured, name) ? configured[name] : definition.default,
        "workflow.invalid_param",
        `Parameter "${name}"`
      ),
    ])
  );

// Core requires exactly this key on the step's connection calls.
const idempotencyKeyOf = (engine: WorkflowEngine, step: string): string =>
  stepIdempotencyKey(engine.runId, step);

/** A step call's options, checked against its method's schema. */
const optionsOf = <Schema extends z.ZodType>(
  schema: Schema,
  name: string,
  options: unknown
): z.output<Schema> =>
  parseOrThrow(
    schema,
    options,
    "workflow.invalid_step_call",
    `Options of step "${name}"`
  );

const createRunner = (
  engine: WorkflowEngine
): {
  steps: UntypedStepRunner;
  readAttachment: WorkflowContext<Params, unknown>["readAttachment"];
} => {
  const started = new Set<string>();
  // The step running now, if any. They run one after another: one started
  // from inside a step's function, or next to another, would be recorded
  // in an order a replay can't promise to repeat.
  let running: string | undefined;

  const exclusive = async <T>(what: string, run: () => Promise<T>) => {
    if (running !== undefined) {
      throw invalidCall(
        `${what} started while ${running} runs; run steps one after another, never inside a step`
      );
    }
    running = what;
    try {
      return await run();
    } finally {
      running = undefined;
    }
  };

  // Returns the step's engine name: its name, or `name:key` for a keyed
  // step. Types catch most bad calls; workflow code that got past them
  // still fails here, before anything runs.
  const start = (name: string, key: string | number | undefined): string => {
    if (typeof name !== "string" || !namePattern.test(name)) {
      throw invalidCall(`Step "${name}" needs a name of ${nameRule}`);
    }
    // Encoded, so a key never contains the separators of engine step names.
    const step =
      key === undefined ? name : `${name}:${encodeURIComponent(key)}`;
    if (started.has(step)) {
      throw invalidCall(
        key === undefined
          ? `Step "${name}" already ran in this run; give each run of it its own key`
          : `Step "${name}" already ran with key "${String(key)}" in this run`
      );
    }
    started.add(step);
    return step;
  };

  const steps: UntypedStepRunner = {
    do: async (name, rawOptions, fn) =>
      await exclusive(`Step "${name}"`, async () => {
        const options = optionsOf(stepOptionSchemas.do, name, rawOptions);
        const step = start(name, options.key);
        if (typeof fn !== "function") {
          throw invalidCall(`Step "${name}" needs a function to run`);
        }
        const { input, retries, timeout } = options;
        const sideEffect = options.sideEffect === true;
        return await engine.do(
          step,
          { retries, timeout, sideEffect, input },
          async () =>
            sideEffect
              ? await fn({
                  idempotencyKey: idempotencyKeyOf(engine, step),
                  input,
                })
              : await fn({ input })
        );
      }),

    llm: async (name, rawOptions) =>
      await exclusive(`Step "${name}"`, async () => {
        const options = optionsOf(stepOptionSchemas.llm, name, rawOptions);
        const step = start(name, options.key);
        const { instructions, input, schema, retries, timeout } = options;
        const request = {
          step,
          model: options.model,
          instructions,
          input,
          // The model writes what the schema accepts, so describe its input
          // side.
          outputSchema: z.toJSONSchema(schema, { io: "input" }),
        };
        // The raw answer is recorded, not the parsed one: parsed output may
        // hold values that don't survive being recorded (a transform to a
        // Date, say). Checking it inside the step makes an answer that
        // doesn't fit a failure the step's retries may fix.
        const answer = await engine.do(
          step,
          { retries, timeout, input },
          async () => {
            const raw = await engine.callModel(request);
            parseOrThrow(
              schema,
              raw,
              "workflow.invalid_model_output",
              `Answer to step "${name}"`
            );
            return raw;
          }
        );
        return parseOrThrow(
          schema,
          answer,
          "workflow.invalid_model_output",
          `Answer to step "${name}"`
        );
      }),

    decision: async (name, rawOptions) =>
      await exclusive(`Step "${name}"`, async () => {
        const { key, description, from, ask, timeout, remindAfter } = optionsOf(
          stepOptionSchemas.decision,
          name,
          rawOptions
        );
        const step = start(name, key);

        // The engine sets the deadline when the decision opens, so time
        // spent asking or reminding never pushes it out, and no answer
        // counts after it. Other times are taken inside steps, so a replay
        // computes the same waits.
        const { decision, deadline } = await engine.do(
          step,
          { input: { from } },
          async () =>
            await engine.openDecision({ step, from, description, timeout })
        );
        // Asking is a side effect, which a dry run doesn't run, so when it
        // finished is a step of its own rather than the ask step's result.
        const askPeople = async (reminder: boolean): Promise<number> => {
          const askStep = `${step}#${reminder ? "remind" : "ask"}`;
          await engine.do(
            askStep,
            { sideEffect: true, input: { from, reminder } },
            async () => {
              const recipients = await engine.decisionRecipients(
                decision,
                reminder
              );
              // A reminder of a decision that was answered or has closed
              // (timed out) goes to nobody, so it isn't sent at all.
              if (reminder && recipients.length === 0) {
                return;
              }
              await ask({
                recipients,
                reminder,
                idempotencyKey: idempotencyKeyOf(engine, askStep),
              });
            }
          );
          return await engine.do(
            `${step}#${reminder ? "reminded" : "asked"}`,
            {},
            async () => await Promise.resolve(Date.now())
          );
        };
        const waitForAnswer = async (
          waitStep: string,
          since: number,
          until: number,
          last: boolean
        ): Promise<EngineDecision> =>
          await engine.waitForDecision(waitStep, {
            decision,
            timeout: Math.max(until - since, 0),
            last,
          });

        const askedAt = await askPeople(false);
        const remindAt =
          remindAfter === undefined ? undefined : askedAt + remindAfter;
        const reminds = remindAt !== undefined && remindAt < deadline;
        let answer = await waitForAnswer(
          `${step}#answer`,
          askedAt,
          reminds ? remindAt : deadline,
          !reminds
        );
        if (!answer.answered && reminds) {
          const remindedAt = await askPeople(true);
          answer = await waitForAnswer(
            `${step}#answer-after-reminder`,
            remindedAt,
            deadline,
            true
          );
        }
        if (!answer.answered) {
          return { timedOut: true };
        }
        return {
          timedOut: false,
          approved: answer.approved,
          by: answer.by,
          payload: answer.payload,
        };
      }),

    sleep: async (name, rawOptions) => {
      await exclusive(`Step "${name}"`, async () => {
        const { key, duration } = optionsOf(
          stepOptionSchemas.sleep,
          name,
          rawOptions
        );
        await engine.sleep(start(name, key), duration);
      });
    },
  };

  // Not a step of its own: bytes can't be recorded, so the step it runs in
  // reads again whenever it runs again. Every call goes to the engine,
  // which refuses and records each one it must (see `WorkflowEngine`):
  // only what isn't data is left out, so the call can cross to it.
  const readAttachment: WorkflowContext<
    Params,
    unknown
  >["readAttachment"] = async (message, index) => {
    const stored: unknown =
      typeof message === "object" && message !== null
        ? message.stored
        : undefined;
    return await engine.readAttachment(
      typeof stored === "string" || stored === null ? stored : undefined,
      typeof index === "number" ? index : undefined
    );
  };

  return { steps, readAttachment };
};

/**
 * Defines a workflow. `params` are the tunable values; `run` is the workflow
 * itself, with every step and its options written inline. Checks the
 * definition right away, so a bad one fails when it loads.
 */
export const workflow = <
  const P extends Params,
  Output,
  InputSchema extends z.ZodType = z.ZodUndefined,
>(
  id: string,
  config: {
    params: P;
    /** The run's input, e.g. the invoice that started it. */
    input?: InputSchema;
    /** Manual only when missing. */
    triggers?: Trigger<ScheduleParams<P>>[];
  },
  run: (
    step: StepRunner,
    context: WorkflowContext<P, z.output<InputSchema>>
  ) => Promise<Output>
): WorkflowDefinition<Output> => {
  const workflowId = parseOrThrow(
    workflowIdSchema,
    id,
    "workflow.invalid_definition",
    "Workflow ID"
  );
  validateParams(config.params);
  const triggers: Trigger[] = config.triggers ?? [{ type: "manual" }];
  validateTriggers(config.params, triggers);
  const inputSchema: z.ZodType = config.input ?? z.undefined();

  const runOnce = async (
    engine: WorkflowEngine,
    rawInput: unknown
  ): Promise<Output> => {
    // SAFETY: parsed by `config.input`, or checked to be undefined when
    // there is none, which is the default of `InputSchema`.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    const input = parseOrThrow(
      inputSchema,
      rawInput,
      "workflow.invalid_input",
      "Input"
    ) as z.output<InputSchema>;
    // Recorded, so a replay runs with the values the run started with. A
    // value that doesn't fit fails for good: the error is non-retryable.
    const params = await engine.do(
      "$params",
      {},
      async () =>
        await Promise.resolve(resolveParams(config.params, engine.params))
    );
    const runner = createRunner(engine);
    return await run(
      // SAFETY: the untyped runner takes every call the typed one allows
      // and checks each option at run time.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
      runner.steps as StepRunner,
      {
        runId: engine.runId,
        input,
        // SAFETY: resolveParams parses every declared parameter with the
        // schema of its kind, which is what ParamValues<P> describes.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
        params: Object.freeze(params) as ParamValues<P>,
        env: engine.env,
        readAttachment: runner.readAttachment,
      }
    );
  };

  // Frozen, so no code can put another `run` in its place once it is
  // made (a module that imports the workflow's own file, say): the run
  // is held to the steps its review shows this one running.
  const definition: WorkflowDefinition<Output> = {
    metadata: {
      id: workflowId,
      params: describeParams(config.params),
      triggers,
    },
    run: async (engine, rawInput) => {
      try {
        return await runOnce(engine, rawInput);
      } catch (error) {
        // Engines may keep only a failed step's error name and message;
        // the code is in the name, so the error comes back whole.
        throw WorkflowError.from(error) ?? error;
      }
    },
  };
  return freeze(definition);
};
