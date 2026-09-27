import { authErrors } from "@grasp-os/shared/errors";

import { connectCore, isTransient, retrying, wait } from "../core.ts";

/** A signed-in session's API, as a connection to core gives it. */
type Session = Awaited<
  ReturnType<ReturnType<typeof connectCore>["authenticate"]>
>;

/** How long to wait before connecting again, at first and at most. */
const reconnectMs = { first: 1000, most: 30_000 };

/**
 * The pauses before trying again what a page needs to start: its first
 * connection, or its first call. The same growing pauses as reconnecting,
 * but only a few, so a page whose core stays out of reach says so.
 */
const startRetryMs = [
  reconnectMs.first,
  reconnectMs.first * 2,
  reconnectMs.first * 4,
] as const;

const closedError = (): Error =>
  new Error("The page closed its connection to core.");

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
    // Core failing or out of reach is tried again on the first connection
    // too, a few times: only a connection that worked reconnects when it
    // breaks. A refusal, such as the session having ended, is core's answer.
    this.#session = retrying(
      async () => {
        if (this.#closed) {
          // Closed while waiting: a new connection would never be closed.
          throw closedError();
        }
        return await this.#connect();
      },
      startRetryMs,
      (failure) => !this.#closed && isTransient(failure)
    );
    void settled(this.#session);
  }

  /** The signed-in session, once connected. */
  async session(): Promise<Session> {
    return await this.#session;
  }

  /**
   * Runs `run` on the signed-in session, and a few times again, with a
   * growing pause, while it fails in a way that may pass: core failing, or
   * the connection breaking (the next try waits for the new one). Not
   * connecting at all fails at once: connecting has tried again already.
   */
  async retrying<T>(run: (session: Session) => Promise<T>): Promise<T> {
    let connected = false;
    return await retrying(
      async () => {
        connected = false;
        const session = await this.session();
        connected = true;
        return await run(session);
      },
      startRetryMs,
      (failure) => connected && !this.#closed && isTransient(failure)
    );
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
    // A failed attempt's connection, before opening the next.
    this.#drop();
    const core = connectCore();
    this.#core = core;
    const session = core.authenticate();
    // Core's own answer, never an App's: the session holds, or it ended.
    await session.whoami();
    const ready = await session;
    this.#delay = reconnectMs.first;
    // Only a connection that worked starts a reconnect when it breaks, and
    // only once: a failed attempt is retried by the loop that made it, so
    // nothing is awaited once this is registered. Registered after the
    // last answer, it still hears of a break before it.
    core.onRpcBroken(() => {
      if (!this.#closed && this.#core === core) {
        this.#drop();
        const next = this.#reconnect();
        void settled(next);
        this.#session = next;
      }
    });
    return ready;
  }

  async #reconnect(): Promise<Session> {
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- one attempt at a time
      await wait(this.#delay);
      if (this.#closed) {
        // Closed while waiting: a new connection would never be closed.
        throw closedError();
      }
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
