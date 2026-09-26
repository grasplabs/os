import type {
  Approval,
  ApprovalsApi,
  ApproveOptions,
} from "@grasp-os/shared/approvals";
import { RpcTarget } from "capnweb";

import { approve, decline, listApprovals, withdraw } from "./approvals.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";

/**
 * A signed-in person's `approvals`. Each method takes what the client sent
 * as it is: the approval functions validate it, and check who may decide,
 * on every call.
 */
export class ApprovalsRpc extends RpcTarget implements ApprovalsApi {
  readonly #env: Env;
  readonly #check: SessionCheck;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
  }

  async list(): Promise<Approval[]> {
    return await withPerson(
      this.#check,
      async (person) => await listApprovals(this.#env, person)
    );
  }

  async approve(id: string, options?: ApproveOptions): Promise<Approval> {
    return await withPerson(
      this.#check,
      async (person) => await approve(this.#env, person, id, options)
    );
  }

  async decline(id: string): Promise<Approval> {
    return await withPerson(
      this.#check,
      async (person) => await decline(this.#env, person, id)
    );
  }

  async withdraw(id: string): Promise<Approval> {
    return await withPerson(
      this.#check,
      async (person) => await withdraw(this.#env, person, id)
    );
  }
}
