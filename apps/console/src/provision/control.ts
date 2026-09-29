/**
 * What staff do with a client's provisioning (src/provision/workflow.ts):
 * start it, confirm the account is on Workers Paid, and resume a run that
 * failed. Each is audited before it acts on the Workflow, so an action
 * that then fails is still an audited attempt.
 *
 * A run's instance id is its client's id: Workflows refuses a second
 * instance of one id, so two starts for one client (two staff members at
 * once) end with one run.
 */
import { releaseIdSchema } from "@grasp-os/shared/release";
import { newClientIdSchema } from "@grasp-os/shared/router";
import { eq } from "drizzle-orm";
import { z } from "zod";

import type { Staff } from "../access.ts";
import { audit, consoleDatabase } from "../db/act.ts";
import { clientDeploys, clients, releases } from "../db/schema.ts";
import { clientDomain } from "../deploy/context.ts";
import { deployStep, workersPaidEvent } from "./workflow.ts";
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
const endedStatuses: ReadonlySet<InstanceStatus["status"]> = new Set([
  "errored",
  "terminated",
]);

/** The client `id`'s row, if there is one. */
const clientOf = async (env: Env, id: string) => {
  const db = consoleDatabase(env.DB);
  const [row] = await db
    .select({ status: clients.status })
    .from(clients)
    .where(eq(clients.id, id));
  return row;
};

/** The run of client `clientId`, or null when there's none. */
const runOf = async (
  env: Env,
  clientId: string
): Promise<WorkflowInstance | null> => {
  try {
    return await env.PROVISION_CLIENT.get(clientId);
  } catch {
    // Workflows throws for an instance id it doesn't have.
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
 * Starts provisioning the client `input` describes, as `staff`, and
 * returns its id. A client whose run is still going is refused, and so is
 * one that exists (its page resumes its run instead) and an account
 * another client has. A run for the id that ended before it recorded the
 * client (an account it couldn't create or read) is replaced, so staff
 * can start again with another account.
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
  await existing?.delete();
  // Two starts that raced past the checks above: Workflows refuses the
  // second instance of an id, so one run goes on.
  await env.PROVISION_CLIENT.create({ id: clientId, params });
  return clientId;
};

/**
 * Tells client `clientId`'s run that its account is on Workers Paid, as
 * `staff`. Refused unless the client is being provisioned. Sending it
 * again, or before the run waits for it, is harmless: the run takes the
 * first when it gets there.
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
 * Resumes client `clientId`'s run that failed, as `staff`: from its deploy
 * once it got that far, so the account and the Workers Paid confirmation
 * stand, or else from the start. Everything a run makes it finds again,
 * so nothing is made twice. Refused unless the run ended without
 * finishing.
 */
export const retryProvisioning = async (
  env: Env,
  staff: Staff,
  clientId: string
): Promise<void> => {
  const run = await runOf(env, clientId);
  const status = run === null ? null : await statusOf(run);
  if (run === null || status === null || !endedStatuses.has(status)) {
    throw new ProvisionError(
      "not_provisioning",
      `Client ${clientId} has no failed run to resume`
    );
  }
  const db = consoleDatabase(env.DB);
  const [deploy] = await db
    .select({ id: clientDeploys.id })
    .from(clientDeploys)
    .where(eq(clientDeploys.clientId, clientId))
    .limit(1);
  const from = deploy === undefined ? "start" : deployStep;
  await audit(db, staff, {
    action: "client.provision_retry",
    clientId,
    detail: { from },
  });
  await run.restart(
    deploy === undefined ? undefined : { from: { name: deployStep } }
  );
};
