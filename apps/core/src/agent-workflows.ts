import type { Permission } from "@grasp-os/shared/permissions";
import type { WorkflowRun, WorkflowSummary } from "@grasp-os/shared/workflows";
import { WorkerEntrypoint, exports } from "cloudflare:workers";

import { asPerson, readDenied } from "./agent-person.ts";
import type { AgentApi, AgentScope } from "./agent-scope.ts";
import { listAllRuns, workflowOverview } from "./workflows/overview.ts";
import { runStatus } from "./workflows/runs.ts";

// Workflows for a chat's code: `await env.workflows.runs("app-1",
// "report")`. What the chat's person sees of them themselves
// (agent-person.ts), of the workflows the agent may read: a permission's
// object of its own. The agent sees runs' state, never what a run returned
// or its error's words: those hold what the run read through its App's
// connections and collections, which the chat has no permission for, and
// whose restricted mode it doesn't share. Every call is audited as the
// chat's agent acting for its person.

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

const agentRun = (run: WorkflowRun): AgentRun => ({
  id: run.id,
  app: run.app,
  workflow: run.workflow,
  version: run.version,
  status: run.status,
  startedBy: run.startedBy,
  createdAt: run.createdAt,
  endedAt: run.endedAt,
  failure:
    run.failure === undefined
      ? null
      : { step: run.failure.step, code: run.failure.error.code },
});

/** Workflows, as a chat's code reads them. */
export class WorkflowsApi extends WorkerEntrypoint<Env, AgentScope> {
  /** The workflows the agent may read, of Apps the person sees. */
  async list(): Promise<WorkflowSummary[]> {
    return await asPerson(this.env, this.ctx.props, {
      feature: "workflows",
      allowed: () => true,
      method: "workflows.list",
      read: async (person, permissions) => {
        const summaries = await workflowOverview(this.env, person);
        return summaries.filter(({ app, workflow }) =>
          readsWorkflow(app, workflow)(permissions)
        );
      },
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
        return runs.map(agentRun);
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
        const found = await runStatus(this.env, person, run);
        if (!readsWorkflow(found.app, found.workflow)(permissions)) {
          throw readDenied();
        }
        return agentRun(found);
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
