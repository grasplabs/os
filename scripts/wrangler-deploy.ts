/**
 * Deploys the Worker in the current directory with its Secrets Store
 * bindings pointed at the account's own store. A binding needs the store's
 * id, which differs per account (grasp-os-staging, grasp-os-ops) and which
 * Wrangler can't look up, so wrangler.jsonc carries a placeholder and this
 * fills it in before `wrangler deploy`: from SECRETS_STORE_ID when the job
 * sets it (deploy-ops does), otherwise from the Cloudflare API, as the
 * account's only store.
 *
 * The lookup needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (with
 * Secrets Store read), as the deploy jobs set them.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";

/** The `store_id` wrangler.jsonc names instead of a real one. */
const placeholder = '"account-secrets-store"';
const config = "wrangler.jsonc";
const deployConfig = "wrangler.deploy.jsonc";

const required = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is not set`);
  }
  return value;
};

/** The ids of the account's stores, from the API's JSON (`result[].id`). */
const storeIds = (body: unknown): string[] => {
  if (typeof body !== "object" || body === null || !("result" in body)) {
    return [];
  }
  const { result } = body;
  if (!Array.isArray(result)) {
    return [];
  }
  return result.flatMap((store: unknown) =>
    typeof store === "object" &&
    store !== null &&
    "id" in store &&
    typeof store.id === "string"
      ? [store.id]
      : []
  );
};

const accountStoreId = async (): Promise<string> => {
  const accountId = required("CLOUDFLARE_ACCOUNT_ID");
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/secrets_store/stores`,
    { headers: { authorization: `Bearer ${required("CLOUDFLARE_API_TOKEN")}` } }
  );
  if (!response.ok) {
    throw new Error(
      `Listing the account's Secrets Stores: HTTP ${response.status}`
    );
  }
  const ids = storeIds(await response.json());
  const [id] = ids;
  if (id === undefined || ids.length > 1) {
    throw new Error(
      `Expected the account to have one Secrets Store, found ${ids.length}`
    );
  }
  return id;
};

/** The store id the job gives, else the one the API finds. */
const storeId = async (): Promise<string> => {
  const configured = process.env.SECRETS_STORE_ID;
  if (configured !== undefined && configured !== "") {
    return configured;
  }
  return await accountStoreId();
};

const text = readFileSync(config, "utf-8");
if (!text.includes(placeholder)) {
  throw new Error(`${config} names no ${placeholder} store to fill in`);
}
writeFileSync(
  deployConfig,
  text.replaceAll(placeholder, JSON.stringify(await storeId()))
);
try {
  execFileSync("wrangler", ["deploy", "--config", deployConfig], {
    stdio: "inherit",
  });
} finally {
  rmSync(deployConfig, { force: true });
}
