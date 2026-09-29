/**
 * What a deploy works with (`DeployContext`), from the console's env: the
 * Cloudflare API as the deployer, the releases bucket, the router's
 * hostname map and the secrets from Secrets Store (wrangler.jsonc).
 *
 * Built afresh for each run, so a secret rotated in Secrets Store reaches
 * the next deploy. The token and the secrets stay in the context: a caller
 * running in a Workflow step never returns it from the step, whose result
 * is stored (threat model R17, CO3).
 */
import { cloudflareApi } from "../cloudflare/api.ts";
import type { CloudflareApi } from "../cloudflare/api.ts";
import { consoleDatabase } from "../db/act.ts";
import type { DeployContext } from "./deploy.ts";
import type { DeploySecrets } from "./secrets.ts";

/** The secrets every client shares, as their bindings are named. */
type SharedSecret =
  | "ENTRA_CLIENT_SECRET"
  | "MICROSOFT_CLIENT_SECRET"
  | "GOOGLE_CLIENT_SECRET"
  | "COMPOSIO_API_KEY";

/**
 * Which Worker gets which shared secret: core signs people in with the
 * Entra and Google apps, connect connects their Microsoft and Google
 * accounts and reaches Composio. Each is named as the Worker secret it
 * becomes.
 */
const sharedSecrets: Readonly<Record<string, readonly SharedSecret[]>> = {
  core: ["ENTRA_CLIENT_SECRET", "GOOGLE_CLIENT_SECRET"],
  connect: [
    "MICROSOFT_CLIENT_SECRET",
    "GOOGLE_CLIENT_SECRET",
    "COMPOSIO_API_KEY",
  ],
};

/** The console's Secrets Store bindings (wrangler.jsonc). */
type StoreSecret = {
  [Name in keyof Env]-?: Env[Name] extends SecretsStoreSecret ? Name : never;
}[keyof Env];

/**
 * The value of the Secrets Store secret `name`. One that's missing or
 * empty stops the caller, naming the secret and nothing of its value:
 * deploy-ops writes every one of them, so a gap is a store to fix, not a
 * secret to leave off.
 */
const storeSecret = async (env: Env, name: StoreSecret): Promise<string> => {
  let value = "";
  try {
    value = await env[name].get();
  } catch {
    // The binding throws for a secret the store doesn't have: reported
    // below, by name.
  }
  if (value === "") {
    throw new Error(`${name} is missing from Secrets Store`);
  }
  return value;
};

/** The Cloudflare API as the deployer, a member of every client account. */
export const deployerApi = async (env: Env): Promise<CloudflareApi> =>
  cloudflareApi({ token: await storeSecret(env, "DEPLOYER_API_TOKEN") });

/** The domain clients are served under, or null while none is set. */
export const clientDomain = (env: Env): string | null => {
  const domain = env.CLIENT_DOMAIN?.trim() ?? "";
  return domain === "" ? null : domain;
};

/** Every secret a deploy gives the Workers, read from Secrets Store. */
const deploySecrets = async (env: Env): Promise<DeploySecrets> => {
  const names = [...new Set(Object.values(sharedSecrets).flat())];
  const values = new Map(
    await Promise.all(
      names.map(async (name): Promise<[string, string]> => [
        name,
        await storeSecret(env, name),
      ])
    )
  );
  return {
    routerKey: await storeSecret(env, "ROUTER_KEY"),
    clientKey: await storeSecret(env, "CLIENT_KEY"),
    shared: Object.fromEntries(
      Object.entries(sharedSecrets).map(([app, secrets]) => [
        app,
        Object.fromEntries(
          secrets.map((name) => [name, values.get(name) ?? ""])
        ),
      ])
    ),
  };
};

/** Everything a deploy works with, from `env`. Throws while no domain is set. */
export const deployContext = async (env: Env): Promise<DeployContext> => {
  const domain = clientDomain(env);
  if (domain === null) {
    throw new Error("CLIENT_DOMAIN isn't set: no client can be deployed");
  }
  return {
    api: await deployerApi(env),
    db: consoleDatabase(env.DB),
    store: env.RELEASES,
    secrets: await deploySecrets(env),
    router: { hosts: env.ROUTER_HOSTS, domain },
  };
};
