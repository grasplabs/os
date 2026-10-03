import type { SignInErrorCode } from "@grasp-os/shared/sign-in";
import { i18n } from "@lingui/core";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

/**
 * What a refused sign-in says, by the code core sends back in `?error=`.
 * Anyone can put anything in that parameter of a link, so the page shows
 * only these fixed messages and never the value itself.
 */
const messages: Readonly<Record<SignInErrorCode, MessageDescriptor>> = {
  provider_unknown: msg`That way of signing in isn't set up here.`,
  method_not_allowed: msg`Sign in with your organization's account.`,
  tenant_mismatch: msg`That account isn't part of your organization.`,
  guest_not_allowed: msg`Guest accounts can't sign in. Use your organization's own account.`,
  domain_not_allowed: msg`That account's email address isn't one of your organization's.`,
  email_unverified: msg`That account's email address isn't verified.`,
  staff_not_listed: msg`That staff account hasn't been given access here.`,
  staff_window_closed: msg`Staff access to this organization isn't open.`,
  "account not linked": msg`That email address already signs in with another account.`,
  state_mismatch: msg`Sign-in timed out or was started elsewhere. Try again.`,
  state_not_found: msg`Sign-in timed out or was started elsewhere. Try again.`,
  "unable to create session": msg`You don't have access to this organization. Ask an admin.`,
};

const fallback = msg`Sign-in didn't work. Try again, or ask an admin.`;

const isKnownCode = (code: string): code is SignInErrorCode =>
  Object.hasOwn(messages, code);

/** The message for a sign-in refused with `code`. */
export const signInErrorMessage = (code: string): string =>
  i18n._(isKnownCode(code) ? messages[code] : fallback);

/**
 * The `error=<code>` a refused sign-in comes back with, picked from a
 * route's search parameters (for `validateSearch`).
 */
export const signInErrorSearch = (
  search: Record<string, unknown>
): { error?: string } =>
  typeof search.error === "string" ? { error: search.error } : {};
