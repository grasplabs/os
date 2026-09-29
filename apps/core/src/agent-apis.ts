import { WorkerEntrypoint, exports } from "cloudflare:workers";
import { z } from "zod";

import { appsApi } from "./agent-apps.ts";
import { buildApi } from "./agent-builds.ts";
import { connectionsApi } from "./agent-connections.ts";
import { knowledgeApi } from "./agent-knowledge.ts";
import { memoryApi } from "./agent-memory.ts";
import { requireOpenRun } from "./agent-scope.ts";
import type { AgentApi, AgentScope } from "./agent-scope.ts";
import { workflowsApi } from "./agent-workflows.ts";

// The typed APIs the agent's code gets in its env (Code Mode). Each is a
// loopback entrypoint of core whose props core sets for one code run of one
// chat (agent-scope.ts), so the code can call it but never say who it acts
// for. The model sees each API as a TypeScript declaration and writes code
// against it.
//
// An API that reaches a person's data acts as the chat's agent on behalf
// of the chat's person (`chatAuthority`), under the agent's permissions
// and never past what the person may do themselves, checked again on every
// call, with the chat as its context: where restricted mode is kept. Every
// call is recorded in the audit log, by what serves it or as `agent.call`
// (`auditAgentCall`), and what it read from is recorded with the chat
// before the call hands it over (`recordSources`).

/** The chat the code runs in, for the code: `await env.chat.info()`. */
export class ChatApi extends WorkerEntrypoint<Env, AgentScope> {
  /** The chat, the person it acts for, and the time now. */
  async info(): Promise<{ chatId: string; personId: string; now: string }> {
    await requireOpenRun(this.env, this.ctx.props, "chat.info");
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

/**
 * An API's name in `env`: a camelCase JavaScript identifier, and no name
 * every object has (`constructor`, `toString`), which the code's env
 * would answer without the API.
 */
const apiNameSchema = z
  .string()
  .regex(/^[a-z][A-Za-z0-9]{0,63}$/u)
  .refine((name) => !(name in Object.prototype));

/** The APIs a chat's code gets. */
export const agentApis = (): readonly AgentApi[] =>
  [
    chatApi,
    knowledgeApi,
    connectionsApi,
    appsApi,
    buildApi,
    workflowsApi,
    memoryApi,
  ].map((api) => ({
    ...api,
    name: apiNameSchema.parse(api.name),
  }));
