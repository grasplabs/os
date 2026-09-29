/**
 * Rolling a release out to clients, as a Cloudflare Workflow: one
 * instance per rollout, its id the rollout's. It reaches ring 0 first,
 * then waits for a staff member's approval before each ring after
 * (src/rollout/control.ts), and deploys the clients of a ring one at a
 * time.
 *
 * Each client is deployed gradually: its resources and migrations first,
 * then each Worker in turn (connect before core, which binds it) uploaded
 * as a new version, sent a share of the traffic that grows by stages with
 * a pause at each (`gradualStages`), then all of it; then the smoke check
 * and the router's map (src/deploy/deploy.ts). A Worker's first upload,
 * or one with Durable Object migrations, goes live at once, and so does
 * every Worker while a secrets rotation is still to go live: versions
 * with different secrets can't share traffic.
 *
 * One runner per client: the rollout claims each client in D1 before it
 * deploys it and releases it after (src/runners.ts), so it never
 * deploys beside the client's provisioning run or another rollout; a
 * client with another runner is tried again for a while, then the
 * rollout stops. Before and after each change it makes live it checks
 * that it still holds the client (`runner_replaced` otherwise).
 *
 * Every step can run again: a claim the rollout holds already is kept, a
 * deploy it started is resumed, and each deploy phase finds what it made
 * before. A failure a retry can't fix stops the rollout where it is
 * (src/workflow-steps.ts), recorded on the rollout and its client, for
 * staff to act on: nothing rolls back on its own.
 */
import { log } from "@grasp-os/shared/log";
import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { and, eq, inArray } from "drizzle-orm";

import type { Staff } from "../access.ts";
import { actIfChanged, consoleDatabase } from "../db/act.ts";
import type { ConsoleDatabase } from "../db/act.ts";
import { releases, rollouts, rolloutTargets } from "../db/schema.ts";
import { deployContext } from "../deploy/context.ts";
import {
  errorCode,
  finishDeploy,
  makeDeployWorkerLive,
  prepareDeploy,
  shiftDeployTraffic,
  startDeploy,
  uploadDeployWorker,
} from "../deploy/deploy.ts";
import type { DeployContext } from "../deploy/deploy.ts";
import { claimRun, currentRun, hasEnded, releaseRun } from "../runners.ts";
import {
  deployStepConfig,
  guarded,
  isEngineAbort,
  quickStep,
  stop,
  stopReason,
} from "../workflow-steps.ts";
import {
  parsePrevious,
  previousRunOf,
  ringsOf,
  skipReason,
  targetClient,
  TrafficSplitError,
} from "./targets.ts";
import type { PreviousRun, TargetClient } from "./targets.ts";

/** What a rollout's run is started with: identifiers only, since Workflows stores them. */
export interface RolloutParams {
  rolloutId: string;
  releaseId: string;
  /** The staff member who started it. */
  startedBy: Staff;
}

/** The event staff send to approve the rollout's next ring, `ring`. */
export const approvalEvent = (ring: number): string => `approve-ring-${ring}`;

/**
 * A Worker's new version's share of the traffic at each stage before all
 * of it, and how long it's held there.
 */
export const gradualStages = [
  { percent: 10, hold: "5 minutes" },
  { percent: 50, hold: "5 minutes" },
] as const;

/**
 * The most steps a rollout's run may be expected to take: under
 * Workflows' default limit of 1,024 steps per instance, with room to
 * spare. A rollout over it is refused when it starts
 * (src/rollout/control.ts); the way past it is each client's deploy in a
 * child Workflow of its own.
 */
export const stepBudget = 900;

/**
 * The steps a rollout's run takes for `clientCount` clients in `rings` rings
 * of a release with `apps` Workers: its own (the targets, done, a stop
 * recorded), three for each approval between rings (waiting, approved,
 * the wait), and for each client its claim, prepare, finish and done,
 * with each Worker's upload, a traffic change and a hold per stage, and
 * all of its traffic. A step's retries are the same step.
 */
export const rolloutSteps = (
  rings: number,
  clientCount: number,
  apps: number
): number =>
  3 +
  3 * Math.max(rings - 1, 0) +
  clientCount * (4 + apps * (2 + 2 * gradualStages.length));

/** How long a rollout waits for approval of its next ring before it stops. */
const approvalTimeout = "30 days";

/**
 * Claiming a client: tried again for a while (about half an hour) when
 * another runner has it, such as its provisioning run finishing.
 */
const claimStep = {
  retries: { limit: 5, delay: "1 minute", backoff: "exponential" },
  timeout: "2 minutes",
} as const;

/** What the claim step leaves for the rest: identifiers only. */
type Claimed =
  | { skipped: true }
  | { skipped: false; deployId: string; previous: PreviousRun };

