import { connectErrors } from "@grasp-os/shared/connect";
import type { ConnectResult, PendingReference } from "@grasp-os/shared/connect";
import { identifierMaxLength } from "@grasp-os/shared/ids";
import { errorFields, log } from "@grasp-os/shared/log";
import { WorkerEntrypoint, exports } from "cloudflare:workers";

import {
  auditRefusal,
  auditedCall,
  chatAuthority,
  chatContext,
  recordSources,
  requireOpenRun,
} from "./agent-scope.ts";
import type { AgentApi, AgentScope } from "./agent-scope.ts";
import { connectionGrantOf, forSandbox, signedStubCall } from "./bindings.ts";
import type { ConnectionGrant } from "./bindings.ts";
import { connectionOwnersOf } from "./connections.ts";
import { workspace } from "./durable-objects.ts";
import { requireFeature } from "./features.ts";
import { grantedPermissions } from "./permissions.ts";

// Connections for a chat's code: `await env.connections.call("OUTLOOK",
// "mail.search", { query })`. The agent's connection permissions, each
// under its binding name, used as the chat's agent acting for its person:
// every call is checked against the permission again, signed by core and
// carried out by connect, which audits it, refuses a personal connection
// that isn't the person's, and holds every side effect from chat for the
// person to confirm (bindings.ts, restricted.ts). Here, a call that read
// something is also recorded with the chat, which every later model
// request carries as provenance: the client's rules for a connection's
// data (EU only, sensitive) then hold in every later turn.

/** A connection the chat's agent may use, as its code sees it. */
export interface AgentConnection {
  /** What `call` names it by: its permission's binding name. */
  name: string;
  connectionId: string;
  /** The one resource it covers, such as a mailbox; `null` for all. */
  resource: string | null;
  /** The actions it may call. */
  actions: string[];
}

/** What a call answered. */
export interface AgentCallResult {
  /** What the action returned; `null` while it waits for the person. */
  output: unknown;
  /** Set when the call waits for the person to confirm it. */
  pending: PendingReference | null;
}

/** The chat's connection grants, as its agent holds them now. */
const connectionGrants = async (
  env: Env,
  scope: AgentScope
): Promise<(ConnectionGrant & { name: string; actions: string[] })[]> => {
  const grantOf = connectionGrantOf(chatContext(scope));
  const permissions = await grantedPermissions(env, chatAuthority(scope));
  return permissions.flatMap((permission) => {
    const grant = grantOf(permission);
    return grant === undefined
      ? []
      : [{ ...grant, name: permission.binding, actions: permission.actions }];
  });
};

/**
 * The longest idempotency key a chat's code may choose: connect's limit
 * less the chat's prefix (`<chatId>:`), which `chatKeyed` adds.
 */
export const chatKeyMaxLength = (chatId: string): number =>
  identifierMaxLength - chatId.length - 1;

/**
 * `options` with its idempotency key, if it has one, made the chat's own.
 * A key too long to take the prefix is refused as the invalid call it
 * would become, saying how long a key may be.
 */
const chatKeyed = (scope: AgentScope, options: unknown): unknown => {
  if (typeof options !== "object" || options === null) {
    return options;
  }
  const key: unknown = Reflect.get(options, "idempotencyKey");
  if (typeof key !== "string") {
    return options;
  }
  const max = chatKeyMaxLength(scope.chatId);
  if (key.length > max) {
    throw connectErrors.create("connect.invalid", {
      issues: [`options.idempotencyKey: At most ${max} characters`],
    });
  }
  return { ...options, idempotencyKey: `${scope.chatId}:${key}` };
};

/**
 * Tells the chat's watchers a write was held, so the person sees it to
 * confirm at once. A failure is logged: the write is held either way, and
 * the page reads it at its next change.
 */
const heldInChat = async (env: Env, scope: AgentScope): Promise<void> => {
  try {
    await workspace(env, scope.workspaceId).heldChanged(scope.chatId);
  } catch (error) {
    log.warn("chat.held_push_failed", {
      chatId: scope.chatId,
      ...errorFields(error),
    });
  }
};

