/** Reading clients and their provisioning, as the client pages show them. */
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import { consoleDatabase } from "../db/act.ts";
import { auditEvents, clients } from "../db/schema.ts";
import { clientDomain } from "../deploy/context.ts";
import { latestDeployOf } from "../deploy/deploy.ts";
import { endedStatuses, runOf } from "./control.ts";

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
  /** Its run's status, as Workflows reports it; null when it has none. */
  run: InstanceStatus["status"] | null;
  /**
   * Why its run last stopped (`client.provision_stop`): the step and the
   * error's code with our words. Null when it hasn't, or was started or
   * resumed since.
   */
  stopped: { step: string; error: string } | null;
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

/** Client `clientId`'s run's status, or null when it has none. */
const runStatus = async (
  env: Env,
  clientId: string
): Promise<ProvisioningView["run"]> => {
  const run = await runOf(env, clientId);
  if (run === null) {
    return null;
  }
  const { status } = await run.status();
  return status;
};

const phaseOf = (
  view: Omit<ProvisioningView, "phase" | "stopped">
): ProvisioningPhase => {
  if (view.client?.status === "active") {
    return "active";
  }
  const gone = view.run === null && view.client !== null;
  if (gone || (view.run !== null && endedStatuses.has(view.run))) {
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
  const run = await runStatus(env, clientId);
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
    phase: phaseOf(view),
  };
};
