import { appErrors } from "@grasp-os/shared/apps";
import { isExpectedCode } from "@grasp-os/shared/errors";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { Permission } from "@grasp-os/shared/permissions";
import { roleErrors } from "@grasp-os/shared/roles";
import { workflowErrors } from "@grasp-os/shared/workflows";
import type { WorkflowRun, WorkflowSummary } from "@grasp-os/shared/workflows";
import { WorkerEntrypoint, exports } from "cloudflare:workers";

import { asPerson } from "./agent-person.ts";
import type { AgentApi, AgentScope } from "./agent-scope.ts";
import { appHost } from "./durable-objects.ts";
import { listAllRuns, workflowOverview } from "./workflows/overview.ts";
import { runStatus } from "./workflows/runs.ts";

// Workflows for a chat's code: `await env.workflows.runs("app-1",
// "report")`. What the chat's person sees of them themselves
// (agent-person.ts), of the workflows the agent may read: a permission's
// object of its own. The agent sees runs' state here, never what a run
// returned or its error's words: those hold what the run read through its
// App's connections and collections, which the chat has no permission
// for, and whose restricted mode it doesn't share; of a restricted App's
// run not even where it failed, beyond a platform error code. Every call
// is audited as the organization's agent acting for the chat's person.
// Only a chat its person started to fix a failed run gets that run's
// report, attached with the App's sources and restricted mode
// (run-fixes.ts).

/** Whether the agent may read workflow `workflow` of App `app`. */
const readsWorkflow =
  (app: unknown, workflow: unknown) =>
  (permissions: Permission[]): boolean =>
    permissions.some(
      ({ object, actions }) =>
        object.type === "workflow" &&
        object.appId === app &&
        object.workflowId === workflow &&
        actions.includes("read")
    );

/** A run, as the chat's agent sees it: its state, not what it read. */
export interface AgentRun {
  id: string;
  app: string;
  workflow: string;
  version: number;
  status: WorkflowRun["status"];
  startedBy: WorkflowRun["startedBy"];
  createdAt: string;
  endedAt: string | null;
  /** Where it failed: the step (null outside one) and the error's code. */
  failure: { step: string | null; code: string } | null;
}

/**
 * Where a run failed, as the chat may see it. A step's name is the
 * workflow's to choose (from what it read, even) and an error's code may
 * be its own, so of a restricted App's run, whose data the chat doesn't
 * share, it sees only a code of the platform's.
 */
const failureOf = (
  { failure }: WorkflowRun,
  restricted: boolean
): AgentRun["failure"] => {
  if (failure === undefined) {
    return null;
  }
  const { step, error } = failure;
  if (!restricted) {
    return { step, code: error.code };
  }
  return {
    step: null,
    code: isExpectedCode(error.code) ? error.code : "workflow.run_failed",
  };
};

const agentRun = (run: WorkflowRun, restricted: boolean): AgentRun => ({
  id: run.id,
  app: run.app,
  workflow: run.workflow,
  version: run.version,
  status: run.status,
  startedBy: run.startedBy,
  createdAt: run.createdAt,
  endedAt: run.endedAt,
  failure: failureOf(run, restricted),
});

/** Whether the App `app` has read restricted data (restricted.ts). */
const appRestricted = async (env: Env, app: string): Promise<boolean> =>
  await appHost(env, appIdSchema.parse(app)).isRestricted();

const notFound = () => workflowErrors.create("workflow.run_not_found");

/**
 * A run the agent may not see, as one that doesn't exist: its App is one
 * the person can't open, however it refuses them (none for them, or one
 * shared with them that read what they can't read), or its workflow one
 * the agent may not read. The same refusal as an unknown run, so run IDs
 * can't be probed.
 */
const hidden = (error: unknown): unknown => {
  const code = appErrors.codeOf(error);
  return code === "app.not_found" ||
    code === "app.unreadable" ||
    roleErrors.codeOf(error) !== undefined
    ? notFound()
    : error;
};

