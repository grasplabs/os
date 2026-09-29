import { applyPartial } from "@grasp-os/shared/chat";
import type {
  ChatMessage,
  ChatPartial,
  ChatProvenance,
  ChatUpdate,
} from "@grasp-os/shared/chat";
import { messageOf } from "@grasp-os/shared/errors";
import { RpcStub } from "capnweb";

import { CoreLink } from "../screens/core-link.ts";

// Following one chat as it streams (`chats.watch` in core), on a
// connection that reconnects when it drops. After a drop, the watch starts
// again after the last message this page has, so nothing is missed or
// shown twice; a reload starts from the first.

/** A chat as the page shows it, put together from its updates. */
export interface ChatView {
  messages: ChatMessage[];
  /** The response being written; `null` between responses. */
  partial: ChatPartial | null;
  running: boolean;
  provenance: ChatProvenance;
  /** Why the last question stopped short; `null` once another starts. */
  stopped: string | null;
  /** Changes whenever the agent had a write held: read them again. */
  held: number;
  /** Whether the first update has come. */
  loaded: boolean;
}

export const emptyView: ChatView = {
  messages: [],
  partial: null,
  running: false,
  provenance: { sources: [], restricted: false },
  stopped: null,
  held: 0,
  loaded: false,
};

/** `view` with `update` applied: new messages added once, in order. */
export const applyUpdate = (view: ChatView, update: ChatUpdate): ChatView => {
  const last = view.messages.at(-1)?.id ?? 0;
  return {
    messages: [
      ...view.messages,
      ...update.messages.filter(({ id }) => id > last),
    ],
    partial: applyPartial(view.partial, update.partial),
    running: update.running,
    // Sent first, then only when it changes.
    provenance: update.provenance ?? view.provenance,
    stopped: update.stopped,
    held: update.held,
    loaded: true,
  };
};

/** Lets go of a watch; one whose connection is gone already is let go. */
const releaseQuietly = async (subscription: {
  release: () => Promise<void>;
}): Promise<void> => {
  try {
    await subscription.release();
  } catch {
    // The connection is gone, and core drops the watch with it.
  }
};

/**
 * Follows `chatId`: `onUpdate` gets every update, `onFailed` why following
 * stopped for good (the chat is gone, the session ended). Returns what
 * stops it.
 */
export const followChat = (
  chatId: string,
  onUpdate: (update: ChatUpdate) => void,
  onFailed: (reason: string) => void
): (() => void) => {
  let closed = false;
  let after: number | null = null;
  let release: (() => void) | undefined;
  const link = new CoreLink(() => {
    // The session ended: the shell sends the person to sign in.
    window.location.reload();
  });
  const received = (update: ChatUpdate): void => {
    const last = update.messages.at(-1);
    if (last !== undefined) {
      after = last.id;
    }
    onUpdate(update);
  };
  const watch = async (): Promise<void> => {
    try {
      const subscription = await link.retrying(
        async (session) => await session.chats.watch(chatId, after, received)
      );
      release = () => {
        void releaseQuietly(subscription);
        subscription[Symbol.dispose]();
      };
      if (closed) {
        release();
        return;
      }
      // The connection dropped: watch again on the next, after the last
      // message this page has. Core answers the watch with a stub.
      const stub: unknown = subscription;
      if (stub instanceof RpcStub) {
        stub.onRpcBroken(() => {
          if (!closed) {
            void watch();
          }
        });
      }
    } catch (error) {
      if (!closed) {
        onFailed(messageOf(error));
      }
    }
  };
  void watch();
  return () => {
    closed = true;
    release?.();
    link.close();
  };
};
