// Routes split into chunks of their own share this module, so the bundler
// moves it, with Zod and the shared schemas, into a chunk that runs before
// main.tsx does. Importing this first keeps Zod jitless before any of them
// builds a schema, whichever chunk they land in.
import "./zod-jitless.ts";
import { internalErrors } from "@grasp-os/shared/errors";
import type { CoreApi } from "@grasp-os/shared/rpc";
import { t } from "@lingui/core/macro";
import { newWebSocketRpcSession } from "capnweb";
import type { RpcStub } from "capnweb";

/**
 * Opens a Cap'n Web session with core, on the origin this page came from.
 * The browser sends the session cookie with it, which says who the
 * connection is for as long as it lasts.
 */
export const connectCore = (): RpcStub<CoreApi> => {
  const url = new URL("/rpc", window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return newWebSocketRpcSession<CoreApi>(url.href);
};

/** How long a read from core may take before core counts as unreachable. */
export const timeoutMs = 5000;

/** What the page says when core can't be reached, in the page's language. */
const unreachable = (): string =>
  t`Grasp can't be reached right now. Try again in a moment.`;

/**
 * Core didn't answer in time, or no connection to it came in time: out of
 * reach, not a refusal. Its message is what the person reads.
 */
export class CoreTimeoutError extends Error {
  readonly ms: number;

  constructor(ms: number) {
    super(unreachable());
    this.ms = ms;
    this.name = "CoreTimeoutError";
  }
}

/**
 * Rejects with a `CoreTimeoutError` when `promise` hasn't settled within
 * `ms`, a few seconds unless given.
 */
export const withTimeout = async <T>(
  promise: Promise<T>,
  ms = timeoutMs
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // oxlint-disable-next-line promise/avoid-new -- setTimeout has no promise form in browsers
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new CoreTimeoutError(ms));
    }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * A signal that gives up after `ms` (a few seconds unless given), with a
 * `CoreTimeoutError`.
 */
export const deadline = (ms = timeoutMs): AbortSignal => {
  const controller = new AbortController();
  setTimeout(() => {
    controller.abort(new CoreTimeoutError(ms));
  }, ms);
  return controller.signal;
};

/**
 * `promise`, unless `signal` gives up first: then rejects with the
 * signal's reason. What `promise` stands for goes on either way.
 */
export const unlessAborted = async <T>(
  promise: Promise<T>,
  signal: AbortSignal
): Promise<T> => {
  signal.throwIfAborted();
  const aborted = Promise.withResolvers<never>();
  const abort = (): void => {
    aborted.reject(signal.reason);
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    return await Promise.race([promise, aborted.promise]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
};

/** Resolves after `ms`. */
export const wait = async (ms: number): Promise<void> => {
  // oxlint-disable-next-line promise/avoid-new -- setTimeout has no promise form in browsers
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
};

/**
 * Whether `error` may pass when core is asked again: core out of reach or
 * failing, never a refusal it meant. Told by the error's shape alone, so a
 * code from a family this chunk hasn't loaded still counts as an answer.
 * A connection that failed or broke rejects with an error that has no
 * string `code` (a browser sees a refused upgrade, even a 500, only as a
 * closed socket), and anything core didn't plan for arrives as
 * `internal.unexpected`, such as a busy database. Any other coded error
 * (nobody signed in, not found, forbidden) is core's answer.
 */
export const isTransient = (error: unknown): boolean => {
  if (internalErrors.codeOf(error) !== undefined) {
    return true;
  }
  const coded =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string";
  return !coded;
};

/**
 * Runs `attempt`, and again after each of `delaysMs` for as long as it
 * fails in a way `retries` (`isTransient` unless given) says may pass.
 * Rejects with the last failure once there is no delay left.
 */
export const retrying = async <T>(
  attempt: () => Promise<T>,
  delaysMs: readonly number[],
  retries: (error: unknown) => boolean = isTransient
): Promise<T> => {
  for (const delay of delaysMs) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- one attempt at a time
      return await attempt();
    } catch (error) {
      if (!retries(error)) {
        throw error;
      }
    }
    // oxlint-disable-next-line no-await-in-loop -- backing off between attempts
    await wait(delay);
  }
  return await attempt();
};

/** The signed-in person's API, as a connection hands it out. */
export type Session = Awaited<ReturnType<RpcStub<CoreApi>["authenticate"]>>;

/**
 * Starts signing in with the IdP `providerId`: core answers with the IdP's
 * address, and the IdP sends the person back to `returnTo` (a path of this
 * site), signed in or with `error=<code>` added to it. Better Auth keeps
 * `returnTo` with the sign-in state until the person is back.
 */
export const signIn = async (
  providerId: string,
  returnTo = "/"
): Promise<void> => {
  const response = await fetch("/api/auth/sign-in/sso", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      providerId,
      callbackURL: returnTo,
      errorCallbackURL: returnTo,
    }),
  });
  const body: unknown = await response.json();
  if (
    !response.ok ||
    typeof body !== "object" ||
    body === null ||
    !("url" in body) ||
    typeof body.url !== "string"
  ) {
    throw new Error(`Sign-in did not start (${response.status})`);
  }
  window.location.assign(body.url);
};
