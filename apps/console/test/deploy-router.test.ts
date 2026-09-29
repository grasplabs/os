import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import {
  coreOrigin,
  registerHostname,
  smokeCheck,
} from "../src/deploy/router.ts";
import type { RouterHosts } from "../src/deploy/router.ts";

describe("core's address", () => {
  it("is its script on the account's workers.dev subdomain", () => {
    expect(coreOrigin("grasp-os-core", "grasp-acme")).toBe(
      "https://grasp-os-core.grasp-acme.workers.dev"
    );
  });

  it("is refused before anything is sent to it unless it's a workers.dev origin", () => {
    const refused = [
      ["grasp-os-core", "evil.example.com/x"],
      ["grasp-os-core", "grasp acme"],
      ["grasp-os-core", "grasp-acme:8443"],
    ].map(([script = "", subdomain = ""]) => {
      try {
        coreOrigin(script, subdomain);
        return "allowed";
      } catch (error) {
        return error instanceof Error && "code" in error ? error.code : "other";
      }
    });

    expect(refused).toStrictEqual([
      "invalid_core_origin",
      "invalid_core_origin",
      "invalid_core_origin",
    ]);
  });
});

const origin = "https://grasp-os-core.grasp-acme.workers.dev";

/** A `fetch` to core that never answers until its signal aborts. */
const hanging = async (
  _: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> => {
  const stalled = Promise.withResolvers<Response>();
  init?.signal?.addEventListener("abort", () => {
    stalled.reject(new Error("aborted"));
  });
  return await stalled.promise;
};

describe("the smoke check", () => {
  it("gives each try its own deadline, so a stalled one moves on to the next", async () => {
    let tries = 0;
    const attempts = await smokeCheck(origin, "secret", "version-2", {
      retryDelayMs: 0,
      attemptTimeoutMs: 5,
      fetch: async (input, init) => {
        tries += 1;
        return tries === 1
          ? await hanging(input, init)
          : Response.json({ ok: true, version: "version-2" });
      },
    });

    expect(attempts).toBe(2);
  });

  it("fails as smoke_check_failed when every try stalls", async () => {
    await expect(
      smokeCheck(origin, "secret", "version-2", {
        retryDelayMs: 0,
        attemptTimeoutMs: 5,
        fetch: hanging,
      })
    ).rejects.toMatchObject({ code: "smoke_check_failed" });
  });
});

const isKv = (value: unknown): value is KVNamespace =>
  typeof value === "object" &&
  value !== null &&
  "get" in value &&
  "put" in value;
/** The test pool's KV namespace for the router's map (vite.test.config.ts). */
const kv: unknown = Reflect.get(env, "ROUTER_HOSTS");
if (!isKv(kv)) {
  throw new TypeError("Expected the router's hostname map as ROUTER_HOSTS");
}

/**
 * The hostname map in the test pool's KV, whose reads after a write can be
 * made to answer `readBack` instead, as another writer's entry landing
 * after this one would.
 */
const hostsWith = (readBack?: string): RouterHosts & { writes: number } => {
  const hosts = {
    writes: 0,
    get: async (key: string): Promise<unknown> => {
      const stored: unknown = await kv.get(key, "json");
      const lagging: unknown =
        readBack === undefined ? undefined : JSON.parse(readBack);
      return hosts.writes > 0 && lagging !== undefined ? lagging : stored;
    },
    put: async (key: string, value: string) => {
      hosts.writes += 1;
      await kv.put(key, value);
    },
  };
  return hosts;
};

const entry = {
  clientId: "acme",
  coreUrl: origin,
  generation: 2,
};

describe("registering a hostname", () => {
  it("checks the deploy is still the latest as the last thing before it writes", async () => {
    const hostname = `${crypto.randomUUID().slice(0, 8)}.grasp.test`;
    const hosts = hostsWith();
    const seen: unknown[] = [];

    await registerHostname(hosts, hostname, entry, async () => {
      seen.push(await kv.get(hostname));
    });

    expect({ seen, writes: hosts.writes }).toStrictEqual({
      seen: [null],
      writes: 1,
    });
  });

  it("fails loudly when the entry reads back at a lower generation than it wrote", async () => {
    const hostname = `${crypto.randomUUID().slice(0, 8)}.grasp.test`;
    const hosts = hostsWith(JSON.stringify({ ...entry, generation: 1 }));

    await expect(
      registerHostname(hosts, hostname, entry, async () => {
        await kv.get(hostname);
      })
    ).rejects.toMatchObject({ code: "generation_behind" });
  });
});
