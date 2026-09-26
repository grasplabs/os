/**
 * Stand-ins for the OAuth providers connect talks to: Entra ID and Google's
 * token and revocation endpoints, answering connect's own outbound
 * requests. They check PKCE as the real ones do (a code only redeems with
 * the verifier whose challenge the authorization carried) and issue tokens
 * with an ID token for the account the test chose. Tests read back every
 * request, and choose how refreshes and revocations fare.
 */
import { toBase64Url } from "@grasp-os/shared/encoding";
import { afterEach, beforeEach, vi } from "vite-plus/test";

export const acmeTenant = "11111111-1111-4111-8111-111111111111";
export const otherTenant = "33333333-3333-4333-8333-333333333333";
export const acmeDomain = "acme.test";

/** Grasp's apps at the providers, as set on connect in vite.config.ts. */
export const clients = {
  microsoft: { id: "grasp-connect-entra", secret: "entra-connect-secret" },
  google: { id: "grasp-connect-google", secret: "google-connect-secret" },
} as const;

export type ProviderName = keyof typeof clients;

/** The account a code is for, as its ID token will say. */
export interface Account {
  provider: ProviderName;
  /** Microsoft: the tenant ID. Google: the Workspace domain, if any. */
  tenant?: string;
  subject: string;
  email: string;
  /** Google only. */
  emailVerified?: boolean;
  /** Who the ID token is for; Grasp's app unless a test says otherwise. */
  audience?: string;
  /** Microsoft only: a B2B guest, signed in by this other identity provider. */
  guestFrom?: string;
}

/** One request connect sent to a provider. */
export interface ProviderRequest {
  url: string;
  form: URLSearchParams;
}

/** How a refresh or revocation fares: an answer, or a promise of one. */
export type Answer = () => Response | Promise<Response>;

interface ProviderState {
  requests: ProviderRequest[];
  /** Every token issued, access and refresh, so tests can look for them. */
  issued: string[];
  codes: Map<string, { challenge: string; account: Account }>;
  /** Runs before a refresh is answered; a failure is sent instead. */
  refresh: Answer | undefined;
  revoke: Answer | undefined;
  /**
   * Whether a refresh sends a new refresh token back: by default Entra
   * does and Google doesn't.
   */
  rotate: boolean | undefined;
  /** Refresh token → the account it was issued for. */
  grants: Map<string, Account>;
  /** Every token issued (access and refresh) → its account. */
  holders: Map<string, Account>;
}

const sameGrant = (a: Account, b: Account): boolean =>
  a.provider === b.provider && a.subject === b.subject;

const unsignedJwt = (claims: Record<string, unknown>): string =>
  [
    toBase64Url(new TextEncoder().encode(JSON.stringify({ alg: "RS256" }))),
    toBase64Url(new TextEncoder().encode(JSON.stringify(claims))),
    "signature",
  ].join(".");

const idTokenFor = (account: Account): string => {
  const audience = account.audience ?? clients[account.provider].id;
  if (account.provider === "microsoft") {
    const tenant = account.tenant ?? acmeTenant;
    return unsignedJwt({
      iss: `https://login.microsoftonline.com/${tenant}/v2.0`,
      aud: audience,
      tid: tenant,
      oid: account.subject,
      preferred_username: account.email,
      idp: account.guestFrom,
    });
  }
  return unsignedJwt({
    iss: "https://accounts.google.com",
    aud: audience,
    sub: account.subject,
    hd: account.tenant,
    email: account.email,
    email_verified: account.emailVerified ?? true,
  });
};

const s256 = async (verifier: string): Promise<string> =>
  toBase64Url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
    )
  );

const oauthError = (error: string, status = 400): Response =>
  Response.json({ error, error_description: "Refused" }, { status });

const isProviderUrl = (url: URL): boolean =>
  url.host === "login.microsoftonline.com" ||
  url.host === "oauth2.googleapis.com";

/**
 * The providers, for each test in the file. `authorize(url, account)`
 * plays the person consenting at the provider: it returns the code the
 * provider would send back, bound to that authorization's PKCE challenge.
 */
