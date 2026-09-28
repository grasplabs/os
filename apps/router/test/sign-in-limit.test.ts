import { errorPayloadSchema } from "@grasp-os/shared/errors";
import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vite-plus/test";

import worker from "../src/index.ts";
import {
  fakeCores,
  mapHost,
  routerKeyAdmin,
  testRouterKey,
} from "./fixtures.ts";

/**
 * A stand-in for Cloudflare's rate limiter that lets `allowed` requests
 * through per key. The real one counts in wall-clock windows, which a test
 * can't pin down.
 */
const limiterAllowing = (allowed: number): RateLimit => {
  const counts = new Map<string, number>();
  return {
    limit: async ({ key }) => {
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      return await Promise.resolve({ success: count <= allowed });
    },
  };
};

const signInFrom = async (
  ip: string,
  url: string,
  limiter: RateLimit
): Promise<Response> =>
  await worker.fetch(
    new Request(url, {
      method: "POST",
      headers: { "cf-connecting-ip": ip },
    }),
    { ...env, AUTH_RATE_LIMIT: limiter }
  );

describe("sign-in rate limit", () => {
  const cores = fakeCores();

  beforeAll(async () => {
    const admin = await routerKeyAdmin();
    await admin.create(testRouterKey);
    const core = { coreUrl: "https://grasp-os-core.acme.workers.dev" };
    await Promise.all([
      mapHost("acme.limit.test", { ...core, clientId: "acme", generation: 1 }),
      mapHost("beta.limit.test", { ...core, clientId: "beta", generation: 1 }),
    ]);
  });

  it("limits sign-in per hostname and client IP, without reaching core", async () => {
    const limiter = limiterAllowing(2);
    const signIn = "https://acme.limit.test/api/auth/sign-in/sso";

    const first = await signInFrom("192.0.2.1", signIn, limiter);
    const second = await signInFrom("192.0.2.1", signIn, limiter);
    const refused = await signInFrom("192.0.2.1", signIn, limiter);
    const otherIp = await signInFrom("192.0.2.2", signIn, limiter);
    const otherHost = await signInFrom(
      "192.0.2.1",
      "https://beta.limit.test/api/auth/sign-in/sso",
      limiter
    );

    expect(
      [first, second, refused, otherIp, otherHost].map(({ status }) => status)
    ).toStrictEqual([200, 200, 429, 200, 200]);
    // The headers core puts on its own responses, as the router answers in
    // its place; the request ID is also in the error, as core's are.
    const requestId = refused.headers.get("x-request-id") ?? "";
    const error = errorPayloadSchema.parse(await refused.json());
    expect({
      retryAfter: refused.headers.get("retry-after"),
      nosniff: refused.headers.get("x-content-type-options"),
      hsts: refused.headers.get("strict-transport-security"),
      requestIdIsUuid: /^[0-9a-f-]{36}$/u.test(requestId),
      code: error.code,
      errorRequestId: error.details?.requestId,
    }).toStrictEqual({
      retryAfter: "60",
      nosniff: "nosniff",
      hsts: "max-age=31536000; includeSubDomains",
      requestIdIsUuid: true,
      code: "request.rate_limited",
      errorRequestId: requestId,
    });
    expect(cores.received).toHaveLength(4);
  });

  it("counts every IPv6 address in one /64 against one budget", async () => {
    const limiter = limiterAllowing(2);
    const signIn = "https://acme.limit.test/api/auth/sign-in/sso";

    const first = await signInFrom("2001:db8:1:2::1", signIn, limiter);
    const second = await signInFrom("2001:db8:1:2:aaaa::7", signIn, limiter);
    const refused = await signInFrom(
      "2001:db8:1:2:ffff:ffff:ffff:ffff",
      signIn,
      limiter
    );
    const otherPrefix = await signInFrom("2001:db8:1:3::1", signIn, limiter);

    expect(
      [first, second, refused, otherPrefix].map(({ status }) => status)
    ).toStrictEqual([200, 200, 429, 200]);
  });

  it("never limits signing out", async () => {
    const limiter = limiterAllowing(0);

    const signOut = await signInFrom(
      "192.0.2.6",
      "https://acme.limit.test/api/auth/sign-out",
      limiter
    );

    expect(signOut.status).toBe(200);
    expect(
      cores.received.map(({ url }) => new URL(url).pathname)
    ).toStrictEqual(["/api/auth/sign-out"]);
  });

  it("limits only core's sign-in routes", async () => {
    const limiter = limiterAllowing(0);
    const paths = [
      "/",
      "/api/things",
      "/api/authority",
      "/api/auth",
      "/api/auth/get-session",
    ];

    const statuses = await Promise.all(
      paths.map(async (path) => {
        const response = await signInFrom(
          "192.0.2.3",
          `https://acme.limit.test${path}`,
          limiter
        );
        return response.status;
      })
    );

    expect(statuses).toStrictEqual([200, 200, 200, 429, 429]);
  });

  it("lets sign-in through when the limiter fails", async () => {
    const broken: RateLimit = {
      limit: async () => {
        await Promise.resolve();
        throw new Error("rate limiter unavailable");
      },
    };

    const response = await signInFrom(
      "192.0.2.4",
      "https://acme.limit.test/api/auth/sign-in/sso",
      broken
    );

    expect(response.status).toBe(200);
  });

  it("counts with the rate limiter binding it's deployed with", async () => {
    const response = await exports.default.fetch(
      "https://acme.limit.test/api/auth/get-session",
      { headers: { "cf-connecting-ip": "192.0.2.5" } }
    );

    expect(response.status).toBe(200);
  });
});
