import { appIdSchema, workspaceIdSchema } from "@grasp-os/shared/ids";
import type {
  CollectionReader,
  KnowledgeTools,
} from "@grasp-os/shared/knowledge";
import { authoritySchema } from "@grasp-os/shared/permissions";
import type {
  Authority,
  PermissionSubjectInput,
} from "@grasp-os/shared/permissions";
import { env } from "cloudflare:workers";

import { bindingsFor } from "../src/bindings.ts";
import type { ConnectionBinding } from "../src/bindings.ts";
import { workspace } from "../src/durable-objects.ts";
import type { WorkContext } from "../src/restricted.ts";

/**
 * A new chat in the workspace of `agent`, where it works: an agent works
 * only in its own workspace's chats, so the workspace is named after it.
 */
export const newChat = async (
  of: PermissionSubjectInput | Authority
): Promise<Extract<WorkContext, { type: "chat" }>> => {
  const subject = "subject" in of ? of.subject : of;
  // Anyone else's chat is in a workspace of its own, which no agent's is.
  const workspaceId = workspaceIdSchema.parse(
    subject.type === "agent" ? subject.agentId : crypto.randomUUID()
  );
  const { id } = await workspace(env, workspaceId).createChat(
    "Chat",
    "person-1",
    subject.type === "agent" ? subject.agentId : "nobody"
  );
  return { type: "chat", workspaceId, chatId: id };
};

/** `subject` acting for `userId`, as a person using it interactively. */
export const actingFor = (
  subject: PermissionSubjectInput,
  userId: string
): Authority =>
  authoritySchema.parse({
    subject,
    onBehalfOf: userId,
    mode: "interactive",
    // An App code runs a version: its first, in these tests.
    ...(subject.type === "app" ? { appVersion: 1 } : {}),
  });

type Bindings = Awaited<ReturnType<typeof bindingsFor>>;

/**
 * The env an agent or App gets for `authority` in `context`, or where it
 * works without one: an agent in a chat of its workspace, an App as itself.
 */
export const envOf = async (
  authority: Authority,
  context?: WorkContext
): Promise<Bindings> =>
  await bindingsFor(
    env,
    authority,
    context ??
      (authority.subject.type === "app"
        ? { type: "app", appId: appIdSchema.parse(authority.subject.appId) }
        : await newChat(authority))
  );

/**
 * Tests register no connection in connect, so a call that ends in this
 * code passed every check on its way: core's and connect's.
 */
export const reached = "connect.connection_not_found";

/** A connection's stub in an env, as App or agent code calls it. */
export const connectionIn = (
  bindings: Bindings,
  name: string
): Fetcher<ConnectionBinding> | undefined =>
  // SAFETY: the tests name a binding they granted for a connection, and
  // `bindingsFor` gives a connection permission a `ConnectionBinding`.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  bindings[name] as Fetcher<ConnectionBinding> | undefined;

/** A collection's stub in an env, as App or agent code calls it. */
export const collectionIn = (
  bindings: Bindings,
  name: string
): CollectionReader | undefined =>
  // SAFETY: the tests name a binding they granted for a collection, and
  // `bindingsFor` gives a collection permission a `CollectionBinding`, whose
  // methods are those of `CollectionReader`.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  bindings[name] as CollectionReader | undefined;

/** An agent's Knowledge tools in its env, if it may read any collection. */
export const knowledgeIn = (bindings: Bindings): KnowledgeTools | undefined =>
  // SAFETY: `bindingsFor` gives `KNOWLEDGE` a `KnowledgeBinding`, whose
  // methods are those of `KnowledgeTools`.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  bindings.KNOWLEDGE as KnowledgeTools | undefined;
