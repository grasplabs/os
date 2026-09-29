/**
 * Onboarding a client, as a Cloudflare Workflow: its account (created, or
 * adopted by id), its client record, a pause while staff upgrade the
 * account to Workers Paid, then a deploy of the chosen release (its EU
 * resources, migrations, Workers with their secrets, smoke check and
 * hostname in the router's map, src/deploy/deploy.ts), and the client
 * marked active.
 *
 * One instance per client, its id the client's id (src/provision/control.ts),
 * so a second start for the same client can't run beside the first: the
 * single runner that a deploy's D1 migrations and router map write rely on.
 *
 * Every step can run again: the account is found by name before it's
 * created, the record is inserted once, and a deploy finds what it made
 * before (src/deploy/deploy.ts). A step that fails is retried, and a run
 * that failed is resumed from its deploy (`retryProvisioning`), so a
 * failure part way creates nothing twice.
 *
 * The deployer's token and the secrets are read from Secrets Store inside
 * each step and never returned from one: a step's result and the run's
 * params are stored by Workflows (threat model R17, CO3).
 */
import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { and, desc, eq, sql } from "drizzle-orm";

import type { Staff } from "../access.ts";
import { ensureAccount, getAccount } from "../cloudflare/accounts.ts";
import { actIfChanged, consoleDatabase } from "../db/act.ts";
import type { ConsoleDatabase } from "../db/act.ts";
import { clientDeploys, clients } from "../db/schema.ts";
import { deployContext, deployerApi } from "../deploy/context.ts";
import { runDeploy, startDeploy } from "../deploy/deploy.ts";

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
 * The step a failed run is resumed from once it got past the pause, so
 * staff don't confirm Workers Paid again.
 */
export const deployStep = "deploy";

/** The name of the account a run creates for a client. */
export const accountName = (clientId: string): string => `grasp-os-${clientId}`;

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
 * started again from the page.
 */
const workersPaidTimeout = "30 days";

/**
 * Records the client, audited as `client.create` by whoever started the
 * run. A client already recorded on this account is left as it is (a step
 * that runs again); one on another account, or an account another client
 * has, stops the run: that's for staff to sort out, not for a retry.
 */
const recordClient = async (
  db: ConsoleDatabase,
  params: ProvisionParams,
  accountId: string
): Promise<void> => {
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
      detail: { ring: params.ring },
    }
  );
  const [row] = await db
    .select({ accountId: clients.accountId })
    .from(clients)
    .where(eq(clients.id, params.clientId));
  if (row?.accountId !== accountId) {
    throw new NonRetryableError(
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
  const [latest] = await db
    .select({
      id: clientDeploys.id,
      releaseId: clientDeploys.releaseId,
      status: clientDeploys.status,
    })
    .from(clientDeploys)
    .where(eq(clientDeploys.clientId, params.clientId))
    .orderBy(desc(clientDeploys.createdAt), desc(sql`rowid`))
    .limit(1);
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

    const accountId = await step.do("account", quickStep, async () => {
      const api = await deployerApi(this.env);
      const account =
        params.accountId === undefined
          ? await ensureAccount(api, accountName(params.clientId))
          : await getAccount(api, params.accountId);
      return account.id;
    });

    await step.do("client", quickStep, async () => {
      await recordClient(db, params, accountId);
    });

    // Workers Paid can't be bought through the API yet: staff upgrade the
    // account in the dashboard and confirm on the client's page.
    await step.waitForEvent("workers paid", {
      type: workersPaidEvent,
      timeout: workersPaidTimeout,
    });

    const deployId = await step.do(deployStep, deployStepConfig, async () => {
      const context = await deployContext(this.env);
      const id = await deployToRun(context.db, params);
      await runDeploy(context, id);
      return id;
    });

    await step.do("activate", quickStep, async () => {
      await activate(db, params.clientId);
    });

    return { accountId, deployId };
  }
}
