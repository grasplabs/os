/**
 * Rolling a client back from a rollout: each of its Workers sent all its
 * traffic back to the version it ran before the rollout reached it
 * (`previous` on its target, src/rollout/targets.ts). Instant: the
 * versions are there, with their own secrets, so nothing is uploaded.
 * Migrations only expand for the release after, so the previous code runs
 * on the database the release left, as long as the previous release is
 * the one right before it (or the same one, after a secrets rollout,
 * which puts the previous shared secrets back); a client further back
 * isn't rolled back. Crons and Workflows stay as the release set them.
 *
 * A rollback is a runner like the others (src/runners.ts): a Workflow
 * instance, `RollbackClient`, that claims the client, taking it from the
 * rollout it rolls back even while that rollout is deploying it (but not
 * while it's making the client's resources or running its migrations),
 * and from no other runner still going. It checks it still holds the
 * client before each Worker it restores, and records the rollback only
 * while it does, in the same batch. The rollout checks it still holds the
 * client right before and after each change it makes live, and once it
 * lost the client it changes nothing (src/rollout/workflow.ts). A change
 * of the rollout's already on its way when the rollback took the client
 * can still land: right before it records and releases the client, the
 * rollback reads what runs again and puts its versions back where one
 * did. A change that lands after the rollback released the client isn't
 * put right (drift shows it as split or drifted), which takes one on its
 * way for longer than the rollback's whole run. Rolling a client back
 * stops its rollout, and ends its run while it deploys no client (as
 * when it waits for approval).
 */
import { log } from "@grasp-os/shared/log";
import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { and, desc, eq, inArray, lt } from "drizzle-orm";
import { z } from "zod";

import type { Staff } from "../access.ts";
import type { CloudflareApi } from "../cloudflare/api.ts";
import { deployVersion, liveVersion } from "../cloudflare/workers.ts";
import { actIfChanged, consoleDatabase } from "../db/act.ts";
import type { ConsoleDatabase } from "../db/act.ts";
import {
  auditEvents,
  clientRuns,
  clients,
  clientWorkers,
  releases,
  rollouts,
  rolloutTargets,
} from "../db/schema.ts";
import { activityKeys, clientDomain, deployerApi } from "../deploy/context.ts";
import { errorCode, latestDeployOf } from "../deploy/deploy.ts";
import { importedManifest } from "../deploy/release.ts";
import { mappedGeneration } from "../deploy/router.ts";
import { deployOrder } from "../deploy/versions.ts";
import {
  claimRun,
  currentRun,
  hasEnded,
  holdsClient,
  instanceStatus,
  releaseRun,
  stillHolds,
} from "../runners.ts";
import type { HeldClient } from "../runners.ts";
import {
  guarded,
  isEngineAbort,
  quickStep,
  stop,
  stopReason,
} from "../workflow-steps.ts";
import { tellCore } from "./activity.ts";
import { RolloutError } from "./errors.ts";
import { parsePrevious } from "./targets.ts";
import type { PreviousRun } from "./targets.ts";

/** A Worker to send all traffic back to its previous version. */
export interface RestoredWorker {
  app: string;
  scriptName: string;
  version: string;
}

/**
 * Sends all of each of `workers`' traffic to its version, in order,
 * unless it goes there already. Forced: the previous version's secrets
 * are meant (`deployVersion`). `stillHeld`, when given, is checked right
 * before each: once it says no, nothing more is restored
 * (`runner_replaced`).
 */
export const restoreVersions = async (
  api: CloudflareApi,
  accountId: string,
  workers: readonly RestoredWorker[],
  message: string,
  stillHeld?: () => Promise<boolean>
): Promise<void> => {
  for (const { scriptName, version } of workers) {
    // oxlint-disable-next-line no-await-in-loop -- checked right before each
    if (stillHeld !== undefined && !(await stillHeld())) {
      throw stop("runner_replaced", "The rollback no longer holds the client");
    }
    // oxlint-disable-next-line no-await-in-loop -- one Worker at a time, in order
    if ((await liveVersion(api, accountId, scriptName)) !== version) {
      // oxlint-disable-next-line no-await-in-loop -- one Worker at a time, in order
      await deployVersion(api, accountId, scriptName, version, {
        message,
        force: true,
      });
    }
  }
};

