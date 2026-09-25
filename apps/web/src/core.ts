import type { CoreApi } from "@grasp-os/shared/rpc";
import { newWebSocketRpcSession } from "capnweb";

/** Opens a Cap'n Web session with core, on the origin this page came from. */
export const connectCore = () => {
  const url = new URL("/rpc", window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return newWebSocketRpcSession<CoreApi>(url.href);
};

const pingTimeoutMs = 5000;

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

/**
 * Whether core answers over RPC within a few seconds. Opens a session just
 * for this call; a hanging connection counts as no answer.
 */
export const pingCore = async (): Promise<boolean> => {
  const core = connectCore();
  try {
    return (await withTimeout(core.ping(), pingTimeoutMs)) === "pong";
  } catch {
    return false;
  } finally {
    core[Symbol.dispose]();
  }
};
