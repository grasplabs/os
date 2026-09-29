/**
 * What staff do with a client's provisioning (src/provision/workflow.ts):
 * start it, confirm the account is on Workers Paid, and resume a run that
 * stopped or is gone.
 *
 * Starting and resuming claim the client's next run in D1, audited in the
 * same batch (src/runners.ts): of two staff members acting at once,
 * one wins and creates a run, the other is refused (`already_running`).
 */
import { releaseIdSchema } from "@grasp-os/shared/release";
import { newClientIdSchema } from "@grasp-os/shared/router";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import type { Staff } from "../access.ts";
import { getAccount } from "../cloudflare/accounts.ts";
import { isRefused } from "../cloudflare/api.ts";
import { audit, consoleDatabase } from "../db/act.ts";
import type { ConsoleDatabase } from "../db/act.ts";
import { auditEvents, clients, releases } from "../db/schema.ts";
import { clientDomain, deployerApi, signInApps } from "../deploy/context.ts";
import { clientSignInSchema, missingSignInApp } from "../deploy/core-config.ts";
import { latestDeployOf } from "../deploy/deploy.ts";
import { claimRun, currentRun, isReplaceable } from "../runners.ts";
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
  /** A run for that client is still going, or another staff member just started or resumed one. */
  "already_running",
  /** No run for that client, or it isn't where the action applies. */
  "not_provisioning",
  /** Its sign-in names an IdP the console has no OAuth app id for. */
  "sign_in_app_missing",
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
  /** How its people sign in: every deploy makes core's `SIGN_IN` from it. */
  signIn: clientSignInSchema,
});
export type ProvisionInput = z.infer<typeof provisionInputSchema>;

const alreadyRunning = (clientId: string): ProvisionError =>
  new ProvisionError(
    "already_running",
    `Client ${clientId} is being provisioned already`
  );

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
    if (isRefused(error)) {
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
 * isn't free (`checkAdoptable`). A run that stopped before it recorded the
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
  const missing = missingSignInApp(parsed.signIn, signInApps(env));
  if (missing !== null) {
    throw new ProvisionError(
      "sign_in_app_missing",
      `The console has no ${missing} app id for ${clientId}'s sign-in`
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
  const run = await currentRun(env, clientId);
  // A finished run leaves its client, refused next.
  if (run !== null && run.status !== "complete" && !isReplaceable(run.status)) {
    throw alreadyRunning(clientId);
  }
  if ((await clientOf(env, clientId)) !== undefined) {
    throw new ProvisionError("client_exists", `Client ${clientId} exists`);
  }
  if (accountId !== undefined) {
    await checkAdoptable(env, clientId, accountId);
  }
  const runId = await claimRun(db, staff, clientId, run?.runId ?? null, {
    action: "client.provision_start",
    clientId,
    target: releaseId,
    detail: {
      account: accountId ?? "new",
      ring: parsed.ring,
      ...(run === null ? {} : { replaces: run.runId }),
    },
  });
  if (runId === undefined) {
    throw alreadyRunning(clientId);
  }
  const params: ProvisionParams = {
    ...parsed,
    startedBy: { email: staff.email, sub: staff.sub },
  };
  await env.PROVISION_CLIENT.create({ id: runId, params });
  return clientId;
};

/**
 * Records, as `staff`, that client `clientId`'s account is on Workers
 * Paid, then tells the client's current run, as `client_runs` names it
 * once the confirmation is recorded. Every run checks for the
 * confirmation before it waits for it, so whichever run is current when
 * a resume races this one, it goes on: the one told, or a new one that
 * finds the confirmation. Refused unless the client is being provisioned
 * and has had a run. Confirming again, or before the run waits, is
 * harmless.
 */
export const confirmWorkersPaid = async (
  env: Env,
  staff: Staff,
  clientId: string
): Promise<void> => {
  const client = await clientOf(env, clientId);
  if (
    client?.status !== "provisioning" ||
    (await currentRun(env, clientId)) === null
  ) {
    throw new ProvisionError(
      "not_provisioning",
      `Client ${clientId} isn't waiting for Workers Paid`
    );
  }
  await audit(consoleDatabase(env.DB), staff, {
    action: "client.workers_paid",
    clientId,
  });
  // Read after the confirmation is recorded: a run claimed since finds it.
  const run = await currentRun(env, clientId);
  // A run that stopped takes no event; the one that replaces it finds the
  // confirmation instead.
  const instance = run?.instance ?? null;
  if (run !== null && instance !== null && !isReplaceable(run.status)) {
    await instance.sendEvent({ type: workersPaidEvent, payload: {} });
  }
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

/**
 * Resumes provisioning client `clientId`, as `staff`, with a new run made
 * from the client's record, with the release its latest deploy was of (or
 * the one it was started with); it waits for Workers Paid only if staff
 * never confirmed it. One path whichever step the old run stopped at, and
 * whether it stopped or is gone: every step finds what an earlier run
 * made, and the deploy resumes the client's failed deploy, so nothing is
 * made twice.
 *
 * Refused unless the client is recorded and still provisioning (a run
 * that stopped before it recorded the client is started again instead),
 * while its run is still going, and when another staff member's resume
 * claimed the new run first.
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
  const run = await currentRun(env, clientId);
  if (run !== null && !isReplaceable(run.status)) {
    throw alreadyRunning(clientId);
  }
  const releaseId = await releaseToResume(db, clientId);
  const runId = await claimRun(db, staff, clientId, run?.runId ?? null, {
    action: "client.provision_retry",
    clientId,
    target: releaseId,
    detail: run === null ? {} : { replaces: run.runId },
  });
  if (runId === undefined) {
    throw alreadyRunning(clientId);
  }
  await env.PROVISION_CLIENT.create({
    id: runId,
    params: {
      clientId,
      name: client.name,
      accountId: client.accountId,
      releaseId,
      ring: client.ring,
      startedBy: { email: staff.email, sub: staff.sub },
    } satisfies ProvisionParams,
  });
};
