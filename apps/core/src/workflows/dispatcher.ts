import { createDynamicWorkflowEntrypoint } from "@cloudflare/dynamic-workflows";
import type { WorkflowRunner } from "@cloudflare/dynamic-workflows";
import {
  appIdSchema,
  runIdSchema,
  workflowIdSchema,
} from "@grasp-os/shared/ids";
import type { AppId, RunId } from "@grasp-os/shared/ids";
import { permissionErrors } from "@grasp-os/shared/permissions";
import type { Authority } from "@grasp-os/shared/permissions";
import { exports } from "cloudflare:workers";
import { z } from "zod";

import { versionFiles } from "../apps.ts";
import { bindingsFor } from "../bindings.ts";
import { featureEnabled } from "../features.ts";
import { requireActivePerson } from "../permissions.ts";
import type { WorkContext } from "../restricted.ts";
import { loadRun } from "./code.ts";
import type { Settled, StepError } from "./code.ts";
import { coreStepPrefix, fromIsolate, RunHost, settle } from "./host.ts";
import type { HostedRun, RunStep } from "./host.ts";
import {
  appRecord,
  endRun,
  findRun,
  pauseForOwner,
  resumeRun,
} from "./runs.ts";
import type { RunRow } from "./runs.ts";

export { DynamicWorkflowBinding } from "@cloudflare/dynamic-workflows";

// The one Workflow of a deployment (`WORKFLOWS` in wrangler.jsonc). Every
// run of every App's workflow is an instance of it, tagged with its App,
// workflow and App version (runs.ts). Each time Cloudflare Workflows runs
// an instance, at its start and on every resume, the dispatcher loads it
// afresh: the run's row, who it acts for now, an env built from the App's
// permissions as they are now, and the workflow's code at the run's own
// version. So a run keeps its code when a new version becomes current, and
// a permission revoked while it waited is gone from its next step on.
//
// Who a run acts for (threat model decision Q10): the person who started
// it, or, for a run a trigger started, the App's owner. A run acts for
// nobody who has left, checked at every load and before every step: a
// person's run fails, and a triggered run pauses until its App has an
// owner again.

/** What the dispatcher tags each run with (runs.ts). */
const pinnedSchema = z.object({
  app: appIdSchema,
  workflow: workflowIdSchema,
  version: z.int().positive(),
});

/**
 * The event a run paused for its owner waits for: sent to it when its App
 * has an active owner again.
 */
export const ownerEventType = "grasp-owner-set";

/** How long a paused run waits for an owner, or for workflows, at a time. */
const pauseLimit = "365 days";

/** Who a run acts for now: its person, or its App's owner. */
const authorityOf = async (env: Env, row: RunRow): Promise<Authority> => {
  const app = appIdSchema.parse(row.appId);
  const { ownerId } = await appRecord(env, app);
  return {
    subject: { type: "app", appId: app },
    onBehalfOf: row.startedBy ?? ownerId,
    mode: "workflow",
  };
};

/**
 * Runs `attempt`, and while it fails because a triggered run's owner has left,
 * waits, paused, for an owner and runs it again. The wait is a step, so a
 * run that resumes from it goes on from here. A person's run fails once
 * they have left. After the wait, the next load acts for whoever owns the
 * App then; until it, the same person must be back.
 */
const whileOwnerActs = async <T>(
  env: Env,
  step: RunStep,
  row: RunRow,
  attempt: () => Promise<T>
): Promise<T> => {
  try {
    return await attempt();
  } catch (error) {
    const ownerLeft =
      row.startedBy === null &&
      permissionErrors.codeOf(error) === "permission.person_inactive";
    if (!ownerLeft) {
      throw error;
    }
  }
  const wait = await pauseForOwner(env, row);
  await step.waitForEvent(`${coreStepPrefix}owner:${wait}`, {
    type: ownerEventType,
    timeout: pauseLimit,
  });
  const now = (await findRun(env, runIdSchema.parse(row.id))) ?? row;
  await resumeRun(env, now);
  return await whileOwnerActs(env, step, now, attempt);
};

/** The error a failed run ends with: its own name and message. */
const runError = ({ name, message }: StepError): Error => {
  const error = new Error(message);
  error.name = name;
  return error;
};

/**
 * How the run's code ended: as it reports it, or as loading it failed
 * (its person has left, say, or its code doesn't build).
 */
const settledRun = async (
  failedWith: (error: unknown) => void,
  run: () => Promise<unknown>
): Promise<Settled<unknown>> => {
  const outer = await settle(async () => {
    try {
      return await run();
    } catch (error) {
      failedWith(error);
      throw error;
    }
  });
  return outer.ok ? fromIsolate(outer.value) : outer;
};

/** How Cloudflare Workflows has a run it is pausing or stopping. */
const stoppingStatuses = new Set<InstanceStatus["status"]>([
  "waitingForPause",
  "paused",
  "terminated",
]);

