// Response headers every Grasp-made HTTP response carries, whether core or
// the router in front of it makes it.

/** Carries the request ID back to the caller, on every response. */
export const requestIdHeader = "x-request-id";

/** Browsers keep to https for this long after a visit: one year. */
const hstsMaxAgeSeconds = 365 * 24 * 60 * 60;

/** `strict-transport-security`, sent on https only: browsers ignore it over http. */
export const strictTransportSecurity = `max-age=${hstsMaxAgeSeconds}; includeSubDomains`;
