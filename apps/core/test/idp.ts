/**
 * A stand-in for Microsoft Entra ID and Google: the outside systems sign-in
 * talks to. It answers their token and key endpoints at their real URLs, so
 * core runs unchanged with the endpoints it would use in production. A test
 * plays the person at the IdP with `authorize`, choosing the ID token's
 * claims, including ones a real IdP would never issue for this client (other
 * tenants, spoofed emails).
 */
import { afterEach, beforeEach, vi } from "vite-plus/test";

import { entraClient, googleClient } from "./sign-in-config.ts";

export type Claims = Record<string, unknown>;

interface Grant {
  claims: Claims;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  issuer: string;
}

const encoder = new TextEncoder();

const base64url = (data: ArrayBuffer | string): string => {
  const bytes =
    typeof data === "string" ? encoder.encode(data) : new Uint8Array(data);
  return btoa(String.fromCodePoint(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
};

const keyId = "test-signing-key";
const generated = await crypto.subtle.generateKey(
  {
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  },
  true,
  ["sign", "verify"]
);
if (!("privateKey" in generated)) {
  throw new Error("Expected a key pair");
}
const keys = generated;
const publicJwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
if (publicJwk instanceof ArrayBuffer) {
  throw new TypeError("Expected a JSON Web Key");
}

const signIdToken = async (claims: Claims): Promise<string> => {
  const header = base64url(
    JSON.stringify({ alg: "RS256", typ: "JWT", kid: keyId })
  );
  const payload = base64url(JSON.stringify(claims));
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    keys.privateKey,
    encoder.encode(`${header}.${payload}`)
  );
  return `${header}.${payload}.${base64url(signature)}`;
};

const secrets = new Map([
  [entraClient.id, entraClient.secret],
  [googleClient.id, googleClient.secret],
]);

const microsoftEndpoint =
  /^https:\/\/login\.microsoftonline\.com\/(?<tenant>[^/]+)\/(?<endpoint>oauth2\/v2\.0\/(?:authorize|token)|discovery\/v2\.0\/keys)$/u;
const googleIssuer = "https://accounts.google.com";
const googleToken = "https://oauth2.googleapis.com/token";

/** The issuer a real IdP puts in tokens it issues through this endpoint. */
const issuerOf = (endpoint: string): string | undefined => {
  const tenant = microsoftEndpoint.exec(endpoint)?.groups?.tenant;
  if (tenant !== undefined) {
    return `https://login.microsoftonline.com/${tenant}/v2.0`;
  }
  return endpoint === googleToken ||
    endpoint === `${googleIssuer}/o/oauth2/v2/auth`
    ? googleIssuer
    : undefined;
};

const isTokenEndpoint = (url: string): boolean =>
  url === googleToken ||
  microsoftEndpoint.exec(url)?.groups?.endpoint === "oauth2/v2.0/token";

const isKeysEndpoint = (url: string): boolean =>
  url === "https://www.googleapis.com/oauth2/v3/certs" ||
  microsoftEndpoint.exec(url)?.groups?.endpoint === "discovery/v2.0/keys";

const oauthError = (error: string): Response =>
  Response.json({ error }, { status: 400 });

const createIdp = () => {
  const grants = new Map<string, Grant>();

  const token = async (request: Request, issuer: string) => {
    const form = await request.formData();
    const field = (name: string): string => {
      const value = form.get(name);
      return typeof value === "string" ? value : "";
    };
    const code = field("code");
    const grant = grants.get(code);
    // Codes are single use, as at a real IdP.
    grants.delete(code);
    const challenge = base64url(
      await crypto.subtle.digest(
        "SHA-256",
        encoder.encode(field("code_verifier"))
      )
    );
    if (
      !grant ||
      grant.issuer !== issuer ||
      field("grant_type") !== "authorization_code" ||
      field("client_id") !== grant.clientId ||
      field("client_secret") !== secrets.get(grant.clientId) ||
      field("redirect_uri") !== grant.redirectUri ||
      challenge !== grant.codeChallenge
    ) {
      return oauthError("invalid_grant");
    }
    const now = Math.floor(Date.now() / 1000);
    const idToken = await signIdToken({
      iss: issuer,
      aud: grant.clientId,
      iat: now,
      nbf: now,
      exp: now + 3600,
      ...grant.claims,
    });
    return Response.json({
      access_token: "idp-access-token",
      token_type: "Bearer",
      expires_in: 3600,
      id_token: idToken,
    });
  };

  return {
    /**
     * The person signs in at the IdP, which redirects them back to core with
     * a code for an ID token with `claims` (on top of `iss`, `aud` and the
     * times, which `claims` can override). Returns that redirect.
     */
    authorize: (authorizationUrl: URL, claims: Claims): URL => {
      const { origin, pathname, searchParams } = authorizationUrl;
      const issuer = issuerOf(`${origin}${pathname}`);
      const redirectUri = searchParams.get("redirect_uri");
      if (issuer === undefined || redirectUri === null) {
        throw new Error(
          `Not an authorization request: ${authorizationUrl.href}`
        );
      }
      const code = crypto.randomUUID();
      grants.set(code, {
        claims,
        issuer,
        redirectUri,
        clientId: searchParams.get("client_id") ?? "",
        codeChallenge: searchParams.get("code_challenge") ?? "",
      });
      const callback = new URL(redirectUri);
      callback.searchParams.set("code", code);
      callback.searchParams.set("state", searchParams.get("state") ?? "");
      return callback;
    },

    /** Answers core's calls to the IdPs; anything else is a test failure. */
    fetch: async (
      input: RequestInfo | URL,
      init?: RequestInit
    ): Promise<Response> => {
      const request = new Request(input, init);
      const { origin, pathname, host } = new URL(request.url);
      const endpoint = `${origin}${pathname}`;
      if (isKeysEndpoint(endpoint)) {
        return Response.json({
          keys: [
            {
              kty: publicJwk.kty,
              n: publicJwk.n,
              e: publicJwk.e,
              kid: keyId,
              alg: "RS256",
              use: "sig",
            },
          ],
        });
      }
      const issuer = issuerOf(endpoint);
      if (
        issuer !== undefined &&
        isTokenEndpoint(endpoint) &&
        request.method === "POST"
      ) {
        return await token(request, issuer);
      }
      throw new Error(`Unexpected outbound request to ${host}`);
    },
  };
};

export type Idp = ReturnType<typeof createIdp>;

/** An IdP that answers core's outbound calls, for each test in the file. */
export const mockIdp = (): Idp => {
  const idp = createIdp();
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockImplementation(idp.fetch);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  return idp;
};
