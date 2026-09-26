// A refused sign-in lands on the frontend with `?error=<code>`, and the
// frontend has a message for each code. These are every code it can get.

/** Why core refused a sign-in: its check of the IdP's claims, or the method. */
const signInRefusals = [
  "provider_unknown",
  "tenant_mismatch",
  "guest_not_allowed",
  "email_unverified",
  "domain_not_allowed",
  "staff_not_listed",
  "staff_window_closed",
  "method_not_allowed",
] as const;
export type SignInRefusal = (typeof signInRefusals)[number];

/** The codes Better Auth itself sends for a sign-in that failed. */
const betterAuthSignInErrors = [
  "account not linked",
  "state_mismatch",
  "state_not_found",
  "unable to create session",
] as const;

/** Every code a failed sign-in comes back with. */
export type SignInErrorCode =
  | SignInRefusal
  | (typeof betterAuthSignInErrors)[number];
