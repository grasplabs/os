import { connectErrors } from "@grasp-os/shared/connect";
import type { PendingReference } from "@grasp-os/shared/connect";
import { WorkerEntrypoint, exports } from "cloudflare:workers";

import {
  auditAgentCall,
  chatAuthority,
  chatContext,
  recordSources,
  requireOpenRun,
} from "./agent-scope.ts";
import type { AgentApi, AgentScope } from "./agent-scope.ts";
import { connectionGrantOf, forSandbox, runStubCall } from "./bindings.ts";
import type { ConnectionGrant } from "./bindings.ts";
import { connectionOwnersOf } from "./connections.ts";
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

/** Connections, as a chat's code calls them. */
export class ConnectionsApi extends WorkerEntrypoint<Env, AgentScope> {
  /**
   * The connections the agent may use for its person: those it has a
   * permission for that the person may use themselves (a shared one, or
   * their own personal one).
   */
  async list(): Promise<AgentConnection[]> {
    const scope = this.ctx.props;
    await requireOpenRun(this.env, scope);
    try {
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
      const listed = grants
        .filter(({ connection }) => usable.has(connection.connectionId))
        .map(({ name, connection, actions }) => ({
          name,
          connectionId: connection.connectionId,
          resource: connection.resource ?? null,
          actions,
        }));
      await auditAgentCall(this.env, scope, {
        method: "connections.list",
        detail: { connections: listed.length },
      });
      return listed;
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
    await requireOpenRun(this.env, scope);
    requireFeature(this.env, "connections");
    let grants: Awaited<ReturnType<typeof connectionGrants>> = [];
    try {
      grants = await connectionGrants(this.env, scope);
    } catch (error) {
      throw forSandbox(error);
    }
    const grant = grants.find(({ name }) => name === connection);
    if (grant === undefined) {
      throw connectErrors.create("connect.connection_not_found");
    }
    const result = await runStubCall(this.env, chatAuthority(scope), grant, [
      action,
      input,
      options,
    ]);
    if (result.pending !== undefined) {
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
   * \`idempotencyKey\` of your own: calling again with the same key returns
   * the first call's answer instead of doing it twice.
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
