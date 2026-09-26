import { agentErrors } from "@grasp-os/shared/agent";
import type { ChatId, WorkspaceId } from "@grasp-os/shared/ids";
import { WorkerEntrypoint, exports } from "cloudflare:workers";

import { inJurisdiction } from "./durable-objects.ts";

// The typed APIs the agent's code gets in its env (Code Mode). Each is a
// loopback entrypoint of core whose props core sets for one code run of one
// chat, so the code can call it but never say who it acts for. The model
// sees each API as a TypeScript declaration and writes code against it.
//
// Every chat starts with the APIs below and nothing else. An API that
// reaches a person's data (Knowledge, connections, Apps, workflows) comes
// from that person's permissions and checks them on every call, as the
// connection bindings do (src/bindings.ts), with the chat as its context:
// `{ type: "chat", workspaceId, chatId }`.

/** Whom and where an agent's code acts for, as core sets it. */
export interface AgentScope {
  workspaceId: WorkspaceId;
  chatId: ChatId;
  /** The person the chat belongs to, whom the agent acts for. */
  personId: string;
  /** The code run the stub was made for: it answers only while that runs. */
  runId: string;
}

/** One typed API the agent's code can call. */
export interface AgentApi {
  /** Its name in the code's `env`: a JavaScript identifier. */
  name: string;
  /**
   * What the model sees: members of `interface Env`, with their doc
   * comments.
   */
  declaration: string;
  /** Its stub for one code run. */
  stub: (scope: AgentScope) => Fetcher;
}

/**
 * Refuses a call from a code run that has ended: the turn moved on, or
 * the run was cancelled or timed out while its code kept running. Every
 * API checks it first, on every call.
 */
export const requireOpenRun = async (
  env: Env,
  { workspaceId, chatId, runId }: AgentScope
): Promise<void> => {
  const open = await inJurisdiction(env, env.WORKSPACES)
    .getByName(workspaceId)
    .isCodeRunOpen(chatId, runId);
  if (!open) {
    throw agentErrors.create("agent.run_ended");
  }
};

/** The chat the code runs in, for the code: `await env.chat.info()`. */
export class ChatApi extends WorkerEntrypoint<Env, AgentScope> {
  /** The chat, the person it acts for, and the time now. */
  async info(): Promise<{ chatId: string; personId: string; now: string }> {
    await requireOpenRun(this.env, this.ctx.props);
    const { chatId, personId } = this.ctx.props;
    return { chatId, personId, now: new Date().toISOString() };
  }
}

const chatApi: AgentApi = {
  name: "chat",
  declaration: `/** The chat this code runs in. */
chat: {
  /** The chat's ID, the person it acts for, and the time now (ISO 8601, UTC). */
  info(): Promise<{ chatId: string; personId: string; now: string }>;
};`,
  stub: (scope) => exports.ChatApi({ props: scope }),
};

/** The APIs a chat's code gets. */
export const agentApis = (): readonly AgentApi[] => [chatApi];
