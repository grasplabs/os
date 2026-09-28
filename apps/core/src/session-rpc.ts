import type { Identity, SessionApi } from "@grasp-os/shared/rpc";
import { RpcTarget } from "capnweb";

import { AppsRpc } from "./apps-rpc.ts";
import { AuditRpc } from "./audit-rpc.ts";
import { ConnectionsRpc } from "./connections.ts";
import { DecisionsRpc } from "./decisions/rpc.ts";
import { requireFeature, uploadFeatures } from "./features.ts";
import type { Feature } from "./features.ts";
import { MemoryRpc } from "./knowledge/memory-rpc.ts";
import { KnowledgeRpc } from "./knowledge/rpc.ts";
import { UploadsRpc } from "./knowledge/uploads-rpc.ts";
import { MembersRpc } from "./members.ts";
import { PendingActionsRpc } from "./pending-actions.ts";
import { PermissionsRpc } from "./permissions-rpc.ts";
import { ScreensRpc } from "./screens-rpc.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";
import { SignalsRpc } from "./signals-rpc.ts";
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
  readonly #memory: MemoryRpc;
  readonly #uploads: UploadsRpc;
  readonly #permissions: PermissionsRpc;
  readonly #connections: ConnectionsRpc;
  readonly #workflows: WorkflowsRpc;
  readonly #decisions: DecisionsRpc;
  readonly #screens: ScreensRpc;
  readonly #members: MembersRpc;
  readonly #audit: AuditRpc;
  readonly #pendingActions: PendingActionsRpc;
  readonly #signals: SignalsRpc;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#check = check;
    /**
     * The session check, refused first while any of `features` is switched
     * off, so switching a feature off stops its API at the next call.
     */
    const checkWith =
      (...features: Feature[]): SessionCheck =>
      async () => {
        for (const feature of features) {
          requireFeature(env, feature);
        }
        return await check();
      };
    // Sharing Apps and blueprints: the Apps kill switch stops them too, and
    // blueprints, whose access is App roles, need sharing on.
    this.#apps = new AppsRpc(
      env,
      checkWith("apps"),
      checkWith("apps", "app_sharing"),
      checkWith("apps", "app_sharing", "app_blueprints")
    );
    this.#knowledge = new KnowledgeRpc(env, checkWith("knowledge"));
    // Memory files are Knowledge documents: that kill switch stops them too.
    this.#memory = new MemoryRpc(env, checkWith("knowledge", "memory"));
    // Uploads become Knowledge documents: that kill switch stops them too.
    this.#uploads = new UploadsRpc(env, checkWith(...uploadFeatures));
    this.#permissions = new PermissionsRpc(env, checkWith("permissions"));
    this.#connections = new ConnectionsRpc(env, checkWith("connections"));
    this.#workflows = new WorkflowsRpc(env, checkWith("workflows"));
    // Decisions belong to runs: the workflows kill switch stops them too.
    this.#decisions = new DecisionsRpc(
      env,
      checkWith("workflows", "decisions")
    );
    // Screens run Apps: the Apps kill switch stops them too.
    this.#screens = new ScreensRpc(env, checkWith("apps", "screens"));
    this.#members = new MembersRpc(env, checkWith("members"));
    this.#audit = new AuditRpc(env, checkWith("audit"));
    // Held actions are calls on connections: that kill switch stops them
    // too. With the flag off, connect still holds side effects, and nobody
    // can confirm them: nothing runs without the person.
    this.#pendingActions = new PendingActionsRpc(
      env,
      checkWith("connections", "confirmations")
    );
    this.#signals = new SignalsRpc(env, checkWith("improvement_signals"));
  }

  get apps(): AppsRpc {
    return this.#apps;
  }

  get knowledge(): KnowledgeRpc {
    return this.#knowledge;
  }

  get memory(): MemoryRpc {
    return this.#memory;
  }

  get uploads(): UploadsRpc {
    return this.#uploads;
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

  get decisions(): DecisionsRpc {
    return this.#decisions;
  }

  get screens(): ScreensRpc {
    return this.#screens;
  }

  get members(): MembersRpc {
    return this.#members;
  }

  get audit(): AuditRpc {
    return this.#audit;
  }

  get pendingActions(): PendingActionsRpc {
    return this.#pendingActions;
  }

  get signals(): SignalsRpc {
    return this.#signals;
  }

  async whoami(): Promise<Identity> {
    return await withPerson(this.#check, (identity) => identity);
  }
}
