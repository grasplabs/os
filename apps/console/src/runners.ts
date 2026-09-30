/**
 * A client's runner: the one thing that may change what its account runs,
 * as `client_runs` names it. A provisioning run (a Workflow instance per
 * attempt, `<clientId>-<random>`, src/provision/workflow.ts), a rollout
 * while it deploys the client (the rollout's instance,
 * src/rollout/workflow.ts), a rollback of the client (its instance,
 * src/rollout/rollback.ts), or applying its settings (its instance,
 * src/clients/apply.ts). Instances are never deleted or reused.
 *
 * A runner claims the client with one conditional write that names the
 * runner it replaces (none, for a client without one), audited in the
 * same batch. However many act at once, one claim wins and only its
 * caller goes on, so a client has one runner: the precondition of a
 * deploy's D1 migrations and router map write (src/deploy/deploy.ts). A
 * rollout or a rollback releases its claim once it's done with the
 * client; a provisioning run's stays, naming the client's last run. Only
 * a rollback takes a client from a runner still going, and only from the
 * rollout it rolls back.
 *
 * One set of rules for every runner: each is a Workflow instance, and it
 * holds the client while `client_runs` names it and its instance hasn't
 * ended (`hasEnded`); a claim whose instance doesn't exist yet counts as
 * starting for `startingMs`. A runner checks it still holds the client
 * right before and after each change it makes live, and every write it
 * makes to the client's record carries `stillHolds` in the same
 * statement, so one that lost the client changes nothing.
 */