/**
 * The version each Worker was confirmed live on, by app: null when it
 * wasn't (its traffic split, or its deployments couldn't be read).
 */
export type Confirmed = Record<string, string | null>;

/** How often a rollback tries to read what a Worker runs once it restored it. */
const confirmAttempts = 3;

/** A Worker the rollback couldn't confirm, as its record stores it. */
const unconfirmed = "unknown";

/** Where the rollback's record stores what `app` was confirmed live on. */
const confirmedKey = (app: string): string => `confirmed_${app}`;

/**
 * The version `scriptName` sends all its traffic to, read live, tried a
 * few times: null when its traffic is split, or it couldn't be read. A
 * read that fails never fails the restore it follows.
 */
const confirmLive = async (
  api: CloudflareApi,
  accountId: string,
  scriptName: string
): Promise<string | null> => {
  for (let attempt = 1; attempt <= confirmAttempts; attempt += 1) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- tried again only on failure
      return (await liveVersion(api, accountId, scriptName)) ?? null;
    } catch (error) {
      log.warn("rollback.unconfirmed", {
        scriptName,
        attempt,
        error: errorCode(error),
      });
    }
  }
  return null;
};

/** What each of `workers` is confirmed live on (`confirmLive`), by app. */
const confirmVersions = async (
  api: CloudflareApi,
  accountId: string,
  workers: readonly RestoredWorker[]
): Promise<Confirmed> =>
  Object.fromEntries(
    await Promise.all(
      workers.map(
        async ({ app, scriptName }): Promise<[string, string | null]> => [
          app,
          await confirmLive(api, accountId, scriptName),
        ]
      )
    )
  );

const detailSchema = z.record(z.string(), z.unknown());

/**
 * What rollback of client `clientId` from rollout `rolloutId` stored as
 * confirmed live when it recorded itself (`recordRollback`): read back,
 * never live again once the client is released.
 */
const storedConfirmed = async (
  db: ConsoleDatabase,
  rolloutId: string,
  clientId: string,
  workers: readonly RestoredWorker[]
): Promise<Confirmed> => {
  const [row] = await db
    .select({ detail: auditEvents.detail })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.clientId, clientId),
        eq(auditEvents.target, rolloutId),
        eq(auditEvents.action, "rollout.client_rolled_back")
      )
    )
    .orderBy(desc(auditEvents.at))
    .limit(1);
  const parsed = detailSchema.safeParse(JSON.parse(row?.detail ?? "null"));
  const detail = parsed.success ? parsed.data : {};
  return Object.fromEntries(
    workers.map(({ app }) => {
      const value = detail[confirmedKey(app)];
      return [
        app,
        typeof value === "string" && value !== unconfirmed ? value : null,
      ];
    })
  );
};

/**
 * Client `clientId`'s Workers as a rollback of release `releaseId` puts
 * them back: each Worker before those it binds (core before connect),
 * the reverse of a deploy's order, so no Worker runs against one newer
 * than itself.
 */
export const workersToRestore = async (
  db: ConsoleDatabase,
  clientId: string,
  releaseId: string,
  previous: PreviousRun
): Promise<RestoredWorker[]> => {
  const manifest = await importedManifest(db, releaseId);
  const scripts = await db
    .select({ app: clientWorkers.worker, scriptName: clientWorkers.scriptName })
    .from(clientWorkers)
    .where(eq(clientWorkers.clientId, clientId));
  const order = deployOrder(manifest?.workers ?? {}).toReversed();
  return scripts
    .toSorted((a, b) => order.indexOf(a.app) - order.indexOf(b.app))
    .flatMap(({ app, scriptName }) => {
      const version = previous.versions[app];
      return version === undefined ? [] : [{ app, scriptName, version }];
    });
};

/**
 * A target's statuses once a step of the rollout's started on it: what can
 * be rolled back, if its traffic moved (`check`).
 */
const reached = ["deploying", "done", "failed", "stopped"] as const;

/** Whether a target in `status` was reached by its rollout. */
const wasReached = (status: string): boolean =>
  reached.some((each) => each === status);

