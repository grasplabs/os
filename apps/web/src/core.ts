import type { CoreApi } from "@grasp-os/shared/rpc";
import { newWebSocketRpcSession } from "capnweb";

/** Opens a Cap'n Web session with core, on the origin this page came from. */
export const connectCore = () => {
  const url = new URL("/rpc", window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return newWebSocketRpcSession<CoreApi>(url.href);
};

const pingTimeoutMs = 5000;

/**
 * Whether core answers over RPC within a few seconds. Opens a session just
 * for this call; a hanging connection counts as no answer.
 */
export const pingCore = async (): Promise<boolean> => {
  const core = connectCore();
  const { promise: timeout, resolve } = Promise.withResolvers<string>();
  const timer = setTimeout(() => {
    resolve("timeout");
  }, pingTimeoutMs);
  try {
    return (await Promise.race([core.ping(), timeout])) === "pong";
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    core[Symbol.dispose]();
  }
};
