/**
 * The sign-in config and IdP secrets the tests run with: a client at
 * `https://acme.grasp.test` with both an Entra tenant and a Google Workspace,
 * and a staff window open from a day ago until three days ahead. Imported by vite.config.ts (Node)
 * and by the tests (workerd), so it only holds data.
 */
export const clientOrigin = "https://acme.grasp.test";

export const acmeTenant = "11111111-1111-4111-8111-111111111111";
export const graspTenant = "22222222-2222-4222-8222-222222222222";
export const otherTenant = "33333333-3333-4333-8333-333333333333";
/** The one Grasp staff member allowed in. */
export const staffOid = "44444444-4444-4444-8444-444444444444";

export const entraClient = { id: "grasp-os-entra-app", secret: "entra-secret" };
export const googleClient = {
  id: "grasp-os-google-app",
  secret: "google-secret",
};

const day = 24 * 60 * 60 * 1000;

export const signInConfig = {
  origin: clientOrigin,
  domains: ["acme.test"],
  admins: ["ada@acme.test"],
  entra: { tenantId: acmeTenant, clientId: entraClient.id },
  google: { hostedDomain: "acme.test", clientId: googleClient.id },
  staff: {
    tenantId: graspTenant,
    clientId: entraClient.id,
    domains: ["grasp.test"],
    oids: [staffOid],
    role: "admin",
    opened: new Date(Date.now() - day).toISOString(),
    until: new Date(Date.now() + 3 * day).toISOString(),
  },
};

export const testSignIn = {
  SIGN_IN: signInConfig,
  ENTRA_CLIENT_SECRET: entraClient.secret,
  GOOGLE_CLIENT_SECRET: googleClient.secret,
};
