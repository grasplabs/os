import { appIdSchema } from "@grasp-os/shared/ids";
import { errorFields, log } from "@grasp-os/shared/log";

import { appHost } from "../durable-objects.ts";
import { featureEnabled } from "../features.ts";

// Run status, live, on an App's screens: each time one of its runs
// starts, waits for a decision, has it answered or closed, or ends, core
// tells the App's host (app.ts, `runChanged`), which tells the screens
// following that workflow (`screens.watchRuns`), each push checked by
// screens-rpc.ts as every push to a screen is. A push says only which run
// changed: the screen reads it again, as its person, with what they may
// see of it. Reading again, rather than taking a status from the push,
// also means pushes that overtake each other can't leave a screen showing
// an older status than the one it read last.

/**
 * Tells the screens of the run's App that `run` changed. Best effort, after
 * the change is written: it never fails what changed the run, and a push
 * that doesn't arrive is made up for by the next one, or by the screen
 * reading its runs again when it follows again. Nothing while
 * `screen_workflows` is off.
 */
export const tellScreens = async (
  env: Env,
  run: { id: string; appId: string; workflowId: string }
): Promise<void> => {
  if (!featureEnabled(env, "screen_workflows")) {
    return;
  }
  try {
    await appHost(env, appIdSchema.parse(run.appId)).runChanged(
      run.workflowId,
      run.id
    );
  } catch (error) {
    log.warn("workflow.screens_not_told", {
      runId: run.id,
      ...errorFields(error),
    });
  }
};