/** Rollout `rolloutId`'s target client `clientId`. */
const targetWhere = (rolloutId: string, clientId: string) =>
  and(
    eq(rolloutTargets.rolloutId, rolloutId),
    eq(rolloutTargets.clientId, clientId)
  );

/**
 * Marks client `clientId` skipped in the rollout for `reason`, audited
 * once, and releases it if an earlier run of the step claimed it.
 */
const skipTarget = async (
  db: ConsoleDatabase,
  rolloutId: string,
  clientId: string,
  reason: string
): Promise<void> => {
  await actIfChanged(
    db,
    "system",
    db
      .update(rolloutTargets)
      .set({ status: "skipped", error: reason, updatedAt: new Date() })
      .where(
        and(
          targetWhere(rolloutId, clientId),
          eq(rolloutTargets.status, "pending")
        )
      ),
    {
      action: "rollout.client_skip",
      clientId,
      target: rolloutId,
      detail: { reason },
    },
    [releaseRun(db, clientId, rolloutId)]
  );
};

/**
 * Claims client `clientId` for rollout `rolloutId`, audited, unless the
 * rollout holds it already (the step running again). One whose runner
 * hasn't ended is refused for now (`client_busy`), and the step retried.
 */
const claimClient = async (
  env: Env,
  db: ConsoleDatabase,
  rolloutId: string,
  clientId: string
): Promise<void> => {
  const run = await currentRun(env, clientId);
  if (run?.runId === rolloutId) {
    return;
  }
  if (run !== null && !hasEnded(run.status)) {
    throw new Error(`client_busy: ${clientId} has another runner`);
  }
  const won = await claimRun(
    db,
    "system",
    clientId,
    run?.runId ?? null,
    { action: "rollout.client_start", clientId, target: rolloutId },
    { kind: "rollout", runId: rolloutId }
  );
  if (won === undefined) {
    throw new Error(`client_busy: ${clientId} was just claimed`);
  }
};

/**
 * What `client` runs now (`previousRunOf`); a client whose traffic is
 * split has none to go back to, which stops the rollout
 * (`traffic_split`).
 */
const readPrevious = async (
  env: Env,
  client: TargetClient
): Promise<PreviousRun> => {
  const { api, router } = await deployContext(env);
  try {
    return await previousRunOf(
      api,
      router.hosts,
      `${client.id}.${router.domain}`,
      client
    );
  } catch (error) {
    if (error instanceof TrafficSplitError) {
      throw stop("traffic_split", error.message);
    }
    throw error;
  }
};

/**
 * Claims client `clientId` for the rollout, unless it skips it, and
 * returns the deploy it runs and what the client ran before. A client
 * that's no longer active, pinned to another release, or on this one
 * already (with no rotation waiting) or a newer one (`skipReason`), is
 * skipped, audited, unless the rollout is deploying it already. What it ran before is read once, before anything of the
 * release is live, and kept on its target.
 */
const claimTarget = async (
  env: Env,
  db: ConsoleDatabase,
  params: RolloutParams,
  clientId: string
): Promise<Claimed> => {
  const { rolloutId, releaseId } = params;
  const [target] = await db
    .select({
      status: rolloutTargets.status,
      deployId: rolloutTargets.deployId,
      previous: rolloutTargets.previous,
    })
    .from(rolloutTargets)
    .where(targetWhere(rolloutId, clientId));
  if (target === undefined || target.status === "skipped") {
    return { skipped: true };
  }
  const client = await targetClient(db, clientId);
  const [release] = await db
    .select({ id: releases.id, builtAt: releases.builtAt })
    .from(releases)
    .where(eq(releases.id, releaseId));
  if (release === undefined) {
    throw stop("release_not_imported", `Release ${releaseId} isn't imported`);
  }
  const skip =
    client?.status === "active" ? skipReason(client, release) : "not_active";
  if (client === undefined || (skip !== null && target.status === "pending")) {
    await skipTarget(db, rolloutId, clientId, skip ?? "not_active");
    return { skipped: true };
  }
  await claimClient(env, db, rolloutId, clientId);
  const previous =
    parsePrevious(target.previous) ?? (await readPrevious(env, client));
  const deployId =
    target.deployId ??
    (await startDeploy(db, params.startedBy, clientId, releaseId));
  await db
    .update(rolloutTargets)
    .set({
      status: "deploying",
      deployId,
      previous: JSON.stringify(previous),
      updatedAt: new Date(),
    })
    .where(targetWhere(rolloutId, clientId));
  return { skipped: false, deployId, previous };
};

