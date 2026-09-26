import { runAgentLoop } from "@earendil-works/pi-agent-core";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type {
  AssistantMessage,
  Message,
  SystemMessage,
} from "@earendil-works/pi-ai";

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
    return {
      content: [{ type: "text", text: describeRun(run) }],
      details: run,
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
}

const messageRoles = new Set<unknown>([
  "system",
  "user",
  "assistant",
  "toolResult",
]);

/** One of pi's own messages, the only kind this loop makes. */
const isMessage = (message: AgentMessage): message is Message =>
  messageRoles.has(message.role);

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
  signal,
  keep,
}: Turn): Promise<TurnResult> => {
  const prompts: Message[] = [
    ...systemUpdates(history, apis),
    { role: "user", content: question, timestamp: Date.now() },
  ];
  const progress: { steps: number; last?: AssistantMessage } = { steps: 0 };
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
  const { steps, last } = progress;
  const outcome = outcomeOf(last, steps, signal);
  return {
    outcome,
    answer: textOf(last),
    ...(outcome === "failed" ? { error: last?.errorMessage } : {}),
  };
};
