import type {
  Permission,
  PermissionRequest,
  PermissionSubjectInput,
} from "@grasp-os/shared/permissions";
import type { Identity, SessionApi } from "@grasp-os/shared/rpc";
import { RpcTarget } from "capnweb";

import { AppsRpc } from "./apps-rpc.ts";
import { KnowledgeRpc } from "./knowledge/rpc.ts";
import {
  grantPermission,
  listPermissions,
  requestPermission,
  revokePermission,
} from "./permissions.ts";

/** Checks the connection's session again; throws when it has ended. */
export type SessionCheck = () => Promise<Identity>;

/**
 * What a signed-in person reaches over `/rpc`. It holds no identity: every
 * method runs through `#asPerson`, which checks the session first and hands
 * over the identity that check returned, so a method can't reach the person
 * without the check, or use one kept from an earlier call.
 */
export class SessionRpc extends RpcTarget implements SessionApi {
  readonly #env: Env;
  readonly #check: SessionCheck;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
  }

  async #asPerson<T>(run: (identity: Identity) => T | Promise<T>): Promise<T> {
    return await run(await this.#check());
  }

  get apps(): AppsRpc {
    return new AppsRpc(this.#env, this.#check);
  }

  /** Knowledge, whose every method checks the session again. */
  get knowledge(): KnowledgeRpc {
    return new KnowledgeRpc(this.#env, this.#check);
  }

  async whoami(): Promise<Identity> {
    return await this.#asPerson((identity) => identity);
  }

  // Each takes what the client sent as it is: the permission functions
  // validate it, and check the person's role, on every call.

  async requestPermission(request: PermissionRequest): Promise<Permission> {
    return await this.#asPerson(
      async (identity) => await requestPermission(this.#env, identity, request)
    );
  }

  async grantPermission(id: string): Promise<Permission> {
    return await this.#asPerson(
      async (identity) => await grantPermission(this.#env, identity, id)
    );
  }

  async revokePermission(id: string): Promise<Permission> {
    return await this.#asPerson(
      async (identity) => await revokePermission(this.#env, identity, id)
    );
  }

  async listPermissions(
    subject?: PermissionSubjectInput
  ): Promise<Permission[]> {
    return await this.#asPerson(
      async (identity) => await listPermissions(this.#env, identity, subject)
    );
  }
}