/**
 * The deploy context for the rollout's work on client `clientId`, as its
 * runner: it stops (`runner_replaced`) as soon as the rollout no longer
 * holds the client, and writes nothing to its record after.
 */
const contextFor = async (
  env: Env,
  rolloutId: string,
  clientId: string
): Promise<DeployContext> => ({
  ...(await deployContext(env)),
  runner: { clientId, runId: rolloutId },
});

/** Marks client `clientId` done in the rollout and releases it, audited once. */
const completeTarget = async (
  db: ConsoleDatabase,
  rolloutId: string,
  clientId: string
): Promise<void> => {
  await actIfChanged(
    db,
    "system",
    db
      .update(rolloutTargets)
      .set({ status: "done", error: null, updatedAt: new Date() })
      .where(
        and(
          eq(rolloutTargets.rolloutId, rolloutId),
          eq(rolloutTargets.clientId, clientId),
          eq(rolloutTargets.status, "deploying")
        )
      ),
    { action: "rollout.client_done", clientId, target: rolloutId },
    [releaseRun(db, clientId, rolloutId)]
  );
};

/**
 * Deploys client `clientId`, as steps of the rollout's run: claimed, its
 * resources and migrations, each Worker by stages, the smoke check and
 * the router, then released.
 */
const deployClient = async (
  env: Env,
  step: WorkflowStep,
  params: RolloutParams,
  clientId: string
): Promise<void> => {
  const { rolloutId } = params;
  const db = consoleDatabase(env.DB);
  const claimed = await step.do(
    `${clientId} claim`,
    claimStep,
    guarded(async () => await claimTarget(env, db, params, clientId))
  );
  if (claimed.skipped) {
    return;
  }
  const { deployId, previous } = claimed;
  const context = async () => await contextFor(env, rolloutId, clientId);
  const prepared = await step.do(
    `${clientId} prepare`,
    deployStepConfig,
    guarded(async () => await prepareDeploy(await context(), deployId))
  );
  for (const app of prepared?.apps ?? []) {
    // oxlint-disable-next-line no-await-in-loop -- one Worker at a time
    const uploaded = await step.do(
      `${clientId} ${app} upload`,
      deployStepConfig,
      guarded(
        async () =>
          await uploadDeployWorker(
            await context(),
            deployId,
            app,
            prepared?.databases ?? {}
          )
      )
    );
    if (uploaded === null) {
      // The deploy was done already: an earlier run of this step's
      // successors got that far.
      break;
    }
    const before = previous.versions[app];
    // Versions with different secrets can't share traffic: a rotation
    // still to go live (the new versions carry a generation the router
    // doesn't send yet) goes live at once.
    const sameSecrets = prepared?.generation === previous.generation;
    if (
      !uploaded.live &&
      sameSecrets &&
      before !== undefined &&
      before !== uploaded.version
    ) {
      for (const { percent, hold } of gradualStages) {
        // oxlint-disable-next-line no-await-in-loop -- one stage at a time
        await step.do(
          `${clientId} ${app} ${percent}%`,
          quickStep,
          guarded(async () => {
            await shiftDeployTraffic(await context(), deployId, app, {
              version: uploaded.version,
              previous: before,
              percent,
            });
          })
        );
        // oxlint-disable-next-line no-await-in-loop -- held before the next stage
        await step.sleep(`${clientId} ${app} ${percent}% hold`, hold);
      }
    }
    // oxlint-disable-next-line no-await-in-loop -- live before the next Worker
    await step.do(
      `${clientId} ${app} live`,
      quickStep,
      guarded(async () => {
        await makeDeployWorkerLive(
          await context(),
          deployId,
          app,
          uploaded.version
        );
      })
    );
  }
  await step.do(
    `${clientId} finish`,
    deployStepConfig,
    guarded(async () => {
      await finishDeploy(await context(), deployId);
    })
  );
  await step.do(
    `${clientId} done`,
    quickStep,
    guarded(async () => {
      await completeTarget(db, rolloutId, clientId);
    })
  );
};

/**
 * Whether ring `ring` of rollout `rolloutId` is approved: a staff member
 * moved the rollout on to it (src/rollout/control.ts).
 */
const isApproved = async (
  db: ConsoleDatabase,
  rolloutId: string,
  ring: number
): Promise<boolean> => {
  const [row] = await db
    .select({ status: rollouts.status, ring: rollouts.ring })
    .from(rollouts)
    .where(eq(rollouts.id, rolloutId));
  return row?.status === "running" && row.ring === ring;
};

/**
 * Waits after ring `after` for a staff member to approve ring `next`:
 * the rollout marked waiting, audited, then an approval recorded
 * already, or the event the approval sends (one per ring, so an approval
 * of one ring never passes for the next).
 */
