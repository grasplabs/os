import type { AppId, ChatId, RunId, WorkspaceId } from "@grasp-os/shared/ids";
import { permissionErrors } from "@grasp-os/shared/permissions";
import type { Authority } from "@grasp-os/shared/permissions";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { apps, workflowRuns } from "./db/core/schema.ts";
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
//
// The flag is only as good as the boundaries between contexts: it must
// follow every way data moves from one to another. A workflow run started
// by an App must start from (and restrict) that App's flag, and state
// shared across a workspace's chats would need a flag on the workspace, not
// on each chat. Whatever adds such a flow adds the flag with it.

/**
 * Where an App or agent works, and keeps its restricted mode: a chat, an
 * App, or a run of one of the App's workflows. The host sets it, like the
 * authority.
 *
 * A run keeps its App's flag, not one of its own: a run and its App share
 * data both ways (the workflow's state is shared by all its runs, and a run
 * calls its App's methods, whose answers carry the App's data), so a run
 * starts restricted when its App is, becomes so when its App does, and
 * restricts its App when it reads restricted data itself.
 */
export type WorkContext =
  | { type: "chat"; workspaceId: WorkspaceId; chatId: ChatId }
  | { type: "app"; appId: AppId }
  | { type: "run"; appId: AppId; runId: RunId };

const contextInvalid = () =>
  permissionErrors.create("permission.context_invalid");

/**
 * Refuses an App context that isn't the App `authority` names, or an App
 * that isn't in the registry, so no App can read or set another's flag;
 * for a run, a run that isn't one of that App's.
 */
const requireOwnApp = async (
  env: Env,
  authority: Authority,
  context: Extract<WorkContext, { appId: AppId }>
): Promise<void> => {
  const { subject } = authority;
  const { appId } = context;
  if (subject.type !== "app" || subject.appId !== appId) {
    throw contextInvalid();
  }
  const db = drizzle(env.DB);
  const found =
    context.type === "run"
      ? await db
          .select({ id: workflowRuns.id })
          .from(workflowRuns)
          .where(
            and(
              eq(workflowRuns.id, context.runId),
              eq(workflowRuns.appId, appId)
            )
          )
          .get()
      : await db
          .select({ id: apps.id })
          .from(apps)
          .where(eq(apps.id, appId))
          .get();
  if (!found) {
    throw contextInvalid();
  }
};

/**
 * Whether `context` has read restricted data. Throws
 * `permission.context_invalid` for a context `authority` can't work in, or
 * one that doesn't exist: it has nowhere to keep the flag.
 */
const isRestricted = async (
  env: Env,
  authority: Authority,
  context: WorkContext
): Promise<boolean> => {
  if (context.type !== "chat") {
    await requireOwnApp(env, authority, context);
    return await appHost(env, context.appId).isRestricted();
  }
  const restricted = await workspace(env, context.workspaceId).isChatRestricted(
    context.chatId
  );
  if (restricted === undefined) {
    throw contextInvalid();
  }
  return restricted;
};

/**
 * Puts `context` in restricted mode, for good. Throws
 * `permission.context_invalid` as `isRestricted` does.
 */
export const restrict = async (
  env: Env,
  authority: Authority,
  context: WorkContext
): Promise<void> => {
  if (context.type !== "chat") {
    await requireOwnApp(env, authority, context);
    await appHost(env, context.appId).restrict();
    return;
  }
  const found = await workspace(env, context.workspaceId).restrictChat(
    context.chatId
  );
  if (!found) {
    throw contextInvalid();
  }
};

/** Refuses a call out of a restricted context: `permission.restricted`. */
export const requireUnrestricted = async (
  env: Env,
  authority: Authority,
  context: WorkContext
): Promise<void> => {
  if (await isRestricted(env, authority, context)) {
    throw permissionErrors.create("permission.restricted");
  }
};
