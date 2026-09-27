/**
 * A stand-in for Microsoft Entra ID and Google: the outside systems sign-in
 * talks to. It answers their token and key endpoints: at their real URLs in
 * the workerd tests (idp.ts), and Entra's at a local address for local
 * development and the end-to-end tests (idp-worker.ts). A test plays the
 * person at the IdP with `authorize`, choosing the ID token's claims,
 * including ones a real IdP would never issue for this client (other
 * tenants, spoofed emails). No test runner imports here: it also runs as a
 * Worker of its own.
 */
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

/** Where Microsoft Entra ID answers, unless the IdP stands in elsewhere. */
export const microsoftOrigin = "https://login.microsoftonline.com";

/** Entra's endpoints under its origin, by tenant. */
const entraPath =
  /^\/(?<tenant>[^/]+)\/(?<endpoint>oauth2\/v2\.0\/(?:authorize|token)|discovery\/v2\.0\/keys)$/u;
const googleIssuer = "https://accounts.google.com";
const googleToken = "https://oauth2.googleapis.com/token";

const oauthError = (error: string): Response =>
  Response.json({ error }, { status: 400 });

/**
 * An IdP with Entra at `entraOrigin`, Microsoft's own unless it stands in
 * at a local address, and Google at Google's.
 */
export const createIdp = (entraOrigin = microsoftOrigin) => {
  const grants = new Map<string, Grant>();

  /** The tenant and endpoint of an Entra URL at this IdP's origin. */
  const entraEndpoint = (url: URL) =>
    url.origin === entraOrigin
      ? entraPath.exec(url.pathname)?.groups
      : undefined;

  /** The issuer a real IdP puts in tokens it issues through this endpoint. */
  const issuerOf = (url: URL): string | undefined => {
    const tenant = entraEndpoint(url)?.tenant;
    if (tenant !== undefined) {
      return `${entraOrigin}/${tenant}/v2.0`;
    }
    const endpoint = `${url.origin}${url.pathname}`;
    return endpoint === googleToken ||
      endpoint === `${googleIssuer}/o/oauth2/v2/auth`
      ? googleIssuer
      : undefined;
  };

  const isTokenEndpoint = (url: URL): boolean =>
    `${url.origin}${url.pathname}` === googleToken ||
    entraEndpoint(url)?.endpoint === "oauth2/v2.0/token";

  const isKeysEndpoint = (url: URL): boolean =>
    `${url.origin}${url.pathname}` ===
      "https://www.googleapis.com/oauth2/v3/certs" ||
    entraEndpoint(url)?.endpoint === "discovery/v2.0/keys";

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
      const { searchParams } = authorizationUrl;
      const issuer = issuerOf(authorizationUrl);
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
      const url = new URL(request.url);
      if (isKeysEndpoint(url)) {
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
      const issuer = issuerOf(url);
      if (
        issuer !== undefined &&
        isTokenEndpoint(url) &&
        request.method === "POST"
      ) {
        return await token(request, issuer);
      }
      throw new Error(`Unexpected outbound request to ${url.host}`);
    },
  };
};

export type Idp = ReturnType<typeof createIdp>;
