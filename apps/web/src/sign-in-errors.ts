import type { SignInErrorCode } from "@grasp-os/shared/sign-in";

/**
 * What a refused sign-in says, by the code core sends back in `?error=`.
 * Anyone can put anything in that parameter of a link, so the page shows
 * only these fixed messages and never the value itself.
 */
const messages: Readonly<Record<SignInErrorCode, string>> = {
  provider_unknown: "That way of signing in isn't set up here.",
  method_not_allowed: "Sign in with your organization's account.",
  tenant_mismatch: "That account isn't part of your organization.",
  guest_not_allowed:
    "Guest accounts can't sign in. Use your organization's own account.",
  domain_not_allowed:
    "That account's email address isn't one of your organization's.",
  email_unverified: "That account's email address isn't verified.",
  staff_not_listed: "That staff account hasn't been given access here.",
  staff_window_closed: "Staff access to this organization isn't open.",
  "account not linked":
    "That email address already signs in with another account.",
  state_mismatch: "Sign-in timed out or was started elsewhere. Try again.",
  state_not_found: "Sign-in timed out or was started elsewhere. Try again.",
  "unable to create session":
    "You don't have access to this organization. Ask an admin.",
};

const fallback = "Sign-in didn't work. Try again, or ask an admin.";

const isKnownCode = (code: string): code is SignInErrorCode =>
  Object.hasOwn(messages, code);

/** The message for a sign-in refused with `code`. */
export const signInErrorMessage = (code: string): string =>
  isKnownCode(code) ? messages[code] : fallback;
