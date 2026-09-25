import { internalErrors, requestErrors } from "@grasp-os/shared/errors";
import type { CoreApi } from "@grasp-os/shared/rpc";
import { newWebSocketRpcSession, RpcTarget } from "capnweb";

import { errorResponse } from "./errors.ts";
import { errorFields, log } from "./log.ts";

/** What the frontend reaches over `/rpc`. */
export class CoreRpc extends RpcTarget implements CoreApi {
  // Cap'n Web exposes prototype methods only, so this can't be static.
  // oxlint-disable-next-line class-methods-use-this
  ping(): "pong" {
    return "pong";
  }
}

/**
 * Decides what an error looks like to the frontend. Errors from a known
 * family go out as they are (Cap'n Web drops the stack); anything else is
 * replaced, so internals never reach the client.
 */
export const toClientError = (
  error: Error,
  requestId: string
): Error | undefined => {
  if (requestErrors.codeOf(error) || internalErrors.codeOf(error)) {
    return undefined;
  }
  const replacement = internalErrors.create("internal.unexpected", {
    requestId,
  });
  // Cap'n Web sends the stack of a replacement error; this one has none to send.
  replacement.stack = undefined;
  return replacement;
};

/**
 * Opens a Cap'n Web session over WebSocket. The session lives in this Worker
 * invocation for as long as the socket is open; hibernation applies once RPC
 * is routed to a Durable Object.
 */
export const rpcResponse = (request: Request, requestId: string): Response => {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    const response = errorResponse(
      426,
      requestErrors.create("request.upgrade_required"),
      requestId
    );
    response.headers.set("Upgrade", "websocket");
    return response;
  }

  const { 0: client, 1: server } = new WebSocketPair();
  // Cap'n Web also passes the reason a session ended through onSendError.
  // A closed socket is how sessions normally end, so that isn't logged.
  let open = true;
  server.addEventListener("close", () => {
    open = false;
  });
  server.accept();
  newWebSocketRpcSession(server, new CoreRpc(), {
    onSendError: (error) => {
      const sent = toClientError(error, requestId);
      if (sent && open) {
        log.error("rpc.failed", { requestId, ...errorFields(error) });
      }
      return sent;
    },
  });
  return new Response(null, { status: 101, webSocket: client });
};
