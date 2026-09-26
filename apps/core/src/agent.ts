import { runAgentLoop } from "@earendil-works/pi-agent-core";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type {
  AssistantMessage,
  Message,
  SystemMessage,
} from "@earendil-works/pi-ai";
import { permissionErrors } from "@grasp-os/shared/permissions";

import type { AgentApi, AgentScope } from "./agent-apis.ts";
import { describeRun, runCode } from "./code-mode.ts";
import type { CodeRun } from "./code-mode.ts";
import type { AgentModel } from "./models.ts";

// The agent loop: Pi (pi-agent-core) in Code Mode. The model answers, or
// calls one tool, `executeCode`, with code against the chat's typed APIs;
// the code runs in its own locked isolate (src/code-mode.ts) and what it
// returns or throws goes back to the model, until the model answers. Every
// request goes through the model gateway (`models(env).agent`).
//
// The transcript is pi's: system, user, assistant and tool result
// messages. The caller keeps each message as the loop finishes it, so a
// turn that stops half way (a restart, say) leaves every finished step,
// and the next turn continues from them.

/** Most model requests one turn may make before it stops. */
export const maxSteps = 20;

/**
 * Most code runs one model response may ask for, and one turn may make:
 * each run is an isolate, so the model can't make a turn start hundreds.
 */
export const maxRunsPerResponse = 5;
export const maxRunsPerTurn = 30;

const instructions = `You are the Grasp assistant, in a chat with one person. You answer their questions, and you look things up or act for them by writing code.

To use an API, call the \`executeCode\` tool with a JavaScript module whose default export is an async function of \`env\`:

\`\`\`js
export default async (env) => {
  const info = await env.chat.info();
  return info.now;
};
\`\`\`

What it returns comes back to you as JSON, with what it logs and anything it throws. The code runs in a sandbox with no network: it reaches nothing but the APIs in \`env\`, declared below. Don't guess at APIs that aren't declared. When the chat lacks what a question needs, say so.`;

/** The chat's APIs, as the model reads them. */
const apisSection = (apis: readonly AgentApi[]): string =>
  [
    "<apis>",
    "interface Env {",
    ...apis.flatMap(({ declaration }) =>
      declaration.split("\n").map((line) => `  ${line}`)
    ),
    "}",
    "</apis>",
  ].join("\n");

/** The last `apis` section the transcript declared, if any. */
const declaredApis = (history: readonly Message[]): string | undefined => {
  for (const message of history.toReversed()) {
    const section =
      message.role === "system" ? message.sections?.apis : undefined;
    if (typeof section === "string") {
      return section;
    }
  }
  return undefined;
};

/**
 * What the turn has to tell the model before the question: the
 * instructions on a new chat, and the APIs whenever they changed since the
 * transcript last declared them.
 */
const systemUpdates = (
  history: readonly Message[],
  apis: readonly AgentApi[]
): SystemMessage[] => {
  const section = apisSection(apis);
  const timestamp = Date.now();
  if (history.length === 0) {
    return [
      {
        role: "system",
        content: instructions,
        sections: { apis: section },
        timestamp,
      },
    ];
  }
  return declaredApis(history) === section
    ? []
    : [{ role: "system", content: "", sections: { apis: section }, timestamp }];
};

const codeParameters = Type.Object({
  code: Type.String({
    description:
      "A complete JavaScript module whose default export is an async function of `env`: `export default async (env) => { ... }`.",
  }),
});

/**
 * The code runs of a chat that are running now. A stub answers only while
 * the run it was made for is open, so code that is still running after its
 * run was cancelled or timed out can't act any more.
 */
export interface CodeRuns {
  open: () => string;
  close: (runId: string) => void;
}

/** Runs code with stubs that answer only while the run is open. */
const runOpen = async (
  {
    apis,
    scope,
    runs,
    loader,
  }: Pick<Turn, "apis" | "scope" | "runs" | "loader">,
  code: string,
  signal: AbortSignal | undefined
): Promise<CodeRun> => {
  const runId = runs.open();
  const env = Object.fromEntries(
    apis.map((api) => [api.name, api.stub({ ...scope, runId })])
  );
  try {
    return await runCode(loader, code, env, signal);
  } finally {
    runs.close(runId);
  }
};

/** The one tool: runs code against the chat's APIs in a locked isolate. */
const executeCode = ({
  apis,
  scope,
  runs,
  loader,
}: Pick<Turn, "apis" | "scope" | "runs" | "loader">): AgentTool<
  typeof codeParameters
> => ({
  name: "executeCode",
  label: "Run code",
  description:
    "Runs a JavaScript module in a sandbox with the chat's APIs as `env`, and returns what its default export returns, what it logs, or what it throws.",
  parameters: codeParameters,
  executionMode: "sequential",
  execute: async (_toolCallId, { code }, signal) => {
    const run = await runOpen({ apis, scope, runs, loader }, code, signal);
    if (!run.ok) {
      // pi hands a thrown error's message to the model as a failed result.
      throw new Error(describeRun(run));
    }
    // Only the text the model reads is kept: it is bounded, and the run's
    // own output (which the transcript stores) needn't be.
    return {
      content: [{ type: "text", text: describeRun(run) }],
      details: undefined,
    };
  },
});

