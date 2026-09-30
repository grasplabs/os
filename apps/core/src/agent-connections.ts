import { connectErrors } from "@grasp-os/shared/connect";
import type {
  ConnectResult,
  HeldOutcome,
  PendingReference,
} from "@grasp-os/shared/connect";
import { errorFields, log } from "@grasp-os/shared/log";
import { permissionErrors } from "@grasp-os/shared/permissions";
import { WorkerEntrypoint, exports } from "cloudflare:workers";
import { z } from "zod";

import {
  auditRefusal,
  auditedCall,
  chatAuthority,
  chatContext,
  recordSources,
  requireOpenRun,
} from "./agent-scope.ts";
import type { AgentApi, AgentScope } from "./agent-scope.ts";
import {
  connectionGrantOf,
  forSandbox,
  signedCall,
  signedStubCall,
} from "./bindings.ts";
import type { ConnectionGrant } from "./bindings.ts";
import { connectionOwnersOf } from "./connections.ts";
import { workspace } from "./durable-objects.ts";
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

/** How a call that waited for the person ended, as a chat's code reads it. */
export interface AgentCallOutcome {
  /**
   * `waiting` for the person still (or being carried out now), `declined`
   * by them (or dropped), `done`, or `failed`.
   */
  status: HeldOutcome["state"];
  /** What the action returned, once done; what it said, if it failed. */
  output: unknown;
  /** Why it failed. */
  error: string | null;
}

/** `outcome` as a chat's code reads it; read outputs are JSON text. */
const callOutcome = (outcome: HeldOutcome): AgentCallOutcome => {
  if (outcome.state === "done") {
    return {
      status: "done",
      output: JSON.parse(outcome.result.output),
      error: null,
    };
  }
  if (outcome.state === "failed") {
    return {
      status: "failed",
      output: outcome.output === null ? null : JSON.parse(outcome.output),
      error: outcome.reason,
    };
  }
  return { status: outcome.state, output: null, error: null };
};

/** The ID a held call was answered with (`AgentCallResult.pending`). */
const pendingIdSchema = z.uuid();

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
   * says so. The call names no idempotency key: connect makes one for each
   * side effect it holds, which the person takes exactly once. While it
   * waits, the same call made again finds the same held action; how it
   * ended, `outcome` says.
   */
  async call(
    connection: unknown,
    action: unknown,
    input: unknown
  ): Promise<AgentCallResult> {
    const scope = this.ctx.props;
    await requireOpenRun(this.env, scope, "connections.call");
    // Everything before connect sees the call: refused here, it is
    // recorded here, once; what connect takes, connect records.
    const { grant, request } = await (async () => {
      const named = await this.#grantNamed(connection);
      const signed = await signedStubCall(
        this.env,
        chatAuthority(scope),
        named,
        [action, input]
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

  /**
   * How the held call `pendingId` of this chat ended: the chat's code has
   * no other way to a confirmed call's answer, as a call made again is a
   * call of its own. Only for a call this chat's agent made for its
   * person (connect finds no other), and authorised exactly as that call
   * would be now: by a permission the agent holds now for that action on
   * that connection and that same resource, checked and signed as any
   * call's (`signedCall`). Connect records it, as it records a call; what is refused
   * before connect has the call is recorded here, once. What it hands
   * over is recorded with the chat first, as a direct call's answer.
   */
  async outcome(pendingId: unknown): Promise<AgentCallOutcome> {
    const scope = this.ctx.props;
    await requireOpenRun(this.env, scope, "connections.outcome");
    const id = pendingIdSchema.safeParse(pendingId);
    const request = await (async () => {
      if (!id.success) {
        throw connectErrors.create("connect.invalid");
      }
      const held = await this.env.CONNECT.heldCall({
        agentId: scope.agentId,
        onBehalfOf: scope.personId,
        workspaceId: scope.workspaceId,
        chatId: scope.chatId,
        id: id.data,
      });
      // A permission the agent holds for exactly that call, as it is now.
      const grants = await connectionGrants(this.env, scope);
      const grant = grants.find(
        ({ connection, actions }) =>
          connection.connectionId === held.connectionId &&
          (connection.resource ?? null) === held.resource &&
          actions.includes(held.action)
      );
      if (grant === undefined) {
        throw permissionErrors.create("permission.denied", {
          action: held.action,
        });
      }
      const { capability, scope: call } = await signedCall(
        this.env,
        { ...grant, authority: chatAuthority(scope) },
        { action: held.action, idempotencyKey: held.idempotencyKey }
      );
      return { capability, ...call, idempotencyKey: held.idempotencyKey };
    })().catch(
      async (error: unknown) =>
        await auditRefusal(
          this.env,
          scope,
          {
            method: "connections.outcome",
            detail: { pendingActionId: id.success ? id.data : null },
          },
          forSandbox(error)
        )
    );
    let outcome: HeldOutcome;
    try {
      outcome = await this.env.CONNECT.heldOutcome(request);
    } catch (error) {
      throw forSandbox(error);
    }
    if (outcome.state === "done" || outcome.state === "failed") {
      await recordSources(this.env, scope, [request.connectionId]);
    }
    return callOutcome(outcome);
  }
}

/** What the model reads of `env.connections`. */
const connectionsDeclaration = `/**
 * The outside systems this chat may act in (mail, calendars, files), each
 * under the name its permission gives it. Every call is recorded. A call
 * that changes something (sends, creates, deletes) is never done straight
 * away: it waits for the person to confirm it in Grasp, and \`pending\`
 * says so. Tell them it waits for them; don't call it again to push it:
 * while it waits, the same call only finds the same waiting change. Once
 * they decided, a note in this chat says how it ended, from your next
 * turn on; \`outcome\` reads how it ended, and its answer, at any time.
 */
connections: {
  /** The connections this chat may use, and the actions each allows. */
  list(): Promise<{ name: string; connectionId: string; resource: string | null; actions: string[] }[]>;
  /** Calls one of a connection's actions with its input. */
  call(
    name: string,
    action: string,
    input: Record<string, unknown>
  ): Promise<{
    /** What the action returned; null while it waits for the person. */
    output: unknown;
    /** Set while it waits for the person to confirm it. */
    pending: { id: string } | null;
  }>;
  /**
   * How a call that waited for the person ended, by its \`pending.id\`:
   * still \`waiting\`, \`declined\` by them, \`done\` (with what the action
   * returned) or \`failed\` (with why, and what the action said). Only for
   * calls of this chat.
   */
  outcome(pendingId: string): Promise<{
    status: "waiting" | "declined" | "done" | "failed";
    output: unknown;
    error: string | null;
  }>;
};`;

/** `env.connections`. */
export const connectionsApi: AgentApi = {
  name: "connections",
  declaration: connectionsDeclaration,
  stub: (scope) => exports.ConnectionsApi({ props: scope }),
};
