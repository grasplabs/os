import { roleSchema } from "@grasp-os/shared";
import { z } from "zod";

import { jsonVar } from "../json-var.ts";

/**
 * How people sign in to this deployment. Deployment config, set by the
 * console as the `SIGN_IN` var, never an in-product setting: a compromised
 * admin session can't add a tenant, widen the domains or open staff access.
 * Without it nobody can sign in.
 */
const domainSchema = z
  .string()
  .regex(/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/u, "a lowercase domain, e.g. acme.com");

const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** An HTTPS origin, or plain HTTP on this machine for local development. */
const isOrigin = (value: string): boolean => {
  if (!URL.canParse(value)) {
    return false;
  }
  const url = new URL(value);
  const secure =
    url.protocol === "https:" ||
    (url.protocol === "http:" && loopbackHosts.has(url.hostname));
  return secure && url.origin === value;
};

const signInConfigSchema = z.object({
  /**
   * The deployment's own address, e.g. `https://acme.<domain>`: where the
   * IdPs send people back, and the only page that may open `/rpc`.
   */
  origin: z.url().refine(isOrigin, "an https origin, without a path"),
  /** Email domains people may sign in with, exactly (no subdomains). */
  domains: z.array(domainSchema).min(1),
  /** Emails that get the admin role when they join. */
  admins: z.array(z.email().toLowerCase()).default([]),
  /*
   * A deployment may offer both IdPs, but a person is one account at one of
   * them: an email already signed in through one is refused through the
   * other, as accounts are never linked by email (threat model R15).
   */
  /** The client's Microsoft Entra tenant, pinned. */
  entra: z
    .object({ tenantId: z.guid(), clientId: z.string().min(1) })
    .optional(),
  /** The client's Google Workspace, pinned by its primary domain (`hd`). */
  google: z
    .object({ hostedDomain: domainSchema, clientId: z.string().min(1) })
    .optional(),
  /**
   * Grasp staff access, off unless the console opens a window. Only the
   * listed people (Entra object ids in Grasp's own tenant) sign in, get
   * `role` without joining the organization, and lose access when `until`
   * passes.
   */
  staff: z
    .object({
      tenantId: z.guid(),
      clientId: z.string().min(1),
      domains: z.array(domainSchema).min(1),
      oids: z.array(z.guid()).min(1),
      role: roleSchema,
      /** When the console opened the window. */
      opened: z.iso.datetime({ offset: true }),
      until: z.iso.datetime({ offset: true }),
    })
    .optional(),
});
export type SignInConfig = z.infer<typeof signInConfigSchema>;

/** Settings core reads that aren't in wrangler.jsonc for every deployment. */
export type AuthEnv = Env & {
  SIGN_IN?: unknown;
  ENTRA_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_SECRET?: string;
};

/**
 * The deployment's sign-in config, or `undefined` when none is set. A config
 * that doesn't parse counts as none: sign-in fails closed.
 */
export const signInConfig = (env: AuthEnv): SignInConfig | undefined => {
  const parsed = signInConfigSchema.safeParse(jsonVar(env.SIGN_IN));
  return parsed.success ? parsed.data : undefined;
};

/** The longest a staff window may be. */
const staffWindowMaxMs = 7 * 24 * 60 * 60 * 1000;

/**
 * Whether the staff window is open at `now`: between `opened` and `until`,
 * and seven days long at most. A longer window counts as closed for its
 * whole length, never only once its end draws near: the console opens short
 * windows, and a longer one is a mistake rather than a reason to let staff
 * in.
 */
export const staffWindowOpen = (
  config: SignInConfig | undefined,
  now: number
): boolean => {
  if (config?.staff === undefined) {
    return false;
  }
  const opened = Date.parse(config.staff.opened);
  const until = Date.parse(config.staff.until);
  return opened <= now && now < until && until - opened <= staffWindowMaxMs;
};

const isSet = (secret: string | undefined): secret is string =>
  secret !== undefined && secret !== "";

/** The IdPs people can sign in with. The ids are also callback path segments. */
export const providerIds = {
  entra: "microsoft",
  google: "google",
  staff: "grasp-staff",
} as const;
export type ProviderId = (typeof providerIds)[keyof typeof providerIds];

/**
 * One OIDC provider as the SSO plugin takes it. Endpoints are fixed rather
 * than discovered: no discovery fetch at sign-in, and no UserInfo call, so
 * the claims checked are always those of the verified ID token.
 */
export interface OidcProvider {
  providerId: ProviderId;
  /** Shown on the sign-in button. */
  label: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksEndpoint: string;
}

const entraProvider = (
  providerId: ProviderId,
  label: string,
  tenantId: string,
  clientId: string,
  clientSecret: string
): OidcProvider => {
  // The tenant's own issuer, not `common`: ID tokens from any other tenant
  // carry another `iss` and fail verification.
  const base = `https://login.microsoftonline.com/${tenantId}`;
  return {
    providerId,
    label,
    issuer: `${base}/v2.0`,
    clientId,
    clientSecret,
    authorizationEndpoint: `${base}/oauth2/v2.0/authorize`,
    tokenEndpoint: `${base}/oauth2/v2.0/token`,
    jwksEndpoint: `${base}/discovery/v2.0/keys`,
  };
};

/**
 * The providers this deployment offers at `now`: configured, with their
 * secret set, and staff sign-in only while its window is open.
 */
export const oidcProviders = (
  env: AuthEnv,
  config: SignInConfig,
  now: number
): OidcProvider[] => {
  const providers: OidcProvider[] = [];
  const entraSecret = env.ENTRA_CLIENT_SECRET;
  const googleSecret = env.GOOGLE_CLIENT_SECRET;
  if (config.entra && isSet(entraSecret)) {
    providers.push(
      entraProvider(
        providerIds.entra,
        "Microsoft",
        config.entra.tenantId,
        config.entra.clientId,
        entraSecret
      )
    );
  }
  if (config.google && isSet(googleSecret)) {
    providers.push({
      providerId: providerIds.google,
      label: "Google",
      issuer: "https://accounts.google.com",
      clientId: config.google.clientId,
      clientSecret: googleSecret,
      authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenEndpoint: "https://oauth2.googleapis.com/token",
      jwksEndpoint: "https://www.googleapis.com/oauth2/v3/certs",
    });
  }
  // Staff sign in through Grasp's own tenant on the same multi-tenant app.
  if (config.staff && isSet(entraSecret) && staffWindowOpen(config, now)) {
    providers.push(
      entraProvider(
        providerIds.staff,
        "Grasp staff",
        config.staff.tenantId,
        config.staff.clientId,
        entraSecret
      )
    );
  }
  return providers;
};
