import { deploymentConfig } from "@grasp-os/shared/config";
import {
  signInConfigSchema,
  staffWindowOpen,
} from "@grasp-os/shared/deployment-config";
import type { SignInConfig } from "@grasp-os/shared/deployment-config";
import { loopbackHosts } from "@grasp-os/shared/router";

/**
 * The deployment's sign-in config (the `SIGN_IN` var the console sets), or
 * `undefined` when none is set. A config that doesn't parse counts as none:
 * sign-in fails closed.
 */
export const signInConfig = (env: Env): SignInConfig | undefined =>
  deploymentConfig(signInConfigSchema, "SIGN_IN", env.SIGN_IN);

/** Whether `value` is an origin on this machine, e.g. `http://localhost:8787`. */
const isLocalOrigin = (value: string): boolean =>
  URL.canParse(value) &&
  new URL(value).origin === value &&
  loopbackHosts.has(new URL(value).hostname);

const isSet = (secret: string | undefined): secret is string =>
  secret !== undefined && secret !== "";

/** The IdPs people can sign in with. The ids are also callback path segments. */
export const providerIds = {
  entra: "microsoft",
  google: "google",
  staff: "grasp-staff",
} as const;
type ProviderId = (typeof providerIds)[keyof typeof providerIds];

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

const microsoftOrigin = "https://login.microsoftonline.com";

/**
 * Where a stand-in for Entra answers instead of Microsoft, if anywhere:
 * local development and the end-to-end tests sign in through one on this
 * machine (`DEV_IDP_ORIGIN`, set with `wrangler dev --var`, never in
 * wrangler.jsonc; apps/core/test/idp-worker.ts). It applies only while
 * both it and the deployment's own origin (`SIGN_IN.origin`) are on this
 * machine. A deployment's origin is its public hostname, set by the
 * console, so setting the var alone does nothing there; and whoever can set
 * both already controls sign-in.
 */
export const devIdpOrigin = (
  env: Env,
  config: SignInConfig
): string | undefined => {
  const devIdp = env.DEV_IDP_ORIGIN;
  return devIdp !== undefined &&
    isLocalOrigin(devIdp) &&
    isLocalOrigin(config.origin)
    ? devIdp
    : undefined;
};

const entraProvider = (
  origin: string,
  providerId: ProviderId,
  label: string,
  tenantId: string,
  clientId: string,
  clientSecret: string
): OidcProvider => {
  // The tenant's own issuer, not `common`: ID tokens from any other tenant
  // carry another `iss` and fail verification.
  const base = `${origin}/${tenantId}`;
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
  env: Env,
  config: SignInConfig,
  now: number
): OidcProvider[] => {
  const providers: OidcProvider[] = [];
  const entraSecret = env.ENTRA_CLIENT_SECRET;
  const googleSecret = env.GOOGLE_CLIENT_SECRET;
  const entra = devIdpOrigin(env, config) ?? microsoftOrigin;
  if (config.entra && isSet(entraSecret)) {
    providers.push(
      entraProvider(
        entra,
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
        entra,
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