/** Connections, as a chat's code calls them. */
export class ConnectionsApi extends WorkerEntrypoint<Env, AgentScope> {
  /** The agent's grant under `name`, read now, or why there is none. */
  async #grantNamed(
    name: unknown
  ): Promise<Awaited<ReturnType<typeof connectionGrants>>[number]> {
    requireFeature(this.env, "connections");
    const grants = await connectionGrants(this.env, this.ctx.props);
    const grant = grants.find((held) => held.name === name);
    if (grant === undefined) {
      throw connectErrors.create("connect.connection_not_found");
    }
    return grant;
  }

  /**
   * The connections the agent may use for its person: those it has a
   * permission for that the person may use themselves (a shared one, or
   * their own personal one).
   */
  async list(): Promise<AgentConnection[]> {
    const scope = this.ctx.props;
    await requireOpenRun(this.env, scope, "connections.list");
    try {
      return await auditedCall(
        this.env,
        scope,
        {
          method: "connections.list",
          detailOf: (listed: AgentConnection[]) => ({
            connections: listed.length,
          }),
        },
        async () => {
          requireFeature(this.env, "connections");
          const grants = await connectionGrants(this.env, scope);
          const owners = await connectionOwnersOf(this.env, [
            ...new Set(grants.map(({ connection }) => connection.connectionId)),
          ]);
          const usable = new Set(
            owners.flatMap(({ id, ownerUserId }) =>
              ownerUserId === null || ownerUserId === scope.personId ? [id] : []
            )
          );
          return grants
            .filter(({ connection }) => usable.has(connection.connectionId))
            .map(({ name, connection, actions }) => ({
              name,
              connectionId: connection.connectionId,
              resource: connection.resource ?? null,
              actions,
            }));
        }
      );
    } catch (error) {
      throw forSandbox(error);
    }
  }

  /**
   * Calls `action` on the connection named `connection`. A side effect is
   * held for the person to confirm: nothing is done yet, and `pending`
   * says so.
   */
  async call(
    connection: unknown,
    action: unknown,
    input: unknown,
    options?: unknown
  ): Promise<AgentCallResult> {
    const scope = this.ctx.props;
    await requireOpenRun(this.env, scope, "connections.call");
    // Everything before connect sees the call: refused here, it is
    // recorded here, once; what connect takes, connect records.
    const { grant, request } = await (async () => {
      const named = await this.#grantNamed(connection);
      // Connect keeps a side effect's answer, and its held action, under
      // the agent and the key: the agent is the workspace's, so each
      // chat's keys are its own, and one chat never gets another's answer
      // or held action.
      const signed = await signedStubCall(
        this.env,
        chatAuthority(scope),
        named,
        [action, input, chatKeyed(scope, options)]
      );
      return { grant: named, request: signed };
    })().catch(
      async (error: unknown) =>
        await auditRefusal(
          this.env,
          scope,
          {
            method: "connections.call",
            detail: {
              connection: typeof connection === "string" ? connection : null,
            },
          },
          forSandbox(error)
        )
    );
    let result: ConnectResult;
    try {
      result = await this.env.CONNECT.call(request);
    } catch (error) {
      throw forSandbox(error);
    }
    if (result.pending !== undefined) {
      await heldInChat(this.env, scope);
      return { output: null, pending: result.pending };
    }
    await recordSources(this.env, scope, [grant.connection.connectionId]);
    return { output: JSON.parse(result.output), pending: null };
  }
}

/** What the model reads of `env.connections`. */
const connectionsDeclaration = `/**
 * The outside systems this chat may act in (mail, calendars, files), each
 * under the name its permission gives it. Every call is recorded. A call
 * that changes something (sends, creates, deletes) is never done straight
 * away: it waits for the person to confirm it in Grasp, and \`pending\`
 * says so. Tell them it waits for them; don't call it again to push it.
 */
connections: {
  /** The connections this chat may use, and the actions each allows. */
  list(): Promise<{ name: string; connectionId: string; resource: string | null; actions: string[] }[]>;
  /**
   * Calls one of a connection's actions with its input. A change needs an
   * \`idempotencyKey\` of your own (at most 200 characters): calling again
   * with the same key returns the first call's answer instead of doing it
   * twice.
   */
  call(
    name: string,
    action: string,
    input: Record<string, unknown>,
    options?: { idempotencyKey?: string }
  ): Promise<{
    /** What the action returned; null while it waits for the person. */
    output: unknown;
    /** Set while it waits for the person to confirm it. */
    pending: { id: string } | null;
  }>;
};`;

/** `env.connections`. */
export const connectionsApi: AgentApi = {
  name: "connections",
  declaration: connectionsDeclaration,
  stub: (scope) => exports.ConnectionsApi({ props: scope }),
};
