import { routerSecretHeader } from "@grasp-os/shared/router";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import worker from "../src/index.ts";

/** A request as the router sends it: over https, with the secret. */
const routed = async (path: string) =>
  await exports.default.fetch(`https://core${path}`, {
    headers: { [routerSecretHeader]: env.ROUTER_SECRET },
  });

const whitespace = /\s+/u;

/**
 * The directives of a response's Content Security Policy, by name. As in
 * browsers, the first of a repeated directive counts.
 */
const policyOf = (response: Response): Map<string, string[]> => {
  const header = response.headers.get("content-security-policy") ?? "";
  const directives = new Map<string, string[]>();
  for (const directive of header.split(";")) {
    const [name = "", ...sources] = directive.trim().split(whitespace);
    const key = name.toLowerCase();
    if (key !== "" && !directives.has(key)) {
      directives.set(key, sources);
    }
  }
  return directives;
};

/** The frontend's HTML: the start page, a client-side route, the file. */
const pages = ["/", "/apps/some-app", "/index.html"];

const eachPage = async () =>
  await Promise.all(pages.map(async (path) => await routed(path)));

describe("security headers on the frontend", () => {
  it("serves the frontend's HTML under a policy", async () => {
    for (const response of await eachPage()) {
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(response.headers.has("content-security-policy")).toBeTruthy();
    }
  });

  it("can't be framed, by another origin or its own", async () => {
    for (const response of await eachPage()) {
      expect(policyOf(response).get("frame-ancestors")).toStrictEqual([
        "'none'",
      ]);
    }
  });

  it("runs only its own script files: no inline script, eval or other origin", async () => {
    for (const response of await eachPage()) {
      const policy = policyOf(response);
      expect(policy.get("default-src")).toStrictEqual(["'self'"]);
      expect(policy.get("script-src")).toStrictEqual(["'self'"]);
      // Would otherwise loosen what script-src allows, per kind of script.
      expect(policy.has("script-src-elem")).toBeFalsy();
      expect(policy.has("script-src-attr")).toBeFalsy();
    }
  });

  it("connects, loads and submits only to its own origin", async () => {
    for (const response of await eachPage()) {
      const policy = policyOf(response);
      expect(policy.get("connect-src")).toStrictEqual(["'self'"]);
      expect(policy.get("form-action")).toStrictEqual(["'self'"]);
      expect(policy.get("style-src")).toStrictEqual(["'self'"]);
      expect(policy.get("img-src")).toStrictEqual(["'self'", "data:"]);
    }
  });

  it("allows no plugins and no <base> that re-points relative URLs", async () => {
    for (const response of await eachPage()) {
      const policy = policyOf(response);
      expect(policy.get("object-src")).toStrictEqual(["'none'"]);
      expect(policy.get("base-uri")).toStrictEqual(["'none'"]);
    }
  });

  it("stops content sniffing and cross-origin referrers with paths", async () => {
    for (const response of await eachPage()) {
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("referrer-policy")).toBe(
        "strict-origin-when-cross-origin"
      );
    }
  });

  it("tells browsers to use https only, for at least a year", async () => {
    const response = await routed("/");
    const hsts = response.headers.get("strict-transport-security") ?? "";
    const maxAge = Number(
      /max-age=(?<seconds>\d+)/u.exec(hsts)?.groups?.seconds
    );
    const oneYear = 365 * 24 * 60 * 60;
    expect(maxAge).toBeGreaterThanOrEqual(oneYear);
  });

  it("sends no HSTS over plain http, where browsers ignore it", async () => {
    const local = { ...env, ROUTER_SECRET: "", DEV_SKIP_ROUTER_SECRET: "true" };
    const response = await worker.fetch(
      new Request("http://localhost:8787/"),
      local
    );
    expect(response.status).toBe(200);
    expect(response.headers.has("strict-transport-security")).toBeFalsy();
    expect(policyOf(response).get("frame-ancestors")).toStrictEqual(["'none'"]);
  });

  it("keeps API responses what they are, and never sniffed", async () => {
    const response = await routed("/api/unknown");
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    await expect(response.json()).resolves.toMatchObject({
      code: "request.not_found",
    });
  });
});

// The document App screens run in: code nobody reviewed line by line, which
// must reach nothing but the page that frames it.
describe("security headers on the screen frame", () => {
  it("frames screens only from the product's own origin", async () => {
    for (const response of await eachPage()) {
      expect(policyOf(response).get("frame-src")).toStrictEqual(["'self'"]);
    }
  });

  it("is an opaque sandbox, framed only by the product page, that runs only inline and data: code and reaches nothing", async () => {
    const policy = policyOf(await routed("/screen-frame"));
    expect(Object.fromEntries(policy)).toStrictEqual({
      sandbox: ["allow-scripts"],
      "default-src": ["'none'"],
      "script-src": ["data:", "'unsafe-inline'"],
      "style-src": ["data:", "'unsafe-inline'"],
      "img-src": ["data:"],
      "font-src": ["data:"],
      "connect-src": ["'none'"],
      "worker-src": ["'none'"],
      "frame-src": ["'none'"],
      "form-action": ["'none'"],
      "base-uri": ["'none'"],
      "frame-ancestors": ["'self'"],
    });
  });

  it("gives its policy to its own address only", async () => {
    const others = await Promise.all(
      ["/screen-frame/", "/screen-frame.html", "/x/screen-frame"].map(
        async (path) => policyOf(await routed(path)).get("script-src")
      )
    );
    expect(others).toStrictEqual(others.map(() => ["'self'"]));
  });
});
