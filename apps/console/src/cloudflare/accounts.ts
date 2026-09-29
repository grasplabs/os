/**
 * A client account and the resources a deployment needs in it. Everything
 * that stores data is created in the EU jurisdiction and nowhere else
 * (threat model R18); one that already exists outside it stops the caller,
 * since a jurisdiction is set only at creation.
 *
 * The `ensure*` calls are idempotent, so a provisioning step can run again
 * after a failure: each finds the resource first and creates it only when
 * it's missing.
 */
import { z } from "zod";

import { isNotFound, listAll } from "./api.ts";
import type { CloudflareApi } from "./api.ts";

const eu = "eu";

const accountSchema = z.object({ id: z.string(), name: z.string() });
export type Account = z.infer<typeof accountSchema>;

/** The account `accountId`, as the token sees it. */
export const getAccount = async (
  api: CloudflareApi,
  accountId: string
): Promise<Account> =>
  await api.call(
    { method: "GET", path: `/accounts/${accountId}` },
    accountSchema
  );

/** Every account the token is a member of. */
export const listAccounts = async (api: CloudflareApi): Promise<Account[]> =>
  await listAll(api, "/accounts", accountSchema);

/**
 * The account named exactly `name` the token sees, or undefined. Two of
 * that name stop it rather than pick one.
 */
export const findAccount = async (
  api: CloudflareApi,
  name: string
): Promise<Account | undefined> => {
  // The API matches `name` loosely: pick the exact one.
  const listed = await listAll(api, "/accounts", accountSchema, { name });
  const matches = listed.filter((account) => account.name === name);
  const [found, ...others] = matches;
  if (others.length > 0) {
    throw new Error(`${matches.length} accounts are named ${name}`);
  }
  return found;
};

/**
 * The account named `name`, created if the token sees none by that name.
 * Only a tenant admin's token (Cloudflare's partner programme) may create
 * accounts. A create is a POST, so it isn't retried after a server error
 * or a lost answer; running this again finds the account it made by its
 * name, so it makes one account however often it runs.
 */
export const ensureAccount = async (
  api: CloudflareApi,
  name: string
): Promise<Account> =>
  (await findAccount(api, name)) ??
  (await api.call(
    { method: "POST", path: "/accounts", json: { name, type: "standard" } },
    accountSchema
  ));

const userSchema = z.object({ email: z.string() });

/** The email of the user whose token `api` holds. */
export const tokenUserEmail = async (api: CloudflareApi): Promise<string> => {
  const { email } = await api.call(
    { method: "GET", path: "/user" },
    userSchema
  );
  return email;
};

const memberSchema = z.object({
  id: z.string(),
  status: z.string(),
  user: z.object({ email: z.string() }),
});
const roleSchema = z.object({ id: z.string(), name: z.string() });

/**
 * Makes the Cloudflare user `email` a member of account `accountId` with
 * the role named `roleName`, accepted at once (it's an existing user, as
 * the tenant admin adds it), unless it's a member already. Running it
 * again after a lost answer finds the member it added. A membership still
 * pending (an invitation nobody accepted) stops it: staff accept or remove
 * it by hand.
 */
export const ensureMember = async (
  api: CloudflareApi,
  accountId: string,
  email: string,
  roleName: string
): Promise<void> => {
  const path = `/accounts/${accountId}/members`;
  const members = await listAll(api, path, memberSchema);
  const existing = members.find(
    (member) => member.user.email.toLowerCase() === email.toLowerCase()
  );
  if (existing?.status === "accepted") {
    return;
  }
  if (existing !== undefined) {
    throw new Error(
      `${email}'s membership of ${accountId} is ${existing.status}`
    );
  }
  const roles = await listAll(api, `/accounts/${accountId}/roles`, roleSchema);
  const role = roles.find(({ name }) => name === roleName);
  if (role === undefined) {
    throw new Error(`Account ${accountId} has no role named ${roleName}`);
  }
  await api.call(
    {
      method: "POST",
      path,
      json: { email, roles: [role.id], status: "accepted" },
    },
    memberSchema
  );
};

const subdomainSchema = z.object({ subdomain: z.string() });

/**
 * The account's workers.dev subdomain, set to `subdomain` if it has none.
 * Returns the one it has, which may differ.
 */
export const ensureWorkersSubdomain = async (
  api: CloudflareApi,
  accountId: string,
  subdomain: string
): Promise<string> => {
  const path = `/accounts/${accountId}/workers/subdomain`;
  try {
    const { subdomain: current } = await api.call(
      { method: "GET", path },
      subdomainSchema
    );
    return current;
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }
  }
  const created = await api.call(
    { method: "PUT", path, json: { subdomain } },
    subdomainSchema
  );
  return created.subdomain;
};

