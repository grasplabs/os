import type { CoreApi } from "@grasp-os/shared/rpc";
import { newWebSocketRpcSession } from "capnweb";

/** Opens a Cap'n Web session with core, on the origin this page came from. */
export const connectCore = () => {
  const url = new URL("/rpc", window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return newWebSocketRpcSession<CoreApi>(url.href);
};

/** Whether core answers over RPC. Opens a session just for this call. */
export const pingCore = async (): Promise<boolean> => {
  const core = connectCore();
  try {
    return (await core.ping()) === "pong";
  } catch {
    return false;
  } finally {
    core[Symbol.dispose]();
  }
};
