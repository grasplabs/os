import type {
  Api,
  AssistantMessage,
  FetchFunction,
  Message,
  Model,
  ProviderHeaders,
  SimpleStreamOptions,
  StreamFunction,
  Usage,
} from "@earendil-works/pi-ai";
import { streamSimple as anthropicMessages } from "@earendil-works/pi-ai/api/anthropic-messages";
import {
  CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL,
  createAiBindingFetch,
} from "@earendil-works/pi-ai/api/cloudflare-ai-binding";
import type { AiBinding } from "@earendil-works/pi-ai/api/cloudflare-ai-binding";
import { streamSimple as openaiCompletions } from "@earendil-works/pi-ai/api/openai-completions";
import { streamSimple as openaiResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";
import { CLOUDFLARE_WORKERS_AI_MODELS } from "@earendil-works/pi-ai/providers/cloudflare-workers-ai.models";
import { OPENAI_MODELS } from "@earendil-works/pi-ai/providers/openai.models";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import {
  auditActorSchema,
  auditEventSchema,
  auditIdentifierMaxLength,
  createAuditEvent,
} from "@grasp-os/shared/audit";
import type { AuditEntry } from "@grasp-os/shared/audit";
import { log } from "@grasp-os/shared/log";
import { modelErrors } from "@grasp-os/shared/models";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { outboxed, sendAuditOutboxNow } from "./audit-outbox.ts";
import { jsonVar } from "./json-var.ts";

// The model gateway: every model call in a deployment goes through here, and
// from here through the deployment's AI Gateway, never straight to a
// provider. Core holds no provider key: AI Gateway pays with Workers AI,
// Unified Billing (Cloudflare credits) or the client's own keys stored in
// the gateway, and core reaches it over the AI binding, which needs no token
// either. Every request is audited as metadata only: who or what asked, why,
// the model, tokens and cost, never the prompt or the answer. The event goes
// through the audit outbox, so a request that was answered (and paid for)
// is recorded even when the queue refuses it for a moment.
//
// Only providers whose pi adapter takes a custom fetch can ride the binding.
// Google's refuses one, so Google models would need a gateway token over
// HTTPS, and aren't offered.

/**
 * The providers the gateway offers, by their AI Gateway path: the pi adapter
 * for the API their native endpoint speaks, and pi's catalog of their
 * models, which gives each model's limits and prices.
 */
const providers = {
  anthropic: {
    stream: anthropicMessages,
    catalog: ANTHROPIC_MODELS,
    path: "anthropic",
  },
  openai: {
    stream: openaiResponses,
    catalog: OPENAI_MODELS,
    path: "openai",
  },
  // Workers AI's own OpenAI-compatible endpoint, not the gateway's
  // cross-provider /compat layer, which drops provider features.
  "workers-ai": {
    stream: openaiCompletions,
    catalog: CLOUDFLARE_WORKERS_AI_MODELS,
    path: "workers-ai/v1",
  },
} as const;
type Provider = keyof typeof providers;

const isProvider = (value: string): value is Provider =>
  Object.hasOwn(providers, value);

/**
 * Workers AI counts the answer's cap against the model's window and refuses
 * a request whose total is over it, so answers are capped well below.
 */
const workersAiMaxTokens = 32_768;

/**
 * How long an answer may be when the call doesn't say: enough for a long
 * answer, well below what most models could write (and bill) in one go.
 */
const defaultMaxTokens = 16_384;

/**
 * How long a call may take, retries included, when it doesn't say; and the
 * most it may ask for.
 */
const defaultTimeoutMs = 3 * 60_000;
const maxTimeoutMs = 15 * 60_000;

/**
 * Retries for a request the provider refused for a moment (429 or 5xx) or
 * that didn't connect; the provider SDKs back off in between.
 */
const maxRetries = 2;

interface ModelRef {
  provider: Provider;
  id: string;
  /** pi's descriptor, which points at the provider's own endpoint. */
  catalog: Model<Api>;
}

/**
 * A model as the gateway names it: `<provider>/<model>`, such as
 * `anthropic/claude-sonnet-5` or
 * `workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast`. Only models in pi's
 * catalog, so every call has a price.
 */
const parseModelRef = (ref: string): ModelRef | undefined => {
  const slash = ref.indexOf("/");
  const provider = ref.slice(0, slash);
  const id = ref.slice(slash + 1);
  if (slash === -1 || !isProvider(provider)) {
    return undefined;
  }
  const catalog: Readonly<Record<string, Model<Api>>> =
    providers[provider].catalog;
  // Own keys only, so `constructor` and the like are no model.
  const model = Object.hasOwn(catalog, id) ? catalog[id] : undefined;
  return model === undefined ? undefined : { provider, id, catalog: model };
};

/** An AI Gateway ID: lowercase letters, digits and dashes. */
const gatewayIdPattern = /^[a-z0-9][a-z0-9-]{0,63}$/u;

const modelGatewayConfigSchema = z.object({
  /** The deployment's AI Gateway, in the deployment's own account. */
  gateway: z.string().regex(gatewayIdPattern),
  /** The models this deployment allows; every other model is refused. */
  models: z
    .array(
      z.string().refine((ref) => parseModelRef(ref) !== undefined, {
        message: "A <provider>/<model> the gateway offers",
      })
    )
    .min(1),
});
type ModelGatewayConfig = z.infer<typeof modelGatewayConfigSchema>;

/**
 * Core's env, with the AI binding as pi describes it. It is absent on plain
 * workerd (on-prem), where no call can be made.
 */
export type ModelsEnv = Omit<Env, "AI"> & { AI?: AiBinding };

/**
 * The deployment's model gateway config: deployment config, set by the
 * console as the `MODEL_GATEWAY` var, never an in-product setting, so an
 * admin session can't allow a model the client didn't agree to. `undefined`
 * when none is set; one that doesn't parse counts as none, and every call
 * fails closed.
 */
const modelGatewayConfig = (env: ModelsEnv): ModelGatewayConfig | undefined => {
  if (env.MODEL_GATEWAY === undefined) {
    return undefined;
  }
  const parsed = modelGatewayConfigSchema.safeParse(jsonVar(env.MODEL_GATEWAY));
  if (!parsed.success) {
    log.error("model.config_invalid", {
      paths: parsed.error.issues.map(({ path }) => path.join(".")).join(" "),
    });
    return undefined;
  }
  return parsed.data;
};

/** What a call is for, such as `workflow.step` or `chat.turn`. */
const purposePattern = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/u;

const callSchema = z
  .strictObject({
    /** `<provider>/<model>`, one the deployment allows. */
    model: z.string().min(1),
    /** Instructions: the system prompt. */
    system: z.string().optional(),
    /** One message to answer: text, or JSON sent as its text. */
    input: z.json().optional(),
    /** A conversation to continue, ending with the person's turn. */
    messages: z
      .array(
        z.strictObject({
          role: z.enum(["user", "assistant"]),
          content: z.string().min(1),
        })
      )
      .min(1)
      .optional(),
    /** The most tokens the answer may take; capped at the model's limit. */
    maxTokens: z.int().positive().optional(),
    /** How long the call may take, in milliseconds, retries included. */
    timeoutMs: z.int().positive().max(maxTimeoutMs).optional(),
    /** Why the call is made, for the audit log. */
    purpose: z.string().max(64).regex(purposePattern),
    /** Who or what asked: a person, an agent, an App or a workflow run. */
    trigger: auditActorSchema,
    /** IDs of the resources that fed the prompt. */
    provenance: auditEventSchema.shape.provenance,
    requestId: auditEventSchema.shape.requestId,
  })
  .refine(({ input, messages }) => (input === undefined) !== !messages, {
    message: "Either input or messages",
  })
  .refine(({ messages }) => messages?.at(-1)?.role !== "assistant", {
    message: "Messages end with the person's turn",
  });
type Call = z.output<typeof callSchema>;

/** One model call. */
export type ModelCall<Output> = z.input<typeof callSchema> & {
  /**
   * The answer must be JSON that matches this schema: it is validated, and
   * the model asked once more when it doesn't match.
   */
  schema?: z.ZodType<Output>;
};

/** What a call answered. */
export interface ModelAnswer<Output> {
  /** The answer's text. */
  text: string;
  /** The answer parsed with the call's schema; `undefined` without one. */
  output: Output;
  /** The model hit its output limit, so the text may stop short. */
  truncated: boolean;
  /** Across every request the call made. */
  usage: { inputTokens: number; outputTokens: number };
  /** In US dollars, at the provider's list prices. */
  cost: number;
}

/**
 * The model, pointed at the deployment's gateway over the AI binding: the
 * gateway's route for the provider's native API, the same path as over
 * HTTPS minus the account, which the binding carries.
 */
const gatewayModel = (gateway: string, ref: ModelRef): Model<Api> => ({
  ...ref.catalog,
  baseUrl: `https://workers-binding.ai/ai-gateway/gateways/${gateway}/${providers[ref.provider].path}`,
  maxTokens:
    ref.provider === "workers-ai"
      ? Math.min(ref.catalog.maxTokens, workersAiMaxTokens)
      : ref.catalog.maxTokens,
});

const gatewayHeaders = (call: Call): ProviderHeaders => ({
  // The binding authenticates the request. pi still wants auth before it
  // sends, and the gateway strips this placeholder. The nulls drop the
  // SDKs' own auth headers, which the gateway would take for a caller's
  // provider key instead of using its stored ones.
  "cf-aig-authorization": `Bearer ${CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL}`,
  Authorization: null,
  "x-api-key": null,
  // The gateway logs metadata, never prompts or answers.
  "cf-aig-collect-log-payload": "false",
  // So the gateway's log can be searched by why and for what kind of
  // caller; identifiers only, like the audit event.
  "cf-aig-metadata": JSON.stringify({
    purpose: call.purpose,
    actor: call.trigger.type,
    ...(call.requestId === undefined ? {} : { requestId: call.requestId }),
  }),
});

const noUsage: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** The call's messages in pi's shape. */
const toMessages = (call: Call, model: Model<Api>): Message[] => {
  const timestamp = Date.now();
  if (call.messages === undefined) {
    const { input } = call;
    const content = typeof input === "string" ? input : JSON.stringify(input);
    return [{ role: "user", content, timestamp }];
  }
  return call.messages.map(({ role, content }): Message =>
    role === "user"
      ? { role, content, timestamp }
      : {
          role,
          content: [{ type: "text", text: content }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: noUsage,
          stopReason: "stop",
          timestamp,
        }
  );
};

const structuredInstructions = (schema: z.ZodType): string =>
  [
    "Answer with only a JSON value that matches this JSON Schema, and no other text:",
    JSON.stringify(z.toJSONSchema(schema, { unrepresentable: "any" })),
  ].join("\n");

const answerText = (answer: AssistantMessage): string =>
  answer.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("");

const jsonFencePattern = /^```(?:json)?\s*(?<body>[\s\S]*?)\s*```$/u;

/** The answer's JSON parsed with the schema, or why it doesn't fit. */
const parseOutput = <Output>(
  text: string,
  schema: z.ZodType<Output>
): { ok: true; output: Output } | { ok: false; problem: string } => {
  const trimmed = text.trim();
  let value: unknown = undefined;
  try {
    value = JSON.parse(jsonFencePattern.exec(trimmed)?.groups?.body ?? trimmed);
  } catch {
    return { ok: false, problem: "it isn't JSON." };
  }
  const parsed = schema.safeParse(value);
  return parsed.success
    ? { ok: true, output: parsed.data }
    : { ok: false, problem: z.prettifyError(parsed.error) };
};

/** Tokens the prompt took, cached or not. */
const inputTokens = ({ input, cacheRead, cacheWrite }: Usage): number =>
  input + cacheRead + cacheWrite;

const costOf = ({ cost }: Usage): number =>
  Number.isFinite(cost.total) && cost.total > 0 ? cost.total : 0;

const hasFailed = ({ stopReason }: AssistantMessage): boolean =>
  stopReason === "error" || stopReason === "aborted";

interface Request {
  model: Model<Api>;
  ref: ModelRef;
  call: Call;
  /** The AI binding's fetch, which reaches the gateway. */
  transport: FetchFunction;
  /** Ends the call when it takes too long, retries included. */
  signal: AbortSignal;
  system: string | undefined;
  messages: Message[];
}

interface Sent {
  answer: AssistantMessage;
  /** The HTTP status and the gateway's log entry, once it answered. */
  status: number | undefined;
  logId: string | undefined;
}

/**
 * Sends one request through the gateway. pi reports a failed request as an
 * answer with an error stop reason instead of throwing.
 */
const send = async ({
  model,
  ref,
  call,
  transport,
  signal,
  system,
  messages,
}: Request): Promise<Sent> => {
  let status: number | undefined = undefined;
  let logId: string | undefined = undefined;
  // SAFETY: the provider picks both the adapter and the catalog the model
  // comes from, so the model always speaks the adapter's API.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  const adapter = providers[ref.provider].stream as StreamFunction<
    Api,
    SimpleStreamOptions
  >;
  const stream = adapter(
    model,
    normalizeContext({ systemPrompt: system, messages }),
    {
      fetch: transport,
      headers: gatewayHeaders(call),
      maxTokens: Math.min(call.maxTokens ?? defaultMaxTokens, model.maxTokens),
      maxRetries,
      // Reasoning at a middle effort where the model has it: without a
      // level pi turns it off.
      reasoning: model.reasoning ? "medium" : undefined,
      signal,
      onResponse: (response) => {
        ({ status } = response);
        logId = response.headers["cf-aig-log-id"];
      },
    }
  );
  const answer = await stream.result();
  return { answer, status, logId };
};

/**
 * The HTTP status at the start of pi's text for a refused request, in each
 * adapter's form: `429 {…}`, `429: {…}` or `OpenAI API error (429): {…}`.
 * pi fails such a request before `onResponse`, so this is the only place
 * the status is.
 */
const failedStatusPattern = /^[^{]{0,40}?\b(?<status>[1-5]\d{2})\b/u;

const errorTypeSchema = z.string().regex(/^[A-Za-z][\w.-]{0,63}$/u);

/**
 * The provider's error body, as pi quotes it after the status: Anthropic's
 * `{ error: { type } }`, or the `{ type }` pi takes from OpenAI's.
 */
const providerErrorSchema = z.union([
  z.object({ error: z.object({ type: errorTypeSchema }) }),
  z.object({ type: errorTypeSchema }),
]);

/** Why a request failed, as far as can be told without its message. */
interface Failure {
  status: number | undefined;
  /** The provider's error type, such as `rate_limit_error`, or `timeout`. */
  errorType: string | undefined;
}

const providerErrorType = (text: string): string | undefined => {
  const start = text.indexOf("{");
  if (start === -1) {
    return undefined;
  }
  let body: unknown = undefined;
  try {
    body = JSON.parse(text.slice(start));
  } catch {
    return undefined;
  }
  const parsed = providerErrorSchema.safeParse(body);
  if (!parsed.success) {
    return undefined;
  }
  return "error" in parsed.data ? parsed.data.error.type : parsed.data.type;
};

/**
 * What failed: the status and the provider's error type, never the error's
 * message, which may quote the prompt.
 */
const failureOf = ({ answer, status }: Sent, signal: AbortSignal): Failure => {
  if (signal.aborted) {
    return { status, errorType: "timeout" };
  }
  const text = answer.errorMessage?.trim() ?? "";
  const quoted = failedStatusPattern.exec(text)?.groups?.status;
  return {
    status: quoted === undefined ? status : Number(quoted),
    errorType: providerErrorType(text),
  };
};

/** How one request ended, as the audit log records it. */
type Outcome = "answered" | "truncated" | "invalid_output" | "failed";

/** What the audit log records of one request. */
interface Recorded {
  inputTokens: number;
  outputTokens: number;
  cost: number;
  logId: string | undefined;
  attempt: number;
  outcome: Outcome;
  status: number | undefined;
  errorType: string | undefined;
}

const auditEntry = (call: Call, ref: ModelRef, recorded: Recorded) => {
  const { logId } = recorded;
  return {
    actor: call.trigger,
    action: "model.call",
    requestId: call.requestId,
    provenance: call.provenance,
    model: {
      provider: ref.provider,
      model: ref.id,
      inputTokens: recorded.inputTokens,
      outputTokens: recorded.outputTokens,
    },
    cost: { amount: recorded.cost, currency: "USD" },
    detail: {
      purpose: call.purpose,
      outcome: recorded.outcome,
      attempt: recorded.attempt,
      status: recorded.status ?? null,
      errorType: recorded.errorType ?? null,
      // Never an ID so long that the event would be refused.
      gatewayLogId:
        logId !== undefined && logId.length <= auditIdentifierMaxLength
          ? logId
          : null,
    },
  } satisfies AuditEntry;
};

/**
 * The most any request can add to its call's audit event: a call whose
 * event wouldn't fit the audit log with it is refused before anything is
 * sent and paid for, rather than left unrecorded after.
 */
const largestRecord: Recorded = {
  inputTokens: Number.MAX_SAFE_INTEGER,
  outputTokens: Number.MAX_SAFE_INTEGER,
  cost: Number.MAX_VALUE,
  logId: "x".repeat(auditIdentifierMaxLength),
  attempt: 2,
  outcome: "invalid_output",
  status: 599,
  errorType: "x".repeat(64),
};

/**
 * Records one request in the audit log, however it ended: in the outbox
 * first, then sent. A queue that refuses the event neither fails the call
 * nor loses the event; the outbox sends it again later.
 */
const record = async (
  env: ModelsEnv,
  call: Call,
  ref: ModelRef,
  { answer, logId, status }: Sent,
  attempt: number,
  outcome: Outcome,
  failure?: Failure
): Promise<void> => {
  await outboxed(
    drizzle(env.DB),
    auditEntry(call, ref, {
      inputTokens: inputTokens(answer.usage),
      outputTokens: answer.usage.output,
      cost: costOf(answer.usage),
      logId,
      attempt,
      outcome,
      status: failure?.status ?? status,
      errorType: failure?.errorType,
    })
  );
  await sendAuditOutboxNow(env);
};

/** Checks a call against the deployment's config, before anything is sent. */
const admit = (
  env: ModelsEnv,
  fields: unknown
): { call: Call; ref: ModelRef; gateway: string; transport: FetchFunction } => {
  const parsed = callSchema.safeParse(fields);
  if (!parsed.success) {
    throw modelErrors.create("model.invalid_call");
  }
  const call = parsed.data;
  const config = modelGatewayConfig(env);
  // Plain workerd (on-prem) has no AI binding, so no gateway either.
  if (config === undefined || typeof env.AI?.fetch !== "function") {
    throw modelErrors.create("model.unconfigured");
  }
  const ref = config.models.includes(call.model)
    ? parseModelRef(call.model)
    : undefined;
  if (ref === undefined) {
    throw modelErrors.create("model.not_allowed", { model: call.model });
  }
  try {
    createAuditEvent(auditEntry(call, ref, largestRecord), "core");
  } catch {
    // Its provenance, say, is too long to record.
    throw modelErrors.create("model.invalid_call");
  }
  return {
    call,
    ref,
    gateway: config.gateway,
    transport: createAiBindingFetch(env.AI),
  };
};

const callModel = async <Output>(
  env: ModelsEnv,
  { schema, ...fields }: ModelCall<Output>
): Promise<ModelAnswer<Output>> => {
  const { call, ref, gateway, transport } = admit(env, fields);
  const model = gatewayModel(gateway, ref);
  const signal = AbortSignal.timeout(call.timeoutMs ?? defaultTimeoutMs);
  const request: Request = {
    model,
    ref,
    call,
    transport,
    signal,
    system:
      schema === undefined
        ? call.system
        : [call.system, structuredInstructions(schema)]
            .filter((part) => part !== undefined)
            .join("\n\n"),
    messages: toMessages(call, model),
  };

  const usage = { inputTokens: 0, outputTokens: 0 };
  let cost = 0;
  // A call with a schema asks once more when the answer doesn't fit it.
  const attempts = schema === undefined ? 1 : 2;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    // Each attempt follows up on the answer before it.
    // oxlint-disable-next-line no-await-in-loop
    const sent = await send(request);
    const { answer } = sent;
    usage.inputTokens += inputTokens(answer.usage);
    usage.outputTokens += answer.usage.output;
    cost += costOf(answer.usage);
    const text = answerText(answer);
    const truncated = answer.stopReason === "length";

    if (hasFailed(answer)) {
      const failure = failureOf(sent, signal);
      log.warn("model.failed", {
        model: call.model,
        status: failure.status,
        errorType: failure.errorType,
        stopReason: answer.stopReason,
      });
      // oxlint-disable-next-line no-await-in-loop
      await record(env, call, ref, sent, attempt, "failed", failure);
      throw modelErrors.create("model.failed");
    }
    if (schema === undefined) {
      // oxlint-disable-next-line no-await-in-loop
      await record(
        env,
        call,
        ref,
        sent,
        attempt,
        truncated ? "truncated" : "answered"
      );
      // SAFETY: without a schema `Output` can't be inferred, so it is its
      // default, `undefined`.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
      return { text, output: undefined as Output, truncated, usage, cost };
    }
    // An answer cut short is judged like any other: JSON that stops short
    // doesn't parse, so the model is asked again.
    const result = parseOutput(text, schema);
    // oxlint-disable-next-line no-await-in-loop
    await record(
      env,
      call,
      ref,
      sent,
      attempt,
      result.ok ? "answered" : "invalid_output"
    );
    if (result.ok) {
      return { text, output: result.output, truncated, usage, cost };
    }
    request.messages.push(answer, {
      role: "user",
      content: `That answer doesn't fit: ${result.problem}\nAnswer again, with only the JSON.`,
      timestamp: Date.now(),
    });
  }
  throw modelErrors.create("model.invalid_output");
};

/**
 * The model gateway for core: `await models(env).call({ model, input,
 * purpose, trigger })`. Refuses a model the deployment doesn't allow, sends
 * the call through AI Gateway, and records every request it makes in the
 * audit log. With a `schema`, the answer is JSON that matches it.
 */
export const models = (env: ModelsEnv) => ({
  call: async <Output = undefined>(
    call: ModelCall<Output>
  ): Promise<ModelAnswer<Output>> => await callModel(env, call),
});
