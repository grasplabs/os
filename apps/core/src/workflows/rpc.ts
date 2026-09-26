import type { WorkflowRun, WorkflowsApi } from "@grasp-os/shared/workflows";
import { RpcTarget } from "capnweb";

import { withPerson } from "../session-check.ts";
import type { SessionCheck } from "../session-check.ts";
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

  /** `paramsCheck` is the session check of `params`, with its flags. */
  constructor(env: Env, check: SessionCheck, paramsCheck: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
    this.#params = new WorkflowParamsRpc(env, paramsCheck);
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
}
