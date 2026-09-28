import {
  deriveRouterSecret,
  routerClientIpHeader,
  routerSecretHeader,
} from "@grasp-os/shared/router";
import { exports } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import {
  fakeCores,
  mapHost,
  routerKeyAdmin,
  testRouterKey,
} from "./fixtures.ts";

const acme = {
  clientId: "acme",
  coreUrl: "https://grasp-os-core.acme.workers.dev",
  generation: 3,
};

const secretOf = async (clientId: string, generation: number) =>
  await deriveRouterSecret(testRouterKey, clientId, generation);

const statusOf = async (url: string): Promise<number> => {
  const response = await exports.default.fetch(url);
  return response.status;
};

// The route cache lives for the isolate, across tests: each test uses
// hostnames of its own.
describe("router", () => {
  const cores = fakeCores();
  let routerKeyId = "";

  beforeAll(async () => {
    const admin = await routerKeyAdmin();
    routerKeyId = await admin.create(testRouterKey);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("forwards a client's hostname to its core, with the client's router secret", async () => {
    await mapHost("acme.grasp.test", acme);

    const response = await exports.default.fetch(
      "https://acme.grasp.test/api/things?page=2",
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie: "a=b" },
        body: '{"name":"x"}',
      }
    );

    await expect(response.text()).resolves.toBe(
      "core at grasp-os-core.acme.workers.dev"
    );
    expect(cores.received).toMatchObject([
      {
        url: "https://grasp-os-core.acme.workers.dev/api/things?page=2",
        method: "POST",
        body: '{"name":"x"}',
      },
    ]);
    const headers = cores.received[0]?.headers;
    expect(headers?.get("cookie")).toBe("a=b");
    expect(headers?.get(routerSecretHeader)).toBe(await secretOf("acme", 3));
  });

  it("looks a hostname up however the request cases it", async () => {
    await mapHost("mixed.grasp.test", acme);

    await expect(statusOf("https://MiXeD.Grasp.Test./")).resolves.toBe(200);
    expect(cores.received).toHaveLength(1);
  });

  it("gives each client its own secret, and a new one per generation", async () => {
    await Promise.all([
      mapHost("one.grasp.test", { ...acme, clientId: "one" }),
      mapHost("two.grasp.test", { ...acme, clientId: "two" }),
      mapHost("next.grasp.test", { ...acme, clientId: "one", generation: 4 }),
    ]);

    await Promise.all(
      ["one", "two", "next"].map(
        async (host) =>
          await exports.default.fetch(`https://${host}.grasp.test/`)
      )
    );

    const secrets = new Set(
      cores.received.map(({ headers }) => headers.get(routerSecretHeader))
    );
    expect(secrets.size).toBe(3);
  });

  it("replaces a router secret the caller sent with the client's own", async () => {
    await mapHost("spoof.grasp.test", acme);

    await exports.default.fetch("https://spoof.grasp.test/", {
      headers: { [routerSecretHeader]: "guessed" },
    });

    expect(cores.received[0]?.headers.get(routerSecretHeader)).toBe(
      await secretOf("acme", 3)
    );
  });

  it("tells core the client's IP as Cloudflare saw it, and not the client's Host", async () => {
    await mapHost("client-ip.grasp.test", acme);

    await exports.default.fetch("https://client-ip.grasp.test/", {
      headers: {
        host: "other.grasp.test",
        "cf-connecting-ip": "192.0.2.10",
        [routerClientIpHeader]: "198.51.100.1",
      },
    });
    await exports.default.fetch("https://client-ip.grasp.test/", {
      headers: { [routerClientIpHeader]: "198.51.100.1" },
    });

    const [seen, withoutIp] = cores.received.map(({ headers }) => ({
      host: headers.get("host"),
      clientIp: headers.get(routerClientIpHeader),
    }));
    expect(seen).toStrictEqual({ host: null, clientIp: "192.0.2.10" });
    expect(withoutIp).toStrictEqual({ host: null, clientIp: null });
  });

  it("answers 404 for a hostname the map doesn't have, and forwards nothing", async () => {
    await expect(statusOf("https://nobody.grasp.test/")).resolves.toBe(404);
    expect(cores.received).toHaveLength(0);
  });

  it("forwards only to an https workers.dev origin, for a well-formed entry", async () => {
    const refused = [
      { coreUrl: "http://grasp-os-core.acme.workers.dev" },
      { coreUrl: "https://evil.example.com" },
      { coreUrl: "https://grasp-os-core.acme.workers.dev.evil.example.com" },
      { coreUrl: "https://workers.dev" },
      { coreUrl: "https://grasp-os-core.acme.workers.dev:8443" },
      { coreUrl: "https://someone@grasp-os-core.acme.workers.dev" },
      { coreUrl: "https://grasp-os-core.acme.workers.dev/elsewhere" },
      { coreUrl: "https://grasp-os-core.acme.workers.dev/?x=1" },
      { coreUrl: "not a url" },
      { clientId: "a:b" },
      { generation: -1 },
    ];
    await Promise.all(
      refused.map(async (change, index) => {
        await mapHost(`bad-${index}.grasp.test`, { ...acme, ...change });
      })
    );

    const statuses = await Promise.all(
      refused.map(
        async (_, index) => await statusOf(`https://bad-${index}.grasp.test/`)
      )
    );

    expect(new Set(statuses)).toStrictEqual(new Set([404]));
    expect(cores.received).toHaveLength(0);
  });

  it("hands core's redirects back instead of following them", async () => {
    await mapHost("redirect.grasp.test", acme);
    cores.answerWith(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://login.example.com/authorize" },
        })
    );

    // The test's own call mustn't follow the redirect either.
    const response = await exports.default.fetch(
      "https://redirect.grasp.test/",
      { redirect: "manual" }
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://login.example.com/authorize"
    );
    expect(cores.received).toMatchObject([{ redirect: "manual" }]);
  });

  it("passes WebSocket upgrades through to core", async () => {
    await mapHost("socket.grasp.test", acme);

    const response = await exports.default.fetch(
      "https://socket.grasp.test/rpc",
      { headers: { upgrade: "websocket" } }
    );

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
    expect(cores.received[0]?.headers.get(routerSecretHeader)).toBe(
      await secretOf("acme", 3)
    );
  });

  it("answers 502 when core can't be reached", async () => {
    await mapHost("down.grasp.test", acme);
    cores.answerWith(() => {
      throw new Error("connection refused");
    });

    await expect(statusOf("https://down.grasp.test/")).resolves.toBe(502);
  });

  it("logs only the kind of a failed forward, never its message or stack", async () => {
    await mapHost("leaky.grasp.test", acme);
    const target =
      "https://grasp-os-core.acme.workers.dev/api/auth/sso/callback/entra?code=secret-code&state=secret-state";
    cores.answerWith(() => {
      throw new TypeError(`fetch to ${target} failed`);
    });
    const logged: unknown[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(...args);
    });

    await statusOf("https://leaky.grasp.test/api/auth/sso/callback/entra");

    const text = JSON.stringify(logged);
    expect(logged).toStrictEqual([
      {
        event: "router.forward_failed",
        host: "leaky.grasp.test",
        errorName: "TypeError",
      },
    ]);
    expect(text).not.toContain("secret-code");
    expect(text).not.toContain("workers.dev");
  });

  it("keeps what it read from the map for 30 seconds, found or not", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await mapHost("cached.grasp.test", acme);
    await statusOf("https://cached.grasp.test/");
    const unknownFirst = await statusOf("https://late.grasp.test/");

    await mapHost("cached.grasp.test", { ...acme, generation: 4 });
    await mapHost("late.grasp.test", acme);
    vi.setSystemTime(Date.now() + 29_000);
    await statusOf("https://cached.grasp.test/");
    const stillUnknown = await statusOf("https://late.grasp.test/");

    vi.setSystemTime(Date.now() + 2000);
    await statusOf("https://cached.grasp.test/");
    const nowKnown = await statusOf("https://late.grasp.test/");

    expect([unknownFirst, stillUnknown, nowKnown]).toStrictEqual([
      404, 404, 200,
    ]);
    expect(
      cores.received.map(({ headers }) => headers.get(routerSecretHeader))
    ).toStrictEqual([
      await secretOf("acme", 3),
      await secretOf("acme", 3),
      await secretOf("acme", 4),
      await secretOf("acme", 3),
    ]);
  });

  it("answers 503 and forwards nothing while its key can't be read", async () => {
    const admin = await routerKeyAdmin();
    await admin.delete(routerKeyId);
    await mapHost("keyless.grasp.test", acme);
    let keyless = 0;
    try {
      keyless = await statusOf("https://keyless.grasp.test/");
    } finally {
      routerKeyId = await admin.create(testRouterKey);
    }

    expect(keyless).toBe(503);
    expect(cores.received).toHaveLength(0);
    // Nothing was cached: with the key back, the host routes.
    await expect(statusOf("https://keyless.grasp.test/")).resolves.toBe(200);
  });
});