/** A new rollback's runner id: its Workflow instance's. */
const newRollbackId = (): string =>
  `rollback-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;

/** The steps of a deploy before anything of it is live: a rollback waits them out. */
const preparing: ReadonlySet<string | null> = new Set([null, "resources"]);

/** What a rollback of a client works from, once checked. */
interface Checked {
  accountId: string;
  previous: PreviousRun;
  /** Its Workers, in the order a rollback restores them. */
  workers: RestoredWorker[];
}

/**
 * Whether `previous` is the release built right before release
 * `releaseId`: the only one whose code the release's migrations still
 * serve (they expand for it, and contract only in the release after).
 */
const isReleaseBefore = async (
  db: ConsoleDatabase,
  releaseId: string,
  previous: string | null
): Promise<boolean> => {
  const [release] = await db
    .select({ builtAt: releases.builtAt })
    .from(releases)
    .where(eq(releases.id, releaseId));
  if (release === undefined || previous === null) {
    return false;
  }
  const [before] = await db
    .select({ id: releases.id })
    .from(releases)
    .where(lt(releases.builtAt, release.builtAt))
    .orderBy(desc(releases.builtAt))
    .limit(1);
  return before?.id === previous;
};

/**
 * Whether any of `workers` in account `accountId` isn't sending all its
 * traffic to its previous version, read live from the account: the
 * truth of what a rollback would change, whatever was or wasn't recorded
 * (an upload can go live and the write after it fail).
 */
const movedOffPrevious = async (
  api: CloudflareApi,
  accountId: string,
  workers: readonly RestoredWorker[]
): Promise<boolean> => {
  const live = await Promise.all(
    workers.map(
      async ({ scriptName }) => await liveVersion(api, accountId, scriptName)
    )
  );
  return workers.some(({ version }, index) => live[index] !== version);
};

/**
 * Checks that client `clientId` can be rolled back from rollout
 * `rolloutId`: the rollout reached it and recorded what it ran before,
 * and a Worker of the client isn't serving its previous version, read
 * live from its account (`nothing_to_roll_back`: otherwise there's
 * nothing to undo), the rollout's deploy is still its latest
 * (`superseded`) and past its resources and migrations
 * (`client_busy`: nothing of it is live before), what it ran before is the release right
 * before the rollout's, or the same one (`too_far_back`), and its secrets generation is
 * the one the previous versions carry, in the console and the router's
 * map (`rotated_since`: the router would send a secret they don't have).
 */
const check = async (
  env: Env,
  api: CloudflareApi,
  rolloutId: string,
  clientId: string
): Promise<Checked> => {
  const db = consoleDatabase(env.DB);
  const [target] = await db
    .select({
      status: rolloutTargets.status,
      deployId: rolloutTargets.deployId,
      previous: rolloutTargets.previous,
      generation: clients.generation,
      accountId: clients.accountId,
    })
    .from(rolloutTargets)
    .innerJoin(clients, eq(clients.id, rolloutTargets.clientId))
    .where(
      and(
        eq(rolloutTargets.rolloutId, rolloutId),
        eq(rolloutTargets.clientId, clientId)
      )
    );
  const previous = parsePrevious(target?.previous ?? null);
  if (
    target === undefined ||
    previous === null ||
    target.deployId === null ||
    !wasReached(target.status)
  ) {
    throw new RolloutError(
      "nothing_to_roll_back",
      `Rollout ${rolloutId} has nothing of ${clientId}'s to roll back`
    );
  }
  const latest = await latestDeployOf(db, clientId);
  if (latest?.id !== target.deployId) {
    throw new RolloutError(
      "superseded",
      `A newer deploy of ${clientId} went out after rollout ${rolloutId}`
    );
  }
  if (latest.status === "running" && preparing.has(latest.step)) {
    throw new RolloutError(
      "client_busy",
      `Rollout ${rolloutId} is still preparing ${clientId}: nothing of it is live yet`
    );
  }
  const workers = await workersToRestore(
    db,
    clientId,
    latest.releaseId,
    previous
  );
  if (!(await movedOffPrevious(api, target.accountId, workers))) {
    throw new RolloutError(
      "nothing_to_roll_back",
      `${clientId} runs what it ran before rollout ${rolloutId} already`
    );
  }
  // A secrets rollout's client ran the same release before: its code
  // runs on the database as it is.
  if (
    previous.release !== latest.releaseId &&
    !(await isReleaseBefore(db, latest.releaseId, previous.release))
  ) {
    throw new RolloutError(
      "too_far_back",
      `${clientId} ran ${previous.release ?? "several releases"} before, not the release right before ${latest.releaseId}: roll out instead`
    );
  }
  const mapped = await mappedGeneration(
    env.ROUTER_HOSTS,
    `${clientId}.${clientDomain(env) ?? ""}`
  );
  if (mapped !== previous.generation || target.generation !== mapped) {
    throw new RolloutError(
      "rotated_since",
      `${clientId}'s secrets rotated after rollout ${rolloutId} reached it`
    );
  }
  return { accountId: target.accountId, previous, workers };
};

