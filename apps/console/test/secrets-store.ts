/**
 * The console's Secrets Store in the test pool, filled for each test as
 * deploy-ops fills it (wrangler.jsonc), and emptied after.
 */
import { env } from "cloudflare:workers";
import { afterEach, beforeEach } from "vite-plus/test";

/** What the local Secrets Store (Miniflare) offers tests to manage a secret. */
export interface SecretsStoreAdmin {
  create: (value: string) => Promise<string>;
  delete: (id: string) => Promise<void>;
}

/** The local Secrets Store's admin API for the secret `binding` names. */
export const adminOf = async (
  binding: SecretsStoreSecret
): Promise<SecretsStoreAdmin> => {
  // SAFETY: Miniflare's local Secrets Store binding answers this method with
  // its admin API, whose `create` and `delete` have these signatures.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  const admin = Reflect.get(
    binding,
    "SecretsStoreSecret::admin_api"
  ) as () => Promise<SecretsStoreAdmin>;
  return await admin();
};

/**
 * Puts every secret the console reads in the store before each test, the
 * deployer's and tenant admin's tokens as given, and takes them out after.
 */
export const useStoreSecrets = (tokens: {
  deployer: string;
  tenant: string;
}): void => {
  const secrets: [SecretsStoreSecret, string][] = [
    [env.TENANT_ADMIN_TOKEN, tokens.tenant],
    [env.DEPLOYER_API_TOKEN, tokens.deployer],
    [env.ROUTER_KEY, "test-router-key"],
    [env.CLIENT_KEY, "test-client-key"],
    [env.ENTRA_CLIENT_SECRET, "entra-secret"],
    [env.MICROSOFT_CLIENT_SECRET, "microsoft-secret"],
    [env.GOOGLE_CLIENT_SECRET, "google-secret"],
    [env.COMPOSIO_API_KEY, "composio-key"],
  ];
  const stored: { admin: SecretsStoreAdmin; id: string }[] = [];
  beforeEach(async () => {
    for (const [binding, value] of secrets) {
      // oxlint-disable-next-line no-await-in-loop -- a few, in order
      const admin = await adminOf(binding);
      // oxlint-disable-next-line no-await-in-loop -- a few, in order
      stored.push({ admin, id: await admin.create(value) });
    }
  });
  afterEach(async () => {
    for (const { admin, id } of stored.splice(0)) {
      // oxlint-disable-next-line no-await-in-loop -- a few, in order
      await admin.delete(id);
    }
  });
};
