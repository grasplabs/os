import type { ApproveOptions } from "@grasp-os/shared/approvals";
import type {
  Permission,
  PermissionRequest,
  PermissionsApi,
  PermissionSubjectInput,
} from "@grasp-os/shared/permissions";
import { RpcTarget } from "capnweb";

import { grantPermission } from "./approvals.ts";
import {
  listPermissions,
  requestPermission,
  revokePermission,
} from "./permissions.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";

/**
 * A signed-in person's `permissions`. Each method takes what the client
 * sent as it is: the permission functions validate it, and check the
 * person's role, on every call.
 */
export class PermissionsRpc extends RpcTarget implements PermissionsApi {
  readonly #env: Env;
  readonly #check: SessionCheck;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
  }

  async request(request: PermissionRequest): Promise<Permission> {
    return await withPerson(
      this.#check,
      async (person) => await requestPermission(this.#env, person, request)
    );
  }

  async grant(id: string, options?: ApproveOptions): Promise<Permission> {
    return await withPerson(
      this.#check,
      async (person) => await grantPermission(this.#env, person, id, options)
    );
  }

  async revoke(id: string): Promise<Permission> {
    return await withPerson(
      this.#check,
      async (person) => await revokePermission(this.#env, person, id)
    );
  }

  async list(subject?: PermissionSubjectInput): Promise<Permission[]> {
    return await withPerson(
      this.#check,
      async (person) => await listPermissions(this.#env, person, subject)
    );
  }
}
