/**
 * What staff do with a client's provisioning (src/provision/workflow.ts):
 * start it, confirm the account is on Workers Paid, and resume a run that
 * failed or is gone. Each is audited before it acts on the Workflow, so an action
 * that then fails is still an audited attempt.
 *
 * A run's instance id is its client's id: Workflows refuses a second
 * instance of one id, so two starts for one client (two staff members at
 * once) end with one run.
 */
import { releaseIdSchema } from "@grasp-os/shared/release";
import { newClientIdSchema } from "@grasp-os/shared/router";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import type { Staff } from "../access.ts";
import { getAccount } from "../cloudflare/accounts.ts";
import { CloudflareApiError } from "../cloudflare/api.ts";
import { audit, consoleDatabase } from "../db/act.ts";
import type { ConsoleDatabase } from "../db/act.ts";
import { auditEvents, clients, releases } from "../db/schema.ts";
import { clientDomain, deployerApi } from "../deploy/context.ts";
import { latestDeployOf } from "../deploy/deploy.ts";
import { scriptInTheWay, workersPaidEvent } from "./workflow.ts";
import type { ProvisionParams } from "./workflow.ts";

/** Why staff's action was refused, as the page shows it. */
export const provisionErrorCodes = [
  /** The console has no CLIENT_DOMAIN, so no client can get a hostname. */
  "domain_not_set",
  /** The release isn't imported. */
  "release_not_imported",
  /** A client of that id exists already. */
  "client_exists",
  /** Another client is on that account. */
  "account_taken",
  /** The account runs a Grasp Worker: staging, the console's, or a client's the console doesn't know. */
  "account_in_use",
  /** The deployer isn't a member of the account to adopt. */
  "account_unreachable",
  /** A run for that client is still going. */
  "already_running",
  /** No run for that client, or it isn't where the action applies. */
  "not_provisioning",
] as const;
export type ProvisionErrorCode = (typeof provisionErrorCodes)[number];

export class ProvisionError extends Error {
  readonly code: ProvisionErrorCode;

  constructor(code: ProvisionErrorCode, message: string) {
    super(message);
    this.name = "ProvisionError";
    this.code = code;
  }
}

/** A Cloudflare account id: 32 hex characters. */
const accountIdSchema = z.string().regex(/^[0-9a-f]{32}$/u);

/** What staff fill in to start provisioning a client. */
export const provisionInputSchema = z.object({
  clientId: newClientIdSchema,
  name: z.string().trim().min(1).max(100),
  /** Left out to have the run create the account. */
  accountId: accountIdSchema.optional(),
  releaseId: releaseIdSchema,
  ring: z.int().nonnegative(),
});
export type ProvisionInput = z.infer<typeof provisionInputSchema>;

/** A run that ended without finishing, which a new start may replace. */
export const endedStatuses: ReadonlySet<InstanceStatus["status"]> = new Set([
  "errored",
  "terminated",
]);

/** The client `id`'s row, if there is one. */
const clientOf = async (env: Env, id: string) => {
  const db = consoleDatabase(env.DB);
  const [row] = await db
    .select({
      name: clients.name,
      accountId: clients.accountId,
      ring: clients.ring,
      status: clients.status,
    })
    .from(clients)
    .where(eq(clients.id, id));
  return row;
};

/** The run of client `clientId`, or null when there's none. */
export const runOf = async (
  env: Env,
  clientId: string
): Promise<WorkflowInstance | null> => {
  try {
    return await env.PROVISION_CLIENT.get(clientId);
  } catch {
    // Workflows throws for an instance id it doesn't have, or no longer
    // has (its retention passed).
    return null;
  }
};

/** Where `run` is. */
const statusOf = async (
  run: WorkflowInstance
): Promise<InstanceStatus["status"]> => {
  const { status } = await run.status();
  return status;
};