/** A resource Grasp needs in the EU that exists elsewhere. */
export class OutsideEuError extends Error {
  constructor(kind: string, name: string, jurisdiction: string | undefined) {
    super(
      `${kind} ${name} exists outside the EU jurisdiction (${jurisdiction ?? "none"}); it has to be recreated`
    );
    this.name = "OutsideEuError";
  }
}

const d1Schema = z.object({
  uuid: z.string(),
  name: z.string(),
  jurisdiction: z.string().nullish(),
});
export type D1DatabaseInfo = z.infer<typeof d1Schema>;

/** The D1 database `name` in the EU, created if it's missing. */
export const ensureD1Database = async (
  api: CloudflareApi,
  accountId: string,
  name: string
): Promise<D1DatabaseInfo> => {
  const path = `/accounts/${accountId}/d1/database`;
  // The API matches `name` as a substring: pick the exact one.
  const matches = await listAll(api, path, d1Schema, { name });
  const database =
    matches.find((found) => found.name === name) ??
    (await api.call(
      { method: "POST", path, json: { name, jurisdiction: eu } },
      d1Schema
    ));
  // Whichever call answered, only a database Cloudflare reports in the EU
  // is used.
  if (database.jurisdiction !== eu) {
    throw new OutsideEuError(
      "D1 database",
      name,
      database.jurisdiction ?? undefined
    );
  }
  return database;
};

const bucketSchema = z.object({
  name: z.string(),
  jurisdiction: z.string().nullish(),
});
export type R2BucketInfo = z.infer<typeof bucketSchema>;

/**
 * The R2 bucket `name` in the EU, created if it's missing. A bucket's name
 * is unique per jurisdiction, so one of the same name elsewhere is another
 * bucket, and never used.
 */
export const ensureR2Bucket = async (
  api: CloudflareApi,
  accountId: string,
  name: string
): Promise<R2BucketInfo> => {
  const headers = { "cf-r2-jurisdiction": eu };
  const path = `/accounts/${accountId}/r2/buckets`;
  let bucket: R2BucketInfo | undefined = undefined;
  try {
    bucket = await api.call(
      { method: "GET", path: `${path}/${name}`, headers },
      bucketSchema
    );
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }
  }
  bucket ??= await api.call(
    { method: "POST", path, headers, json: { name } },
    bucketSchema
  );
  // Whichever call answered, only a bucket Cloudflare reports in the EU is
  // used.
  if (bucket.jurisdiction !== eu) {
    throw new OutsideEuError(
      "R2 bucket",
      name,
      bucket.jurisdiction ?? undefined
    );
  }
  return bucket;
};

/**
 * An AI Gateway, with every setting it reports kept: an update (PUT)
 * replaces them all, so turning authentication on must send the rest back
 * whole, BYOK's `store_id` and log settings included.
 */
const gatewaySchema = z.looseObject({
  id: z.string(),
  authentication: z.boolean().nullish(),
});
export type AiGatewayInfo = z.infer<typeof gatewaySchema>;

/** What a gateway reports but an update doesn't take: ids and timestamps. */
const readOnlyGatewayFields: ReadonlySet<string> = new Set([
  "id",
  "created_at",
  "modified_at",
  "is_default",
  "account_id",
  "account_tag",
  "internal_id",
]);

/**
 * The AI Gateway `id`, created if it's missing, and always authenticated:
 * the gateway holds the client's provider keys (BYOK), so without
 * authentication anyone who knows its URL could spend them (threat model
 * CO14). Core reaches it through the AI binding, which Cloudflare
 * authenticates in-account, so it needs no token. An existing gateway with
 * authentication off gets it switched on, its other settings kept.
 *
 * A new gateway has no cache and no rate limit (core's model gateway
 * enforces budgets). It logs each call's metadata, which core's audit
 * events point to by log id; core turns payload logging off on every call,
 * so prompts and replies aren't kept (threat model EU7).
 */
export const ensureAiGateway = async (
  api: CloudflareApi,
  accountId: string,
  id: string
): Promise<AiGatewayInfo> => {
  const path = `/accounts/${accountId}/ai-gateway/gateways`;
  let existing: AiGatewayInfo | undefined = undefined;
  try {
    existing = await api.call(
      { method: "GET", path: `${path}/${id}` },
      gatewaySchema
    );
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }
  }
  if (existing === undefined) {
    return await api.call(
      {
        method: "POST",
        path,
        json: {
          id,
          authentication: true,
          cache_ttl: 0,
          cache_invalidate_on_update: false,
          collect_logs: true,
          rate_limiting_interval: 0,
          rate_limiting_limit: 0,
          rate_limiting_technique: "fixed",
        },
      },
      gatewaySchema
    );
  }
  if (existing.authentication === true) {
    return existing;
  }
  const settings = Object.fromEntries(
    Object.entries(existing).filter(
      ([field]) => !readOnlyGatewayFields.has(field)
    )
  );
  return await api.call(
    {
      method: "PUT",
      path: `${path}/${existing.id}`,
      json: { ...settings, authentication: true },
    },
    gatewaySchema
  );
};
