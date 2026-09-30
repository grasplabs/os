import { actorOf, delegateActorOf } from "@grasp-os/shared/audit";
import type { AuditActor } from "@grasp-os/shared/audit";
import type { ChatConnectionRequest } from "@grasp-os/shared/chat";
import type {
  ConnectionPerson,
  ConnectionSummary,
} from "@grasp-os/shared/connect";
import { isExpectedError } from "@grasp-os/shared/errors";
import { permissionIdSchema } from "@grasp-os/shared/ids";
import type { ChatId } from "@grasp-os/shared/ids";
import { errorFields, log } from "@grasp-os/shared/log";
import {
  permissionErrors,
  permissionRequestSchema,
} from "@grasp-os/shared/permissions";
import type { Permission } from "@grasp-os/shared/permissions";
import { roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import type { AgentScope } from "./agent-scope.ts";
import { chatAuthority } from "./agent-scope.ts";
import {
  auditedBatch,
  keepAuditEvent,
  outboxedIfChanged,
} from "./audit-outbox.ts";
import { activeMember } from "./auth/auth.ts";
import { memberOf } from "./auth/identity.ts";
import {
  offeredConnections,
  personOf,
  requireOfferedConnection,
} from "./connections.ts";
import { permissions, users } from "./db/core/schema.ts";
import { isUniqueViolation } from "./db/d1.ts";
import { workspace } from "./durable-objects.ts";
import {
  changeEntry,
  findRow,
  insertWhere,
  noBindingClash,
  permissionEntry,
  requireNoBindingClash,
  tellChat,
  toPermission,
} from "./permissions.ts";

// Connections a chat's agent asks for, each granted in that chat alone.
// The agent asks (`env.connections.request`); the chat's person grants or
// denies a request for their own personal connection (a mailbox, a drive)
// on a card in the chat, and nobody else sees it; a shared connection
// still needs an admin (`grantPermission`), and the person may withdraw
// it. The grant is an ordinary permission of the chat's agent that holds
// only in that chat and only for that person (`chat_id`, `requested_by`;
// `holdsIn` in permissions.ts), so every call is checked, signed and
// audited as any other, connect still refuses a personal connection to
// anyone but its owner, and every write from chat is still held for the
// person to confirm.
//
// How it can fail, and what stops it:
//
// - Someone grants another person's connection: only the chat's own
//   person decides its requests (the row names them, the chat is theirs
//   in their own Workspace object), and grants only a request for their
//   own personal connection (`personal`, from connect as it was asked
//   for). Connect refuses it to anyone else anyway. An admin never sees,
//   grants or revokes a personal one.
// - The agent grants itself: its code reaches only its env's stubs; the
//   decision is on `/rpc` alone, behind the person's session.
// - A guest chat: guests have no agent, no code and no session; nothing
//   here is in their reach.
// - A card replayed or forged: a decision names a request by ID only, and
//   only a waiting request of that very chat and person changes, in one
//   conditional update; anything else is refused as if there were none,
//   and the refusal is audited.
// - A grant that outlives the chat, the person or the connection:
//   deleting the chat, or removing the person, revokes its grants and
//   requests; the grant never holds in another chat or for anyone else;
//   connect refuses a disconnected connection.
// - An admin-hidden connector: it can't be asked for, and a waiting
//   request for it can't be granted, whoever decides.
// - Cross-chat and cross-agent use: the grant holds for the chat's agent
//   in that chat alone, on every check (`authorize`, and every env built).
// - More granted than asked: the decision takes no object, actions or
//   binding: it grants the stored request, exactly as the card showed it.
// - A name taken over: a chat's binding and one that holds everywhere
//   never both go live (`noBindingClash`), whichever is granted later.
// - Asking without end: at most a few requests wait in a chat, and one
//   turned down there can't be asked for again, both in the insert itself.

/** Most requests one chat may have waiting: no flood of cards. */
export const maxWaitingRequests = 5;

/** Most characters of why the agent asks. */
const reasonMaxLength = 500;

/** What the chat's code sends to ask for a connection. */
const askSchema = z.strictObject({
  connectionId: z.string(),
  resource: z.string().optional(),
  actions: z.array(z.string()),
  binding: z.string(),
  reason: z.string().trim().min(1).max(reasonMaxLength),
});

/** A connection the chat's agent may ask for, as its code reads it. */
export interface AskableConnection {
  connectionId: string;
  /** A native provider (`microsoft`), or a catalog toolkit's slug. */
  provider: string;
  /** The account at the provider, such as an email address. */
  account: string | null;
  scope: "personal" | "shared";
  /** The actions it has, which a request may name. */
  actions: string[];
  /** Who grants it: the person in the chat, or an admin. */
  decidedBy: "person" | "admin";
}

/** What asking did, as the chat's code reads it. */
export interface AskedConnection {
  /** The request's ID. */
  id: string;
  binding: string;
  decidedBy: "person" | "admin";
}

/** A decision on a request, and the audit action it is recorded as. */
type Decision = "granted" | "denied";

const decisionActions = {
  granted: "permission.granted",
  denied: "permission.request_denied",
} as const;

/**
 * The actions of each connection in `offered`, by its ID: a native
 * provider's manifest's (one lookup per provider), a toolkit's those the
 * admin allowed as they connected it.
 */
const actionsOf = async (
  env: Env,
  offered: readonly ConnectionSummary[]
): Promise<Map<string, string[]>> => {
  const natives = [
    ...new Set(
      offered.flatMap(({ source, provider }) =>
        source === "native" ? [provider] : []
      )
    ),
  ];
  const manifests = new Map(
    await Promise.all(
      natives.map(async (provider) => {
        const tools = await env.CONNECT.catalogTools({
          composio: false,
          source: "native",
          id: provider,
        });
        return [provider, tools.map(({ name }) => name)] as const;
      })
    )
  );
  return new Map(
    offered.map(({ id, source, provider, tools }) => [
      id,
      source === "native" ? (manifests.get(provider) ?? []) : (tools ?? []),
    ])
  );
};

/**
 * The chat's person, as connect needs them (`personOf`, with the email
 * they signed in with read now), or why the agent can't act for them.
 */
const scopePerson = async (
  env: Env,
  scope: AgentScope
): Promise<ConnectionPerson> => {
  const [member, user] = await Promise.all([
    memberOf(env.DB, scope.personId),
    drizzle(env.DB)
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, scope.personId))
      .get(),
  ]);
  if (member === undefined || user === undefined) {
    throw permissionErrors.create("permission.person_inactive");
  }
  return await personOf(env, { ...member, email: user.email });
};

