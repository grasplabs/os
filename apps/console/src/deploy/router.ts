import { deadline, whenAborted } from "@grasp-os/shared/deadline";
/**
 * The last steps of a deploy: checking that the client's core runs the
 * version this deploy made live, as the router reaches it, then pointing
 * the client's hostname at it in the router's map.
 *
 * The check comes first, so the router never sends a client's people to a
 * core that doesn't answer: a first deploy's hostname appears only once
 * its core works.
 */
import {
  routerHostKey,
  routerHostSchema,
  routerSecretHeader,
} from "@grasp-os/shared/router";
import type { RouterHost } from "@grasp-os/shared/router";
import { z } from "zod";

import { CloudflareApiError, isNotFound } from "../cloudflare/api.ts";
import type { CloudflareApi } from "../cloudflare/api.ts";
import { DeployError } from "./errors.ts";

/** The router's hostname map, as the console uses it (the router's `HOSTS`, a KV namespace). */
export interface RouterHosts {
  get: (key: string, type: "json") => Promise<unknown>;
  put: (key: string, value: string) => Promise<void>;
}

const subdomainSchema = z.object({ subdomain: z.string() });

/** Tries at a free workers.dev subdomain: `grasp-<clientId>`, then with a suffix. */
const subdomainTries = 3;

/**
 * Cloudflare's error code for a workers.dev subdomain another account
 * has, as Wrangler reads it when it registers one (10032 means free).
 */
const subdomainUnavailableCode = 10_031;

/** Whether Cloudflare refused a subdomain as another account's. */
const isTaken = (error: unknown): boolean =>
  error instanceof CloudflareApiError &&
  error.codes.includes(subdomainUnavailableCode);

const randomSuffix = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(3)), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");

/**
 * The account's workers.dev subdomain: the one it has, or else
 * `grasp-<clientId>`, set now. A subdomain is unique across Cloudflare,
 * so one another account has (error 10031) is tried again with a short
 * random suffix (`subdomain_unavailable` after a few tries).
 */
export const workersSubdomain = async (
  api: CloudflareApi,
  accountId: string,
  clientId: string
): Promise<string> => {
  const path = `/accounts/${accountId}/workers/subdomain`;
  try {
    const { subdomain } = await api.call(
      { method: "GET", path },
      subdomainSchema
    );
    return subdomain;
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }
  }
  for (let attempt = 0; attempt < subdomainTries; attempt += 1) {
    const wanted =
      attempt === 0
        ? `grasp-${clientId}`
        : `grasp-${clientId}-${randomSuffix()}`;
    try {
      // oxlint-disable-next-line no-await-in-loop -- one name at a time
      const { subdomain } = await api.call(
        { method: "PUT", path, json: { subdomain: wanted } },
        subdomainSchema
      );
      return subdomain;
    } catch (error) {
      if (!isTaken(error)) {
        throw error;
      }
    }
  }
  throw new DeployError(
    "subdomain_unavailable",
    `No free workers.dev subdomain for ${clientId}`
  );
};

/**
 * A client's core on its account's workers.dev subdomain, checked to be
 * an `https://*.workers.dev` origin before anything is sent to it.
 */
export const coreOrigin = (coreScript: string, subdomain: string): string => {
  const origin = `https://${coreScript}.${subdomain}.workers.dev`;
  if (!routerHostSchema.shape.coreUrl.safeParse(origin).success) {
    throw new DeployError(
      "invalid_core_origin",
      `${origin} isn't a workers.dev origin`
    );
  }
  return origin;
};

/** How the smoke check reaches core, and how long it waits between tries. */
export interface SmokeOptions {
  /** `fetch` by default. */
  fetch?: typeof fetch;
  /** The first retry's wait, doubling after; tests pass 0. */
  retryDelayMs?: number;
  /** How long one try may take, its body included; tests pass less. */
  attemptTimeoutMs?: number;
}

/** Tries of the smoke check: a new workers.dev hostname can take a moment. */
const smokeAttempts = 5;
const defaultSmokeDelayMs = 2000;
/**
 * How long one try may take. With the waits between them, the check takes
 * at most about 80 s (5 tries of 10 s, and 30 s of waiting).
 */
const defaultAttemptTimeoutMs = 10_000;

/** What core's `/health` answers: the version answering (core's src/entry.ts). */
const healthSchema = z.object({ ok: z.literal(true), version: z.string() });

/**
 * The version core's `/health` at `origin` names, to a request carrying
 * `routerSecret` as the router sends it; undefined when it doesn't
 * answer, answers otherwise, or takes longer than `timeoutMs` (its body
 * included): a stalled connection ends this try, not the check.
 */