/**
 * Refuses an account to adopt for client `clientId` unless the deployer
 * can reach it (`account_unreachable`) and it's free: no other client's
 * (`account_taken`), and running no Grasp Worker (`account_in_use`), which
 * keeps staging, the console's own account and clients the console
 * doesn't know out. The run checks both again in its account step.
 */
const checkAdoptable = async (
  env: Env,
  clientId: string,
  accountId: string
): Promise<void> => {
  const db = consoleDatabase(env.DB);
  const [holder] = await db
    .select({ id: clients.id })
    .from(clients)
    .where(eq(clients.accountId, accountId));
  if (holder !== undefined) {
    throw new ProvisionError(
      "account_taken",
      `Account ${accountId} is client ${holder.id}'s`
    );
  }
  const api = await deployerApi(env);
  try {
    await getAccount(api, accountId);
  } catch (error) {
    if (
      error instanceof CloudflareApiError &&
      (error.status === 403 || error.status === 404)
    ) {
      throw new ProvisionError(
        "account_unreachable",
        `The deployer isn't a member of account ${accountId}`
      );
    }
    throw error;
  }
  const inTheWay = await scriptInTheWay(api, db, accountId, clientId);
  if (inTheWay !== undefined) {
    throw new ProvisionError(
      "account_in_use",
      `Account ${accountId} already runs ${inTheWay}`
    );
  }
};

/**
 * Starts provisioning the client `input` describes, as `staff`, and
 * returns its id. A client whose run is still going is refused, and so is
 * one that exists (its page resumes its run instead) and an account that
 * isn't free (`checkAdoptable`). A run for the id that ended before it
 * recorded the client (an account it couldn't create or read) is
 * replaced, so staff can start again with another account.
 */
export const startProvisioning = async (
  env: Env,
  staff: Staff,
  input: ProvisionInput
): Promise<string> => {
  const db = consoleDatabase(env.DB);
  const parsed = provisionInputSchema.parse(input);
  const { clientId, accountId, releaseId } = parsed;
  if (clientDomain(env) === null) {
    throw new ProvisionError(
      "domain_not_set",
      "Set CLIENT_DOMAIN on the console before provisioning a client"
    );
  }
  const [release] = await db
    .select({ id: releases.id })
    .from(releases)
    .where(eq(releases.id, releaseId));
  if (release === undefined) {
    throw new ProvisionError(
      "release_not_imported",
      `Release ${releaseId} isn't imported`
    );
  }
  const existing = await runOf(env, clientId);
  const status = existing === null ? null : await statusOf(existing);
  // A finished run leaves its client, refused next.
  if (status !== null && status !== "complete" && !endedStatuses.has(status)) {
    throw new ProvisionError(
      "already_running",
      `Client ${clientId} is being provisioned`
    );
  }
  if ((await clientOf(env, clientId)) !== undefined) {
    throw new ProvisionError("client_exists", `Client ${clientId} exists`);
  }
  if (accountId !== undefined) {
    await checkAdoptable(env, clientId, accountId);
  }
  const params: ProvisionParams = {
    ...parsed,
    startedBy: { email: staff.email, sub: staff.sub },
  };
  await audit(db, staff, {
    action: "client.provision_start",
    clientId,
    target: releaseId,
    detail: {
      account: accountId ?? "new",
      ring: params.ring,
      replaces: existing !== null,
    },
  });
  if (existing !== null) {
    // Read again right before: a start that raced this one may have
    // replaced the ended run already, and its new run must stay.
    if (!endedStatuses.has(await statusOf(existing))) {
      throw new ProvisionError(
        "already_running",
        `Client ${clientId} is being provisioned`
      );
    }
    await existing.delete();
  }
  // Two starts that raced past the checks above: Workflows refuses the
  // second instance of an id, so one run goes on.
  await env.PROVISION_CLIENT.create({ id: clientId, params });
  return clientId;
};

