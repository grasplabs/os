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
import { z } from "zod";

import { callApp } from "../app.ts";
import { versionFiles } from "../apps.ts";
import { runBindingsFor } from "../bindings.ts";
import { requireActivePerson } from "../permissions.ts";
import type { WorkContext } from "../restricted.ts";
import { declaredParams, loadRun } from "./code.ts";
import type { Settled, StepError } from "./code.ts";
import {
  coreStepPrefix,
  fromIsolate,
  RunHost,
  settle,
  stepLimitOf,
  watchedStep,
} from "./host.ts";
import type { FailedStep, HostedRun, RunStep } from "./host.ts";
import { paramValues } from "./params.ts";
import {
  actFor,
  appRecord,
  endRun,
  findRun,
  pauseForOwner,
  recordWaiting,
  resumeRun,
} from "./runs.ts";
import type { RunRow, Stopped } from "./runs.ts";

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
//
// A run's parameter values are the ones people set (params.ts), read as
// the version it is pinned to declares them, never the current version:
// so a stored value counts only where that version declares it of that
// kind. The SDK records them in the run's first step, so a run keeps the
// values it started with.

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

/**
 * Who a run acts for now: its person, or its App's owner; and the App
 * version whose code it runs, for the audit log.
 */
const authorityOf = async (env: Env, row: RunRow): Promise<Authority> => {
  const app = appIdSchema.parse(row.appId);
  const { ownerId } = await appRecord(env, app);
  return {
    subject: { type: "app", appId: app },
    onBehalfOf: row.startedBy ?? ownerId,
    mode: "workflow",
    appVersion: row.version,
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

/**
 * What a failed run reports: the step it stopped at, when it failed with
 * the error of the step that failed last (workflow code that caught that
 * error and failed otherwise, or failed before any step, stopped at none),
 * and its error's code and message.
 */
const stoppedWith = (
  error: StepError,
  last: FailedStep | undefined
): Stopped => {
  const atStep =
    last !== undefined &&
    last.error.name === error.name &&
    last.error.message === error.message &&
    last.error.code === error.code;
  return {
    step: atStep ? last.step : null,
    input: atStep ? last.input : null,
    error: {
      code: error.code ?? "workflow.run_failed",
      message: error.message,
    },
  };
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
  run: () => Promise<unknown>
): Promise<Settled<unknown>> => {
  const outer = await settle(run);
  return outer.ok ? fromIsolate(outer.value) : outer;
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
  engineStep: RunStep
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
  // The error the engine stopped this execution with (a pause, a cancel),
  // once it has: it stays for the rest of the execution, whose every
  // later engine call stops the same way, and is the one to end it with.
  let engineError: { error: unknown } | undefined;
  const engineStopped = (error: unknown): void => {
    engineError = { error };
  };
  const step = watchedStep(engineStep, engineStopped, stepLimitOf(env));
  let lastFailed: FailedStep | undefined;
  const stepFailed = (failure: FailedStep): void => {
    lastFailed = failure;
  };
  const result = await settledRun(async () => {
    const { authority, bindings, connections } = await whileOwnerActs(
      env,
      step,
      row,
      async () => {
        const acting = await authorityOf(env, row);
        return {
          authority: acting,
          ...(await runBindingsFor(
            env,
            acting,
            contextOf(pinned.data.app, runId)
          )),
        };
      }
    );
    await resumeRun(env, row);
    await actFor(env, row, authority.onBehalfOf);
    const run: HostedRun = { ...pinned.data, runId, authority, connections };
    const files = await versionFiles(env, run.app, run.version);
    // Read on every load, though only the run's first uses them: after
    // that the SDK replays the values its `$params` step recorded.
    const params = await paramValues(
      env,
      run.app,
      run.workflow,
      await declaredParams(env, run.app, run.version, run.workflow, files)
    );
    const code = loadRun(env, {
      app: run.app,
      version: run.version,
      workflow: run.workflow,
      files,
      env: bindings,
    });
    // Before every step, the person the run acts for must still be there.
    const acting = async (): Promise<void> => {
      await whileOwnerActs(env, step, row, async () => {
        await requireActivePerson(env, authority);
      });
    };
    const host = new RunHost(env, step, run, {
      acting,
      stepFailed,
      waiting: async (feature) => {
        await recordWaiting(env, row, feature);
      },
      callApp: async (caller, method, args) =>
        await callApp(env, run.app, caller, method, args),
    });
    return await code.run(host, {
      runId,
      params: Object.fromEntries(params),
      input: event.payload,
      connections: Object.keys(connections),
    });
  });
  const failed = result.ok ? undefined : result.error;
  if (failed && engineError) {
    // The engine stopped this execution, to resume or end it itself: the
    // run didn't fail, and the engine hears its own error back. Whether
    // it has resumed the run meanwhile makes no difference: that is
    // another execution, which goes on from here.
    const stopped = engineError.error;
    throw stopped instanceof Error ? stopped : runError(failed);
  }
  // A step, so a run that ended is recorded and audited once. A failed
  // run stops here, whatever failed: the step's retries (only for failures
  // trying again may fix, host.ts) are behind it.
  const stopped = failed && stoppedWith(failed, lastFailed);
  await step.do(`${coreStepPrefix}end`, {}, async () => {
    await endRun(env, row, stopped);
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
