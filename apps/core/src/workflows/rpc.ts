import type {
  RunsPage,
  RunFilter,
  WorkflowDetail,
  WorkflowDryRun,
  WorkflowRun,
  WorkflowsApi,
  WorkflowSummary,
} from "@grasp-os/shared/workflows";
import { RpcTarget } from "capnweb";

import { withPerson } from "../session-check.ts";
import type { SessionCheck } from "../session-check.ts";
import {
  dryRunWorkflow,
  listAllRuns,
  workflowDetail,
  workflowOverview,
} from "./overview.ts";
import { WorkflowParamsRpc } from "./params-rpc.ts";
import { cancelRun, listRuns, runStatus, startWorkflow } from "./runs.ts";

/**
 * A signed-in person's `workflows`. Like AppsRpc, every call checks the
 * session (and the feature flag) first and hands the identity that check
 * returned to the run functions, which check the person's role and
 * validate what the client sent.
 */
export class WorkflowsRpc extends RpcTarget implements WorkflowsApi {
  readonly #env: Env;
  readonly #check: SessionCheck;
  readonly #params: WorkflowParamsRpc;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
    this.#params = new WorkflowParamsRpc(env, check);
  }

  get params(): WorkflowParamsRpc {
    return this.#params;
  }

  async start(
    app: string,
    workflow: string,
    input?: unknown
  ): Promise<WorkflowRun> {
    return await withPerson(
      this.#check,
      async (by) => await startWorkflow(this.#env, by, app, workflow, input)
    );
  }

  async status(run: string): Promise<WorkflowRun> {
    return await withPerson(
      this.#check,
      async (by) => await runStatus(this.#env, by, run)
    );
  }

  async list(app: string): Promise<WorkflowRun[]> {
    return await withPerson(
      this.#check,
      async (by) => await listRuns(this.#env, by, app)
    );
  }

  async cancel(run: string): Promise<WorkflowRun> {
    return await withPerson(
      this.#check,
      async (by) => await cancelRun(this.#env, by, run)
    );
  }

  async overview(): Promise<WorkflowSummary[]> {
    return await withPerson(
      this.#check,
      async (by) => await workflowOverview(this.#env, by)
    );
  }

  async runs(filter?: RunFilter): Promise<RunsPage> {
    return await withPerson(
      this.#check,
      async (by) => await listAllRuns(this.#env, by, filter)
    );
  }

  async get(app: string, workflow: string): Promise<WorkflowDetail> {
    return await withPerson(
      this.#check,
      async (by) => await workflowDetail(this.#env, by, app, workflow)
    );
  }

  async test(app: string, workflow: string): Promise<WorkflowDryRun> {
    return await withPerson(
      this.#check,
      async (by) => await dryRunWorkflow(this.#env, by, app, workflow)
    );
  }
}