/** Releases client `clientId` from runner `runId`, logging a failure to. */
const releaseQuietly = async (
  db: ConsoleDatabase,
  clientId: string,
  runId: string
): Promise<void> => {
  try {
    await releaseRun(db, clientId, runId);
  } catch (releaseError) {
    log.error("rollback.release_failed", {
      clientId,
      error: errorCode(releaseError),
    });
  }
};

/** What a rollback's run is started with: identifiers only. */
export interface RollbackParams {
  rolloutId: string;
  clientId: string;
  /** The staff member who asked for it. */
  startedBy: Staff;
}

/**
 * Rolls client `clientId` back from rollout `rolloutId`, as `staff`:
 * claims the client, audited as `rollout.rollback`, and starts the
 * rollback's run (`RollbackClient`), whose id it returns; the run puts
 * the previous versions back in seconds. Refused when the client can't
 * be (`check`), and while a runner other than this rollout has it
 * (`client_busy`).
 */
export const rollbackClient = async (
  env: Env,
  staff: Staff,
  rolloutId: string,
  clientId: string
): Promise<string> => {
  const db = consoleDatabase(env.DB);
  const { previous } = await check(
    env,
    await deployerApi(env),
    rolloutId,
    clientId
  );
  const busy = new RolloutError(
    "client_busy",
    `${clientId} has another runner`
  );
  const run = await currentRun(env, clientId);
  if (run !== null && run.runId !== rolloutId && !hasEnded(run.status)) {
    throw busy;
  }
  const runId = await claimRun(
    db,
    staff,
    clientId,
    run?.runId ?? null,
    {
      action: "rollout.rollback",
      clientId,
      target: rolloutId,
      detail: { release: previous.release ?? "unknown" },
    },
    { kind: "rollback", runId: newRollbackId() }
  );
  if (runId === undefined) {
    throw busy;
  }
  const params: RollbackParams = {
    rolloutId,
    clientId,
    startedBy: { email: staff.email, sub: staff.sub },
  };
  try {
    await env.ROLLBACK_CLIENT.create({ id: runId, params });
  } catch (error) {
    // Its run never started: the client is free again, the error stands.
    await releaseQuietly(db, clientId, runId);
    throw error;
  }
  return runId;
};

/**
 * Records rollback `held` of client `held.clientId` from rollout
 * `rolloutId`, audited: its target `rolled_back`, the console's record of
 * its Workers back on the previous versions, the rollout stopped
 * (`cancelled`), its config marked changed (the previous versions carry
 * the flags and sign-in of their own deploy, not staff's latest, so the
 * next rollout or apply deploys them again), and the client released.
 * All of it only while the rollback still holds the client, in the same
 * batch: one that lost it changes nothing (`runner_replaced`).
 */
