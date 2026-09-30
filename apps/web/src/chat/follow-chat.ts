import { applyPartial } from "@grasp-os/shared/chat";
import type {
  ChatMessage,
  ChatPartial,
  ChatProvenance,
  ChatUpdate,
} from "@grasp-os/shared/chat";
import { failureText } from "@grasp-os/shared/errors";
import { RpcStub } from "capnweb";

import type { CoreConnection } from "../core-connection.ts";
import { CoreTimeoutError, isTransient, retrying } from "../core.ts";

// Following one chat as it streams (`chats.watch` in core), on the tab's
// connection, which connects again when it drops. After a drop, the watch starts
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
  /** Changes whenever the agent writes or drops a draft: read them again. */
  drafts: number;
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
  drafts: 0,
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
    drafts: update.drafts,
    loaded: true,
  };
};

/**
 * The pauses before trying again to start following while core fails: only
 * a few, so a chat whose core keeps failing says so. A try made while the
 * tab's connection is down waits a few seconds for the next connection,
 * and says core can't be reached if none comes.
 */
const startRetryMs = [1000, 2000, 4000] as const;

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
 * Follows `chatId` over `core`: `onUpdate` gets every update, `onFailed`
 * why following stopped for good (the chat is gone, say). Returns what
 * stops it.
 */
export const followChat = (
  core: CoreConnection,
  chatId: string,
  onUpdate: (update: ChatUpdate) => void,
  onFailed: (reason: string) => void
): (() => void) => {
  let closed = false;
  let after: number | null = null;
  let release: (() => void) | undefined;
  const received = (update: ChatUpdate): void => {
    const last = update.messages.at(-1);
    if (last !== undefined) {
      after = last.id;
    }
    onUpdate(update);
  };
  const watch = async (): Promise<void> => {
    try {
      const subscription = await retrying(
        async () =>
          await core.withSession(
            async (session) =>
              await session.chats.watch(chatId, after, received)
          ),
        startRetryMs,
        // No connection came in its few seconds: say so, rather than wait
        // on, as a page does when core is out of reach.
        (failure) =>
          isTransient(failure) && !(failure instanceof CoreTimeoutError)
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
        onFailed(failureText(error));
      }
    }
  };
  void watch();
  return () => {
    closed = true;
    release?.();
  };
};