export const fakeProviders = () => {
  const state: ProviderState = {
    requests: [],
    issued: [],
    codes: new Map(),
    refresh: undefined,
    revoke: undefined,
    rotate: undefined,
    grants: new Map(),
    holders: new Map(),
  };
  let counter = 0;
  const issue = (prefix: string): string => {
    counter += 1;
    const token = `${prefix}-${counter}-${crypto.randomUUID()}`;
    state.issued.push(token);
    return token;
  };
  /** Issues an access token, then (last) a refresh token when asked. */
  const tokens = (account: Account, withRefresh: boolean): Response => {
    const accessToken = issue("access");
    const refreshToken = withRefresh ? issue("refresh") : undefined;
    state.holders.set(accessToken, account);
    if (refreshToken !== undefined) {
      state.grants.set(refreshToken, account);
      state.holders.set(refreshToken, account);
    }
    return Response.json({
      token_type: "Bearer",
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: 3600,
      id_token: idTokenFor(account),
    });
  };

  const tokenEndpoint = async (form: URLSearchParams): Promise<Response> => {
    const provider: ProviderName =
      form.get("client_id") === clients.google.id ? "google" : "microsoft";
    if (form.get("client_secret") !== clients[provider].secret) {
      return oauthError("invalid_client", 401);
    }
    if (form.get("grant_type") === "authorization_code") {
      const code = form.get("code") ?? "";
      const issuedFor = state.codes.get(code);
      state.codes.delete(code);
      const verifier = form.get("code_verifier") ?? "";
      if (
        issuedFor === undefined ||
        (await s256(verifier)) !== issuedFor.challenge
      ) {
        return oauthError("invalid_grant");
      }
      return tokens(issuedFor.account, true);
    }
    if (form.get("grant_type") === "refresh_token") {
      const account = state.grants.get(form.get("refresh_token") ?? "");
      if (account === undefined) {
        return oauthError("invalid_grant");
      }
      if (state.refresh !== undefined) {
        const answer = await state.refresh();
        if (!answer.ok) {
          return answer;
        }
      }
      return tokens(account, state.rotate ?? account.provider === "microsoft");
    }
    return oauthError("unsupported_grant_type");
  };

  const answer = async (url: URL, form: URLSearchParams): Promise<Response> => {
    if (url.pathname.endsWith("/token")) {
      return await tokenEndpoint(form);
    }
    if (url.href === "https://oauth2.googleapis.com/revoke") {
      if (state.revoke !== undefined) {
        return await state.revoke();
      }
      // Google revokes the whole grant of the account and client, whichever
      // of its tokens is revoked.
      const holder = state.holders.get(form.get("token") ?? "");
      for (const [token, account] of state.grants) {
        if (holder !== undefined && sameGrant(account, holder)) {
          state.grants.delete(token);
        }
      }
      return new Response(null, { status: 200 });
    }
    return new Response("Not found", { status: 404 });
  };

  beforeEach(() => {
    state.requests.length = 0;
    state.issued.length = 0;
    state.codes.clear();
    state.grants.clear();
    state.holders.clear();
    state.refresh = undefined;
    state.revoke = undefined;
    state.rotate = undefined;
    const passThrough = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (!isProviderUrl(url)) {
        return await passThrough(input, init);
      }
      const body = await request.arrayBuffer();
      const form = new URLSearchParams(new TextDecoder().decode(body));
      state.requests.push({ url: url.href, form });
      return await answer(url, form);
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  return {
    state,
    /** The code the provider sends back after `account` consents at `url`. */
    authorize: (authorizationUrl: string, account: Account): string => {
      const url = new URL(authorizationUrl);
      const code = `code-${crypto.randomUUID()}`;
      state.codes.set(code, {
        challenge: url.searchParams.get("code_challenge") ?? "",
        account,
      });
      return code;
    },
    /** The token requests connect sent, by grant type. */
    tokenRequests: (grantType: string): ProviderRequest[] =>
      state.requests.filter(({ form }) => form.get("grant_type") === grantType),
    revocations: (): ProviderRequest[] =>
      state.requests.filter(({ url }) => url.endsWith("/revoke")),
    /** Whether the account's grant still holds at the provider. */
    grantHolds: (account: Account): boolean =>
      [...state.grants.values()].some((held) => sameGrant(held, account)),
    oauthError,
  };
};
