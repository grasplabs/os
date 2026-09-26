import type { OAuthProvider } from "@grasp-os/shared/connect";
import { z } from "zod";

// The OAuth providers people connect accounts from, as config records: one
// generic flow (src/oauth.ts) runs them all. Grasp owns one multi-tenant
// app per provider; its client ID and secret are Worker secrets on connect
// (threat model Q1), and a provider whose secrets are unset can't be
// connected.
//
// Every provider is pinned to the organization's own tenant, from the
// deployment's sign-in config: the flow asks the provider for that tenant
// only where the provider can do so, and the account in the ID token must
// be in it (threat model CN5). Accounts outside the organization can't be
// connected, personal ones included.

/** The client credentials of Grasp's app at a provider. */
export interface OAuthClientCredentials {
  id: string;
  secret: string;
}

/** The account a token is for, from its ID token. */
export interface ProviderAccount {
  /** Stable at the provider: an Entra object ID, a Google subject. */
  id: string;
  /** For people: an email address or user principal name. */
  name: string | null;
  /**
   * Its email address, as the provider vouches for it: Google's verified
   * email, or the address the organization's own tenant gives it.
   */
  email: string | null;
}

export interface ProviderConfig {
  id: OAuthProvider;
  /** The native connector that carries out the connection's actions. */
  server: string;
  /** Whether `tenant` is a tenant of this provider's kind. */
  isTenant: (tenant: string) => boolean;
  authorizationEndpoint: (tenant: string) => string;
  tokenEndpoint: (tenant: string) => string;
  /** RFC 7009 revocation; none where the provider has no such endpoint. */
  revocationEndpoint?: string;
  scopes: readonly string[];
  /** Parameters the authorization request adds to the standard ones. */
  authorizationParams: (tenant: string) => Record<string, string>;
  client: (env: Env) => OAuthClientCredentials | undefined;
  /**
   * The account subject the ID token's claims name, whatever else they
   * say: to tell whether a live connection holds the same grant before
   * revoking tokens that won't be kept.
   */
  subject: (claims: unknown) => string | undefined;
  /**
   * The account the ID token's claims name, if they come from this
   * provider for Grasp's app and the account is in `tenant`; `null`
   * otherwise.
   */
  account: (
    claims: unknown,
    tenant: string,
    clientId: string
  ) => ProviderAccount | null;
}

const credentials = (
  id: string | undefined,
  secret: string | undefined
): OAuthClientCredentials | undefined =>
  id === undefined || id === "" || secret === undefined || secret === ""
    ? undefined
    : { id, secret };

const guidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const domainPattern = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/u;

/** Just the subject of an ID token, however the rest of it looks. */
const oidOnly = z.object({ oid: z.string().min(1) });
const subOnly = z.object({ sub: z.string().min(1) });

const microsoftClaims = z.object({
  iss: z.string(),
  aud: z.string(),
  tid: z.string(),
  oid: z.string().min(1),
  /** Set for a B2B guest: the tenant that really signed them in. */
  idp: z.string().optional(),
  email: z.string().optional(),
  preferred_username: z.string().optional(),
});

const googleClaims = z.object({
  iss: z.string(),
  aud: z.string(),
  sub: z.string().min(1),
  hd: z.string().optional(),
  email: z.string().optional(),
  email_verified: z.boolean().optional(),
});

const googleIssuers = new Set([
  "https://accounts.google.com",
  "accounts.google.com",
]);

const microsoftLogin = "https://login.microsoftonline.com";

/**
 * Microsoft 365, through Entra ID's v2 endpoints for the organization's own
 * tenant, so the sign-in page offers only its accounts. Entra has no token
 * revocation endpoint: disconnecting deletes the tokens, and they lapse.
 */
const microsoft: ProviderConfig = {
  id: "microsoft",
  server: "microsoft-365",
  isTenant: (tenant) => guidPattern.test(tenant),
  authorizationEndpoint: (tenant) =>
    `${microsoftLogin}/${tenant}/oauth2/v2.0/authorize`,
  tokenEndpoint: (tenant) => `${microsoftLogin}/${tenant}/oauth2/v2.0/token`,
  // What the Microsoft 365 connector needs: mail (the person's own and
  // shared mailboxes), calendars, and files in OneDrive and SharePoint.
  scopes: [
    "openid",
    "profile",
    "email",
    "offline_access",
    "User.Read",
    "Mail.ReadWrite",
    "Mail.ReadWrite.Shared",
    "Mail.Send",
    "Mail.Send.Shared",
    "Calendars.Read",
    "Files.Read.All",
    "Sites.Read.All",
  ],
  authorizationParams: () => ({ response_mode: "query" }),
  client: (env) =>
    credentials(env.MICROSOFT_CLIENT_ID, env.MICROSOFT_CLIENT_SECRET),
  subject: (claims) => oidOnly.safeParse(claims).data?.oid,
  account: (claims, tenant, clientId) => {
    const parsed = microsoftClaims.safeParse(claims);
    if (!parsed.success) {
      return null;
    }
    const {
      iss,
      aud,
      tid,
      oid,
      idp,
      email,
      preferred_username: name,
    } = parsed.data;
    // A guest is homed in another tenant: not an account of the organization.
    const inTenant =
      tid.toLowerCase() === tenant &&
      iss.toLowerCase() === `${microsoftLogin}/${tenant}/v2.0` &&
      (idp === undefined || idp === iss) &&
      aud === clientId;
    return inTenant
      ? { id: oid, name: name ?? null, email: email ?? name ?? null }
      : null;
  },
};

/**
 * Google Workspace. Google can only hint at the domain (`hd`), so the ID
 * token's `hd` is what counts. `access_type=offline` with `prompt=consent`
 * is how Google gives a refresh token every time.
 */
const google: ProviderConfig = {
  id: "google",
  server: "google-workspace",
  isTenant: (tenant) => domainPattern.test(tenant),
  authorizationEndpoint: () => "https://accounts.google.com/o/oauth2/v2/auth",
  tokenEndpoint: () => "https://oauth2.googleapis.com/token",
  revocationEndpoint: "https://oauth2.googleapis.com/revoke",
  // What the Google Workspace connector needs: Gmail (read, label, send),
  // Calendar and Drive, read-only where it only reads.
  scopes: [
    "openid",
    "email",
    "profile",
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/drive.readonly",
  ],
  authorizationParams: (tenant) => ({
    access_type: "offline",
    prompt: "consent",
    hd: tenant,
  }),
  client: (env) => credentials(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET),
  subject: (claims) => subOnly.safeParse(claims).data?.sub,
  account: (claims, tenant, clientId) => {
    const parsed = googleClaims.safeParse(claims);
    if (!parsed.success) {
      return null;
    }
    const { iss, aud, sub, hd, email, email_verified: verified } = parsed.data;
    const inTenant =
      googleIssuers.has(iss) &&
      aud === clientId &&
      hd?.toLowerCase() === tenant &&
      verified === true;
    return inTenant
      ? { id: sub, name: email ?? null, email: email ?? null }
      : null;
  },
};

export const providers: Readonly<Record<OAuthProvider, ProviderConfig>> = {
  microsoft,
  google,
};
