/**
 * Onboarding a client, as a Cloudflare Workflow: its account (created, or
 * adopted by id), its client record, a pause while staff upgrade the
 * account to Workers Paid, then a deploy of the chosen release (its EU
 * resources, migrations, Workers with their secrets, smoke check and
 * hostname in the router's map, src/deploy/deploy.ts), and the client
 * marked active.
 *
 * One run per client at a time: each is an instance of its own, and
 * starting or resuming claims it in D1 first (src/provision/runs.ts), so
 * a second start or resume for the same client can't run beside the
 * first: the single runner that a deploy's D1 migrations and router map
 * write rely on.
 *
 * Every step can run again: the account is found by name before it's
 * created, the record is inserted once, and a deploy finds what it made
 * before (src/deploy/deploy.ts). A step that fails for a reason a retry
 * can fix is retried; any other failure stops the run at once
 * (`NonRetryableError`, carrying its code), for staff to fix and resume
 * (`retryProvisioning`, a new run from the client's record). Either way
 * nothing is made twice.
 *
 * Two tokens, by privilege, both from Secrets Store: the tenant admin's,
 * read only in the account step, creates the account and makes the
 * deployer a member; the deployer's, scoped to what a deploy does, does
 * everything else. Neither is ever returned from a step: a step's result
 * and the run's params are stored by Workflows (threat model R17, CO3).
 */
import { log } from "@grasp-os/shared/log";
import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { and, eq } from "drizzle-orm";

import type { Staff } from "../access.ts";
import {
  ensureAccount,
  ensureMember,
  findAccount,
  getAccount,
  tokenUserEmail,
} from "../cloudflare/accounts.ts";
import { CloudflareApiError, isRefused } from "../cloudflare/api.ts";
import type { CloudflareApi } from "../cloudflare/api.ts";
import { listScripts } from "../cloudflare/workers.ts";
import { actIfChanged, audit, consoleDatabase } from "../db/act.ts";
import type { ConsoleDatabase } from "../db/act.ts";
import { auditEvents, clients } from "../db/schema.ts";
import {
  deployContext,
  deployerApi,
  MissingStoreSecretError,
  tenantAdminApi,
} from "../deploy/context.ts";
import {
  errorCode,
  latestDeployOf,
  runDeploy,
  startDeploy,
} from "../deploy/deploy.ts";
import { DeployError } from "../deploy/errors.ts";
import type { DeployErrorCode } from "../deploy/errors.ts";

/** What a run is started with: identifiers only, since Workflows stores them. */
export interface ProvisionParams {
  /** The client's id, its hostname's label (`newClientIdSchema`). */
  clientId: string;
  name: string;
  /** An account to adopt; without one, the run creates `grasp-os-<clientId>`. */
  accountId?: string;
  /** The release to deploy first. */
  releaseId: string;
  ring: number;
  /** The staff member who started it. */
  startedBy: Staff;
}

/** The event staff send once the account is on Workers Paid. */
export const workersPaidEvent = "workers-paid";

/**
 * Whether staff confirmed Workers Paid for client `clientId`, in this run
 * or an earlier one (`client.workers_paid`).
 */
const confirmedWorkersPaid = async (
  db: ConsoleDatabase,
  clientId: string
): Promise<boolean> => {
  const [confirmed] = await db
    .select({ id: auditEvents.id })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.clientId, clientId),
        eq(auditEvents.action, "client.workers_paid")
      )
    )
    .limit(1);
  return confirmed !== undefined;
};

/** The deploy step, as a stopped run's audit event names it. */
const deployStep = "deploy";

/** The name of the account a run creates for a client. */
export const accountName = (clientId: string): string => `grasp-os-${clientId}`;

/**
 * The role the tenant admin gives the deployer in a new account. What the
 * deployer can do there is what its token's permissions allow within this
 * role, so the token, scoped to deploying, is what limits it.
 */
const deployerRole = "Administrator";

/** Grasp's Worker scripts, as every release names them. */
const graspScriptPrefix = "grasp-os-";

/** Quick steps: a few API calls or a row. */
const quickStep = {
  retries: { limit: 3, delay: "10 seconds", backoff: "exponential" },
  timeout: "2 minutes",
} as const;

/**
 * The deploy: uploads, migrations and a smoke check of up to about 80 s.
 * A retry resumes the same deploy, so it's retried less often, and later.
 */
const deployStepConfig = {
  retries: { limit: 2, delay: "1 minute", backoff: "exponential" },
  timeout: "30 minutes",
} as const;

/**
 * How long a run waits for Workers Paid before it fails; a failed run is
 * resumed from the page.
 */
const workersPaidTimeout = "30 days";