/**
 * Tells the chat's watchers something waits for its person. A failure is
 * logged: the page reads it at its next change.
 */
const waitingChanged = async (env: Env, scope: AgentScope): Promise<void> => {
  try {
    await workspace(env, scope.workspaceId).heldChanged(scope.chatId);
  } catch (error) {
    log.warn("chat.held_push_failed", {
      chatId: scope.chatId,
      ...errorFields(error),
    });
  }
};

/**
 * The connections the chat's agent may ask for: its person's own personal
 * ones and the shared ones, active and offered (`offeredConnections`).
 */
export const askableConnections = async (
  env: Env,
  scope: AgentScope
): Promise<AskableConnection[]> => {
  const offered = await offeredConnections(env, await scopePerson(env, scope));
  const actions = await actionsOf(env, offered);
  return offered.map(({ id, provider, accountName, ownerUserId }) => ({
    connectionId: id,
    provider,
    account: accountName,
    scope: ownerUserId === null ? "shared" : "personal",
    actions: actions.get(id) ?? [],
    decidedBy: ownerUserId === null ? "admin" : "person",
  }));
};

/** Why a request wasn't stored, read once the insert took nothing. */
const whyNotStored = async (
  env: Env,
  {
    chatId,
    agentId,
    objectId,
    resource,
    actions,
    binding,
  }: {
    chatId: string;
    agentId: string;
    objectId: string;
    resource: string | null;
    actions: string;
    binding: string;
  }
): Promise<Error> => {
  const db = drizzle(env.DB);
  const [deniedBefore, taken] = await Promise.all([
    db
      .select({ id: permissions.id })
      .from(permissions)
      .where(
        and(
          eq(permissions.chatId, chatId),
          eq(permissions.status, "revoked"),
          eq(permissions.objectId, objectId),
          resource === null
            ? isNull(permissions.resource)
            : eq(permissions.resource, resource),
          eq(permissions.actions, actions)
        )
      )
      .get(),
    db
      .select({ id: permissions.id })
      .from(permissions)
      .where(
        and(
          eq(permissions.subjectType, "agent"),
          eq(permissions.subjectId, agentId),
          eq(permissions.binding, binding),
          isNull(permissions.chatId),
          ne(permissions.status, "revoked")
        )
      )
      .get(),
  ]);
  if (deniedBefore !== undefined) {
    return permissionErrors.create("permission.denied_before");
  }
  if (taken !== undefined) {
    return permissionErrors.create("permission.conflict", { binding });
  }
  return permissionErrors.create("permission.too_many_requests");
};

