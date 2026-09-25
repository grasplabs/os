import {
  errorPayloadSchema,
  internalErrors,
  requestErrors,
} from "@grasp-os/shared/errors";
import { routerSecretHeader } from "@grasp-os/shared/router";
import type { CoreApi } from "@grasp-os/shared/rpc";
import { newWebSocketRpcSession } from "capnweb";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { toClientError } from "../src/rpc.ts";

const openRpc = async (headers: HeadersInit) =>
  await exports.default.fetch("https://core/rpc", { headers });

describe("Cap'n Web RPC", () => {
  it("answers ping over a WebSocket", async () => {
    const response = await openRpc({
      Upgrade: "websocket",
      [routerSecretHeader]: env.ROUTER_SECRET,
    });
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    if (!socket) {
      throw new Error("Expected a WebSocket");
    }
    socket.accept();

    const core = newWebSocketRpcSession<CoreApi>(socket);
    try {
      await expect(core.ping()).resolves.toBe("pong");
    } finally {
      core[Symbol.dispose]();
    }
  });

  it("asks for a WebSocket upgrade on a plain request", async () => {
    const response = await openRpc({ [routerSecretHeader]: env.ROUTER_SECRET });
    expect(response.status).toBe(426);
    expect(response.headers.get("Upgrade")).toBe("websocket");
    const error = errorPayloadSchema.parse(await response.json());
    expect(error.code).toBe("request.upgrade_required");
  });

  it("won't open a session without the router secret", async () => {
    const response = await openRpc({ Upgrade: "websocket" });
    expect(response.status).toBe(403);
    expect(response.webSocket).toBeNull();
  });
});

describe("errors sent to the client", () => {
  it("replaces an unexpected error, keeping only the request ID", () => {
    const cause = new Error("Bucket grasp-internal unreachable");
    const sent = toClientError(cause, "request-1");

    expect(internalErrors.codeOf(sent)).toBe("internal.unexpected");
    expect(sent?.message).not.toContain("grasp-internal");
    expect(sent?.stack).toBeUndefined();
    expect(sent).toMatchObject({ details: { requestId: "request-1" } });
  });

  it("sends an expected error as it is", () => {
    const expected = requestErrors.create("request.forbidden");
    expect(toClientError(expected, "request-1")).toBeUndefined();
  });
});
