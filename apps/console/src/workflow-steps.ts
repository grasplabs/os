/**
 * How the console's Workflows (provisioning, src/provision/workflow.ts,
 * and rollouts, src/rollout/workflow.ts) run their steps: their retry
 * configs, and how a step fails. A failure a retry can fix is retried;
 * any other stops the run at once (`NonRetryableError`, carrying its
 * code). Either way nothing a step returns or throws carries a token or a
 * response body: Workflows stores both (threat model R17, CO3).
 */
import { NonRetryableError } from "cloudflare:workflows";

import { CloudflareApiError, isRefused } from "./cloudflare/api.ts";
import { MissingStoreSecretError } from "./deploy/context.ts";
import { errorCode } from "./deploy/deploy.ts";
import { DeployError } from "./deploy/errors.ts";
import type { DeployErrorCode } from "./deploy/errors.ts";

/** Quick steps: a few API calls or a row. */
export const quickStep = {
  retries: { limit: 3, delay: "10 seconds", backoff: "exponential" },
  timeout: "2 minutes",
} as const;

/**
 * A deploy, or a phase of one: uploads, migrations and a smoke check of
 * up to about 80 s. A retry resumes the same deploy, so it's retried less
 * often, and later.
 */
export const deployStepConfig = {
  retries: { limit: 2, delay: "1 minute", backoff: "exponential" },
  timeout: "30 minutes",
} as const;

/** Deploy failures a retry can fix: a new version still starting, a name race, a flaky query. */
const retryableDeployCodes: ReadonlySet<DeployErrorCode> = new Set([
  "smoke_check_failed",
  "subdomain_unavailable",
  "d1_migration_failed",
]);

/** A failure no retry fixes, as the run stops with it: its code, then what we say of it. */
export const stop = (code: string, detail?: string): NonRetryableError =>
  new NonRetryableError(detail === undefined ? code : `${code}: ${detail}`);

/**
 * `error` as a step fails with it, carrying its code and our own words,
 * never a response body. One a retry can't fix is a `NonRetryableError`:
 * every deploy failure but the few a retry can fix, a secret missing from
 * Secrets Store, and any API refusal but a timeout or a rate limit
 * (`isRefused`). Anything else is retried, as an `Error` saying what it
 * was: a deploy code, `cloudflare_<status>_<codes>`, our own message, or
 * only the name of an error we didn't throw (a parse error can quote what
 * it parsed).
 */
export const asStepError = (error: unknown): Error => {
  if (error instanceof NonRetryableError) {
    return error;
  }
  if (error instanceof DeployError) {
    return retryableDeployCodes.has(error.code)
      ? new Error(`${error.code}: ${error.message}`)
      : stop(error.code, error.message);
  }
  if (error instanceof MissingStoreSecretError) {
    return stop("store_secret_missing", error.message);
  }
  if (isRefused(error)) {
    return stop(errorCode(error));
  }
  if (error instanceof CloudflareApiError) {
    return new Error(errorCode(error));
  }
  if (error instanceof Error && error.name === "Error") {
    return new Error(error.message);
  }
  return new Error(
    `unexpected: ${error instanceof Error ? error.name : typeof error}`
  );
};

/** `task` as a step runs it, its failures as `asStepError` makes them. */
export const guarded =
  <T>(task: () => Promise<T>) =>
  async (): Promise<T> => {
    try {
      return await task();
    } catch (error) {
      throw asStepError(error);
    }
  };

/**
 * The error's class a step failure's message comes back to the run with
 * (`NonRetryableError: <code>: ...`), left off what's recorded.
 */
const errorNamePrefix = /^\w*Error: /u;

/**
 * The prefix of what the Workflows engine throws into a run it stops
 * itself (a pause, a terminate, a restart): the run isn't failing, so it
 * rethrows it at once and records nothing.
 */
const engineAbortPrefix = "Aborting engine:";

/** Whether `error` is the Workflows engine stopping the run (`engineAbortPrefix`). */
export const isEngineAbort = (error: unknown): boolean =>
  error instanceof Error && error.message.startsWith(engineAbortPrefix);

/** What a run records of the failure that stopped it: its code and our words. */
export const stopReason = (error: unknown): string =>
  error instanceof Error
    ? error.message.replace(errorNamePrefix, "")
    : "unexpected";
