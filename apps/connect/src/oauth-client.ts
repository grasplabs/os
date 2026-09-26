import { fromBase64Url } from "@grasp-os/shared/encoding";

import type { OAuthClientCredentials, ProviderConfig } from "./providers.ts";

// Talks to a provider's token and revocation endpoints. Every request
// refuses redirects (a followed 307 would post the client secret and the
// code somewhere else), times out, and reads at most a small answer. Errors
// carry the HTTP status and the provider's OAuth error code, never its
// description or anything it sent back: those can echo tokens, and errors
// end up in logs.

const timeoutMs = 10_000;
const maxResponseBytes = 64 * 1024;
/** Access tokens without an `expires_in` are taken to last an hour. */
const defaultLifetimeSeconds = 3600;
/** RFC 6749 §5.2: `error` is printable ASCII without `"` and `\`. */
const oauthErrorPattern = /^[\u0020\u0021\u0023-\u005B\u005D-\u007E]{1,64}$/u;

/** A token or revocation endpoint turned a request down, or answered badly. */
export class OAuthResponseError extends Error {
  readonly httpStatus: number;
  readonly oauthError: string | undefined;

  constructor(httpStatus: number, oauthError?: string) {
    const code =
      oauthError !== undefined && oauthErrorPattern.test(oauthError)
        ? oauthError
        : undefined;
    super(
      `The provider refused the OAuth request (HTTP ${httpStatus}${code === undefined ? "" : `, ${code}`})`
    );
    this.name = "OAuthResponseError";
    this.httpStatus = httpStatus;
    this.oauthError = code;
  }
}

/**
 * Whether a refresh failed because the grant is gone for good (revoked,
 * expired, the password changed): only then is a connection dead. A 5xx, a
 * 429, a WAF page or a network error never is (threat model CN12).
 */
export const isInvalidGrant = (error: unknown): boolean =>
  error instanceof OAuthResponseError &&
  error.oauthError === "invalid_grant" &&
  error.httpStatus < 500 &&
  error.httpStatus !== 429;

/** What a token endpoint gave. */
export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds, counted from before the request. */
  expiresAt: number;
  idToken?: string;
}

/** The first `maxResponseBytes` of the body; more than that is refused. */
const readCapped = async (response: Response): Promise<string> => {
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let size = 0;
  try {
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- a stream is read in order
      const chunk = await reader?.read();
      if (chunk === undefined || chunk.done) {
        break;
      }
      const bytes: unknown = chunk.value;
      if (!(bytes instanceof Uint8Array)) {
        throw new OAuthResponseError(response.status);
      }
      size += bytes.byteLength;
      if (size > maxResponseBytes) {
        throw new OAuthResponseError(response.status);
      }
      parts.push(decoder.decode(bytes, { stream: true }));
    }
  } finally {
    await reader?.cancel();
  }
  parts.push(decoder.decode());
  return parts.join("");
};

const jsonObject = (text: string): Record<string, unknown> => {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return Object.fromEntries(Object.entries(value));
    }
  } catch {
    // Not JSON: an error page, or nothing.
  }
  return {};
};

/** Posts a form with the client's credentials; the JSON answer. */
const post = async (
  url: string,
  client: OAuthClientCredentials,
  fields: Record<string, string>
): Promise<Record<string, unknown>> => {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      ...fields,
      client_id: client.id,
      client_secret: client.secret,
    }),
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new OAuthResponseError(response.status);
  }
  const body = jsonObject(await readCapped(response));
  const error = typeof body.error === "string" ? body.error : undefined;
  if (!response.ok || error !== undefined) {
    throw new OAuthResponseError(response.status, error);
  }
  return body;
};

const lifetimeSeconds = (value: unknown): number => {
  const seconds = typeof value === "string" ? Number(value) : value;
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0
    ? seconds
    : defaultLifetimeSeconds;
};

const tokenSet = (
  body: Record<string, unknown>,
  requestedAt: number
): TokenSet => {
  const {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: expiresIn,
    id_token: idToken,
  } = body;
  if (typeof accessToken !== "string" || accessToken === "") {
    throw new OAuthResponseError(200);
  }
  return {
    accessToken,
    refreshToken:
      typeof refreshToken === "string" && refreshToken !== ""
        ? refreshToken
        : undefined,
    expiresAt: requestedAt + lifetimeSeconds(expiresIn) * 1000,
    idToken: typeof idToken === "string" ? idToken : undefined,
  };
};

/** Redeems an authorization code, with the flow's PKCE verifier. */
export const exchangeCode = async (
  provider: ProviderConfig,
  client: OAuthClientCredentials,
  tenant: string,
  {
    code,
    redirectUri,
    verifier,
  }: { code: string; redirectUri: string; verifier: string }
): Promise<TokenSet> => {
  const requestedAt = Date.now();
  return tokenSet(
    await post(provider.tokenEndpoint(tenant), client, {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
    requestedAt
  );
};

/** Redeems a refresh token. A provider that doesn't rotate sends none back. */
export const refreshTokens = async (
  provider: ProviderConfig,
  client: OAuthClientCredentials,
  tenant: string,
  refreshToken: string
): Promise<TokenSet> => {
  const requestedAt = Date.now();
  return tokenSet(
    await post(provider.tokenEndpoint(tenant), client, {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
    requestedAt
  );
};

/**
 * Revokes a token at the provider (RFC 7009). `false` when the provider has
 * no revocation endpoint. A token the provider no longer knows counts as
 * revoked.
 */
export const revokeToken = async (
  provider: ProviderConfig,
  client: OAuthClientCredentials,
  token: string
): Promise<boolean> => {
  if (provider.revocationEndpoint === undefined) {
    return false;
  }
  try {
    await post(provider.revocationEndpoint, client, { token });
  } catch (error) {
    if (
      error instanceof OAuthResponseError &&
      error.oauthError === "invalid_token"
    ) {
      return true;
    }
    throw error;
  }
  return true;
};

const jwtPattern =
  /^[A-Za-z0-9_-]+\.(?<payload>[A-Za-z0-9_-]+)\.[A-Za-z0-9_-]*$/u;

/**
 * The claims of an ID token from the token endpoint, unverified. That is
 * enough here: it came straight from the provider over TLS, in answer to
 * connect's own request with its client secret (OpenID Connect Core
 * §3.1.3.7), never from the browser. `undefined` when it isn't a JWT.
 */
export const idTokenClaims = (idToken: string | undefined): unknown => {
  const payload =
    idToken === undefined
      ? undefined
      : jwtPattern.exec(idToken)?.groups?.payload;
  if (payload === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
        fromBase64Url(payload)
      )
    );
  } catch {
    return undefined;
  }
};