/** Workflows, as a chat's code reads them. */
export class WorkflowsApi extends WorkerEntrypoint<Env, AgentScope> {
  /** The workflows the agent may read, of Apps the person sees. */
  async list(): Promise<WorkflowSummary[]> {
    return await asPerson(this.env, this.ctx.props, {
      feature: "workflows",
      allowed: () => true,
      method: "workflows.list",
      // Only the workflows the agent may read are summed up at all.
      read: async (person, permissions) =>
        await workflowOverview(this.env, person, (app, workflow) =>
          readsWorkflow(app, workflow)(permissions)
        ),
      detail: (listed) => ({ workflows: listed.length }),
    });
  }

  /** A workflow's runs: waiting first, then failed, then newest. */
  async runs(app: unknown, workflow: unknown): Promise<AgentRun[]> {
    return await asPerson(this.env, this.ctx.props, {
      feature: "workflows",
      allowed: readsWorkflow(app, workflow),
      method: "workflows.runs",
      read: async (person) => {
        const { runs } = await listAllRuns(this.env, person, { app, workflow });
        // All of one App's: its restricted mode, read once.
        const [first] = runs;
        const restricted =
          first !== undefined && (await appRestricted(this.env, first.app));
        return runs.map((run) => agentRun(run, restricted));
      },
      detail: (listed) => ({
        app: typeof app === "string" ? app : null,
        workflow: typeof workflow === "string" ? workflow : null,
        runs: listed.length,
      }),
    });
  }

  /** One run, as it is now. */
  async status(run: unknown): Promise<AgentRun> {
    return await asPerson(this.env, this.ctx.props, {
      feature: "workflows",
      allowed: () => true,
      method: "workflows.status",
      read: async (person, permissions) => {
        const found = await runStatus(this.env, person, run).catch(
          (error: unknown) => {
            throw hidden(error);
          }
        );
        if (!readsWorkflow(found.app, found.workflow)(permissions)) {
          throw notFound();
        }
        return agentRun(found, await appRestricted(this.env, found.app));
      },
      detail: (found) => ({ run: found.id }),
    });
  }
}

/** The types `env.workflows` returns, as the model reads them. */
const workflowsTypes = `/** A workflow run: its state, never what it returned. */
interface WorkflowRun {
  id: string;
  app: string;
  workflow: string;
  /** The App version it runs. */
  version: number;
  status: "running" | "waiting" | "paused" | "completed" | "failed" | "cancelled";
  /** A person started it, or a trigger did. */
  startedBy: { type: "person"; userId: string } | { type: "trigger" };
  createdAt: string;
  endedAt: string | null;
  /** Where it failed: the step (null outside one) and the error's code. */
  failure: { step: string | null; code: string } | null;
}`;

/** What the model reads of `env.workflows`. */
const workflowsDeclaration = `/** The workflows this chat may follow, and their runs. */
workflows: {
  /** The workflows this chat may read, with their latest run and counts. */
  list(): Promise<{
    app: string;
    appName: string;
    workflow: string;
    version: number;
    owner: { userId: string; name: string | null };
    lastRun: { id: string; status: string; createdAt: string } | null;
    /** Runs waiting for a decision now. */
    waiting: number;
    /** Runs that failed in the last 7 days. */
    failed: number;
    /** A schedule of it stopped: its run failed to start 8 times in a row. */
    scheduleStopped: boolean;
  }[]>;
  /** A workflow's runs: waiting first, then failed, then the newest, at most 100. */
  runs(app: string, workflow: string): Promise<WorkflowRun[]>;
  /** One run, as it is now. */
  status(run: string): Promise<WorkflowRun>;
};`;

/** `env.workflows`. */
export const workflowsApi: AgentApi = {
  name: "workflows",
  types: workflowsTypes,
  declaration: workflowsDeclaration,
  stub: (scope) => exports.WorkflowsApi({ props: scope }),
};
