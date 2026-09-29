/**
 * Deploys the Worker in the current directory with the ids wrangler can't
 * look up filled in: its Secrets Store bindings pointed at the account's
 * own store, and a binding to the router's hostname map at that
 * namespace. Both ids differ per account (grasp-os-staging, grasp-os-ops),
 * so the config carries placeholders and this fills them in before
 * `wrangler deploy`:
 * - `"account-secrets-store"`: from SECRETS_STORE_ID when the job sets it
 *   (deploy-ops does), otherwise from the Cloudflare API, as the
 *   account's only store;
 * - `"router-hosts-namespace"`: the KV namespace the router's first deploy
 *   created, `grasp-os-router-hosts`, from the Cloudflare API. The router
 *   deploys first (deploy-ops).
 *
 * A Worker built with the Cloudflare Vite plugin (the console) deploys the
 * config its build wrote, which `.wrangler/deploy/config.json` points to;
 * any other deploys its wrangler.jsonc. Arguments are passed on to
 * `wrangler deploy`, such as the console's `--var`s.
 *
 * The lookups need CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (with
 * Secrets Store and Workers KV read), as the deploy jobs set them.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/** The `store_id` a config names instead of a real one. */
const storePlaceholder = '"account-secrets-store"';
/** The KV `id` a config names instead of the router's map's. */
const hostsPlaceholder = '"router-hosts-namespace"';
/** The title the router's first deploy gives its map (wrangler's `<worker>-<binding>`). */
const hostsTitle = "grasp-os-router-hosts";
/** Where the Cloudflare Vite plugin's build says its config is. */
const buildRedirect = ".wrangler/deploy/config.json";

const required = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is not set`);
  }
  return value;
};

/** `value[key]` when value is an object, else undefined. */
const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null
    ? Reflect.get(value, key)
    : undefined;

const isList = (value: unknown): value is unknown[] => Array.isArray(value);

/** Every item of the account's list at `list`, page by page. */
const listAll = async (list: string): Promise<unknown[]> => {
  const accountId = required("CLOUDFLARE_ACCOUNT_ID");
  const items: unknown[] = [];
  for (let page = 1; ; page += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one page after another
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}${list}?per_page=100&page=${page}`,
      {
        headers: {
          authorization: `Bearer ${required("CLOUDFLARE_API_TOKEN")}`,
        },
      }
    );
    if (!response.ok) {
      throw new Error(`Listing the account's ${list}: HTTP ${response.status}`);
    }
    // oxlint-disable-next-line no-await-in-loop -- one page after another
    const body: unknown = await response.json();
    const result = field(body, "result");
    if (isList(result)) {
      items.push(...result);
    }
    const totalPages = Number(
      field(field(body, "result_info"), "total_pages") ?? 1
    );
    if (!isList(result) || page >= totalPages) {
      return items;
    }
  }
};

/** The ids of the items in `items` that `matches` picks out. */
const idsOf = (
  items: unknown[],
  matches: (item: unknown) => boolean
): string[] =>
  items.flatMap((item) => {
    const id = field(item, "id");
    return matches(item) && typeof id === "string" ? [id] : [];
  });

/** The one id in `ids`, or an error naming what was expected. */
const onlyId = (ids: string[], expected: string): string => {
  const [id] = ids;
  if (id === undefined || ids.length > 1) {
    throw new Error(
      `Expected the account to have ${expected}, found ${ids.length}`
    );
  }
  return id;
};

/** The store id the job gives, else the account's only store's. */
const storeId = async (): Promise<string> => {
  const configured = process.env.SECRETS_STORE_ID;
  if (configured !== undefined && configured !== "") {
    return configured;
  }
  return onlyId(
    idsOf(await listAll("/secrets_store/stores"), () => true),
    "one Secrets Store"
  );
};

/** The id of the router's hostname map. */
const hostsId = async (): Promise<string> =>
  onlyId(
    idsOf(
      await listAll("/storage/kv/namespaces"),
      (namespace) => field(namespace, "title") === hostsTitle
    ),
    `one KV namespace ${hostsTitle} (deploy the router first)`
  );

/** The config to deploy: the build's, if the Vite plugin wrote one. */
const configPath = (): string => {
  if (!existsSync(buildRedirect)) {
    return "wrangler.jsonc";
  }
  const target = field(
    JSON.parse(readFileSync(buildRedirect, "utf-8")),
    "configPath"
  );
  if (typeof target !== "string") {
    throw new TypeError(`${buildRedirect} names no configPath`);
  }
  return path.join(path.dirname(buildRedirect), target);
};

const config = configPath();
let text = readFileSync(config, "utf-8");
if (!text.includes(storePlaceholder) && !text.includes(hostsPlaceholder)) {
  throw new Error(`${config} names no placeholder to fill in`);
}
if (text.includes(storePlaceholder)) {
  text = text.replaceAll(storePlaceholder, JSON.stringify(await storeId()));
}
if (text.includes(hostsPlaceholder)) {
  text = text.replaceAll(hostsPlaceholder, JSON.stringify(await hostsId()));
}
// Next to the config, so the paths in it (main, assets) still resolve.
const deployConfig = path.join(path.dirname(config), "wrangler.deploy.jsonc");
writeFileSync(deployConfig, text);
try {
  execFileSync(
    "wrangler",
    ["deploy", "--config", deployConfig, ...process.argv.slice(2)],
    { stdio: "inherit" }
  );
} finally {
  rmSync(deployConfig, { force: true });
}
