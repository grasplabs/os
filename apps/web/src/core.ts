// Routes split into chunks of their own share this module, so the bundler
// moves it, with Zod and the shared schemas, into a chunk that runs before
// main.tsx does. Importing this first keeps Zod jitless before any of them
// builds a schema, whichever chunk they land in.
import "./zod-jitless.ts";
import { authErrors } from "@grasp-os/shared/errors";
import type { CoreApi, Identity, SignInOption } from "@grasp-os/shared/rpc";
import { newWebSocketRpcSession } from "capnweb";
import type { RpcStub } from "capnweb";

/**
 * Opens a Cap'n Web session with core, on the origin this page came from.
 * The browser sends the session cookie with it; core checks it on connect
 * and on every call that needs the person.
 */
export const connectCore = () => {
  const url = new URL("/rpc", window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return newWebSocketRpcSession<CoreApi>(url.href);
};

const timeoutMs = 5000;

/** Rejects when `promise` hasn't settled within `ms`. */
const withTimeout = async <T>(promise: Promise<T>, ms: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // oxlint-disable-next-line promise/avoid-new -- setTimeout has no promise form in browsers
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Timed out after ${ms} ms`));
    }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
};

/** Who is signed in on this connection, or `undefined` for nobody. */
const signedInAs = async (
  core: RpcStub<CoreApi>
): Promise<Identity | undefined> => {
  try {
    using session = core.authenticate();
    return await session.whoami();
  } catch (error) {
    if (authErrors.codeOf(error) === "auth.unauthenticated") {
      return undefined;
    }
    throw error;
  }
};

/** The signed-in person's API, as a connection hands it out. */
export type Session = ReturnType<RpcStub<CoreApi>["authenticate"]>;

/**
 * Runs `run` with the signed-in person's API, on a connection opened just
 * for it and closed after.
 */
export const withSession = async <T>(
  run: (session: Session) => Promise<T>
): Promise<T> => {
  const core = connectCore();
  try {
    using session = core.authenticate();
    return await run(session);
  } finally {
    core[Symbol.dispose]();
  }
};

/** Whether core answers, how people sign in here, and who is signed in. */
export interface CoreStatus {
  connected: boolean;
  signInOptions: SignInOption[];
  identity?: Identity;
}

/**
 * Asks core over RPC, within a few seconds, whether it answers, how people
 * sign in here and who is signed in. Opens a session just for this; a
 * hanging connection counts as no answer.
 */
export const loadCoreStatus = async (): Promise<CoreStatus> => {
  const core = connectCore();
  try {
    const [pong, signInOptions, identity] = await withTimeout(
      Promise.all([core.ping(), core.signInOptions(), signedInAs(core)]),
      timeoutMs
    );
    return { connected: pong === "pong", signInOptions, identity };
  } catch {
    return { connected: false, signInOptions: [] };
  } finally {
    core[Symbol.dispose]();
  }
};

/**
 * Starts signing in with the IdP `providerId`: core answers with the IdP's
 * address, and the IdP sends the person back to `returnTo` (a path of this
 * site), signed in or with `error=<code>` added to it. Better Auth keeps
 * `returnTo` with the sign-in state until the person is back, a decision
 * link's token included; that is harmless, as the token grants nothing
 * without the bound person's own session.
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

/** Ends this browser's session, then reloads the page signed out. */
export const signOut = async (): Promise<void> => {
  await fetch("/api/auth/sign-out", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  window.location.reload();
};
