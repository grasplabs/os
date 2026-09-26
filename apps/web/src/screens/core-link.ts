import { authErrors } from "@grasp-os/shared/errors";

import { connectCore } from "../core.ts";

/** A signed-in session's API, as a connection to core gives it. */
type Session = Awaited<
  ReturnType<ReturnType<typeof connectCore>["authenticate"]>
>;

/** How long to wait before connecting again, at first and at most. */
const reconnectMs = { first: 1000, most: 30_000 };

const wait = async (ms: number): Promise<void> => {
  // oxlint-disable-next-line promise/avoid-new -- setTimeout has no promise form in browsers
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
};

/** Waits for `promise` to settle, whichever way. */
const settled = async (promise: Promise<unknown>): Promise<void> => {
  try {
    await promise;
  } catch {
    // Whoever needs the outcome awaits the promise itself.
  }
};

/**
 * A page's long-lived connection to core: a Cap'n Web session that
 * connects again when it drops, until the person's session has ended.
 * Stubs passed over the old connection (a screen's callbacks) break with
 * it; their owners subscribe again on the new one.
 */
export class CoreLink {
  #session: Promise<Session>;
  #core: ReturnType<typeof connectCore> | undefined;
  #closed = false;
  #delay = reconnectMs.first;
  readonly #onSignedOut: () => void;

  constructor(onSignedOut: () => void) {
    this.#onSignedOut = onSignedOut;
    this.#session = this.#connect();
  }

  /** The signed-in session, once connected. */
  async session(): Promise<Session> {
    return await this.#session;
  }

  close(): void {
    this.#closed = true;
    this.#drop();
  }

  /** Lets go of the current connection, which no longer counts as ours. */
  #drop(): void {
    const core = this.#core;
    this.#core = undefined;
    core?.[Symbol.dispose]();
  }

  async #connect(): Promise<Session> {
    if (this.#closed) {
      throw new Error("The page closed its connection to core.");
    }
    // A failed attempt's connection, before opening the next.
    this.#drop();
    const core = connectCore();
    this.#core = core;
    const session = core.authenticate();
    // Core's own answer, never an App's: the session holds, or it ended.
    await session.whoami();
    this.#delay = reconnectMs.first;
    // Only a connection that worked starts a reconnect when it breaks, and
    // only once: a failed attempt is retried by the loop that made it.
    // Registered after the answer, it still hears of a break before it.
    core.onRpcBroken(() => {
      if (!this.#closed && this.#core === core) {
        this.#drop();
        const next = this.#reconnect();
        void settled(next);
        this.#session = next;
      }
    });
    return await session;
  }

  async #reconnect(): Promise<Session> {
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- one attempt at a time
      await wait(this.#delay);
      this.#delay = Math.min(this.#delay * 2, reconnectMs.most);
      try {
        // oxlint-disable-next-line no-await-in-loop -- one attempt at a time
        return await this.#connect();
      } catch (error) {
        const signedOut = authErrors.codeOf(error) === "auth.unauthenticated";
        if (this.#closed || signedOut) {
          if (signedOut) {
            this.close();
            this.#onSignedOut();
          }
          throw error;
        }
      }
    }
  }
}