export const answeringVersion = async (
  fetchCore: typeof fetch,
  origin: string,
  routerSecret: string,
  timeoutMs: number
): Promise<string | undefined> => {
  const limit = deadline(timeoutMs);
  try {
    const answer = async () => {
      const response = await fetchCore(`${origin}/health`, {
        headers: { [routerSecretHeader]: routerSecret },
        redirect: "manual",
        signal: limit.signal,
      });
      return response.ok ? await response.json() : undefined;
    };
    const body: unknown = await Promise.race([
      answer(),
      whenAborted(limit.signal),
    ]);
    const health = healthSchema.safeParse(body);
    return health.success ? health.data.version : undefined;
  } catch {
    return undefined;
  } finally {
    limit.clear();
  }
};

/**
 * Checks that core at `origin` answers its health check as version
 * `versionId`, to a request carrying the client's router secret as the
 * router sends it: so the version this deploy made live is the one
 * answering, and it has the secret the router will derive. Tries a few
 * times, each with its own deadline, waiting longer between them (a new
 * hostname, or the old version still answering, can take a moment);
 * returns how many tries it took.
 */
export const smokeCheck = async (
  origin: string,
  routerSecret: string,
  versionId: string,
  {
    fetch: fetchCore = fetch,
    retryDelayMs = defaultSmokeDelayMs,
    attemptTimeoutMs = defaultAttemptTimeoutMs,
  }: SmokeOptions = {}
): Promise<number> => {
  for (let attempt = 1; attempt <= smokeAttempts; attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop -- tries in turn
    const answering = await answeringVersion(
      fetchCore,
      origin,
      routerSecret,
      attemptTimeoutMs
    );
    if (answering === versionId) {
      return attempt;
    }
    if (attempt < smokeAttempts) {
      // oxlint-disable-next-line no-await-in-loop -- waits between tries
      await scheduler.wait(retryDelayMs * 2 ** (attempt - 1));
    }
  }
  throw new DeployError(
    "smoke_check_failed",
    `Core at ${origin} didn't answer as version ${versionId}`
  );
};

/** The entry the map has for `key`: absent, or checked against the router's schema. */
const storedEntry = async (
  hosts: RouterHosts,
  key: string
): Promise<RouterHost | null> => {
  const stored: unknown = await hosts.get(key, "json");
  if (stored === null) {
    return null;
  }
  const parsed = routerHostSchema.safeParse(stored);
  if (!parsed.success) {
    throw new DeployError(
      "router_entry_invalid",
      `${key}'s entry in the router's map isn't one the router reads: fix it by hand`
    );
  }
  return parsed.data;
};

/**
 * The entry the router's map has for `hostname`: the client and core it
 * routes to, and the generation it derives the router secret from; null
 * when it has none.
 */
export const mappedRoute = async (
  hosts: RouterHosts,
  hostname: string
): Promise<RouterHost | null> =>
  await storedEntry(hosts, routerHostKey(hostname));

/**
 * The secrets generation the router's map has for `hostname`, which the
 * router derives the secret it sends core from; null when it has none.
 */
export const mappedGeneration = async (
  hosts: RouterHosts,
  hostname: string
): Promise<number | null> => {
  const entry = await storedEntry(hosts, routerHostKey(hostname));
  return entry?.generation ?? null;
};

/** Throws unless `current` may be replaced by `entry`. */
const checkReplaceable = (
  key: string,
  current: RouterHost | null,
  entry: RouterHost
): void => {
  if (current !== null && current.clientId !== entry.clientId) {
    throw new DeployError("hostname_taken", `${key} routes to another client`);
  }
  if (current !== null && current.generation > entry.generation) {
    throw new DeployError(
      "generation_behind",
      `${key} is at a later generation than this deploy`
    );
  }
};

/**
 * Points `hostname` at the client's core in the router's map. Writing the
 * same entry again changes nothing. It refuses an entry that isn't one the
 * router reads (`router_entry_invalid`, for staff to fix by hand), a
 * hostname the map gives another client (`hostname_taken`: client ids, and
 * so hostnames, are one client's each), and a generation below the one the
 * map has (`generation_behind`: the router would derive a secret core no
 * longer has). `beforeWrite` runs as the last thing before the write: the
 * deploy checks there that it's still the client's latest, and its runner.
 *
 * KV has no compare-and-set, so the write can't be made conditional: one
 * runner per client (src/runners.ts) is the precondition, as
 * for D1 migrations. After the write the entry is read back, and one at a
 * lower generation than this deploy's fails loudly (`generation_behind`)
 * rather than passing as written. Should one runner ever not be enough,
 * the map moves into a Durable Object, which can compare and set.
 */
export const registerHostname = async (
  hosts: RouterHosts,
  hostname: string,
  entry: RouterHost,
  beforeWrite: () => Promise<void>
): Promise<void> => {
  const key = routerHostKey(hostname);
  checkReplaceable(key, await storedEntry(hosts, key), entry);
  const value = JSON.stringify(routerHostSchema.parse(entry));
  await beforeWrite();
  await hosts.put(key, value);
  const written = await storedEntry(hosts, key);
  if (written === null || written.generation < entry.generation) {
    throw new DeployError(
      "generation_behind",
      `${key} reads back below this deploy's generation after the write`
    );
  }
  checkReplaceable(key, written, entry);
};