/** Deploy failures a retry can fix: a new version still starting, a name race, a flaky query. */
const retryableDeployCodes: ReadonlySet<DeployErrorCode> = new Set([
  "smoke_check_failed",
  "subdomain_unavailable",
  "d1_migration_failed",
]);

/** A failure no retry fixes, as the run stops with it: its code, then what we say of it. */
const stop = (code: string, detail?: string): NonRetryableError =>
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
const asStepError = (error: unknown): Error => {
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

/**
 * Records that client `clientId`'s run stopped at `step` with `error` (its
 * code and our words), audited as `client.provision_stop`: Workflows
 * reports a stopped run only as stopped, so the page reads why from here.
 * A failure to record it is logged, not thrown, so the run fails with its
 * own error.
 */
const recordStop = async (
  db: ConsoleDatabase,
  clientId: string,
  step: string,
  error: string
): Promise<void> => {
  try {
    await audit(db, "system", {
      action: "client.provision_stop",
      clientId,
      detail: { step, error },
    });
  } catch (recordError) {
    log.error("provision.stop_unrecorded", {
      clientId,
      step,
      error: errorCode(recordError),
    });
  }
};

/**
 * The error's class a step failure's message comes back to the run with
 * (`NonRetryableError: <code>: ...`), left off what's recorded.
 */
const errorNamePrefix = /^\w*Error: /u;

/** `task` as a step runs it, its failures as `asStepError` makes them. */
const guarded =
  <T>(task: () => Promise<T>) =>
  async (): Promise<T> => {
    try {
      return await task();
    } catch (error) {
      throw asStepError(error);
    }
  };

/**
 * The Grasp Worker script in account `accountId` that makes it someone
 * else's, or undefined when it's free for client `clientId`: its own
 * recorded account, or one that runs no Grasp Worker. So another client's
 * account, staging's or the console's own can't be adopted and deployed
 * over, whether the console knows it or not.
 */
export const scriptInTheWay = async (
  api: CloudflareApi,
  db: ConsoleDatabase,
  accountId: string,
  clientId: string
): Promise<string | undefined> => {
  const [own] = await db
    .select({ id: clients.id })
    .from(clients)
    .where(and(eq(clients.id, clientId), eq(clients.accountId, accountId)));
  if (own !== undefined) {
    return undefined;
  }
  const scripts = await listScripts(api, accountId);
  return scripts.find((script) => script.startsWith(graspScriptPrefix));
};

/** The account a run works in, and one an earlier run made for it but left. */
interface RunAccount {
  accountId: string;
  /** `grasp-os-<clientId>`, made by an earlier run, when this one adopts another. */
  abandonedAccountId: string | null;
}

/**
 * The id of `grasp-os-<clientId>`, an account an earlier run made before
 * staff chose to adopt another, so the run records it for staff to close;
 * undefined when there's none, or no tenant admin token to look with.
 */
const madeEarlier = async (
  env: Env,
  clientId: string
): Promise<string | undefined> => {
  let tenant: CloudflareApi;
  try {
    tenant = await tenantAdminApi(env);
  } catch (error) {
    if (error instanceof MissingStoreSecretError) {
      return undefined;
    }
    throw error;
  }
  const made = await findAccount(tenant, accountName(clientId));
  return made?.id;
};

/**
 * The account step: creates `grasp-os-<clientId>` as the tenant admin
 * (found by name if it exists) and makes the deployer a member, or adopts
 * the account staff named, which the deployer must be a member of
 * already. Either way the deployer must reach it, and it must be free for
 * this client (`scriptInTheWay`).
 */
const settleAccount = async (
  env: Env,
  db: ConsoleDatabase,
  params: ProvisionParams
): Promise<RunAccount> => {
  const deployer = await deployerApi(env);
  let { accountId } = params;
  let abandonedAccountId: string | null = null;
  if (accountId === undefined) {
    const tenant = await tenantAdminApi(env);
    const account = await ensureAccount(tenant, accountName(params.clientId));
    await ensureMember(
      tenant,
      account.id,
      await tokenUserEmail(deployer),
      deployerRole
    );
    accountId = account.id;
  } else {
    const made = await madeEarlier(env, params.clientId);
    if (made !== undefined && made !== accountId) {
      abandonedAccountId = made;
    }
  }
  try {
    await getAccount(deployer, accountId);
  } catch (error) {
    if (isRefused(error)) {
      throw stop(
        "account_unreachable",
        `The deployer isn't a member of account ${accountId}`
      );
    }
    throw error;
  }
  const inTheWay = await scriptInTheWay(
    deployer,
    db,
    accountId,
    params.clientId
  );
  if (inTheWay !== undefined) {
    throw stop(
      "account_in_use",
      `Account ${accountId} already runs ${inTheWay}`
    );
  }
  return { accountId, abandonedAccountId };
};

/**
 * Records the client, audited as `client.create` by whoever started the
 * run, with an account an earlier run made and this one left. A client
 * already recorded on this account is left as it is (a step that runs
 * again); one on another account, or an account another client has, stops
 * the run.
 */
const recordClient = async (
  db: ConsoleDatabase,
  params: ProvisionParams,
  account: RunAccount
): Promise<void> => {
  const { accountId, abandonedAccountId } = account;
  const now = new Date();
  await actIfChanged(
    db,
    params.startedBy,
    db
      .insert(clients)
      .values({
        id: params.clientId,
        name: params.name,
        accountId,
        ring: params.ring,
        createdBy: params.startedBy.email,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing(),
    {
      action: "client.create",
      clientId: params.clientId,
      target: accountId,
      detail: {
        ring: params.ring,
        ...(abandonedAccountId === null ? {} : { abandonedAccountId }),
      },
    }
  );
  const [row] = await db
    .select({ accountId: clients.accountId })
    .from(clients)
    .where(eq(clients.id, params.clientId));
  if (row?.accountId !== accountId) {
    throw stop(
      row === undefined ? "account_taken" : "client_on_another_account",
      row === undefined
        ? `Account ${accountId} is another client's`
        : `Client ${params.clientId} is on another account`
    );
  }
};

/**
 * The deploy this run should run: the client's latest deploy when it's of
 * this release and its runner finished (failed or done), so a resume keeps
 * the versions it uploaded; otherwise a new one. A latest deploy still
 * `running` belongs to an attempt that stopped without recording it (its
 * isolate went away, or the step timed out), so it's superseded rather
 * than run twice at once.
 */
const deployToRun = async (
  db: ConsoleDatabase,
  params: ProvisionParams
): Promise<string> => {
  const latest = await latestDeployOf(db, params.clientId);
  if (
    latest?.releaseId === params.releaseId &&
    (latest.status === "failed" || latest.status === "done")
  ) {
    return latest.id;
  }
  return await startDeploy(
    db,
    params.startedBy,
    params.clientId,
    params.releaseId
  );
};

/** Marks the client active once its first deploy is live, audited once. */
const activate = async (
  db: ConsoleDatabase,
  clientId: string
): Promise<void> => {
  await actIfChanged(
    db,
    "system",
    db
      .update(clients)
      .set({ status: "active", updatedAt: new Date() })
      .where(and(eq(clients.id, clientId), eq(clients.status, "provisioning"))),
    { action: "client.activate", clientId }
  );
};

/** What a run returns: identifiers only. */
export interface ProvisionResult {
  accountId: string;
  deployId: string;
}

export class ProvisionClient extends WorkflowEntrypoint<Env, ProvisionParams> {
  override async run(
    event: WorkflowEvent<ProvisionParams>,
    step: WorkflowStep
  ): Promise<ProvisionResult> {
    const { payload: params } = event;
    const db = consoleDatabase(this.env.DB);

    // The step running now, so a run that stops, whatever stops it (a
    // failure no retry fixes, retries used up, the pause timing out),
    // records where.
    let current = "account";
    try {
      const account = await step.do(
        "account",
        quickStep,
        guarded(async () => await settleAccount(this.env, db, params))
      );

      current = "client";
      await step.do(
        "client",
        quickStep,
        guarded(async () => {
          await recordClient(db, params, account);
        })
      );

      // Workers Paid can't be bought through the API yet: staff upgrade the
      // account in the dashboard and confirm on the client's page.
      // Checked first: a confirmation recorded for an earlier run, or while
      // a resume replaced it, stands, and one recorded after this check
      // reaches this run as its event (src/provision/control.ts).
      current = "workers paid";
      const confirmed = await step.do(
        "workers paid confirmed",
        quickStep,
        guarded(async () => await confirmedWorkersPaid(db, params.clientId))
      );
      if (!confirmed) {
        await step.waitForEvent("workers paid", {
          type: workersPaidEvent,
          timeout: workersPaidTimeout,
        });
      }

      current = deployStep;
      const deployId = await step.do(
        deployStep,
        deployStepConfig,
        guarded(async () => {
          const context = await deployContext(this.env);
          const id = await deployToRun(context.db, params);
          await runDeploy(context, id);
          return id;
        })
      );

      current = "activate";
      await step.do(
        "activate",
        quickStep,
        guarded(async () => {
          await activate(db, params.clientId);
        })
      );
      return { accountId: account.accountId, deployId };
    } catch (error) {
      const failed = current;
      await step.do("record stop", quickStep, async () => {
        await recordStop(
          db,
          params.clientId,
          failed,
          error instanceof Error
            ? error.message.replace(errorNamePrefix, "")
            : "unexpected"
        );
      });
      throw error;
    }
  }
}