const awaitApproval = async (
  step: WorkflowStep,
  db: ConsoleDatabase,
  rolloutId: string,
  after: number,
  next: number
): Promise<void> => {
  await step.do(
    `ring ${after} waiting`,
    quickStep,
    guarded(async () => {
      await actIfChanged(
        db,
        "system",
        db
          .update(rollouts)
          .set({ status: "waiting", updatedAt: new Date() })
          .where(
            and(
              eq(rollouts.id, rolloutId),
              eq(rollouts.status, "running"),
              eq(rollouts.ring, after)
            )
          ),
        { action: "rollout.wait", target: rolloutId, detail: { ring: after } }
      );
    })
  );
  // Checked first: an approval recorded after this check reaches the run
  // as its event.
  const approved = await step.do(
    `ring ${next} approved`,
    quickStep,
    guarded(async () => await isApproved(db, rolloutId, next))
  );
  if (!approved) {
    await step.waitForEvent(`ring ${next} approval`, {
      type: approvalEvent(next),
      timeout: approvalTimeout,
    });
  }
};

/** The code at the front of a stop's reason (`<code>: <words>`). */
const codeOf = (reason: string): string => reason.split(":", 1)[0] ?? reason;

/**
 * Records that the rollout stopped with `reason` (its code and our
 * words), audited as `rollout.fail`, with the client it was on marked
 * failed and released. A failure to record it is logged, not thrown, so
 * the run fails with its own error.
 */
const recordStop = async (
  db: ConsoleDatabase,
  rolloutId: string,
  clientId: string | null,
  reason: string
): Promise<void> => {
  const now = new Date();
  try {
    await actIfChanged(
      db,
      "system",
      db
        .update(rollouts)
        .set({ status: "failed", updatedAt: now })
        .where(
          and(
            eq(rollouts.id, rolloutId),
            inArray(rollouts.status, ["running", "waiting"])
          )
        ),
      {
        action: "rollout.fail",
        target: rolloutId,
        detail: {
          error: reason,
          ...(clientId === null ? {} : { client: clientId }),
        },
      },
      clientId === null
        ? []
        : [
            db
              .update(rolloutTargets)
              .set({ status: "failed", error: codeOf(reason), updatedAt: now })
              .where(
                and(
                  eq(rolloutTargets.rolloutId, rolloutId),
                  eq(rolloutTargets.clientId, clientId),
                  inArray(rolloutTargets.status, ["pending", "deploying"])
                )
              ),
            releaseRun(db, clientId, rolloutId),
          ]
    );
  } catch (recordError) {
    log.error("rollout.stop_unrecorded", {
      rollout: rolloutId,
      error: errorCode(recordError),
    });
  }
};

/** What a rollout's run returns: counts only. */
export interface RolloutResult {
  rings: number;
}

export class Rollout extends WorkflowEntrypoint<Env, RolloutParams> {
  override async run(
    event: WorkflowEvent<RolloutParams>,
    step: WorkflowStep
  ): Promise<RolloutResult> {
    const { payload: params } = event;
    const { rolloutId } = params;
    const db = consoleDatabase(this.env.DB);
    // The client being deployed, so a rollout that stops on it, whatever
    // stops it, records which.
    let current: string | null = null;
    try {
      const rings = await step.do(
        "targets",
        quickStep,
        guarded(async () => await ringsOf(db, rolloutId))
      );
      let before: number | undefined = undefined;
      for (const { ring, clientIds } of rings) {
        if (before !== undefined) {
          // oxlint-disable-next-line no-await-in-loop -- a person approves each ring
          await awaitApproval(step, db, rolloutId, before, ring);
        }
        for (const clientId of clientIds) {
          current = clientId;
          // oxlint-disable-next-line no-await-in-loop -- one client at a time
          await deployClient(this.env, step, params, clientId);
          current = null;
        }
        before = ring;
      }
      await step.do(
        "done",
        quickStep,
        guarded(async () => {
          await actIfChanged(
            db,
            "system",
            db
              .update(rollouts)
              .set({ status: "done", updatedAt: new Date() })
              .where(
                and(eq(rollouts.id, rolloutId), eq(rollouts.status, "running"))
              ),
            { action: "rollout.done", target: rolloutId }
          );
        })
      );
      return { rings: rings.length };
    } catch (error) {
      // Paused, the run carries on where it was once resumed; terminated
      // (from the dashboard), the console settles it
      // (src/rollout/control.ts).
      if (isEngineAbort(error)) {
        throw error;
      }
      const failed = current;
      await step.do("record stop", quickStep, async () => {
        await recordStop(db, rolloutId, failed, stopReason(error));
      });
      throw error;
    }
  }
}
