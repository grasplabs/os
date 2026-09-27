import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import worker from "../src/server.ts";
import { accessTeam } from "./access-config.ts";
import { accessJwt, mockAccess } from "./access.ts";

mockAccess();

const origin = "https://console.grasp.test";
const staffEmail = "staff@grasp.test";

/** A request to the console carrying `jwt` as Access would, and `init`. */
const asStaff = (path: string, jwt: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers);
  headers.set("cf-access-jwt-assertion", jwt);
  return new Request(`${origin}${path}`, { ...init, headers });
};

/** The status the console answers `request` with, on an env with `changes`. */
const statusOf = async (request: Request, changes: Partial<Env> = {}) => {
  const response = await worker.fetch(request, { ...env, ...changes });
  return response.status;
};

describe("the Access JWT", () => {
  it("lets a staff member with a valid JWT in", async () => {
    const response = await exports.default.fetch(
      asStaff("/", await accessJwt(staffEmail))
    );
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain("Clients");
  });

  it("refuses every path without one, server functions and unknown pages included", async () => {
    const paths = ["/", "/_serverFn/anything", "/clients/unknown"];
    const statuses = await Promise.all(
      paths.map(async (path) => {
        const response = await exports.default.fetch(`${origin}${path}`);
        return response.status;
      })
    );
    expect(statuses).toStrictEqual(paths.map(() => 403));
  });

  it("refuses a JWT Access didn't issue for the console", async () => {
    const forged = await Promise.all([
      accessJwt(staffEmail, { stranger: true }),
      accessJwt(staffEmail, { claims: { aud: ["another-access-app"] } }),
      accessJwt(staffEmail, {
        claims: { iss: "https://attacker.cloudflareaccess.com" },
      }),
      accessJwt(staffEmail, { expiresIn: -60 }),
    ]);
    const statuses = await Promise.all(
      forged.map(async (jwt) => await statusOf(asStaff("/", jwt)))
    );
    expect(statuses).toStrictEqual([403, 403, 403, 403]);
  });

  it("refuses a JWT whose claims were changed after signing", async () => {
    const jwt = await accessJwt(staffEmail);
    const [header, , signature] = jwt.split(".");
    const payload = btoa(
      JSON.stringify({
        email: "admin@grasp.test",
        iss: accessTeam.issuer,
        aud: [accessTeam.audience],
        exp: Math.floor(Date.now() / 1000) + 3600,
      })
    ).replaceAll("=", "");
    const unsigned = `${btoa(JSON.stringify({ alg: "none" })).replaceAll("=", "")}.${payload}.`;
    const statuses = await Promise.all([
      statusOf(asStaff("/", `${header}.${payload}.${signature}`)),
      statusOf(asStaff("/", unsigned)),
    ]);
    expect(statuses).toStrictEqual([403, 403]);
  });

  it("refuses a JWT that names no person, such as a service token's", async () => {
    const jwt = await accessJwt(staffEmail, {
      claims: { email: undefined, common_name: "ci.access" },
    });
    await expect(statusOf(asStaff("/", jwt))).resolves.toBe(403);
  });

  it("refuses everything while Access isn't configured", async () => {
    const jwt = await accessJwt(staffEmail);
    const statuses = await Promise.all([
      statusOf(asStaff("/", jwt), { CF_ACCESS_AUD: undefined }),
      statusOf(asStaff("/", jwt), { CF_ACCESS_ISS: "" }),
    ]);
    expect(statuses).toStrictEqual([403, 403]);
  });
});

describe("the local dev bypass", () => {
  const dev = { DEV_ACCESS_EMAIL: "dev@grasp.test" };

  it("lets requests to this machine in without a JWT", async () => {
    const statuses = await Promise.all(
      [
        "http://localhost:3000/",
        "http://127.0.0.1:3000/",
        "http://[::1]:3000/",
      ].map(async (url) => await statusOf(new Request(url), dev))
    );
    expect(statuses).toStrictEqual([200, 200, 200]);
  });

  it("refuses everything anywhere else, even with a valid JWT", async () => {
    const jwt = await accessJwt(staffEmail);
    const statuses = await Promise.all([
      statusOf(new Request(`${origin}/`), dev),
      statusOf(asStaff("/", jwt), dev),
      statusOf(new Request("http://localhost.attacker.test/"), dev),
    ]);
    expect(statuses).toStrictEqual([403, 403, 403]);
  });
});

describe("cross-site requests", () => {
  it("refuses a state change from another origin, or none", async () => {
    const jwt = await accessJwt(staffEmail);
    const statuses = await Promise.all([
      statusOf(
        asStaff("/_serverFn/anything", jwt, {
          method: "POST",
          headers: { origin: "https://attacker.test" },
        })
      ),
      statusOf(asStaff("/_serverFn/anything", jwt, { method: "POST" })),
      statusOf(
        asStaff("/_serverFn/anything", jwt, {
          method: "DELETE",
          headers: { origin: "http://console.grasp.test" },
        })
      ),
    ]);
    expect(statuses).toStrictEqual([403, 403, 403]);
  });

  it("lets the console's own pages change state", async () => {
    const jwt = await accessJwt(staffEmail);
    const response = await worker.fetch(
      asStaff("/", jwt, { method: "POST", headers: { origin } }),
      env
    );
    expect(response.status).toBe(200);
  });

  it("lets a link from another site open a page", async () => {
    const jwt = await accessJwt(staffEmail);
    const response = await worker.fetch(
      asStaff("/", jwt, { headers: { origin: "https://elsewhere.test" } }),
      env
    );
    expect(response.status).toBe(200);
  });
});
