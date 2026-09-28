import {
  deriveRouterSecret,
  routerClientIpHeader,
} from "@grasp-os/shared/router";
import { exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vite-plus/test";

import { standInRedirect } from "./core-stand-in.ts";
import { mapHost, routerKeyAdmin, testRouterKey } from "./fixtures.ts";

// Through workerd's real `fetch`, with no stand-in for it in this isolate:
// the router's requests leave it as they would in production and reach the
// core stand-in (the outbound service in vite.config.ts).
describe("router, through the real fetch", () => {
  beforeAll(async () => {
    const admin = await routerKeyAdmin();
    await admin.create(testRouterKey);
    await mapHost("acme.real.test", {
      clientId: "acme",
      coreUrl: "https://grasp-os-core.acme.workers.dev",
      generation: 2,
    });
  });

  it("forwards to the client's core with its secret, and nothing the client made up", async () => {
    const response = await exports.default.fetch(
      "https://acme.real.test/api/things?page=2",
      {
        method: "POST",
        headers: {
          host: "other.real.test",
          "cf-connecting-ip": "192.0.2.20",
          [routerClientIpHeader]: "198.51.100.1",
          "x-grasp-router-secret": "guessed",
        },
        body: "hello",
      }
    );

    // What the core stand-in says reached it.
    const received: unknown = await response.json();
    expect(received).toStrictEqual({
      url: "https://grasp-os-core.acme.workers.dev/api/things?page=2",
      method: "POST",
      // The client's Host is gone. On the network, fetch sets it from the
      // URL; handing the request to an outbound service sets none.
      host: null,
      secret: await deriveRouterSecret(testRouterKey, "acme", 2),
      clientIp: "192.0.2.20",
      body: "hello",
    });
  });

  it("hands core's redirects back instead of following them", async () => {
    const response = await exports.default.fetch(
      "https://acme.real.test/redirect",
      { redirect: "manual" }
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(standInRedirect);
  });

  it("passes a WebSocket through to core and back", async () => {
    const response = await exports.default.fetch("https://acme.real.test/rpc", {
      headers: { upgrade: "websocket" },
    });

    const socket = response.webSocket;
    if (socket === null) {
      throw new Error(`Expected a WebSocket, got ${response.status}`);
    }
    socket.accept();
    const reply = Promise.withResolvers<unknown>();
    socket.addEventListener("message", (event) => {
      reply.resolve(event.data);
    });
    socket.send("hello");
    await expect(reply.promise).resolves.toBe("echo: hello");
  });
});
