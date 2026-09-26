import type { ParamValue } from "@grasp-os/shared/approvals";
import type {
  WorkflowParam,
  WorkflowParamsApi,
} from "@grasp-os/shared/workflows";
import { RpcTarget } from "capnweb";

import { withPerson } from "../session-check.ts";
import type { SessionCheck } from "../session-check.ts";
import { listParams, setParam } from "./params.ts";

/**
 * A signed-in person's `workflows.params`: the values of workflows'
 * parameters. The param functions check the person's role and validate
 * what the client sent.
 */
export class WorkflowParamsRpc extends RpcTarget implements WorkflowParamsApi {
  readonly #env: Env;
  readonly #check: SessionCheck;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
  }

  async list(app: string, workflow: string): Promise<WorkflowParam[]> {
    return await withPerson(
      this.#check,
      async (by) => await listParams(this.#env, by, app, workflow)
    );
  }

  async set(
    app: string,
    workflow: string,
    param: string,
    value: ParamValue
  ): Promise<WorkflowParam> {
    return await withPerson(
      this.#check,
      async (by) => await setParam(this.#env, by, app, workflow, param, value)
    );
  }
}