const recordRollback = async (
  db: ConsoleDatabase,
  params: RollbackParams,
  held: HeldClient,
  previous: PreviousRun,
  workers: readonly RestoredWorker[],
  confirmed: Confirmed
): Promise<void> => {
  const { rolloutId, clientId, startedBy } = params;
  const now = new Date();
  const holding = stillHolds(held);
  const recorded = await actIfChanged(
    db,
    startedBy,
    db
      .update(rolloutTargets)
      .set({ status: "rolled_back", error: null, updatedAt: now })
      .where(
        and(
          eq(rolloutTargets.rolloutId, rolloutId),
          eq(rolloutTargets.clientId, clientId),
          inArray(rolloutTargets.status, [...reached]),
          holding
        )
      ),
    {
      action: "rollout.client_rolled_back",
      clientId,
      target: rolloutId,
      detail: {
        release: previous.release ?? "unknown",
        ...Object.fromEntries(
          workers.map(({ app, version }) => [app, version])
        ),
        // What each Worker was confirmed live on before the release below:
        // what the client's Activity is told, now and on any rerun.
        ...Object.fromEntries(
          workers.map(({ app }) => [
            confirmedKey(app),
            confirmed[app] ?? unconfirmed,
          ])
        ),
      },
    },
    [
      ...workers.map(({ scriptName, version }) =>
        db
          .update(clientWorkers)
          .set({
            releaseId: previous.release,
            versionId: version,
            deployedAt: now,
          })
          .where(
            and(
              eq(clientWorkers.clientId, clientId),
              eq(clientWorkers.scriptName, scriptName),
              holding
            )
          )
      ),
      db
        .update(clients)
        .set({ configChangedAt: now, updatedAt: now })
        .where(and(eq(clients.id, clientId), holding)),
      db
        .update(rollouts)
        .set({ status: "cancelled", updatedAt: now })
        .where(
          and(
            eq(rollouts.id, rolloutId),
            inArray(rollouts.status, ["running", "waiting"]),
            holding
          )
        ),
      // Last: everything above reads the claim this removes.
      releaseRun(db, clientId, held.runId),
    ]
  );
  if (!recorded) {
    throw stop("runner_replaced", "The rollback no longer holds the client");
  }
};

/**
 * Whether rollback `held` recorded itself already: its client's target is
 * rolled back and the rollback no longer holds the client, as its record
 * batch leaves them in one go. A record step run again after that batch
 * committed (its result lost) finds it so, and is done.
 */
const recordedAlready = async (
  db: ConsoleDatabase,
  rolloutId: string,
  held: HeldClient
): Promise<boolean> => {
  const [target] = await db
    .select({ status: rolloutTargets.status })
    .from(rolloutTargets)
    .where(
      and(
        eq(rolloutTargets.rolloutId, rolloutId),
        eq(rolloutTargets.clientId, held.clientId)
      )
    );
  return (
    target?.status === "rolled_back" &&
    !(await holdsClient(db, held.clientId, held.runId))
  );
};

/**
 * Resumes cancelled rollout `rolloutId`'s run if staff paused it (or asked
 * to), so it goes on to its next step, where it finds the rollout
 * cancelled and ends the client it's on by the cancellation rule
 * (src/rollout/workflow.ts): stopped or skipped, its deploy cancelled and
 * the client released. Paused, it would never get there, and would hold
 * the client and leave the rollout open. Whichever of a pause and a
 * rollback's cancel lands second calls it, so the run can't stay paused.
 */
export const goOnToStop = async (
  env: Env,
  rolloutId: string,
  createdAt: Date
): Promise<void> => {
  const { instance, status } = await instanceStatus(
    env.ROLLOUT,
    rolloutId,
    createdAt
  );
  if (
    instance !== null &&
    (status === "paused" || status === "waitingForPause")
  ) {
    await instance.resume();
  }
};

/**
 * Ends rollout `rolloutId`'s run if the rollout is cancelled, its run
 * hasn't ended, and it's working on none of its clients: none deploying,
 * and none claimed (it claims a client before it marks it deploying), as
 * while it waits for approval, when it would only idle until its wait
 * timed out. A run working on a client is left to stop by itself at its
 * next step (src/rollout/workflow.ts), releasing the client, so no client
 * is left claimed by an ended run or part way; one staff paused would
 * never reach that step, so it's resumed to (`goOnToStop`).
 */