/**
 * Tells client `clientId`'s run that its account is on Workers Paid, as
 * `staff`. Refused unless the client is being provisioned by a run.
 * Sending it again, or before the run waits for it, is harmless: the run
 * takes the first when it gets there.
 */
export const confirmWorkersPaid = async (
  env: Env,
  staff: Staff,
  clientId: string
): Promise<void> => {
  const client = await clientOf(env, clientId);
  const run = await runOf(env, clientId);
  if (client?.status !== "provisioning" || run === null) {
    throw new ProvisionError(
      "not_provisioning",
      `Client ${clientId} isn't waiting for Workers Paid`
    );
  }
  await audit(consoleDatabase(env.DB), staff, {
    action: "client.workers_paid",
    clientId,
  });
  await run.sendEvent({ type: workersPaidEvent, payload: {} });
};

/**
 * The release a client's new run deploys: its latest deploy's, else the
 * one staff last started or resumed it with (the audit event's target).
 */
const releaseToResume = async (
  db: ConsoleDatabase,
  clientId: string
): Promise<string> => {
  const latest = await latestDeployOf(db, clientId);
  if (latest !== undefined) {
    return latest.releaseId;
  }
  const [started] = await db
    .select({ releaseId: auditEvents.target })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.clientId, clientId),
        inArray(auditEvents.action, [
          "client.provision_start",
          "client.provision_retry",
        ])
      )
    )
    .orderBy(desc(auditEvents.at), desc(sql`rowid`))
    .limit(1);
  if (started?.releaseId === null || started === undefined) {
    throw new ProvisionError(
      "release_not_imported",
      `No release to resume ${clientId} with`
    );
  }
  return started.releaseId;
};

/** Whether staff confirmed Workers Paid for client `clientId`, in any run. */
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

/**
 * Resumes provisioning client `clientId`, as `staff`, with a new run made
 * from the client's record: the release its latest deploy was of (or the
 * one it was started with), and no Workers Paid pause once staff
 * confirmed it. A run that ended without finishing is deleted first; one
 * that's gone (Workflows dropped it after its retention) needs nothing.
 * One path for both, whichever step the old run stopped at: every step
 * finds what an earlier run made, and the deploy resumes the client's
 * failed deploy, so nothing is made twice.
 *
 * Refused unless the client is recorded and still provisioning (a run
 * that stopped before it recorded the client is started again instead),
 * and while its run is still going.
 */
export const retryProvisioning = async (
  env: Env,
  staff: Staff,
  clientId: string
): Promise<void> => {
  const db = consoleDatabase(env.DB);
  const client = await clientOf(env, clientId);
  if (client?.status !== "provisioning") {
    throw new ProvisionError(
      "not_provisioning",
      `Client ${clientId} isn't being provisioned`
    );
  }
  const run = await runOf(env, clientId);
  const stillGoing = async () =>
    run !== null && !endedStatuses.has(await statusOf(run));
  if (await stillGoing()) {
    throw new ProvisionError(
      "already_running",
      `Client ${clientId}'s run is still going`
    );
  }
  const releaseId = await releaseToResume(db, clientId);
  const workersPaid = await confirmedWorkersPaid(db, clientId);
  await audit(db, staff, {
    action: "client.provision_retry",
    clientId,
    target: releaseId,
    detail: { replaces: run !== null, workersPaid },
  });
  if (run !== null) {
    // Read again right before: a resume that raced this one may have
    // replaced the ended run already, and its new run must stay.
    if (await stillGoing()) {
      throw new ProvisionError(
        "already_running",
        `Client ${clientId}'s run is still going`
      );
    }
    await run.delete();
  }
  await env.PROVISION_CLIENT.create({
    id: clientId,
    params: {
      clientId,
      name: client.name,
      accountId: client.accountId,
      releaseId,
      ring: client.ring,
      startedBy: { email: staff.email, sub: staff.sub },
      workersPaid,
    } satisfies ProvisionParams,
  });
};
