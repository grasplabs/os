import { wrapWorkflowBinding } from "@cloudflare/dynamic-workflows";
import type { AppId, WorkflowId } from "@grasp-os/shared/ids";
import type { Json } from "@grasp-os/shared/json";

// The engine that runs Apps' workflow runs, behind the little core asks of
// it: create a run, see where it is, terminate it, send it an event. This
// is the only module that touches the engine (`WORKFLOWS`, Cloudflare
// Workflows), so another profile swaps it here and nowhere else.
//
// On-prem (plain workerd, scripts/workerd-smoke.ts): workerd has no
// Workflows engine. Wrangler's local dev and the tests get one from
// Miniflare, which emulates it with a Worker of its own; workerd's config
// has no binding for it. And workerd has the Worker Loader (`LOADER`),
// which workflow code runs in, only behind `--experimental`, which
// on-prem doesn't turn on: so Code Mode, which needs the loader, stays off
// there. On-prem has no `WORKFLOWS` and no `LOADER`, and the `workflows`
// feature stays switched off: with the flag off no run starts (runs.ts),
// and nothing here is reached.

export { DynamicWorkflowBinding } from "@cloudflare/dynamic-workflows";

/** What a run is tagged with: the dispatcher loads it by these. */
export interface PinnedRun {
  app: AppId;
  workflow: WorkflowId;
  version: number;
}

/** The engine core runs workflow runs on. */
export interface RunEngine {
  /** Creates the run `id`, pinned to its App version, with its input. */
  create: (run: {
    id: string;
    pinned: PinnedRun;
    input: Json | undefined;
  }) => Promise<void>;
  /** Where the engine has the run; nothing when it has no such run. */
  status: (id: string) => Promise<InstanceStatus | undefined>;
  /** Terminates the run; one that has ended already stays as it is. */
  terminate: (id: string) => Promise<void>;
  /** Sends the run an event, for a wait on it to see. */
  sendEvent: (
    id: string,
    event: { type: string; payload: unknown }
  ) => Promise<void>;
}

/** How Workflows says it has no instance of that ID. */
const instanceNotFound = /\binstance\.not_found\b/u;

/** Where Cloudflare Workflows has a run that has ended. */
const endedStatuses = new Set<InstanceStatus["status"]>([
  "terminated",
  "complete",
  "errored",
]);

/** Cloudflare Workflows, through the deployment's one dispatcher. */
export const runEngine = (env: Env): RunEngine => ({
  create: async ({ id, pinned: { app, workflow, version }, input }) => {
    // Tagged with what the dispatcher loads it by; it reads the rest from
    // the run's row. Placed in the EU where the platform can.
    await wrapWorkflowBinding({ app, workflow, version }).create({
      id,
      params: input,
      locationHint: "weur",
    });
  },
  status: async (id): Promise<InstanceStatus | undefined> => {
    try {
      const instance = await env.WORKFLOWS.get(id);
      return await instance.status();
    } catch (error) {
      if (!(error instanceof Error && instanceNotFound.test(error.message))) {
        throw error;
      }
      return undefined;
    }
  },
  terminate: async (id) => {
    const instance = await env.WORKFLOWS.get(id);
    try {
      await instance.terminate();
    } catch (error) {
      const { status } = await instance.status();
      if (!endedStatuses.has(status)) {
        throw error;
      }
    }
  },
  sendEvent: async (id, event) => {
    const instance = await env.WORKFLOWS.get(id);
    await instance.sendEvent(event);
  },
});
