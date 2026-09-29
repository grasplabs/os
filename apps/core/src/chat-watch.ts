import type {
  ChatMessage,
  ChatPartial,
  ChatPartialUpdate,
  ChatProvenance,
  ChatUpdate,
} from "@grasp-os/shared/chat";

/** Where a watcher's updates go: the frontend's callback, through core. */
export type ChatListener = Rpc.Stub<(update: ChatUpdate) => Promise<void>>;

/** A chat as the Workspace object has it now, besides its messages. */
export interface ChatState {
  /** The response being written, whole; `null` between responses. */
  partial: ChatPartial | null;
  running: boolean;
  stopped: string | null;
  held: number;
  /** Changes whenever the chat's provenance does. */
  provenanceVersion: number;
}

/** A text the watcher has, and the one there is now: what it gains. */
const gained = (shown: string, now: string): { from: number; added: string } =>
  now.startsWith(shown)
    ? { from: shown.length, added: now.slice(shown.length) }
    : { from: 0, added: now };

/** What `now` adds to the response the watcher has (`shown`). */
export const partialUpdate = (
  shown: ChatPartial | null,
  now: ChatPartial | null
): ChatPartialUpdate | null => {
  if (now === null) {
    return null;
  }
  const text = gained(shown?.text ?? "", now.text);
  return {
    from: text.from,
    text: text.added,
    code: now.code.map(({ callId, code }) => {
      const step = gained(
        shown?.code.find((before) => before.callId === callId)?.code ?? "",
        code
      );
      return { callId, from: step.from, code: step.added };
    }),
  };
};

/**
 * One watcher of a chat (the Workspace object's `watch`). Updates go out
 * one at a time: while one is on its way, whatever changes waits, and the
 * next update carries it all: every stored message in order, what the
 * response being written gained since (not all of it again), and the
 * chat's provenance only when it changed. So a response streaming in token
 * by token costs a slow connection a few small updates, and a message is
 * never lost or sent twice. An update that fails (the connection is gone,
 * the person may no longer follow the chat) drops the watcher.
 */
export class ChatWatch {
  readonly #listener: ChatListener;
  readonly #state: () => ChatState;
  readonly #provenance: () => ChatProvenance;
  readonly #drop: () => void;
  /** Stored messages this watcher hasn't had yet, oldest first. */
  readonly #unsent: ChatMessage[] = [];
  /** The response being written, as this watcher has it. */
  #shown: ChatPartial | null = null;
  /** The provenance version this watcher has; none at first. */
  #provenanceSent: number | undefined;
  /** Something changed since the last update went out. */
  #changed = false;
  #sending = false;

  constructor(
    listener: ChatListener,
    state: () => ChatState,
    provenance: () => ChatProvenance,
    drop: () => void
  ) {
    this.#listener = listener;
    this.#state = state;
    this.#provenance = provenance;
    this.#drop = drop;
  }

  /** Sends the watcher `messages`, and the chat as it is when it goes out. */
  push(messages: readonly ChatMessage[] = []): void {
    this.#unsent.push(...messages);
    this.#changed = true;
    void this.#flush();
  }

  #next(): ChatUpdate {
    const { partial, running, stopped, held, provenanceVersion } =
      this.#state();
    const update: ChatUpdate = {
      messages: this.#unsent.splice(0),
      partial: partialUpdate(this.#shown, partial),
      running,
      stopped,
      held,
      ...(provenanceVersion === this.#provenanceSent
        ? {}
        : { provenance: this.#provenance() }),
    };
    this.#shown = partial;
    this.#provenanceSent = provenanceVersion;
    return update;
  }

  async #flush(): Promise<void> {
    if (this.#sending) {
      return;
    }
    this.#sending = true;
    try {
      while (this.#changed) {
        this.#changed = false;
        // oxlint-disable-next-line no-await-in-loop -- one update at a time, in order
        await this.#listener(this.#next());
      }
    } catch {
      this.#drop();
    } finally {
      this.#sending = false;
    }
  }

  [Symbol.dispose](): void {
    this.#changed = false;
    this.#unsent.length = 0;
    this.#listener[Symbol.dispose]();
  }
}