/**
 * Asks, for the chat's agent, to use a connection in this chat alone: one
 * of `askableConnections`, with actions it has, under a binding name no
 * permission of the agent here has. It allows nothing until it is
 * granted. Stored in one conditional insert, only while fewer than
 * {@link maxWaitingRequests} wait in the chat, the same connection and
 * actions weren't turned down there, and no permission that holds
 * everywhere has the name. Audited as the agent's, acting for its person;
 * the chat's page shows it at once.
 */
export const askInChat = async (
  env: Env,
  scope: AgentScope,
  input: unknown
): Promise<AskedConnection> => {
  const { reason, ...ask } = permissionErrors.parse(
    "permission.invalid",
    askSchema,
    input
  );
  const authority = chatAuthority(scope);
  const { object, actions, binding } = permissionErrors.parse(
    "permission.invalid",
    permissionRequestSchema,
    {
      subject: authority.subject,
      object: {
        type: "connection",
        connectionId: ask.connectionId,
        ...(ask.resource === undefined ? {} : { resource: ask.resource }),
      },
      actions: ask.actions,
      binding: ask.binding,
    }
  );
  if (object.type !== "connection") {
    throw permissionErrors.create("permission.invalid");
  }
  const offered = await offeredConnections(env, await scopePerson(env, scope));
  const connection = offered.find(({ id }) => id === object.connectionId);
  if (connection === undefined) {
    throw permissionErrors.create("permission.invalid", {
      issues: [
        "connectionId: No connection you may ask for has that ID (env.connections.available()).",
      ],
    });
  }
  const actionsOfIt = await actionsOf(env, [connection]);
  const known = actionsOfIt.get(connection.id) ?? [];
  const unknown = actions.filter((action) => !known.includes(action));
  if (unknown.length > 0) {
    throw permissionErrors.create("permission.invalid", {
      issues: unknown.map((action) => `actions: It has no action ${action}.`),
    });
  }
  const personal = connection.ownerUserId !== null;
  const row: typeof permissions.$inferSelect = {
    id: crypto.randomUUID(),
    subjectType: "agent",
    // The chat's agent, its ID as `chatAuthority` checked it.
    subjectId: scope.agentId,
    objectType: "connection",
    objectId: object.connectionId,
    resource: object.resource ?? null,
    // Sorted, so the same actions asked for again read the same.
    actions: JSON.stringify(actions.toSorted()),
    binding,
    status: "requested",
    requestedBy: scope.personId,
    requestedAt: new Date(),
    grantedBy: null,
    grantedAt: null,
    revokedBy: null,
    revokedAt: null,
    requestedVia: {
      type: "agent",
      agentId: scope.agentId,
      onBehalfOf: scope.personId,
      workspaceId: scope.workspaceId,
      chatId: scope.chatId,
    },
    chatId: scope.chatId,
    reason,
    personal,
  };
  const permission = toPermission(row);
  const db = drizzle(env.DB);
  const insert = insertWhere(
    db,
    row,
    sql`(SELECT count(*) FROM ${permissions} WHERE chat_id = ${row.chatId} AND status = 'requested') < ${maxWaitingRequests}
      AND NOT EXISTS (SELECT 1 FROM ${permissions} WHERE chat_id = ${row.chatId} AND status = 'revoked' AND object_id = ${row.objectId} AND resource IS ${row.resource} AND actions = ${row.actions})
      AND NOT EXISTS (SELECT 1 FROM ${permissions} WHERE subject_type = 'agent' AND subject_id = ${row.subjectId} AND binding = ${binding} AND chat_id IS NULL AND status <> 'revoked')`
  );
  try {
    await auditedBatch(env, db, [
      insert,
      outboxedIfChanged(
        db,
        changeEntry(
          {
            userId: scope.personId,
            staff: false,
            actor: delegateActorOf(authority),
          },
          "permission.requested",
          permission
        )
      ),
    ]);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw permissionErrors.create("permission.conflict", { binding });
    }
    throw error;
  }
  if ((await findRow(env, row.id)) === undefined) {
    throw await whyNotStored(env, {
      chatId: scope.chatId,
      agentId: scope.agentId,
      objectId: row.objectId,
      resource: row.resource,
      actions: row.actions,
      binding,
    });
  }
  await waitingChanged(env, scope);
  return {
    id: permission.id,
    binding,
    decidedBy: personal ? "person" : "admin",
  };
};

