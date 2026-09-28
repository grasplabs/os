import { agentErrors } from "@grasp-os/shared/agent";
import type { ChatId, WorkspaceId } from "@grasp-os/shared/ids";
import { authoritySchema } from "@grasp-os/shared/permissions";
import type { Authority } from "@grasp-os/shared/permissions";
import { z } from "zod";

import { workspace } from "./durable-objects.ts";
import type { WorkContext } from "./restricted.ts";

// What every API of a chat's code (agent-apis.ts) knows of the call: who
// the agent acts for and where, which code run made it, and whether that
// run is still open. Core sets it in each stub's props; the code can call
// the stub but never read or change them.

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
   * The types its declaration names, declared before `interface Env`, with
   * their doc comments: names no other API declares.
   */
  types?: string;
  /**
   * What the model sees: members of `interface Env`, with their doc
   * comments.
   */
  declaration: string;
  /** Its stub for one code run. */
  stub: (scope: AgentScope) => Fetcher;
}

/**
 * A workspace's ID as its agent's ID: letters, digits and `-` only (a
 * UUID, as core names workspaces), so it reads the same in a permission,
 * an audit event and a memory path (`agents/<id>/AGENTS.md`), and never
 * reaches into another's.
 */
const workspaceAgentIdSchema = z.string().regex(/^[A-Za-z0-9-]{1,64}$/u);

/**
 * The workspace's agent, acting for the chat's person: the one acting on
 * every call its code makes, in the audit log and in every permission
 * check. One agent per workspace, so what an admin grants it holds in all
 * the workspace's chats; each chat still keeps its own sources, restricted
 * mode and code runs (the chat is the context, `chatContext`). Its
 * permissions are the agent's own, and every one reaches only as far as
 * the person may go themselves.
 */
export const chatAuthority = ({
  workspaceId,
  personId,
}: Omit<AgentScope, "runId" | "chatId">): Authority =>
  authoritySchema.parse({
    subject: {
      type: "agent",
      agentId: workspaceAgentIdSchema.parse(workspaceId),
    },
    onBehalfOf: personId,
    mode: "interactive",
  });

/** The chat, as the context an agent works in and keeps restricted mode. */
export const chatContext = ({
  workspaceId,
  chatId,
}: Pick<AgentScope, "workspaceId" | "chatId">): Extract<
  WorkContext,
  { type: "chat" }
> => ({ type: "chat", workspaceId, chatId });

/**
 * What the Workspace object says of one API call of a code run: it may go
 * on, the run has made all the calls it may, or the run has ended.
 */
export type CodeRunCall = "open" | "spent" | "ended";

/**
 * Counts the call with the Workspace object, and refuses it from a code
 * run that has ended (the turn moved on, or the run was cancelled or timed
 * out while its code kept running) or made all the calls it may. Every
 * API checks it first, on every call.
 */
export const requireOpenRun = async (
  env: Env,
  { workspaceId, chatId, runId }: AgentScope
): Promise<void> => {
  const call = await workspace(env, workspaceId).callFromCodeRun(chatId, runId);
  if (call === "spent") {
    throw agentErrors.create("agent.run_calls_spent");
  }
  if (call === "ended") {
    throw agentErrors.create("agent.run_ended");
  }
};

/**
 * Records with the chat what a call read from (collections, a
 * connection), before the call hands over what it read: every later model
 * request of the chat carries them as provenance, so the client's model
 * rules judge it by them (workspace.ts). A run that ended since the call
 * began records nothing, and the call is refused: what it read never
 * reaches code that can no longer be followed.
 */
export const recordSources = async (
  env: Env,
  { workspaceId, chatId, runId }: AgentScope,
  sources: readonly string[]
): Promise<void> => {
  const recorded = await workspace(env, workspaceId).recordSources(
    chatId,
    runId,
    sources
  );
  if (!recorded) {
    throw agentErrors.create("agent.run_ended");
  }
};
