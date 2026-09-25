import type { AppId, ChatId, WorkspaceId } from "@grasp-os/shared/ids";
import { permissionErrors } from "@grasp-os/shared/permissions";

import { appHost } from "./durable-objects.ts";
import { workspace } from "./workspace.ts";

// Restricted mode. Once a chat or an App reads restricted data (in
// Knowledge: what a sensitive collection holds), it is restricted for good,
// and from then on makes no calls to outside systems, so what it read can't
// leave through them. The flag is kept where the chat or App lives (its
// workspace's or its own Durable Object), so it survives restarts, and it
// is set before the data is returned, so nothing that holds the data runs
// unrestricted. It is checked in the one place core lets a call out: where
// it makes the capability for connect (bindings.ts).
//
// Every call through connect reaches an outside system, and either acts
// there (a side effect) or fetches from it; a fetch carries its input (a
// search, an address) out too, and core can't tell one from the other, as
// only connect knows which actions write. So a restricted chat or App makes
// no connection calls at all. Knowledge, which stays in the deployment, can
// still be read.

/**
 * Where an App or agent works, and keeps its restricted mode: a chat, or
 * an App. The host sets it, like the authority. Workflow runs get theirs
 * with the workflow dispatcher.
 */
export type WorkContext =
  | { type: "chat"; workspaceId: WorkspaceId; chatId: ChatId }
  | { type: "app"; appId: AppId };

/** Whether `context` has read restricted data. */
const isRestricted = async (
  env: Env,
  context: WorkContext
): Promise<boolean> =>
  context.type === "chat"
    ? await workspace(env, context.workspaceId).isChatRestricted(context.chatId)
    : await appHost(env, context.appId).isRestricted();

/** Puts `context` in restricted mode, for good. */
export const restrict = async (
  env: Env,
  context: WorkContext
): Promise<void> => {
  await (context.type === "chat"
    ? workspace(env, context.workspaceId).restrictChat(context.chatId)
    : appHost(env, context.appId).restrict());
};

/** Refuses a call out of a restricted context: `permission.restricted`. */
export const requireUnrestricted = async (
  env: Env,
  context: WorkContext
): Promise<void> => {
  if (await isRestricted(env, context)) {
    throw permissionErrors.create("permission.restricted");
  }
};
