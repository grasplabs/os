/**
 * The Content Security Policy of everything core serves. It matters for the
 * frontend's HTML, where it keeps an injected script from running or sending
 * the person's data elsewhere; on API responses it does nothing.
 *
 * - Scripts, styles and connections come only from this origin: no inline
 *   script, no eval. `'self'` covers the same-origin WebSocket to `/rpc`.
 * - Sign-in leaves for the IdP by top-level navigation, which the policy
 *   doesn't govern, so form-action needs no IdP hosts.
 * - Screens (App UIs) will run in sandboxed `data:` iframes with a policy of
 *   their own; allowing them here takes a `frame-src` directive.
 */
const contentSecurityPolicy = Object.entries({
  "default-src": "'self'",
  "script-src": "'self'",
  "style-src": "'self'",
  "img-src": "'self' data:",
  "connect-src": "'self'",
  "object-src": "'none'",
  "base-uri": "'none'",
  "form-action": "'self'",
  "frame-ancestors": "'none'",
})
  .map(([directive, sources]) => `${directive} ${sources}`)
  .join("; ");

/** Browsers keep to https for this long after a visit: one year. */
const hstsMaxAgeSeconds = 365 * 24 * 60 * 60;

/**
 * Sets the security headers on a response core sends for `url`. HSTS goes
 * only on https, since browsers ignore it over http (local development).
 */
export const setSecurityHeaders = (headers: Headers, url: URL): void => {
  headers.set("content-security-policy", contentSecurityPolicy);
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "strict-origin-when-cross-origin");
  if (url.protocol === "https:") {
    headers.set(
      "strict-transport-security",
      `max-age=${hstsMaxAgeSeconds}; includeSubDomains`
    );
  }
};
