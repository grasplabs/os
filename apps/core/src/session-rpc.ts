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
import { WorkflowsRpc } from "./workflows/rpc.ts";

/**
 * What a signed-in person reaches over `/rpc`. Every API here has the same
 * form: an RpcTarget built once per session with core's env and a session
 * check, holding no identity. Each method runs through `withPerson`, which
 * checks the session first and hands over the identity that check returned,
 * so a method can't reach the person without the check, or use one kept
 * from an earlier call. A feature's namespace is created with its flag in
 * the check and handed out as the same object every time. There's no base
 * class: an RpcTarget's methods, protected ones too, can be called over
 * RPC, so each keeps its env and check in private fields.
 */
export class SessionRpc extends RpcTarget implements SessionApi {
  readonly #check: SessionCheck;
  readonly #apps: AppsRpc;
  readonly #knowledge: KnowledgeRpc;
  readonly #permissions: PermissionsRpc;
  readonly #connections: ConnectionsRpc;
  readonly #workflows: WorkflowsRpc;

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
    this.#connections = new ConnectionsRpc(env, checkWith("connections"));
    this.#workflows = new WorkflowsRpc(env, checkWith("workflows"));
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

  get connections(): ConnectionsRpc {
    return this.#connections;
  }

  get workflows(): WorkflowsRpc {
    return this.#workflows;
  }

  async whoami(): Promise<Identity> {
    return await withPerson(this.#check, (identity) => identity);
  }
}
