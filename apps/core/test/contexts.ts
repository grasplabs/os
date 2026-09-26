import { workspaceIdSchema } from "@grasp-os/shared/ids";
import type { CollectionReader } from "@grasp-os/shared/knowledge";
import { authoritySchema } from "@grasp-os/shared/permissions";
import type {
  Authority,
  PermissionSubjectInput,
} from "@grasp-os/shared/permissions";
import { env } from "cloudflare:workers";

import { bindingsFor } from "../src/bindings.ts";
import type { ConnectionBinding } from "../src/bindings.ts";
import type { WorkContext } from "../src/restricted.ts";
import { workspace } from "../src/workspace.ts";

/** A new chat in a new workspace, where an agent works. */
export const newChat = async (): Promise<
  Extract<WorkContext, { type: "chat" }>
> => {
  const workspaceId = workspaceIdSchema.parse(crypto.randomUUID());
  const { id } = await workspace(env, workspaceId).createChat("Chat");
  return { type: "chat", workspaceId, chatId: id };
};

/** `subject` acting for `userId`, as a person using it interactively. */
export const actingFor = (
  subject: PermissionSubjectInput,
  userId: string
): Authority =>
  authoritySchema.parse({ subject, onBehalfOf: userId, mode: "interactive" });

type Bindings = Awaited<ReturnType<typeof bindingsFor>>;

/** The env an agent or App gets for `authority` in `context`, or a chat of its own. */
export const envOf = async (
  authority: Authority,
  context?: WorkContext
): Promise<Bindings> =>
  await bindingsFor(env, authority, context ?? (await newChat()));

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
