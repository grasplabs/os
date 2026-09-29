/**
 * A client's provisioning runs, as the console tracks them: each attempt
 * is a Workflow instance of its own (`<clientId>-<random>`), and
 * `client_runs` names the client's current one. Instances are never
 * deleted or reused.
 *
 * Starting or resuming claims the next run with one conditional write that
 * names the run it replaces (none, for a first start), audited in the same
 * batch. However many staff act at once, one claim wins and only its
 * caller creates a run, so a client has one runner: the precondition of a
 * deploy's D1 migrations and router map write (src/deploy/deploy.ts).
 */
import { and, eq } from "drizzle-orm";

import type { Actor, ConsoleDatabase, ConsoleEvent } from "../db/act.ts";
import { actIfChanged, consoleDatabase } from "../db/act.ts";
import { clientRuns } from "../db/schema.ts";

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

/** Whether `error` is Workflows saying it has no instance of that id. */
const isMissingInstance = (error: unknown): boolean =>
  error instanceof Error && error.message.includes("instance.not_found");

/** Client `clientId`'s current run, or null when it has never had one. */
export const currentRun = async (
  env: Env,
  clientId: string
): Promise<CurrentRun | null> => {
  const [claim] = await consoleDatabase(env.DB)
    .select({ runId: clientRuns.runId, claimedAt: clientRuns.claimedAt })
    .from(clientRuns)
    .where(eq(clientRuns.clientId, clientId));
  if (claim === undefined) {
    return null;
  }
  let instance: WorkflowInstance;
  try {
    instance = await env.PROVISION_CLIENT.get(claim.runId);
  } catch (error) {
    if (!isMissingInstance(error)) {
      throw error;
    }
    const starting = Date.now() - claim.claimedAt.getTime() < startingMs;
    return {
      runId: claim.runId,
      claimedAt: claim.claimedAt,
      status: starting ? "starting" : "gone",
      instance: null,
    };
  }
  const { status } = await instance.status();
  return { runId: claim.runId, claimedAt: claim.claimedAt, status, instance };
};

/** A new run's instance id: the client's, and a random part of its own. */
const newRunId = (clientId: string): string =>
  `${clientId}-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;

/**
 * Claims client `clientId`'s next run in place of `replacing` (null for a
 * first start), recording `event` by `actor` in the same batch, and
 * returns the new run's id; undefined when another claim got there first,
 * so the caller creates nothing.
 */
export const claimRun = async (
  db: ConsoleDatabase,
  actor: Actor,
  clientId: string,
  replacing: string | null,
  event: ConsoleEvent
): Promise<string | undefined> => {
  const runId = newRunId(clientId);
  const claimedAt = new Date();
  const statement =
    replacing === null
      ? db
          .insert(clientRuns)
          .values({ clientId, runId, claimedAt })
          .onConflictDoNothing()
      : db
          .update(clientRuns)
          .set({ runId, claimedAt })
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
