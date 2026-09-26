import { errorPayloadSchema } from "@grasp-os/shared/errors";
import { routerSecretHeader } from "@grasp-os/shared/router";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import worker from "../src/index.ts";
import { routed } from "./sign-in.ts";

const requestIdHeader = "x-request-id";

/** A request with the secret header set to `presented`, or without it. */
const presenting = (url: string, presented: string | null) => {
  const headers = new Headers();
  if (presented !== null) {
    headers.set(routerSecretHeader, presented);
  }
  return new Request(url, { headers });
};

/** The error of a response, checked against the shared shape. */
const errorOf = async (response: Response) => {
  const payload = errorPayloadSchema.parse(await response.json());
  return {
    status: response.status,
    code: payload.code,
    requestIdMatches:
      payload.details?.requestId === response.headers.get(requestIdHeader),
  };
};

/** Stands in for the static assets, to see what core hands them. */
const assetsThat = (handle: (request: Request) => Response): Fetcher => ({
  fetch: async (input, init) =>
    await Promise.resolve(handle(new Request(input, init))),
  connect: () => {
    throw new Error("Core never opens sockets to its assets");
  },
});

describe("router secret", () => {
  it("refuses every path without the secret, static files included", async () => {
    const paths = ["/", "/index.html", "/health", "/rpc", "/api/x"];
    const errors = await Promise.all(
      paths.map(
        async (path) =>
          await errorOf(await exports.default.fetch(`https://core${path}`))
      )
    );
    for (const error of errors) {
      expect(error).toStrictEqual({
        status: 403,
        code: "request.forbidden",
        requestIdMatches: true,
      });
    }
  });

  it("refuses a wrong secret, however close", async () => {
    const secret = env.ROUTER_SECRET;
    const wrong = [
      "",
      secret.slice(0, -1),
      `${secret}x`,
      secret.toUpperCase(),
      `${secret}, ${secret}`,
    ];
    const responses = await Promise.all(
      wrong.map(
        async (presented) =>
          await exports.default.fetch(
            presenting("https://core/health", presented)
          )
      )
    );
    expect(responses.map((response) => response.status)).toStrictEqual(
      wrong.map(() => 403)
    );
  });

  it("lets a request with the right secret through", async () => {
    const response = await routed("/health");
    expect(response.status).toBe(200);
  });

  it("refuses everything while no secret is configured", async () => {
    const unconfigured = { ...env, ROUTER_SECRET: "" };
    const responses = await Promise.all(
      [null, ""].map(
        async (presented) =>
          await worker.fetch(
            presenting("https://core/health", presented),
            unconfigured
          )
      )
    );
    expect(responses.map((response) => response.status)).toStrictEqual([
      403, 403,
    ]);
  });

  it("skips the check in local development, for this machine only", async () => {
    const local = { ...env, ROUTER_SECRET: "", DEV_SKIP_ROUTER_SECRET: "true" };
    const fromHere = await worker.fetch(
      new Request("http://localhost:8787/health"),
      local
    );
    expect(fromHere.status).toBe(200);

    const fromElsewhere = await worker.fetch(
      new Request("https://core.example.com/health"),
      local
    );
    expect(fromElsewhere.status).toBe(403);
  });

  it("only skips the check when the dev flag is exactly true", async () => {
    const flags = ["", "false", "1", "TRUE"];
    const responses = await Promise.all(
      flags.map(async (flag) => {
        const local = { ...env, DEV_SKIP_ROUTER_SECRET: flag };
        return await worker.fetch(
          new Request("http://localhost:8787/health"),
          local
        );
      })
    );
    expect(responses.map((response) => response.status)).toStrictEqual(
      flags.map(() => 403)
    );
  });

  it("strips the secret before anything else sees the request", async () => {
    const seen: Request[] = [];
    const assets = assetsThat((request) => {
      seen.push(request);
      return new Response("ok");
    });
    const request = new Request("https://core/index.html", {
      headers: { [routerSecretHeader]: env.ROUTER_SECRET, accept: "text/html" },
    });
    const response = await worker.fetch(request, { ...env, ASSETS: assets });

    expect(response.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.headers.has(routerSecretHeader)).toBeFalsy();
    expect(seen[0]?.headers.get("accept")).toBe("text/html");
  });
});

describe("routing", () => {
  it("serves the frontend's files", async () => {
    const response = await routed("/");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    await expect(response.text()).resolves.toContain('<div id="root">');
  });

  it("serves the frontend for its own routes, as a single-page app", async () => {
    const response = await routed("/apps/some-app");
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain('<div id="root">');
  });

  it("answers unknown API routes with a 404 error, not the frontend", async () => {
    const paths = ["/api", "/api/", "/api/unknown"];
    const errors = await Promise.all(
      paths.map(async (path) => await errorOf(await routed(path)))
    );
    for (const error of errors) {
      expect(error).toStrictEqual({
        status: 404,
        code: "request.not_found",
        requestIdMatches: true,
      });
    }
  });

  it("gives every response its own request ID", async () => {
    const responses = await Promise.all([routed("/health"), routed("/health")]);
    const [first, second] = responses.map((response) =>
      response.headers.get(requestIdHeader)
    );
    expect(first).toBeTruthy();
    expect(first).not.toBe(second);
  });

  it("answers an unexpected failure with a 500 that leaks nothing", async () => {
    const assets = assetsThat(() => {
      throw new Error("Bucket grasp-internal unreachable at /srv/assets.ts:12");
    });
    const request = presenting("https://core/", env.ROUTER_SECRET);
    const response = await worker.fetch(request, { ...env, ASSETS: assets });

    const body = await response.clone().text();
    expect(body).not.toContain("grasp-internal");
    expect(body).not.toContain("assets.ts");
    await expect(errorOf(response)).resolves.toStrictEqual({
      status: 500,
      code: "internal.unexpected",
      requestIdMatches: true,
    });
  });
});
