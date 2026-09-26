import type { SignInRefusal } from "@grasp-os/shared/sign-in";

import { providerIds, staffWindowOpen } from "./config.ts";
import type { SignInConfig } from "./config.ts";

/** Why a verified ID token doesn't get someone in. Shown to them as a code. */
type ClaimsRefusal = Exclude<SignInRefusal, "method_not_allowed">;

type Claims = Readonly<Record<string, unknown>>;

const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

/** The lowercased domain of the token's email claim, if it has one. */
const emailDomain = (claims: Claims): string | undefined => {
  const { email } = claims;
  if (!nonEmpty(email)) {
    return undefined;
  }
  const at = email.lastIndexOf("@");
  return at > 0 ? email.slice(at + 1).toLowerCase() : undefined;
};

const inDomains = (claims: Claims, domains: readonly string[]): boolean => {
  const domain = emailDomain(claims);
  return domain !== undefined && domains.includes(domain);
};

/**
 * Entra: the tenant (`tid`) is the pinned one and the object id (`oid`), the
 * person's stable id in that tenant, is present. The issuer is pinned to the
 * same tenant when the token is verified; this checks it again from the claim.
 */
const inEntraTenant = (claims: Claims, tenantId: string): boolean =>
  nonEmpty(claims.tid) &&
  claims.tid.toLowerCase() === tenantId.toLowerCase() &&
  nonEmpty(claims.oid);

/**
 * Entra's `acct` optional claim: 0 for the tenant's own members, 1 for B2B
 * guests, whose account lives in another tenant. Without the claim (the app
 * registration must add it) nobody can tell, so that is refused too.
 */
const isTenantMember = (claims: Claims): boolean =>
  claims.acct === 0 || claims.acct === "0";

const checkEntra = (
  claims: Claims,
  tenantId: string,
  domains: readonly string[]
): ClaimsRefusal | undefined => {
  if (!inEntraTenant(claims, tenantId)) {
    return "tenant_mismatch";
  }
  if (!isTenantMember(claims)) {
    return "guest_not_allowed";
  }
  return inDomains(claims, domains) ? undefined : "domain_not_allowed";
};

/**
 * Checks the claims of a verified ID token against the deployment's config,
 * on every sign-in, before any user, account or session is written.
 *
 * The domain check sits on top of the tenant check, never instead of it: an
 * email claim alone proves nothing (anyone can create a Google or Entra
 * account with any address, "nOAuth").
 */
export const checkClaims = (
  config: SignInConfig,
  providerId: string,
  claims: Claims,
  now: number
): ClaimsRefusal | undefined => {
  if (providerId === providerIds.entra && config.entra) {
    return checkEntra(claims, config.entra.tenantId, config.domains);
  }
  if (providerId === providerIds.google && config.google) {
    // `hd` is only set for Google Workspace accounts of that organization;
    // a consumer account with a company address has none.
    if (claims.hd !== config.google.hostedDomain) {
      return "tenant_mismatch";
    }
    if (claims.email_verified !== true) {
      return "email_unverified";
    }
    return inDomains(claims, config.domains) ? undefined : "domain_not_allowed";
  }
  if (providerId === providerIds.staff && config.staff) {
    if (!staffWindowOpen(config, now)) {
      return "staff_window_closed";
    }
    const refusal = checkEntra(
      claims,
      config.staff.tenantId,
      config.staff.domains
    );
    if (refusal) {
      return refusal;
    }
    const listed = config.staff.oids.some(
      (oid) => oid.toLowerCase() === String(claims.oid).toLowerCase()
    );
    return listed ? undefined : "staff_not_listed";
  }
  return "provider_unknown";
};
