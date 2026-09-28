import { wrapWorkflowBinding } from "@cloudflare/dynamic-workflows";
import type { AppId, WorkflowId } from "@grasp-os/shared/ids";
import type { Json } from "@grasp-os/shared/json";
import { z } from "zod";

// The engine that runs Apps' workflow runs, behind the little core asks of
// it: create a run, see where it is, terminate it, send it an event. This
// is the only module that touches the engine (`WORKFLOWS`, Cloudflare
// Workflows), so another profile swaps it here and nowhere else.
//
// On-prem (plain workerd, scripts/workerd-smoke.ts) has no `WORKFLOWS`:
// workerd has no Workflows engine (Wrangler's local dev and the tests get
// one from Miniflare, which emulates it with a Worker of its own). Nor does
// it have `LOADER` unless workerd runs with `--experimental`: workerd
// refuses a Worker Loader binding without it. The loader runs App methods
// (app.ts), the screen compiler (screens.ts) and workflow code (code.ts).
// So on-prem, `apps` and `screens` stay switched off unless workerd runs
// with `--experimental`, and `workflows` and `knowledge_uploads` (whose
// extractions are core's own runs, knowledge/uploads.ts) stay off either
// way. With both off no run starts (runs.ts, uploads.ts), and nothing here
// is reached.

export { DynamicWorkflowBinding } from "@cloudflare/dynamic-workflows";

/** What a run is tagged with: the dispatcher loads it by these. */
export interface PinnedRun {
  app: AppId;
  workflow: WorkflowId;
  version: number;
}

/**
 * A workflow of core's own, not an App's, run on the same engine and
 * dispatcher: extracting an upload's text (knowledge/extraction.ts).
 */
export type InternalWorkflow = "extraction";

/** The engine core runs workflow runs on. */
export interface RunEngine {
  /** Creates the run `id`, pinned to its App version, with its input. */
  create: (run: {
    id: string;
    pinned: PinnedRun;
    input: Json | undefined;
  }) => Promise<void>;
  /** Creates the run `id` of one of core's own workflows, with its input. */
  createInternal: (run: {
    id: string;
    workflow: InternalWorkflow;
    input: Json;
  }) => Promise<void>;
  /** Where the engine has the run; nothing when it has no such run. */
  status: (id: string) => Promise<InstanceStatus | undefined>;
  /**
   * Terminates the run; one that has ended already, or that the engine has
   * no instance of, stays as it is.
   */
  terminate: (id: string) => Promise<void>;
  /**
   * Sends the run an event, for a wait on it to see. `event.id` names the
   * event, not the delivery: a sender that tries again sends the same ID,
   * and the run takes the event once (`RunHost.waitForEvent`).
   */
  sendEvent: (
    id: string,
    event: { type: string; id: string; payload: unknown }
  ) => Promise<void>;
}

/**
 * The payload of an event as the engine carries it: the event's own ID
 * next to its payload. The engine keeps a run's events by type only, with
 * no ID, so a copy of one delivered twice would otherwise pass for a new
 * event.
 */
export const sentEventSchema = z.strictObject({
  id: z.string().min(1),
  payload: z.unknown(),
});

/** How Workflows says it has no instance of that ID. */
const instanceNotFound = /\binstance\.not_found\b/u;

const isNotFound = (error: unknown): boolean =>
  error instanceof Error && instanceNotFound.test(error.message);

/** Where Cloudflare Workflows has a run that has ended. */
const endedStatuses = new Set<InstanceStatus["status"]>([
  "terminated",
  "complete",
  "errored",
]);

/** Whether the instance has ended; not when its status can't be read. */
const hasEnded = async (instance: WorkflowInstance): Promise<boolean> => {
  try {
    const { status } = await instance.status();
    return endedStatuses.has(status);
  } catch {
    return false;
  }
};

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
  createInternal: async ({ id, workflow, input }) => {
    // Tagged with the workflow it is: the dispatcher runs it by that.
    await wrapWorkflowBinding({ internal: workflow }).create({
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
      if (!isNotFound(error)) {
        throw error;
      }
      return undefined;
    }
  },
  terminate: async (id) => {
    let instance: WorkflowInstance;
    try {
      instance = await env.WORKFLOWS.get(id);
    } catch (error) {
      // No instance, nothing to terminate: a run whose start failed, as a
      // cancel racing it finds it.
      if (isNotFound(error)) {
        return;
      }
      throw error;
    }
    try {
      await instance.terminate();
    } catch (error) {
      // The terminate's own error, unless the run has ended anyway.
      if (!(await hasEnded(instance))) {
        throw error;
      }
    }
  },
  sendEvent: async (id, { type, id: eventId, payload }) => {
    const instance = await env.WORKFLOWS.get(id);
    await instance.sendEvent({
      type,
      payload: { id: eventId, payload } satisfies z.input<
        typeof sentEventSchema
      >,
    });
  },
});
