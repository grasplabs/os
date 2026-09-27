/**
 * The console's own check of Cloudflare Access (threat model R19, CO1, CO5).
 * Access stands in front of the console, but the Worker trusts nothing it
 * hasn't verified itself: every request must carry an Access JWT signed by
 * the team's keys, for the console's application, or it is refused.
 */
import { loopbackHosts } from "@grasp-os/shared/router";
import { createRemoteJWKSet, jwtVerify } from "jose";

/** The staff member a request comes from, as Access vouches for them. */
export interface Staff {
  email: string;
  /** Access's stable id for the person; empty for the dev bypass. */
  sub: string;
}

/** What the gate reads from the console's env. */
export interface AccessEnv {
  /** The Access application's AUD tag. */
  CF_ACCESS_AUD?: string;
  /** The team's URL, i.e. `https://<team>.cloudflareaccess.com`. */
  CF_ACCESS_ISS?: string;
  /**
   * Local dev only: the staff member every request to this machine comes
   * from, without Access. Never set in a deployment; if it is, the console
   * refuses everything.
   */
  DEV_ACCESS_EMAIL?: string;
}

const assertionHeader = "cf-access-jwt-assertion";

/** Methods that change nothing, so a cross-site request can't abuse them. */
const safeMethods: ReadonlySet<string> = new Set(["GET", "HEAD"]);

/** One key set per team, so its keys are fetched once per isolate, not per request. */
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

const keySetFor = (issuer: string) => {
  let keySet = keySets.get(issuer);
  if (keySet === undefined) {
    keySet = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    keySets.set(issuer, keySet);
  }
  return keySet;
};

/**
 * The staff member a verified Access JWT names, or null when the request has
 * no JWT, the JWT doesn't verify (signature, `aud`, `iss`, expiry), or it
 * names no person (a service token has no email).
 */
const verifiedStaff = async (
  request: Request,
  env: AccessEnv
): Promise<Staff | null> => {
  const token = request.headers.get(assertionHeader) ?? "";
  const audience = env.CF_ACCESS_AUD ?? "";
  const issuer = env.CF_ACCESS_ISS ?? "";
  if (token === "" || audience === "" || issuer === "") {
    return null;
  }
  try {
    const { payload } = await jwtVerify(token, keySetFor(issuer), {
      issuer,
      audience,
    });
    if (typeof payload.email !== "string" || payload.email === "") {
      return null;
    }
    return { email: payload.email, sub: payload.sub ?? "" };
  } catch {
    return null;
  }
};

/**
 * A state-changing request must come from the console's own pages: CSRF
 * protection on top of Access's SameSite cookie. A missing `Origin` counts
 * as foreign; browsers send it on every non-GET request.
 */
const isForeignWrite = (request: Request): boolean =>
  !safeMethods.has(request.method) &&
  request.headers.get("origin") !== new URL(request.url).origin;

const forbidden = (): Response =>
  new Response("Forbidden", {
    status: 403,
    headers: { "cache-control": "no-store" },
  });

/**
 * Wraps the console's handler so it runs only for a verified staff member,
 * whom it's handed. Fails closed: without the Access settings every request
 * is refused.
 */
export const withAccess =
  (handler: (request: Request, staff: Staff) => Promise<Response>) =>
  async (request: Request, env: AccessEnv): Promise<Response> => {
    if (isForeignWrite(request)) {
      return forbidden();
    }
    const devEmail = env.DEV_ACCESS_EMAIL ?? "";
    if (devEmail !== "") {
      // The bypass holds only for requests addressed to this machine. A
      // deployment that has the variable is misconfigured: refuse everything
      // rather than guess which check was meant.
      if (!loopbackHosts.has(new URL(request.url).hostname)) {
        return forbidden();
      }
      return await handler(request, { email: devEmail, sub: "" });
    }
    const staff = await verifiedStaff(request, env);
    if (staff === null) {
      return forbidden();
    }
    return await handler(request, staff);
  };
