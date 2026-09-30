// Before anything builds a schema, as in core.ts.
import "./zod-jitless.ts";
import { authErrors } from "@grasp-os/shared/errors";
import type { CoreApi, Identity, SignInOption } from "@grasp-os/shared/rpc";
import type { RpcStub } from "capnweb";

import {
  connectCore,
  CoreTimeoutError,
  deadline,
  isTransient,
  retrying,
  unlessAborted,
  wait,
  withTimeout,
} from "./core.ts";
import type { Session } from "./core.ts";

/**
 * How long to wait before connecting again, at first and at most. The most
 * stays well under `timeoutMs`, so a read made once core is back is
 * answered within its own few seconds.
 */
const reconnectMs = { first: 1000, most: 3000 } as const;

/**
 * `ms`, a little more or less: tabs that lost core together don't all come
 * back at the same moment.
 */
const jittered = (ms: number): number => ms * (0.85 + 0.3 * Math.random());

/** Lets go of a connection, which may be broken already. */
const disposeQuietly = (core: RpcStub<CoreApi>): void => {
  try {
    core[Symbol.dispose]();
  } catch {
    // Broken already.
  }
};

/** Waits for `promise` to settle, whichever way. */
const settled = async (promise: Promise<unknown>): Promise<void> => {
  try {
    await promise;
  } catch {
    // Whoever needs the outcome awaits the promise itself.
  }
};

/** A connection that answered: core's API, and the signed-in person's. */
interface Connected {
  api: RpcStub<CoreApi>;
  /** None for a connection nobody is signed in on. */
  session?: Session;
  person?: Identity;
}

/** `api` with its signed-in API and who that is for; refused for nobody. */
const signedIn = async (api: RpcStub<CoreApi>): Promise<Connected> => {
  const session = await api.authenticate();
  return { api, session, person: await session.whoami() };
};

/**
 * `api` once it has said who is signed in on it, which is the first thing
 * every connection is asked. Core out of reach or failing rejects; nobody
 * signed in is an answer.
 */
const answered = async (api: RpcStub<CoreApi>): Promise<Connected> => {
  try {
    return await withTimeout(signedIn(api));
  } catch (error) {
    if (authErrors.codeOf(error) === "auth.unauthenticated") {
      return { api };
    }
    throw error;
  }
};

/**
 * The tab's one connection to core, which everything the page asks of core
 * goes over: loaders, actions, its status, followed chats, notifications.
 * (A screen's frame keeps a connection of its own, screens/core-link.ts.)
 * It opens when first used (a guest's page never uses it) and connects
 * again whenever it drops, for as long as it takes. Whoever asks for it
 * meanwhile waits for the next connection, in the order they asked. A call
 * already on its way when the connection drops fails, and is never made
 * twice. Stubs passed over a connection that dropped (a followed chat's
 * updates) break with it; their owners subscribe again on the next.
 *
 * A connection is for whoever was signed in when it opened. Once a new one
 * finds that person's session gone (signed out, revoked, removed from the
 * organization, or someone else signed in), it closes for good, nothing
 * that waited for it runs, and `onSessionEnded` is called.
 */
export class CoreConnection {
  readonly #onSessionEnded: () => void;
  #closed = false;
  /** Who the first connection that answered was signed in as. */
  #person: Identity | undefined;
  /** The open connection; none while connecting. */
  #live: RpcStub<CoreApi> | undefined;
  #connected: Promise<Connected> | undefined;

  constructor(onSessionEnded: () => void) {
    this.#onSessionEnded = onSessionEnded;
  }

  /**
   * Core's API for anyone, signed in or not, once the connection is there:
   * waited for no longer than `signal` allows (a few seconds unless given),
   * then refused with its reason.
   */
  async api(signal = deadline()): Promise<RpcStub<CoreApi>> {
    const { api } = await this.#current(signal);
    return api;
  }

  /**
   * The signed-in person's API, once the connection is there, waited for
   * as `api` is. Ask again for each call: one kept from before a drop is of
   * the connection that dropped. Refused as core refuses it when nobody is
   * signed in.
   */
  async session(signal = deadline()): Promise<Session> {
    const { session } = await this.#current(signal);
    if (session === undefined) {
      throw authErrors.create("auth.unauthenticated");
    }
    return session;
  }

  /**
   * Runs `run` with the signed-in person's API ({@link session}). Given up
   * on while it waits for the connection, `run` never runs, so nothing it
   * would call is sent once core is back.
   */
  async withSession<T>(
    run: (session: Session) => Promise<T>,
    signal = deadline()
  ): Promise<T> {
    return await run(await this.session(signal));
  }