const endIdleRollout = async (env: Env, rolloutId: string): Promise<void> => {
  const db = consoleDatabase(env.DB);
  const [rollout] = await db
    .select({ status: rollouts.status, createdAt: rollouts.createdAt })
    .from(rollouts)
    .where(eq(rollouts.id, rolloutId));
  const [deploying] = await db
    .select({ clientId: rolloutTargets.clientId })
    .from(rolloutTargets)
    .where(
      and(
        eq(rolloutTargets.rolloutId, rolloutId),
        eq(rolloutTargets.status, "deploying")
      )
    )
    .limit(1);
  const [claimed] = await db
    .select({ clientId: clientRuns.clientId })
    .from(rolloutTargets)
    .innerJoin(clientRuns, eq(clientRuns.clientId, rolloutTargets.clientId))
    .where(
      and(
        eq(rolloutTargets.rolloutId, rolloutId),
        eq(clientRuns.runId, rolloutId)
      )
    )
    .limit(1);
  if (rollout?.status !== "cancelled") {
    return;
  }
  if (deploying !== undefined || claimed !== undefined) {
    await goOnToStop(env, rolloutId, rollout.createdAt);
    return;
  }
  const { instance, status } = await instanceStatus(
    env.ROLLOUT,
    rolloutId,
    rollout.createdAt
  );
  if (instance !== null && !hasEnded(status)) {
    await instance.terminate();
  }
};

/**
 * Rolling a client back, as a Cloudflare Workflow: an instance per
 * rollback, a runner of the client (src/runners.ts). It restores each
 * Worker's previous version while it holds the client, reads what runs
 * again and puts back any change that landed since, records it while it
 * still holds the client (a record step run again after its batch
 * committed is done), and ends the rollout's run while it deploys no
 * client (`endIdleRollout`). A rollback that fails, or lost the client,
 * releases it (if it still holds it) and records nothing.
 */
export class RollbackClient extends WorkflowEntrypoint<Env, RollbackParams> {
  override async run(
    event: WorkflowEvent<RollbackParams>,
    step: WorkflowStep
  ): Promise<void> {
    const { payload: params } = event;
    const { rolloutId, clientId } = params;
    const held: HeldClient = { clientId, runId: event.instanceId };
    const db = consoleDatabase(this.env.DB);
    const holds = async () => await holdsClient(db, clientId, held.runId);
    try {
      const plan = await step.do(
        "plan",
        quickStep,
        guarded(
          async () =>
            await check(
              this.env,
              await deployerApi(this.env),
              rolloutId,
              clientId
            )
        )
      );
      await step.do(
        "restore",
        quickStep,
        guarded(async () => {
          await restoreVersions(
            await deployerApi(this.env),
            plan.accountId,
            plan.workers,
            `Rollback of rollout ${rolloutId}`,
            holds
          );
        })
      );
      // What each Worker was confirmed live on, read last before the
      // client was released and stored with the record: what the
      // client's Activity is told.
      const confirmed = await step.do(
        "record",
        quickStep,
        guarded(async (): Promise<Confirmed> => {
          // First: run again after its batch committed, it's done, and
          // no longer holds the client it released; what it confirmed is
          // what that batch stored, never read live after the release.
          if (await recordedAlready(db, rolloutId, held)) {
            return await storedConfirmed(db, rolloutId, clientId, plan.workers);
          }
          const api = await deployerApi(this.env);
          // Read again, still holding the client, right before it's
          // released: a traffic change of the rollout's that was on its
          // way when the rollback took the client may have landed since.
          await restoreVersions(
            api,
            plan.accountId,
            plan.workers,
            `Rollback of rollout ${rolloutId}`,
            holds
          );
          const live = await confirmVersions(api, plan.accountId, plan.workers);
          await recordRollback(
            db,
            params,
            held,
            plan.previous,
            plan.workers,
            live
          );
          return live;
        })
      );
      await step.do(
        "end the rollout's run",
        quickStep,
        guarded(async () => {
          await endIdleRollout(this.env, rolloutId);
        })
      );
      // In the client's own Activity too, as the platform update it is:
      // told once it's done, of the core version confirmed live, and never
      // failing it (`tellCore`: its keys are read inside it, so even their
      // absence is only an unrecorded notice).
      const core = plan.workers.find(({ app }) => app === "core");
      if (core !== undefined) {
        await step.do("tell core", quickStep, async () => {
          const live = confirmed[core.app] ?? null;
          await tellCore(
            { db, secrets: async () => await activityKeys(this.env) },
            clientId,
            live,
            {
              by: params.startedBy.email,
              what: "rollback",
              // The previous release, if that's what core was confirmed on.
              release:
                live === core.version
                  ? (plan.previous.release ?? "unknown")
                  : "unknown",
              at: new Date(event.timestamp).toISOString(),
            }
          );
        });
      }
    } catch (error) {
      if (isEngineAbort(error)) {
        throw error;
      }
      await step.do("release", quickStep, async () => {
        log.warn("rollback.stopped", { clientId, error: stopReason(error) });
        await releaseQuietly(db, clientId, held.runId);
      });
      throw error;
    }
  }
}

