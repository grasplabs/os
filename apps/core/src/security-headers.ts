import { screenFramePath } from "@grasp-os/shared/screens";

const policy = (directives: Record<string, string>): string =>
  Object.entries(directives)
    .map(([directive, sources]) => `${directive} ${sources}`)
    .join("; ");

/**
 * The Content Security Policy of everything core serves but the screen
 * frame. It matters for the frontend's HTML, where it keeps an injected
 * script from running or sending the person's data elsewhere; on API
 * responses it does nothing.
 *
 * - Scripts, styles and connections come only from this origin: no inline
 *   script, no eval. `'self'` covers the same-origin WebSocket to `/rpc`.
 * - Sign-in leaves for the IdP by top-level navigation, which the policy
 *   doesn't govern, so form-action needs no IdP hosts.
 * - Screens (App UIs) run in sandboxed frames of a document from this
 *   origin (screen-frame.ts), which has a policy of its own. A `srcdoc` or
 *   `data:` frame would inherit this one and couldn't run its screen.
 */
const contentSecurityPolicy = policy({
  "default-src": "'self'",
  "script-src": "'self'",
  "style-src": "'self'",
  "img-src": "'self' data:",
  "connect-src": "'self'",
  "object-src": "'none'",
  "base-uri": "'none'",
  "form-action": "'self'",
  "frame-src": "'self'",
  "frame-ancestors": "'none'",
});

/**
 * The policy of the document screens run in (screen-frame.ts): App code
 * nobody reviewed line by line, so no network at all.
 *
 * - `sandbox allow-scripts` gives it an opaque origin even when it is
 *   opened on its own, not framed: no cookies, storage or DOM of this
 *   origin, no popups, no top-level navigation, no forms.
 * - Scripts, styles, images and fonts only inline and from `data:` URLs,
 *   which is how the page hands it the screen's modules. Nothing to
 *   connect to (fetch, WebSocket, beacons, EventSource), no workers, no
 *   frames, no form targets and no `<base>`.
 * - Only the product page may frame it.
 *
 * What a sandboxed frame keeps despite its policy (navigating itself away,
 * WebRTC) is an accepted risk for now: the screen sees only what the person
 * can already see in that App.
 */
const screenFramePolicy = policy({
  sandbox: "allow-scripts",
  "default-src": "'none'",
  "script-src": "data: 'unsafe-inline'",
  "style-src": "data: 'unsafe-inline'",
  "img-src": "data:",
  "font-src": "data:",
  "connect-src": "'none'",
  "worker-src": "'none'",
  "frame-src": "'none'",
  "form-action": "'none'",
  "base-uri": "'none'",
  "frame-ancestors": "'self'",
});

/** Browsers keep to https for this long after a visit: one year. */
const hstsMaxAgeSeconds = 365 * 24 * 60 * 60;

/**
 * Sets the security headers on a response core sends for `url`. HSTS goes
 * only on https, since browsers ignore it over http (local development). A
 * route may send a stricter referrer policy of its own, such as
 * `no-referrer` where its URL carries a secret; it is kept.
 */
export const setSecurityHeaders = (headers: Headers, url: URL): void => {
  headers.set(
    "content-security-policy",
    url.pathname === screenFramePath ? screenFramePolicy : contentSecurityPolicy
  );
  headers.set("x-content-type-options", "nosniff");
  if (headers.get("referrer-policy") !== "no-referrer") {
    headers.set("referrer-policy", "strict-origin-when-cross-origin");
  }
  if (url.protocol === "https:") {
    headers.set(
      "strict-transport-security",
      `max-age=${hstsMaxAgeSeconds}; includeSubDomains`
    );
  }
};
