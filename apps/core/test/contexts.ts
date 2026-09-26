import { workspaceIdSchema } from "@grasp-os/shared/ids";
import type { CollectionReader } from "@grasp-os/shared/knowledge";
import { env } from "cloudflare:workers";

import type { bindingsFor, ConnectionBinding } from "../src/bindings.ts";
import type { WorkContext } from "../src/restricted.ts";
import { workspace } from "../src/workspace.ts";

/** A new chat in a new workspace, where an agent works. */
export const newChat = async (): Promise<
  Extract<WorkContext, { type: "chat" }>
> => {
  const workspaceId = workspaceIdSchema.parse(crypto.randomUUID());
  const { id } = await workspace(env, workspaceId).createChat(
    "Chat",
    "person-1"
  );
  return { type: "chat", workspaceId, chatId: id };
};

type Bindings = Awaited<ReturnType<typeof bindingsFor>>;

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