/**
 * The requests of `by`'s own chat `chatId` that wait, oldest first, as its
 * page shows them. The caller has checked the chat is theirs.
 */
export const chatRequests = async (
  env: Env,
  by: Identity,
  chatId: ChatId
): Promise<ChatConnectionRequest[]> => {
  const rows = await drizzle(env.DB)
    .select()
    .from(permissions)
    .where(
      and(
        eq(permissions.chatId, chatId),
        eq(permissions.status, "requested"),
        eq(permissions.requestedBy, by.userId)
      )
    )
    .orderBy(asc(permissions.requestedAt), asc(permissions.id));
  if (rows.length === 0) {
    return [];
  }
  const listed = await env.CONNECT.listConnections(await personOf(env, by));
  const named = new Map(listed.map((each) => [each.id, each]));
  return rows.map((row) => {
    const permission = toPermission(row);
    const connection = named.get(row.objectId);
    return {
      id: permission.id,
      connectionId: row.objectId,
      provider: connection?.provider ?? null,
      accountName: connection?.accountName ?? null,
      resource: row.resource,
      actions: permission.actions,
      binding: permission.binding,
      reason: row.reason,
      requestedAt: permission.requestedAt,
      decidedBy: row.personal ? "you" : "admin",
    };
  });
};

/**
 * Grants or denies request `id` of `by`'s own chat `chatId` (the caller has
 * checked the chat is theirs), as it was asked for: granting only a
 * request for their own personal connection, still connected and offered,
 * under a name nothing that holds everywhere has; denying any
 * (withdrawing it, for a shared one). Only from waiting, in one
 * conditional update with its audit event, while `by` is still a member:
 * a decided, forged or someone else's request is refused as if there
 * were none.
 */