  /** Closes the connection for good: whoever waits for it, or asks later, is refused. */
  close(): void {
    this.#closed = true;
    if (this.#live !== undefined) {
      disposeQuietly(this.#live);
      this.#live = undefined;
    }
  }

  /**
   * The connection, unless `signal` gives up first. Checked again once it
   * is there, so what gave up in the same moment isn't sent either.
   */
  async #current(signal: AbortSignal): Promise<Connected> {
    const connected = await unlessAborted(this.#opened(), signal);
    signal.throwIfAborted();
    return connected;
  }

  async #opened(): Promise<Connected> {
    if (this.#connected === undefined) {
      this.#connected = this.#connect(0);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") {
          void this.#probe();
        }
      });
      window.addEventListener("online", () => {
        void this.#probe();
      });
    }
    return await this.#connected;
  }

  /**
   * A connection that answered, tried until one does, the first time after
   * `delay`. Only one that answered is handed on: Cap'n Web keeps what is
   * sent while a socket is still connecting, and fails it all at once when
   * it doesn't connect.
   */
  async #connect(delay: number): Promise<Connected> {
    let next = delay;
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- one attempt at a time
      await wait(jittered(next));
      next = Math.min(Math.max(next * 2, reconnectMs.first), reconnectMs.most);
      if (this.#closed) {
        // Closed while waiting: a new connection would never be closed.
        throw new Error("The page closed its connection to core.");
      }
      const api = connectCore();
      let connected: Connected;
      try {
        // oxlint-disable-next-line no-await-in-loop -- one attempt at a time
        connected = await answered(api);
      } catch {
        disposeQuietly(api);
        continue;
      }
      const { person } = connected;
      if (
        this.#person !== undefined &&
        person?.userId !== this.#person.userId
      ) {
        this.#closed = true;
        disposeQuietly(api);
        this.#onSessionEnded();
        throw authErrors.create("auth.unauthenticated");
      }
      this.#person ??= person;
      this.#live = api;
      // Registered after the answer, it still hears of a break before it.
      api.onRpcBroken(() => {
        this.#lost(api);
      });
      return connected;
    }
  }

  /**
   * `api` broke: from now on, whoever asks waits for the next connection.
   * A connection that isn't the open one any more changes nothing.
   */
  #lost(api: RpcStub<CoreApi>): void {
    if (this.#closed || this.#live !== api) {
      return;
    }
    this.#live = undefined;
    this.#connected = this.#connect(reconnectMs.first);
    void settled(this.#connected);
  }

  /**
   * A socket that died while the tab slept, or with the network, doesn't
   * always say so: asked here whether it still answers, rather than
   * leaving the person's next click to hang on it.
   */
  async #probe(): Promise<void> {
    const api = this.#live;
    if (api === undefined) {
      return;
    }
    try {
      await withTimeout(api.ping());
    } catch {
      this.#lost(api);
      disposeQuietly(api);
    }
  }
}

/** Whether core answers, how people sign in here, and who is signed in. */
export interface CoreStatus {
  connected: boolean;
  signInOptions: SignInOption[];
  identity?: Identity;
}

/** Who is signed in on `core` now, or `undefined` for nobody. */
const signedInAs = async (
  core: CoreConnection,
  signal: AbortSignal
): Promise<Identity | undefined> => {
  try {
    return await core.withSession(
      async (session) => await session.whoami(),
      signal
    );
  } catch (error) {
    if (authErrors.codeOf(error) === "auth.unauthenticated") {
      return undefined;
    }
    throw error;
  }
};

/** Asks core once, as long as `signal` allows. */
const askCoreStatus = async (
  core: CoreConnection,
  signal: AbortSignal
): Promise<CoreStatus> => {
  const api = await core.api(signal);
  const [pong, signInOptions, identity] = await Promise.all([
    api.ping(),
    api.signInOptions(),
    signedInAs(core, signal),
  ]);
  return { connected: pong === "pong", signInOptions, identity };
};

/** How long to wait before asking core for its status again, each time. */
const statusRetryMs = [250, 500, 1000] as const;

/**
 * Asks core over RPC whether it answers, how people sign in here and who is
 * signed in. Core failing or out of reach is asked again a few times, with
 * a growing pause, before it counts as unreachable: one failed request must
 * not look like nobody being signed in. A connection that hangs past the
 * timeout counts as unreachable at once; it has had its few seconds.
 */
export const loadCoreStatus = async (
  core: CoreConnection
): Promise<CoreStatus> => {
  try {
    return await retrying(
      async () => {
        const signal = deadline();
        return await unlessAborted(askCoreStatus(core, signal), signal);
      },
      statusRetryMs,
      (failure) =>
        isTransient(failure) && !(failure instanceof CoreTimeoutError)
    );
  } catch {
    return { connected: false, signInOptions: [] };
  }
};

/**
 * `read` on the signed-in person's API over `core`, within a few seconds
 * all told (or as long as `signal` allows): the wait for a connection and
 * for the answer. Given up on while it waits for the connection, `read`
 * never runs, so it is never sent once core is back; sent already, only
 * its answer is no longer waited for.
 */
export const readWithin = async <T>(
  core: CoreConnection,
  read: (session: Session) => Promise<T>,
  signal = deadline()
): Promise<T> => await unlessAborted(core.withSession(read, signal), signal);

/**
 * Ends this browser's session and the tab's connection, then reloads the
 * page signed out.
 */
export const signOut = async (core: CoreConnection): Promise<void> => {
  await fetch("/api/auth/sign-out", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  core.close();
  window.location.reload();
};