/** How a turn ended. */
export type TurnOutcome = "answered" | "cancelled" | "failed" | "max_steps";

export interface TurnResult {
  outcome: TurnOutcome;
  /** The model's last words: its answer, or where it stopped. */
  answer: string;
  /** Why it failed, in the gateway's words. */
  error?: string;
}

export interface Turn {
  /** The chat's transcript so far. */
  history: readonly Message[];
  question: string;
  model: AgentModel;
  apis: readonly AgentApi[];
  /** Whom and where the code acts for; each run adds its own ID. */
  scope: Omit<AgentScope, "runId">;
  runs: CodeRuns;
  loader: WorkerLoader;
  /** Cancels the turn: the request or code run in flight stops. */
  signal: AbortSignal;
  /** Keeps a finished message: called in order, as each one finishes. */
  keep: (message: Message) => void;
  /**
   * IDs of the resources the turn has read, which feed every later model
   * request; the chat's APIs add to it as they read.
   */
  provenance: string[];
  /** Whether the person the agent acts for may still have it act. */
  stillActing: () => Promise<boolean>;
}

const messageRoles = new Set<unknown>([
  "system",
  "user",
  "assistant",
  "toolResult",
]);

/** One of pi's own messages, the only kind this loop makes and keeps. */
export const isMessage = (
  message: AgentMessage | { role?: unknown }
): message is Message => messageRoles.has(message.role);

/** What the turn has done so far. */
interface Progress {
  /** Model responses. */
  steps: number;
  /** Code runs started. */
  runs: number;
  last?: AssistantMessage;
  /** The person left during the turn. */
  personLeft?: boolean;
}

/**
 * Why a code run the model asked for isn't started, if it isn't: too many
 * in one response or one turn, or its result would never be read.
 */
const refusal = (
  progress: Progress,
  response: AssistantMessage,
  callId: string
): string | undefined => {
  const position = response.content
    .filter((block) => block.type === "toolCall")
    .findIndex(({ id }) => id === callId);
  if (position >= maxRunsPerResponse) {
    return `Not run: one response may run code at most ${maxRunsPerResponse} times. Run the rest in your next response.`;
  }
  if (progress.runs >= maxRunsPerTurn) {
    return `Not run: this turn has run code ${maxRunsPerTurn} times, the most it may. Answer with what you have.`;
  }
  // This response is the turn's last: nobody would read the result.
  if (progress.steps + 1 >= maxSteps) {
    return "Not run: this turn has reached its last step. Answer with what you have.";
  }
  return undefined;
};

const textOf = (message: AssistantMessage | undefined): string =>
  (message?.content ?? [])
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("");

const outcomeOf = (
  last: AssistantMessage | undefined,
  steps: number,
  signal: AbortSignal
): TurnOutcome => {
  if (signal.aborted || last?.stopReason === "aborted") {
    return "cancelled";
  }
  if (last?.stopReason === "error") {
    return "failed";
  }
  return last?.stopReason === "toolUse" && steps >= maxSteps
    ? "max_steps"
    : "answered";
};

/**
 * Runs one turn of a chat: the question, then model requests and code runs
 * until the model answers, fails, is cancelled or reaches {@link maxSteps}.
 */
export const runTurn = async ({
  history,
  question,
  model,
  apis,
  scope,
  runs,
  loader,
  signal: cancelled,
  keep,
  stillActing,
}: Turn): Promise<TurnResult> => {
  // Cancelled by the caller, or stopped here when the person leaves.
  const stop = new AbortController();
  const signal = AbortSignal.any([cancelled, stop.signal]);
  const prompts: Message[] = [
    ...systemUpdates(history, apis),
    { role: "user", content: question, timestamp: Date.now() },
  ];
  const progress: Progress = { steps: 0, runs: 0 };
  await runAgentLoop(
    prompts,
    {
      messages: [...history],
      tools: [executeCode({ apis, scope, runs, loader })],
    },
    {
      model: model.model,
      // The transcript holds only pi's own messages.
      convertToLlm: (messages) => messages.filter(isMessage),
      toolExecution: "sequential",
      // The agent acts for its person only while they are a member: checked
      // again before every model request.
      prepareRequest: async () => {
        if (!(await stillActing())) {
          progress.personLeft = true;
          stop.abort();
        }
      },
      beforeToolCall: async ({ assistantMessage, toolCall }) => {
        const reason = refusal(progress, assistantMessage, toolCall.id);
        if (reason === undefined) {
          progress.runs += 1;
        }
        return await Promise.resolve(
          reason === undefined ? undefined : { block: true, reason }
        );
      },
      finishTurn: ({ message }) => {
        progress.steps += 1;
        progress.last = message;
        return progress.steps >= maxSteps || signal.aborted
          ? { action: "end" }
          : undefined;
      },
    },
    (event) => {
      if (event.type === "message_end" && isMessage(event.message)) {
        keep(event.message);
      }
    },
    signal,
    model.stream
  );
  if (progress.personLeft === true) {
    throw permissionErrors.create("permission.person_inactive");
  }
  const { steps, last } = progress;
  const outcome = outcomeOf(last, steps, signal);
  return {
    outcome,
    answer: textOf(last),
    ...(outcome === "failed" ? { error: last?.errorMessage } : {}),
  };
};
