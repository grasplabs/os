import type { Identity, SessionApi } from "@grasp-os/shared/rpc";
import { RpcTarget } from "capnweb";

import { AppsRpc } from "./apps-rpc.ts";
import { ConnectionsRpc } from "./connections.ts";
import { requireFeature } from "./features.ts";
import type { Feature } from "./features.ts";
import { KnowledgeRpc } from "./knowledge/rpc.ts";
import { PermissionsRpc } from "./permissions-rpc.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";

// Every API a person reaches has the same form: an RpcTarget built once
// per session with core's env and a session check, whose every method goes
// through `withPerson`. A feature's namespace is one of them, created with
// its flag in the check and handed out as the same object every time.

/**
 * What a signed-in person reaches over `/rpc`. It holds no identity: every
 * method runs through `withPerson`, which checks the session first and hands
 * over the identity that check returned, so a method can't reach the person
 * without the check, or use one kept from an earlier call.
 */
export class SessionRpc extends RpcTarget implements SessionApi {
  readonly #check: SessionCheck;
  readonly #apps: AppsRpc;
  readonly #knowledge: KnowledgeRpc;
  readonly #permissions: PermissionsRpc;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#check = check;
    /**
     * The session check, refused first while `feature` is switched off, so
     * switching a feature off stops its API at the next call.
     */
    const checkWith =
      (feature: Feature): SessionCheck =>
      async () => {
        requireFeature(env, feature);
        return await check();
      };
    this.#apps = new AppsRpc(env, checkWith("apps"));
    this.#knowledge = new KnowledgeRpc(env, checkWith("knowledge"));
    this.#permissions = new PermissionsRpc(env, checkWith("permissions"));
  }

  get apps(): AppsRpc {
    return this.#apps;
  }

  get knowledge(): KnowledgeRpc {
    return this.#knowledge;
  }

  get permissions(): PermissionsRpc {
    return this.#permissions;
  }

  /** Connected accounts, whose every method checks the session again. */
  get connections(): ConnectionsRpc {
    return new ConnectionsRpc(this.#env, this.#checkWith("connections"));
  }

  async whoami(): Promise<Identity> {
    return await withPerson(this.#check, (identity) => identity);
  }
}
