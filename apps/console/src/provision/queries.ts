/** Reading clients and their provisioning, as the client pages show them. */
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import { consoleDatabase } from "../db/act.ts";
import { auditEvents, clients } from "../db/schema.ts";
import { clientDomain } from "../deploy/context.ts";
import { latestDeployOf } from "../deploy/deploy.ts";
import { currentRun, isReplaceable } from "./runs.ts";
import type { RunStatus } from "./runs.ts";
import { confirmedWorkersPaid } from "./workflow.ts";

/** A client as the list shows it. */
export interface ClientSummary {
  id: string;
  name: string;
  status: "provisioning" | "active" | "offboarded";
  ring: number;
  accountId: string;
}

/** Every client, by id. */
export const listClients = async (env: Env): Promise<ClientSummary[]> =>
  await consoleDatabase(env.DB)
    .select({
      id: clients.id,
      name: clients.name,
      status: clients.status,
      ring: clients.ring,
      accountId: clients.accountId,
    })
    .from(clients)
    .orderBy(asc(clients.id));

/**
 * Where a client's provisioning is, as its page tells staff what to do:
 * - `account`: the run is creating or reading the account;
 * - `workers_paid`: waiting for staff to upgrade the account;
 * - `deploying`: deploying the release;
 * - `active`: done;
 * - `failed`: the run stopped, or is gone (Workflows dropped it after its
 *   retention) while the client is still provisioning, for staff to fix
 *   what it says and resume.
 */
export type ProvisioningPhase =
  | "account"
  | "workers_paid"
  | "deploying"
  | "active"
  | "failed";

/** A client's provisioning, as its page shows it. */
export interface ProvisioningView {
  clientId: string;
  /** `<id>.<domain>`; null while the console has no domain. */
  hostname: string | null;
  client: {
    name: string;
    accountId: string;
    ring: number;
    status: ClientSummary["status"];
    createdBy: string | null;
    createdAt: Date;
  } | null;
  /** Its latest deploy. */
  deploy: {
    releaseId: string;
    status: "running" | "done" | "failed" | "superseded";
    /** The last step that finished. */
    step: string | null;
    error: string | null;
  } | null;
  /**
   * Its current run's status (src/provision/runs.ts): Workflows', or
   * `starting`, or `gone`; null when it has none.
   */
  run: RunStatus | null;
  /**
   * Why its run last stopped (`client.provision_stop`): the step and the
   * error's code with our words. Null when it hasn't, or was started or
   * resumed since.
   */
  stopped: { step: string; error: string } | null;
  /** Whether staff confirmed Workers Paid already (`client.workers_paid`). */
  workersPaidConfirmed: boolean;
  phase: ProvisioningPhase;
}

const stopSchema = z.object({ step: z.string(), error: z.string() });

/** Why client `clientId`'s run last stopped, unless it was started or resumed since. */
const stopOf = async (
  env: Env,
  clientId: string
): Promise<ProvisioningView["stopped"]> => {
  const [latest] = await consoleDatabase(env.DB)
    .select({ action: auditEvents.action, detail: auditEvents.detail })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.clientId, clientId),
        inArray(auditEvents.action, [
          "client.provision_start",
          "client.provision_retry",
          "client.provision_stop",
        ])
      )
    )
    // Events of one millisecond in the order they were written.
    .orderBy(desc(auditEvents.at), desc(sql`rowid`))
    .limit(1);
  if (latest?.action !== "client.provision_stop") {
    return null;
  }
  const parsed = stopSchema.safeParse(JSON.parse(latest.detail ?? "null"));
  return parsed.success ? parsed.data : null;
};

const phaseOf = (
  view: Omit<ProvisioningView, "phase" | "stopped" | "workersPaidConfirmed">
): ProvisioningPhase => {
  if (view.client?.status === "active") {
    return "active";
  }
  // A client with no run at all can only be resumed.
  const runless = view.run === null && view.client !== null;
  if (runless || (view.run !== null && isReplaceable(view.run))) {
    return "failed";
  }
  if (view.deploy !== null) {
    return "deploying";
  }
  return view.client === null ? "account" : "workers_paid";
};

/**
 * Client `clientId`'s provisioning, or null when it has neither a record
 * nor a run.
 */
export const getProvisioning = async (
  env: Env,
  clientId: string
): Promise<ProvisioningView | null> => {
  const db = consoleDatabase(env.DB);
  const [client] = await db
    .select({
      name: clients.name,
      accountId: clients.accountId,
      ring: clients.ring,
      status: clients.status,
      createdBy: clients.createdBy,
      createdAt: clients.createdAt,
    })
    .from(clients)
    .where(eq(clients.id, clientId));
  const latest = await latestDeployOf(db, clientId);
  const current = await currentRun(env, clientId);
  const run = current?.status ?? null;
  if (client === undefined && run === null) {
    return null;
  }
  const domain = clientDomain(env);
  const view = {
    clientId,
    hostname: domain === null ? null : `${clientId}.${domain}`,
    client: client ?? null,
    deploy:
      latest === undefined
        ? null
        : {
            releaseId: latest.releaseId,
            status: latest.status,
            step: latest.step,
            error: latest.error,
          },
    run,
  };
  return {
    ...view,
    stopped: await stopOf(env, clientId),
    workersPaidConfirmed: await confirmedWorkersPaid(db, clientId),
    phase: phaseOf(view),
  };
};
