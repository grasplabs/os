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
 * every Worker whose new version has other secrets than the one before
 * (a rotation still to go live, or shared secrets changed in Secrets
 * Store): versions with different secrets can't share traffic. So does a
 * client on the release already, deployed again for a config change
 * (src/clients/settings.ts): flags may be kill switches.
 *
 * A secrets rollout (no release) takes the shared secrets in Secrets
 * Store now to clients without a code release: it deploys each client's
 * own release again, as a `secrets` deploy, every Worker live at once.
 * Everything else is a release rollout's: claims, rings, approvals,
 * cancelling, rollbacks and audit.
 *
 * One runner per client: the rollout claims each client in D1 before it
 * deploys it and releases it after (src/runners.ts), so it never
 * deploys beside the client's provisioning run or another rollout; a
 * client with another runner is tried again for a while, then the
 * rollout stops. Before and after each change it makes live it checks
 * that it still holds the client (`runner_replaced` otherwise): a
 * rollback takes the client from it (src/rollout/rollback.ts), and once
 * it has lost the client it never touches its traffic again: the
 * rollback, as its holder, puts right a change of the rollout's that
 * landed late.
 *
 * Staff pause and resume the run (it stops after the step it's in), and
 * stop the rollout by rolling a client back or, between rings, by
 * cancelling it (src/rollout/control.ts). One rule stops the run once the
 * rollout is cancelled: every step of a client checks first
 * (`clientStep`) and ends the client there, `skipped` while nothing of it
 * has started and `stopped` once anything has (`endIfCancelled`). A
 * client pinned to another release is skipped.
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
import {
  clientDeploys,
  releases,
  rollouts,
  rolloutTargets,
} from "../db/schema.ts";
import { deployContext } from "../deploy/context.ts";
import {
  errorCode,
  finishDeploy,
  makeDeployWorkerLive,
  prepareDeploy,
  redeployKind,
  shiftDeployTraffic,
  startDeploy,
  uploadDeployWorker,
} from "../deploy/deploy.ts";
import type { DeployContext, DeployKind } from "../deploy/deploy.ts";
import type { DeployErrorCode } from "../deploy/errors.ts";
import {
  claimRun,
  currentRun,
  hasEnded,
  releaseRun,
  stillHolds,
} from "../runners.ts";
import {
  deployStepConfig,
  guarded,
  isEngineAbort,
  quickStep,
  stop,
  stopReason,
} from "../workflow-steps.ts";
import { ClientEndedError } from "./client-ended.ts";
import {
  previousRunOf,
  ringsOf,
  runningRelease,
  skipReason,
  targetClient,
  TrafficSplitError,
  unfinishedPrevious,
} from "./targets.ts";
import type { PreviousRun, TargetClient } from "./targets.ts";

/** What a rollout's run is started with: identifiers only, since Workflows stores them. */
export interface RolloutParams {
  rolloutId: string;
  /**
   * The release it rolls out; null for a secrets rollout, which deploys
   * each client's own release again with the secrets in Secrets Store now.
   */
  releaseId: string | null;
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

/**
 * What the claim step leaves for the rest: identifiers only. `running`
 * is what the client ran as the rollout claimed it, which its new
 * versions share traffic with by stages.
 */
type Claimed =
  | { state: "skipped" }
  | { state: "cancelled" }
  | { state: "claimed"; deployId: string; running: PreviousRun };

/** Whether rollout `rolloutId` was stopped by staff (a rollback, or a cancel). */
const isCancelled = async (
  db: ConsoleDatabase,
  rolloutId: string
): Promise<boolean> => {
  const [row] = await db
    .select({ status: rollouts.status })
    .from(rollouts)
    .where(eq(rollouts.id, rolloutId));
  return row?.status === "cancelled";
};

/** Rollout `rolloutId`'s target client `clientId`. */
const targetWhere = (rolloutId: string, clientId: string) =>
  and(
    eq(rolloutTargets.rolloutId, rolloutId),
    eq(rolloutTargets.clientId, clientId)
  );

/**
 * Deploy `deployId` marked failed (`cancelled`) if it's still running, as
 * a statement to batch: a cancelled rollout never finishes it, and a
 * rollback of its client doesn't wait for it.
 */
const cancelDeploy = (db: ConsoleDatabase, deployId: string) =>
  db
    .update(clientDeploys)
    .set({ status: "failed", error: "cancelled", updatedAt: new Date() })
    .where(
      and(eq(clientDeploys.id, deployId), eq(clientDeploys.status, "running"))
    );

/**
 * Marks client `clientId` skipped in the rollout for `reason`, audited
 * once, while nothing of it has started (`pending`), then releases it if
 * the rollout claimed it: one it never got to, or one it claimed and then
 * found the rollout cancelled before any step of it began (`cancelled`).
 * `following` goes in the same batch, before the release.
 */
const skipTarget = async (
  db: ConsoleDatabase,
  rolloutId: string,
  clientId: string,
  reason: string,
  following: ReturnType<typeof cancelDeploy>[] = []
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
    [...following, releaseRun(db, clientId, rolloutId)]
  );
};

/**
 * Ends the rollout's work on client `clientId` if staff stopped the
 * rollout, and returns whether it did: the one rule, checked at the start
 * of every step of a client (`clientStep`), a retry's too. What the target
 * ends as depends only on whether anything of the client started (its
 * prepare step marks it `deploying` before it begins, `markStarted`):
 * `skipped` while nothing has, `stopped` once a step has. A stopped
 * target counts as reached, so staff can roll it back if its traffic
 * moved (src/rollout/rollback.ts). Either way, audited once, its deploy
 * is cancelled and then the client released, in the same batch as its
 * end: never released before its end is recorded.
 */
const endIfCancelled = async (
  db: ConsoleDatabase,
  rolloutId: string,
  clientId: string
): Promise<boolean> => {
  if (!(await isCancelled(db, rolloutId))) {
    return false;
  }
  const [target] = await db
    .select({
      status: rolloutTargets.status,
      deployId: rolloutTargets.deployId,
    })
    .from(rolloutTargets)
    .where(targetWhere(rolloutId, clientId));
  const deployId = target?.deployId ?? null;
  const cancelling = deployId === null ? [] : [cancelDeploy(db, deployId)];
  if (target?.status !== "deploying") {
    // Nothing of it started, or its target ended already (a rollback of
    // this client): skipped only while pending, released either way.
    await skipTarget(db, rolloutId, clientId, "cancelled", cancelling);
    return true;
  }
  await actIfChanged(
    db,
    "system",
    db
      .update(rolloutTargets)
      .set({ status: "stopped", error: "cancelled", updatedAt: new Date() })
      .where(
        and(
          targetWhere(rolloutId, clientId),
          eq(rolloutTargets.status, "deploying")
        )
      ),
    {
      action: "rollout.client_stop",
      clientId,
      target: rolloutId,
      detail: { reason: "cancelled" },
    },
    [...cancelling, releaseRun(db, clientId, rolloutId)]
  );
  return true;
};

/**
 * Marks client `clientId` started in the rollout (`deploying`) while the
 * rollout still holds it, before the first step that changes anything of
 * it does: from then on a cancel stops it rather than skips it
 * (`endIfCancelled`), a retry of that step included.
 */
const markStarted = async (
  db: ConsoleDatabase,
  rolloutId: string,
  clientId: string
): Promise<void> => {
  await db
    .update(rolloutTargets)
    .set({ status: "deploying", updatedAt: new Date() })
    .where(
      and(
        targetWhere(rolloutId, clientId),
        eq(rolloutTargets.status, "pending"),
        stillHolds({ clientId, runId: rolloutId })
      )
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
 * Why rollout `params` skips `client` before claiming it, or null: one no
 * longer active (`not_active`); for a release rollout, what `skipReason`
 * says. A secrets rollout skips no active client here: it deploys the
 * release the client runs, whatever it's pinned to, read once it holds
 * the client (`claimTarget`).
 */
const skipFor = async (
  db: ConsoleDatabase,
  params: RolloutParams,
  client: TargetClient
): Promise<string | null> => {
  if (client.status !== "active") {
    return "not_active";
  }
  if (params.releaseId === null) {
    return null;
  }
  const [release] = await db
    .select({ id: releases.id, builtAt: releases.builtAt })
    .from(releases)
    .where(eq(releases.id, params.releaseId));
  if (release === undefined) {
    throw stop(
      "release_not_imported",
      `Release ${params.releaseId} isn't imported`
    );
  }
  return skipReason(client, release);
};

/**
 * What a claimed target deploys: the deploy it started already, or else
 * the release to start one of, the rollout's or, for a secrets rollout,
 * the one `client` runs; null when it has neither.
 */
const deployPlan = (
  deployId: string | null,
  releaseId: string | null,
  client: TargetClient
): { deployId: string } | { releaseId: string } | null => {
  if (deployId !== null) {
    return { deployId };
  }
  const release = releaseId ?? runningRelease(client);
  return release === null ? null : { releaseId: release };
};

/**
 * What the deploy a rollout of `releaseId` starts on `client` changes,
 * as its core records it (`redeployKind`). A secrets rollout (no release)
 * brings new secrets, and with them any settings of the client's that
 * wait for a deploy. A release rollout brings the `release`, unless the
 * client runs it already (`running`): then it reaches the client only for
 * what waits, its settings, its own rotated secrets, or both.
 */
const deployKind = (
  releaseId: string | null,
  running: string | null,
  client: TargetClient
): DeployKind => {
  if (releaseId === null) {
    return redeployKind({ settings: client.configPending, secrets: true });
  }
  if (running !== releaseId) {
    return "release";
  }
  return redeployKind({
    settings: client.configPending,
    secrets: client.rotationPending,
  });
};

/**
 * Claims client `clientId` for the rollout, unless it skips it, and
 * returns the deploy it runs and what the client runs now. A client it
 * skips (`skipFor`) is skipped, audited, unless the rollout is deploying
 * it already; a rollout staff stopped goes no further, and ends the
 * client as every later step does (`endIfCancelled`): skipped, the deploy
 * an earlier try of the step started cancelled, and the client released
 * if that try claimed it. A secrets rollout reads the release the client
 * runs once it holds the client, so no other runner changes it after, and
 * skips (`no_release`) a client whose Workers don't run one release,
 * unless it started its deploy already. What a rollback puts back
 * (`previous`) is settled once, before anything of the release is live:
 * what the client runs now, or, when the rollout that last deployed to it
 * never finished it and this one retries its release or finds the client
 * between releases, what it ran before that one (`unfinishedPrevious`).
 * It's kept on the target with the deploy's id in the batch that starts
 * the deploy, so a try of the step that runs again finds both or neither,
 * never a deploy its target doesn't name. The target stays `pending`
 * until its first step starts (`markStarted`).
 */
const claimTarget = async (
  env: Env,
  db: ConsoleDatabase,
  params: RolloutParams,
  clientId: string
): Promise<Claimed> => {
  const { rolloutId } = params;
  if (await endIfCancelled(db, rolloutId, clientId)) {
    return { state: "cancelled" };
  }
  const [target] = await db
    .select({
      status: rolloutTargets.status,
      deployId: rolloutTargets.deployId,
      previous: rolloutTargets.previous,
    })
    .from(rolloutTargets)
    .where(targetWhere(rolloutId, clientId));
  if (target === undefined || target.status === "skipped") {
    return { state: "skipped" };
  }
  const client = await targetClient(db, clientId);
  const skip =
    client === undefined ? "not_active" : await skipFor(db, params, client);
  if (client === undefined || (skip !== null && target.status === "pending")) {
    await skipTarget(db, rolloutId, clientId, skip ?? "not_active");
    return { state: "skipped" };
  }
  await claimClient(env, db, rolloutId, clientId);
  // Read again now the rollout holds the client: no other runner changes
  // what it runs from here.
  const held = (await targetClient(db, clientId)) ?? client;
  // The deploy it started already, or the release to start one of.
  const plan = deployPlan(target.deployId, params.releaseId, held);
  if (plan === null) {
    await skipTarget(db, rolloutId, clientId, "no_release");
    return { state: "skipped" };
  }
  // Read before a deploy starts: one that stops here leaves none behind.
  const running = await readPrevious(env, held);
  if ("deployId" in plan) {
    // An earlier try of the step started it, and kept `previous` with it.
    return { state: "claimed", deployId: plan.deployId, running };
  }
  const carried = await unfinishedPrevious(db, clientId, {
    releaseId: plan.releaseId,
    running: running.release,
  });
  const previous = carried ?? running;
  // Its target names the deploy, and what a rollback of it puts back, in
  // the batch that starts it. Still pending: claimed, but nothing of it
  // started yet.
  const deployId = await startDeploy(
    db,
    params.startedBy,
    clientId,
    plan.releaseId,
    deployKind(params.releaseId, running.release, held),
    (started) => [
      db
        .update(rolloutTargets)
        .set({
          deployId: started,
          previous: JSON.stringify(previous),
          updatedAt: new Date(),
        })
        .where(targetWhere(rolloutId, clientId)),
    ]
  );
  return { state: "claimed", deployId, running };
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

/** What a client's step leaves: its work's result, unless it ended the client. */
type ClientStepResult<T> = { ended: true } | { ended: false; result: T };

/**
 * Runs `work` as step `name` of the rollout's work on client `clientId`,
 * unless the rollout is cancelled: then the step ends the client instead
 * (`endIfCancelled`), a retry of the step as much as its first try, and
 * `ClientEndedError` is thrown to the run, which goes no further.
 */
const clientStep = async <T>(
  step: WorkflowStep,
  db: ConsoleDatabase,
  { rolloutId, clientId }: { rolloutId: string; clientId: string },
  name: string,
  config: typeof quickStep | typeof deployStepConfig,
  work: () => Promise<T>
): Promise<T> => {
  const done = await step.do(
    name,
    config,
    guarded(async (): Promise<ClientStepResult<T>> => {
      if (await endIfCancelled(db, rolloutId, clientId)) {
        return { ended: true };
      }
      return { ended: false, result: await work() };
    })
  );
  if (done.ended) {
    throw new ClientEndedError(`${rolloutId} ended ${clientId}: cancelled`);
  }
  return done.result;
};

/**
 * The steps of client `clientId`'s deploy once the rollout claimed it,
 * each of them `clientStep`: prepared (marked started first), each
 * Worker uploaded, moved by stages and made live, finished, then done.
 */
const deployClaimed = async (
  env: Env,
  step: WorkflowStep,
  params: RolloutParams,
  clientId: string,
  { deployId, running }: Extract<Claimed, { state: "claimed" }>
): Promise<void> => {
  const { rolloutId } = params;
  const db = consoleDatabase(env.DB);
  const client = { rolloutId, clientId };
  const context = async () => await contextFor(env, rolloutId, clientId);
  const prepared = await clientStep(
    step,
    db,
    client,
    `${clientId} prepare`,
    deployStepConfig,
    async () => {
      await markStarted(db, rolloutId, clientId);
      return await prepareDeploy(await context(), deployId);
    }
  );
  for (const app of prepared?.apps ?? []) {
    const before = running.versions[app];
    // oxlint-disable-next-line no-await-in-loop -- one Worker at a time
    const uploaded = await clientStep(
      step,
      db,
      client,
      `${clientId} ${app} upload`,
      deployStepConfig,
      async () =>
        await uploadDeployWorker(
          await context(),
          deployId,
          app,
          prepared?.databases ?? {},
          before
        )
    );
    if (uploaded === null) {
      // The deploy was done already: an earlier run of this step's
      // successors got that far.
      break;
    }
    // Versions with different secrets can't share traffic, so new ones go
    // live at once: a rotation still to go live (the new versions carry a
    // generation the router doesn't send yet), shared secrets changed in
    // Secrets Store since the version before, or one whose secrets aren't
    // on record. A secrets rollout exists to change them: always at once.
    const sameSecrets =
      params.releaseId !== null &&
      uploaded.sameSecrets &&
      prepared?.generation === running.generation;
    // The release the client runs already: only its config (flags,
    // sign-in) changes, which may be a kill switch, so at once too.
    const newCode = running.release !== params.releaseId;
    if (
      !uploaded.live &&
      sameSecrets &&
      newCode &&
      before !== undefined &&
      before !== uploaded.version
    ) {
      for (const { percent, hold } of gradualStages) {
        // oxlint-disable-next-line no-await-in-loop -- one stage at a time
        await clientStep(
          step,
          db,
          client,
          `${clientId} ${app} ${percent}%`,
          quickStep,
          async () => {
            await shiftDeployTraffic(await context(), deployId, app, {
              version: uploaded.version,
              previous: before,
              percent,
            });
          }
        );
        // oxlint-disable-next-line no-await-in-loop -- held before the next stage
        await step.sleep(`${clientId} ${app} ${percent}% hold`, hold);
      }
    }
    // oxlint-disable-next-line no-await-in-loop -- live before the next Worker
    await clientStep(
      step,
      db,
      client,
      `${clientId} ${app} live`,
      quickStep,
      async () => {
        await makeDeployWorkerLive(
          await context(),
          deployId,
          app,
          uploaded.version
        );
      }
    );
  }
  await clientStep(
    step,
    db,
    client,
    `${clientId} finish`,
    deployStepConfig,
    async () => {
      await finishDeploy(await context(), deployId);
    }
  );
  await clientStep(
    step,
    db,
    client,
    `${clientId} done`,
    quickStep,
    async () => {
      await completeTarget(db, rolloutId, clientId);
    }
  );
};

/**
 * Deploys client `clientId`, as steps of the rollout's run: claimed, its
 * resources and migrations, each Worker by stages, the smoke check and
 * the router, then released. Returns whether the rollout goes on: not
 * once staff stopped it.
 */
const deployClient = async (
  env: Env,
  step: WorkflowStep,
  params: RolloutParams,
  clientId: string
): Promise<boolean> => {
  const db = consoleDatabase(env.DB);
  const claimed = await step.do(
    `${clientId} claim`,
    claimStep,
    guarded(async () => await claimTarget(env, db, params, clientId))
  );
  if (claimed.state !== "claimed") {
    return claimed.state === "skipped";
  }
  try {
    await deployClaimed(env, step, params, clientId, claimed);
    return true;
  } catch (error) {
    if (error instanceof ClientEndedError) {
      return false;
    }
    throw error;
  }
};

/**
 * Where ring `ring` of rollout `rolloutId` is: approved (a staff member
 * moved the rollout on to it, src/rollout/control.ts), still waiting, or
 * the rollout cancelled.
 */
const approvalOf = async (
  db: ConsoleDatabase,
  rolloutId: string,
  ring: number
): Promise<"approved" | "waiting" | "cancelled"> => {
  const [row] = await db
    .select({ status: rollouts.status, ring: rollouts.ring })
    .from(rollouts)
    .where(eq(rollouts.id, rolloutId));
  if (row?.status === "cancelled") {
    return "cancelled";
  }
  return row?.status === "running" && row.ring === ring
    ? "approved"
    : "waiting";
};

/**
 * Waits after ring `after` for a staff member to approve ring `next`:
 * the rollout marked waiting, audited, then an approval recorded
 * already, or the event the approval sends (one per ring, so an approval
 * of one ring never passes for the next). Returns whether the rollout
 * goes on: not once staff cancelled it.
 */
const awaitApproval = async (
  step: WorkflowStep,
  db: ConsoleDatabase,
  rolloutId: string,
  after: number,
  next: number
): Promise<boolean> => {
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
  const approval = await step.do(
    `ring ${next} approved`,
    quickStep,
    guarded(async () => await approvalOf(db, rolloutId, next))
  );
  if (approval === "waiting") {
    await step.waitForEvent(`ring ${next} approval`, {
      type: approvalEvent(next),
      timeout: approvalTimeout,
    });
  }
  return approval !== "cancelled";
};

/** The code at the front of a stop's reason (`<code>: <words>`). */
const codeOf = (reason: string): string => reason.split(":", 1)[0] ?? reason;

/**
 * Records that the rollout stopped with `reason` (its code and our
 * words), audited as `rollout.fail`, with the client it was on marked
 * failed and released. One stopped because another runner took its
 * client (a rollback) is `cancelled`, as the rollback marks it, whichever
 * records first, and audited as that: `rollout.cancel`. A failure to
 * record it is logged, not thrown, so the run fails with its own error.
 */
const recordStop = async (
  db: ConsoleDatabase,
  rolloutId: string,
  clientId: string | null,
  reason: string
): Promise<void> => {
  const now = new Date();
  const code = codeOf(reason);
  const replaced: DeployErrorCode = "runner_replaced";
  const cancelled = code === replaced;
  try {
    await actIfChanged(
      db,
      "system",
      db
        .update(rollouts)
        .set({
          status: cancelled ? "cancelled" : "failed",
          updatedAt: now,
        })
        .where(
          and(
            eq(rollouts.id, rolloutId),
            inArray(rollouts.status, ["running", "waiting"])
          )
        ),
      {
        action: cancelled ? "rollout.cancel" : "rollout.fail",
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
              .set({ status: "failed", error: code, updatedAt: now })
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
        const approved =
          before === undefined ||
          // oxlint-disable-next-line no-await-in-loop -- a person approves each ring
          (await awaitApproval(step, db, rolloutId, before, ring));
        if (!approved) {
          return { rings: rings.length };
        }
        for (const clientId of clientIds) {
          current = clientId;
          // oxlint-disable-next-line no-await-in-loop -- one client at a time
          const goOn = await deployClient(this.env, step, params, clientId);
          current = null;
          if (!goOn) {
            return { rings: rings.length };
          }
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
      // (a cancel, or from the dashboard), the console settles it
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