import { and, eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import type { Actor, ConsoleDatabase, ConsoleEvent } from "./db/act.ts";
import { actIfChanged, consoleDatabase } from "./db/act.ts";
import { clientRuns } from "./db/schema.ts";

/** Which Workflow a runner is an instance of. */
export type RunKind = (typeof clientRuns.kind.enumValues)[number];

/**
 * Where a client's current run is: Workflows' status, `starting` for a run
 * claimed a moment ago that Workflows doesn't have yet (its creation is
 * under way), or `gone` for one Workflows doesn't have after that (its
 * retention passed, or its creation failed).
 */
export type RunStatus = InstanceStatus["status"] | "starting" | "gone";

/** A client's current run. */
export interface CurrentRun {
  runId: string;
  kind: RunKind;
  /** When it was claimed: what's newer belongs to it. */
  claimedAt: Date;
  status: RunStatus;
  /** The instance, when Workflows has it. */
  instance: WorkflowInstance | null;
}

/**
 * How long a claimed run Workflows doesn't have counts as starting: well
 * past the moment between a claim and its create. After it, the run is
 * gone and may be replaced.
 */
export const startingMs = 60_000;

/** Runs that ended without finishing, or that Workflows no longer has: a claim may replace them. */
const replaceable: ReadonlySet<RunStatus> = new Set([
  "errored",
  "terminated",
  "gone",
]);

/**
 * Whether a run in `status` stopped without finishing (or is gone), so a
 * new claim may replace it: what staff resume.
 */
export const isReplaceable = (status: RunStatus): boolean =>
  replaceable.has(status);

/**
 * Whether a run in `status` has ended, finished or not: another kind of
 * runner, such as a rollout, may take the client over from it.
 */
export const hasEnded = (status: RunStatus): boolean =>
  status === "complete" || isReplaceable(status);

/** Whether `error` is Workflows saying it has no instance of that id. */
const isMissingInstance = (error: unknown): boolean =>
  error instanceof Error && error.message.includes("instance.not_found");

/** The Workflow a runner of `kind` is an instance of. */
const workflows: Readonly<Record<RunKind, (env: Env) => Workflow>> = {
  provision: (env) => env.PROVISION_CLIENT,
  rollout: (env) => env.ROLLOUT,
  rollback: (env) => env.ROLLBACK_CLIENT,
  apply: (env) => env.APPLY_CLIENT,
};

/**
 * Where instance `id` of `workflow`, created (or about to be) at
 * `since`, is, and the instance when Workflows has it.
 */
export const instanceStatus = async (
  workflow: Workflow,
  id: string,
  since: Date
): Promise<{ status: RunStatus; instance: WorkflowInstance | null }> => {
  let instance: WorkflowInstance;
  try {
    instance = await workflow.get(id);
  } catch (error) {
    if (!isMissingInstance(error)) {
      throw error;
    }
    const starting = Date.now() - since.getTime() < startingMs;
    return { status: starting ? "starting" : "gone", instance: null };
  }
  const { status } = await instance.status();
  return { status, instance };
};

/** Client `clientId`'s current run, or null when it has none. */
export const currentRun = async (
  env: Env,
  clientId: string
): Promise<CurrentRun | null> => {
  const [claim] = await consoleDatabase(env.DB)
    .select({
      runId: clientRuns.runId,
      kind: clientRuns.kind,
      claimedAt: clientRuns.claimedAt,
    })
    .from(clientRuns)
    .where(eq(clientRuns.clientId, clientId));
  if (claim === undefined) {
    return null;
  }
  const where = await instanceStatus(
    workflows[claim.kind](env),
    claim.runId,
    claim.claimedAt
  );
  return { ...claim, ...where };
};

/** A new provisioning run's instance id: the client's, and a random part of its own. */
const newRunId = (clientId: string): string =>
  `${clientId}-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;

/** The runner a claim is for: a new provisioning run unless it says otherwise. */
export interface Runner {
  kind: RunKind;
  runId: string;
}

/**
 * Claims client `clientId` for a runner in place of `replacing` (null
 * when it has none), recording `event` by `actor` in the same batch, and
 * returns the runner's id; undefined when another claim got there first,
 * so the caller runs nothing. The runner is a new provisioning run unless
 * `runner` names another.
 */
export const claimRun = async (
  db: ConsoleDatabase,
  actor: Actor,
  clientId: string,
  replacing: string | null,
  event: ConsoleEvent,
  runner?: Runner
): Promise<string | undefined> => {
  const { kind, runId } = runner ?? {
    kind: "provision",
    runId: newRunId(clientId),
  };
  const claimedAt = new Date();
  const statement =
    replacing === null
      ? db
          .insert(clientRuns)
          .values({ clientId, runId, kind, claimedAt })
          .onConflictDoNothing()
      : db
          .update(clientRuns)
          .set({ runId, kind, claimedAt })
          .where(
            and(
              eq(clientRuns.clientId, clientId),
              eq(clientRuns.runId, replacing)
            )
          );
  const won = await actIfChanged(db, actor, statement, {
    ...event,
    detail: { ...event.detail, run: runId },
  });
  return won ? runId : undefined;
};

/**
 * Whether runner `runId` is client `clientId`'s current one: what a
 * runner checks before each change it makes live.
 */
export const holdsClient = async (
  db: ConsoleDatabase,
  clientId: string,
  runId: string
): Promise<boolean> => {
  const [claim] = await db
    .select({ runId: clientRuns.runId })
    .from(clientRuns)
    .where(eq(clientRuns.clientId, clientId));
  return claim?.runId === runId;
};

/** A runner and the client it claimed. */
export interface HeldClient {
  clientId: string;
  runId: string;
}

/**
 * That runner `held.runId` still holds `held.clientId`, as SQL: the
 * condition every write a runner makes to the client's record carries,
 * in the same statement, so a runner that lost the client changes
 * nothing.
 */
export const stillHolds = (held: HeldClient): SQL =>
  sql`EXISTS (SELECT 1 FROM ${clientRuns} WHERE ${clientRuns.clientId} = ${held.clientId} AND ${clientRuns.runId} = ${held.runId})`;

/**
 * Releases client `clientId` from runner `runId`, if it still holds it,
 * as a statement to batch with what the runner records: the client then
 * has no runner, and the next claims it afresh.
 */
export const releaseRun = (
  db: ConsoleDatabase,
  clientId: string,
  runId: string
) =>
  db
    .delete(clientRuns)
    .where(and(eq(clientRuns.clientId, clientId), eq(clientRuns.runId, runId)));
