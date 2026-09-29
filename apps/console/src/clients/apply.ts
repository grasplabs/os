/**
 * Applying a client's settings now, without waiting for a rollout: a
 * deploy of the release it runs, so its core gets its flags and sign-in,
 * with every Worker live at once (a kill switch can't wait for a gradual
 * rollout). Staff start it from the client's page.
 *
 * It's a runner like the others (src/runners.ts): it claims the client
 * with the same conditional write, audited (`client.apply_settings`), so
 * it never runs beside a rollout, a rollback or provisioning, and its
 * Workflow (`ApplyClient`) deploys as that runner and releases the client
 * when it's done, whether the deploy worked or not.
 */
import { log } from "@grasp-os/shared/log";
import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { eq } from "drizzle-orm";

import type { Staff } from "../access.ts";
import { consoleDatabase } from "../db/act.ts";
import type { ConsoleDatabase } from "../db/act.ts";
import { clients, clientWorkers } from "../db/schema.ts";
import { deployContext } from "../deploy/context.ts";
import { errorCode, runDeploy, startDeploy } from "../deploy/deploy.ts";
import { claimRun, currentRun, hasEnded, releaseRun } from "../runners.ts";
import {
  deployStepConfig,
  guarded,
  isEngineAbort,
  quickStep,
  stopReason,
} from "../workflow-steps.ts";
import { SettingsError } from "./settings.ts";

/** What an apply's run is started with: identifiers only. */
export interface ApplyParams {
  clientId: string;
  /** The release its Workers run, which it deploys again. */
  releaseId: string;
  /** The staff member who asked for it. */
  startedBy: Staff;
}

/** A new apply run's instance id. */
const newApplyId = (): string =>
  `apply-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;

/**
 * The release every one of client `clientId`'s Workers runs, as the
 * console made it live; null when they run none, or not the same one.
 */
const runningRelease = async (
  db: ConsoleDatabase,
  clientId: string
): Promise<string | null> => {
  const workers = await db
    .select({ releaseId: clientWorkers.releaseId })
    .from(clientWorkers)
    .where(eq(clientWorkers.clientId, clientId));
  const releases = new Set(workers.map(({ releaseId }) => releaseId));
  const [only = null] = releases.size === 1 ? releases : [];
  return only;
};

/** Releases client `clientId` from runner `runId`, logging a failure to. */
const releaseQuietly = async (
  db: ConsoleDatabase,
  clientId: string,
  runId: string
): Promise<void> => {
  try {
    await releaseRun(db, clientId, runId);
  } catch (error) {
    log.error("apply.release_failed", { clientId, error: errorCode(error) });
  }
};

/**
 * Starts applying client `clientId`'s settings, as `staff`, and returns
 * its run's id. Refused for a client the console doesn't have
 * (`unknown_client`), one that isn't active (`not_active`), one whose
 * Workers don't run one release (`nothing_deployed`), and while another
 * runner has it (`client_busy`).
 */
export const applySettings = async (
  env: Env,
  staff: Staff,
  clientId: string
): Promise<string> => {
  const db = consoleDatabase(env.DB);
  const [client] = await db
    .select({ status: clients.status })
    .from(clients)
    .where(eq(clients.id, clientId));
  if (client === undefined) {
    throw new SettingsError("unknown_client", `No client ${clientId}`);
  }
  if (client.status !== "active") {
    throw new SettingsError("not_active", `${clientId} isn't active`);
  }
  const releaseId = await runningRelease(db, clientId);
  if (releaseId === null) {
    throw new SettingsError(
      "nothing_deployed",
      `${clientId}'s Workers don't run one release`
    );
  }
  const busy = new SettingsError(
    "client_busy",
    `${clientId} has another runner`
  );
  const run = await currentRun(env, clientId);
  if (run !== null && !hasEnded(run.status)) {
    throw busy;
  }
  const runId = await claimRun(
    db,
    staff,
    clientId,
    run?.runId ?? null,
    { action: "client.apply_settings", clientId, target: releaseId },
    { kind: "apply", runId: newApplyId() }
  );
  if (runId === undefined) {
    throw busy;
  }
  const params: ApplyParams = {
    clientId,
    releaseId,
    startedBy: { email: staff.email, sub: staff.sub },
  };
  try {
    await env.APPLY_CLIENT.create({ id: runId, params });
  } catch (error) {
    // Its run never started: the client is free again, the error stands.
    await releaseQuietly(db, clientId, runId);
    throw error;
  }
  return runId;
};

/**
 * Applies a client's settings: deploys the release it runs again, as the
 * client's runner, every Worker live at once (`runDeploy`), then releases
 * the client, whether the deploy worked or not.
 */
export class ApplyClient extends WorkflowEntrypoint<Env, ApplyParams> {
  override async run(
    event: WorkflowEvent<ApplyParams>,
    step: WorkflowStep
  ): Promise<void> {
    const { clientId, releaseId, startedBy } = event.payload;
    const db = consoleDatabase(this.env.DB);
    try {
      const deployId = await step.do(
        "start",
        quickStep,
        guarded(
          async () => await startDeploy(db, startedBy, clientId, releaseId)
        )
      );
      await step.do(
        "deploy",
        deployStepConfig,
        guarded(async () => {
          // As the client's runner: it stops if another takes the client.
          await runDeploy(
            {
              ...(await deployContext(this.env)),
              runner: { clientId, runId: event.instanceId },
            },
            deployId
          );
        })
      );
    } catch (error) {
      if (isEngineAbort(error)) {
        throw error;
      }
      await step.do("release after failing", quickStep, async () => {
        log.warn("apply.stopped", { clientId, error: stopReason(error) });
        await releaseQuietly(db, clientId, event.instanceId);
      });
      throw error;
    }
    await step.do("release", quickStep, async () => {
      await releaseRun(db, clientId, event.instanceId);
    });
  }
}