const decide = async (
  env: Env,
  by: Identity,
  chatId: ChatId,
  id: string | undefined,
  decision: Decision
): Promise<Permission> => {
  if (by.staff) {
    // Grasp staff never decide a client's permissions.
    throw roleErrors.create("role.forbidden");
  }
  const found = id === undefined ? undefined : await findRow(env, id);
  if (
    found === undefined ||
    found.chatId !== chatId ||
    found.requestedBy !== by.userId
  ) {
    throw permissionErrors.create("permission.not_found");
  }
  const granting = decision === "granted";
  if (granting) {
    if (!found.personal) {
      throw permissionErrors.create("permission.admin_decides");
    }
    await requireOfferedConnection(
      env,
      await personOf(env, by),
      found.objectId
    );
    await requireNoBindingClash(env, found);
  }
  const db = drizzle(env.DB);
  const now = new Date();
  const [[decided]] = await auditedBatch(env, db, [
    db
      .update(permissions)
      .set(
        granting
          ? { status: "active", grantedBy: by.userId, grantedAt: now }
          : { status: "revoked", revokedBy: by.userId, revokedAt: now }
      )
      .where(
        and(
          eq(permissions.id, found.id),
          eq(permissions.status, "requested"),
          eq(permissions.chatId, chatId),
          eq(permissions.requestedBy, by.userId),
          activeMember(by.userId),
          granting ? noBindingClash : undefined
        )
      )
      .returning(),
    outboxedIfChanged(
      db,
      changeEntry(by, decisionActions[decision], toPermission(found), {
        requestedBy: found.requestedBy,
      })
    ),
  ]);
  if (!decided) {
    if (granting) {
      await requireNoBindingClash(env, found);
    }
    throw permissionErrors.create("permission.not_requested");
  }
  const permission = toPermission(decided);
  await tellChat(env, permission, decision);
  return permission;
};

/**
 * `decide`, with every refusal audited as the decision refused, and why:
 * someone trying a request that isn't theirs, one no longer waiting, or
 * one they may not grant.
 */
export const decideInChat = async (
  env: Env,
  by: Identity,
  chatId: ChatId,
  id: unknown,
  decision: Decision
): Promise<Permission> => {
  const parsed = permissionIdSchema.safeParse(id);
  try {
    return await decide(
      env,
      by,
      chatId,
      parsed.success ? parsed.data : undefined,
      decision
    );
  } catch (error) {
    await keepAuditEvent(env, drizzle(env.DB), {
      actor: actorOf(by),
      action: decisionActions[decision],
      ...(parsed.success
        ? { target: { type: "permission", id: parsed.data } }
        : {}),
      detail: {
        chat: chatId,
        outcome: "refused",
        reason: isExpectedError(error) ? error.code : "internal.unexpected",
      },
    });
    throw error;
  }
};

/**
 * Revokes every chat's own permission `of` selects (a chat's, as it is
 * deleted, or a person's, as they are removed), waiting or granted, each
 * audited with `why`, by `by`: none outlives its chat or its person. How
 * many it revoked.
 */
export const revokeChatPermissions = async (
  env: Env,
  of: { chatId: string } | { requestedBy: string },
  by: { userId: string | null; actor: AuditActor },
  why: "chat_deleted" | "person_removed"
): Promise<number> => {
  const db = drizzle(env.DB);
  const live = inArray(permissions.status, ["requested", "active"]);
  const selected: SQL | undefined =
    "chatId" in of
      ? eq(permissions.chatId, of.chatId)
      : and(
          eq(permissions.requestedBy, of.requestedBy),
          sql`${permissions.chatId} IS NOT NULL`
        );
  const rows = await db.select().from(permissions).where(and(selected, live));
  const now = new Date();
  const [first, ...rest] = rows.flatMap((row) => [
    db
      .update(permissions)
      .set({ status: "revoked", revokedBy: by.userId, revokedAt: now })
      .where(and(eq(permissions.id, row.id), live)),
    outboxedIfChanged(
      db,
      permissionEntry(by.actor, "permission.revoked", toPermission(row), {
        why,
      })
    ),
  ]);
  if (first === undefined) {
    return 0;
  }
  await auditedBatch(env, db, [first, ...rest]);
  return rows.length;
};
