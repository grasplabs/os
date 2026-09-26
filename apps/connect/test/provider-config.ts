/**
 * The tenants and Grasp's OAuth apps the fake providers know, in connect's
 * tests and in core's, which run the real connect. Imported by the vite
 * configs (Node) and the tests (workerd), so it only holds data.
 */
export const acmeTenant = "11111111-1111-4111-8111-111111111111";
export const otherTenant = "33333333-3333-4333-8333-333333333333";
export const acmeDomain = "acme.test";

/** Grasp's apps at the providers, as set on connect in the tests. */
export const clients = {
  microsoft: { id: "grasp-connect-entra", secret: "entra-connect-secret" },
  google: { id: "grasp-connect-google", secret: "google-connect-secret" },
} as const;
