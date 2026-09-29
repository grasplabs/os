/** Reading clients and their provisioning, as the client pages show them. */
import { asc, desc, eq, sql } from "drizzle-orm";

import { consoleDatabase } from "../db/act.ts";
import { clientDeploys, clients } from "../db/schema.ts";
import { clientDomain } from "../deploy/context.ts";
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
 * - `failed`: the run stopped, for staff to fix what it says and resume.
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
  /** Its run, as Workflows reports it; null when it has none. */
  run: { status: InstanceStatus["status"]; error: string | null } | null;
  phase: ProvisioningPhase;
}

/** Client `clientId`'s run, as Workflows reports it, or null when it has none. */
const runStatus = async (
  env: Env,
  clientId: string
): Promise<ProvisioningView["run"]> => {
  const run = await runOf(env, clientId);
  if (run === null) {
    return null;
  }
  const { status, error } = await run.status();
  return { status, error: error?.message ?? null };
};

const phaseOf = (view: Omit<ProvisioningView, "phase">): ProvisioningPhase => {
  if (view.run !== null && endedStatuses.has(view.run.status)) {
    return "failed";
  }
  if (view.client?.status === "active") {
    return "active";
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
  const [deploy] = await db
    .select({
      releaseId: clientDeploys.releaseId,
      status: clientDeploys.status,
      step: clientDeploys.step,
      error: clientDeploys.error,
    })
    .from(clientDeploys)
    .where(eq(clientDeploys.clientId, clientId))
    .orderBy(desc(clientDeploys.createdAt), desc(sql`rowid`))
    .limit(1);
  const run = await runStatus(env, clientId);
  if (client === undefined && run === null) {
    return null;
  }
  const domain = clientDomain(env);
  const view = {
    clientId,
    hostname: domain === null ? null : `${clientId}.${domain}`,
    client: client ?? null,
    deploy: deploy ?? null,
    run,
  };
  return { ...view, phase: phaseOf(view) };
};