/** Whether the engine is stopping the run's execution: paused or cancelled. */
const isStopping = async (env: Env, runId: RunId): Promise<boolean> => {
  const instance = await env.WORKFLOWS.get(runId);
  const { status } = await instance.status();
  return stoppingStatuses.has(status);
};

/**
 * The kill switch: with workflows switched off, a run that starts or
 * resumes pauses at once, before any step, and goes on when resumed with
 * workflows on. The sleep only holds the execution while the pause lands;
 * its name is new each time, as no execution comes back to it. Nothing in
 * core resumes them yet: once the flag is back on, paused instances must be
 * resumed (the Workflows API or dashboard).
 */
const pauseWhileSwitchedOff = async (
  env: Env,
  step: RunStep,
  runId: RunId
): Promise<void> => {
  if (featureEnabled(env, "workflows")) {
    return;
  }
  const instance = await env.WORKFLOWS.get(runId);
  await instance.pause();
  await step.sleep(
    `${coreStepPrefix}switched-off:${crypto.randomUUID()}`,
    365 * 86_400_000
  );
  throw new Error("Workflows are switched off: the run is paused.");
};

/** The run's App, as a context for its restricted mode. */
const contextOf = (app: AppId, runId: RunId): WorkContext => ({
  type: "run",
  appId: app,
  runId,
});

/** Runs (or resumes) one run of an App's workflow. */
const runWorkflow = async (
  env: Env,
  metadata: Record<string, unknown>,
  event: { instanceId: string; payload: unknown },
  step: RunStep
): Promise<unknown> => {
  const pinned = pinnedSchema.safeParse(metadata);
  const runId = runIdSchema.parse(event.instanceId);
  const row = await findRun(env, runId);
  if (
    !(pinned.success && row) ||
    row.appId !== pinned.data.app ||
    row.workflowId !== pinned.data.workflow ||
    row.version !== pinned.data.version
  ) {
    throw new Error(`Run ${runId} doesn't match its record`);
  }
  // Cancelled (its instance maybe not yet terminated) or failed to start:
  // it does nothing more.
  if (row.status === "cancelled" || row.status === "failed") {
    throw new Error(`Run ${runId} has ended: ${row.status}`);
  }
  await pauseWhileSwitchedOff(env, step, runId);
  // The latest error of the engine's own: the one to end an execution the
  // engine is stopping with.
  let engineError: { error: unknown } | undefined;
  const engineFailed = (error: unknown): void => {
    engineError = { error };
  };
  const result = await settledRun(engineFailed, async () => {
    const { authority, bindings } = await whileOwnerActs(
      env,
      step,
      row,
      async () => {
        const acting = await authorityOf(env, row);
        return {
          authority: acting,
          bindings: await bindingsFor(
            env,
            acting,
            contextOf(pinned.data.app, runId)
          ),
        };
      }
    );
    await resumeRun(env, row);
    const run: HostedRun = { ...pinned.data, runId, authority };
    const code = loadRun(env, {
      app: run.app,
      version: run.version,
      workflow: run.workflow,
      files: await versionFiles(env, run.app, run.version),
      env: {
        ...bindings,
        APP: exports.RunAppBinding({ props: { app: run.app, authority } }),
      },
    });
    // Before every step, the person the run acts for must still be there.
    const acting = async (): Promise<void> => {
      await whileOwnerActs(env, step, row, async () => {
        await requireActivePerson(env, authority);
      });
    };
    const host = new RunHost(env, step, run, { acting, engineFailed });
    return await code.run(host, {
      runId,
      // Parameter values people set come with the workflow view; until
      // then every run uses the defaults in the code.
      params: {},
      input: event.payload,
    });
  });
  const failed = result.ok ? undefined : result.error;
  if (failed && (await isStopping(env, runId))) {
    // The engine stopped this execution, to resume or end it itself: the
    // run didn't fail, and the engine hears its own error back.
    const stopped = engineError?.error;
    throw stopped instanceof Error ? stopped : runError(failed);
  }
  // A step, so a run that ended is recorded and audited once.
  await step.do(`${coreStepPrefix}end`, {}, async () => {
    await endRun(env, row, failed);
    return null;
  });
  if (failed) {
    throw runError(failed);
  }
  return result.ok ? result.value : undefined;
};

/**
 * The dispatcher Workflow (`WORKFLOWS`): runs each App's workflow runs,
 * loading each one's code by App and version on every start and resume.
 */
export const WorkflowDispatcher = createDynamicWorkflowEntrypoint<Env>(
  ({ env, metadata }): WorkflowRunner => ({
    run: async (event, step) =>
      await runWorkflow(
        env,
        metadata,
        event,
        // SAFETY: the library hands on the `step` Cloudflare Workflows gave
        // the dispatcher, typed loosely so it needn't depend on its types.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
        step as RunStep
      ),
  })
);
