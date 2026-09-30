import type { Identity, SessionApi } from "@grasp-os/shared/rpc";
import { RpcTarget } from "capnweb";

import { AppsRpc } from "./apps-rpc.ts";
import { AuditRpc } from "./audit-rpc.ts";
import { ChatsRpc } from "./chats-rpc.ts";
import { ConnectionsRpc } from "./connections.ts";
import { DecisionsRpc } from "./decisions/rpc.ts";
import { MemoryRpc } from "./knowledge/memory-rpc.ts";
import { KnowledgeRpc } from "./knowledge/rpc.ts";
import { KnowledgeSignalsRpc } from "./knowledge/signals-rpc.ts";
import { UploadsRpc } from "./knowledge/uploads-rpc.ts";
import { MembersRpc } from "./members.ts";
import { ModelsRpc } from "./models-rpc.ts";
import { NotificationsRpc } from "./notifications.ts";
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
 * from an earlier call. Each namespace is created once and handed out as
 * the same object every time. There's no base
 * class: an RpcTarget's methods, protected ones too, can be called over
 * RPC, so each keeps its env and check in private fields.
 */
export class SessionRpc extends RpcTarget implements SessionApi {
  readonly #check: SessionCheck;
  readonly #apps: AppsRpc;
  readonly #knowledge: KnowledgeRpc;
  readonly #knowledgeSignals: KnowledgeSignalsRpc;
  readonly #memory: MemoryRpc;
  readonly #uploads: UploadsRpc;
  readonly #permissions: PermissionsRpc;
  readonly #connections: ConnectionsRpc;
  readonly #workflows: WorkflowsRpc;
  readonly #decisions: DecisionsRpc;
  readonly #screens: ScreensRpc;
  readonly #members: MembersRpc;
  readonly #audit: AuditRpc;
  readonly #models: ModelsRpc;
  readonly #pendingActions: PendingActionsRpc;
  readonly #signals: SignalsRpc;
  readonly #chats: ChatsRpc;
  readonly #notifications: NotificationsRpc;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#check = check;
    this.#apps = new AppsRpc(env, check);
    this.#knowledge = new KnowledgeRpc(env, check);
    this.#knowledgeSignals = new KnowledgeSignalsRpc(env, check);
    this.#memory = new MemoryRpc(env, check);
    this.#uploads = new UploadsRpc(env, check);
    this.#permissions = new PermissionsRpc(env, check);
    this.#connections = new ConnectionsRpc(env, check);
    this.#workflows = new WorkflowsRpc(env, check);
    this.#decisions = new DecisionsRpc(env, check);
    this.#screens = new ScreensRpc(env, check);
    this.#members = new MembersRpc(env, check);
    this.#audit = new AuditRpc(env, check);
    this.#models = new ModelsRpc(env, check);
    this.#pendingActions = new PendingActionsRpc(env, check);
    this.#signals = new SignalsRpc(env, check);
    this.#chats = new ChatsRpc(env, check);
    this.#notifications = new NotificationsRpc(env, check);
  }

  get notifications(): NotificationsRpc {
    return this.#notifications;
  }

  get chats(): ChatsRpc {
    return this.#chats;
  }

  get apps(): AppsRpc {
    return this.#apps;
  }

  get knowledge(): KnowledgeRpc {
    return this.#knowledge;
  }

  get knowledgeSignals(): KnowledgeSignalsRpc {
    return this.#knowledgeSignals;
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

  get models(): ModelsRpc {
    return this.#models;
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