/** A client's rollback in a ring's: started, or why it was refused. */
export interface RingRollback {
  clientId: string;
  /** The rollback's run, once started. */
  runId: string | null;
  refused: string | null;
}

/**
 * Rolls back, as `staff`, every client of rollout `rolloutId`'s ring
 * `ring` the rollout reached (`rollbackClient`); a client that's refused
 * doesn't stop the others.
 */
export const rollbackRing = async (
  env: Env,
  staff: Staff,
  rolloutId: string,
  ring: number
): Promise<RingRollback[]> => {
  const db = consoleDatabase(env.DB);
  const targets = await db
    .select({ clientId: rolloutTargets.clientId })
    .from(rolloutTargets)
    .where(
      and(
        eq(rolloutTargets.rolloutId, rolloutId),
        eq(rolloutTargets.ring, ring),
        inArray(rolloutTargets.status, [...reached])
      )
    );
  const results: RingRollback[] = [];
  for (const { clientId } of targets) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- one client at a time
      const runId = await rollbackClient(env, staff, rolloutId, clientId);
      results.push({ clientId, runId, refused: null });
    } catch (error) {
      if (!(error instanceof RolloutError)) {
        throw error;
      }
      results.push({ clientId, runId: null, refused: error.code });
    }
  }
  return results;
};

/** How long staff's rollback waits for its run, and how often it looks. */
const rollbackWaitMs = 20_000;
const rollbackPollMs = 500;

/** A rollback run's statuses once it ended without finishing. */
const failedRuns: ReadonlySet<string> = new Set(["errored", "terminated"]);

/**
 * Waits for rollback run `runId` to end, up to `rollbackWaitMs` (its run
 * takes seconds), and returns whether it failed: errored, or ended
 * before it finished. One still going after that isn't failed, and the
 * page shows it as it is.
 */
const rollbackFailed = async (env: Env, runId: string): Promise<boolean> => {
  const instance = await env.ROLLBACK_CLIENT.get(runId);
  for (let waited = 0; waited < rollbackWaitMs; waited += rollbackPollMs) {
    // oxlint-disable-next-line no-await-in-loop -- polled until it ends
    const { status } = await instance.status();
    if (hasEnded(status)) {
      return failedRuns.has(status);
    }
    // oxlint-disable-next-line no-await-in-loop -- polled until it ends
    await scheduler.wait(rollbackPollMs);
  }
  return false;
};

/**
 * Rolls client `clientId` back from rollout `rolloutId`, as `staff`
 * (`rollbackClient`), and waits for its run, so staff read what it did.
 * Refused as `rollbackClient` refuses, and when its run failed
 * (`rollback_failed`).
 */
export const rollbackClientAndWait = async (
  env: Env,
  staff: Staff,
  rolloutId: string,
  clientId: string
): Promise<string> => {
  const runId = await rollbackClient(env, staff, rolloutId, clientId);
  if (await rollbackFailed(env, runId)) {
    throw new RolloutError(
      "rollback_failed",
      `The rollback of ${clientId} didn't finish`
    );
  }
  return runId;
};

/**
 * Rolls ring `ring` of rollout `rolloutId` back, as `staff`
 * (`rollbackRing`), and waits for each client's run: one whose run
 * failed is listed as refused (`rollback_failed`), like one refused to
 * begin with.
 */
export const rollbackRingAndWait = async (
  env: Env,
  staff: Staff,
  rolloutId: string,
  ring: number
): Promise<RingRollback[]> => {
  const results = await rollbackRing(env, staff, rolloutId, ring);
  return await Promise.all(
    results.map(async (result) =>
      result.runId !== null && (await rollbackFailed(env, result.runId))
        ? { ...result, refused: "rollback_failed" }
        : result
    )
  );
};
