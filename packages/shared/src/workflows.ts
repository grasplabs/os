import { defineErrorFamily } from "./errors.ts";
import type { AppId, RunId, WorkflowId } from "./ids.ts";
import type { Json } from "./json.ts";

// A workflow is code in an App (`workflows/<id>.ts`), written with the
// workflow SDK. Each run is pinned to the App version it started on, and
// acts for one person: the one who started it, or the App's owner for a
// run a trigger started.

/** Why a workflow call was refused. */
export const workflowErrors = defineErrorFamily({
  "workflow.invalid": "That isn't a valid request for a workflow.",
  "workflow.not_found": "The App's current version has no such workflow.",
  "workflow.run_not_found": "There's no such workflow run.",
  "workflow.build_failed": "The App's workflows don't build.",
  "workflow.tests_failed":
    "A workflow's tests fail, or it has none, so this version can't be made current.",
});

/**
 * Where a run is: running (a step, or a sleep), waiting for an event or a
 * decision, paused until its App has an owner again, or ended.
 */
export type RunStatus =
  | "running"
  | "waiting"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

/** One run of a workflow. */
export interface WorkflowRun {
  id: RunId;
  app: AppId;
  workflow: WorkflowId;
  /** The App version it runs, whatever version is current now. */
  version: number;
  /** A person started it (and it acts for them), or a trigger did. */
  startedBy: { type: "person"; userId: string } | { type: "trigger" };
  status: RunStatus;
  createdAt: string;
  endedAt: string | null;
  /** What it returned, once completed; only from `status`. */
  output?: Json;
  /** Why it failed; only from `status`. */
  error?: { name: string; message: string };
}

/**
 * A signed-in person's workflows. Admins and builders; every call checks
 * the session and the person's role again.
 */
export interface WorkflowsApi {
  /**
   * Starts a run of an App's workflow on the App's current version, acting
   * for the person who starts it.
   */
  start: (
    app: string,
    workflow: string,
    input?: unknown
  ) => Promise<WorkflowRun>;
  /** A run as it is now. */
  status: (run: string) => Promise<WorkflowRun>;
  /** An App's runs, newest first. */
  list: (app: string) => Promise<WorkflowRun[]>;
  /** Stops a run for good; a run that ended stays as it ended. */
  cancel: (run: string) => Promise<WorkflowRun>;
}
