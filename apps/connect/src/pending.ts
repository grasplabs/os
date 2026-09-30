import { actorOf } from "@grasp-os/shared/audit";
import type { AuditDetailValue, AuditEntry } from "@grasp-os/shared/audit";
import type { CapabilityClaims } from "@grasp-os/shared/capability";
import {
  connectCallSchema,
  connectErrors,
  connectionPersonSchema,
  declineChatActionsSchema,
  endedRunsSchema,
  heldCallRequestSchema,
  heldRequestSchema,
  pendingKeySchema,
  refuseConfirmationSchema,
} from "@grasp-os/shared/connect";
import type {
  ActionDescription,
  ConnectCall,
  ConnectionPerson,
  HeldCall,
  PendingAction,
  PendingReference,
} from "@grasp-os/shared/connect";
import type { Json } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import {
  permissionSubjectSchema,
  workContextSchema,
} from "@grasp-os/shared/permissions";
import type { WorkContext } from "@grasp-os/shared/permissions";
import { and, asc, desc, eq, notExists, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { recordEvents, recordEventsIf } from "./audit.ts";
import type { GuardedChange } from "./audit.ts";
import { providerName } from "./catalog.ts";
import type { Connection } from "./connections.ts";
import { nativeConnector } from "./connectors.ts";
import { connections, idempotentCalls, pendingActions } from "./db/schema.ts";

// Side effects that wait for their person (threat model R7, R12). A side
// effect a person is there for (`interactive`: from chat, or from a person
// using an App), and every side effect of a context that read restricted
// data, is stored here, exactly, bound to the person it acts for and to the
// connection's account, and connect returns a reference to it instead of
// carrying it out. The person sees it, with its exact input, through core,
// from their own session; confirming runs that stored input through the
// normal call path, with its idempotency key, and declining drops it.
// Nothing of it is left but the audit events and, for a workflow run's
// or a chat's under a key connect made, its key, spent as declined (see
// `deletion`): never its input. As in the reference design,
// a held action waits until it is decided: it doesn't expire.
//
// A restricted context's held actions are marked `restricted`, so the
// person sees a warning and every event records it. A workflow run's held
// side effect answers its call with `connect.held`; core then waits before
// running the step again, under the same key, until the person decided
// (workflows/host.ts): confirmed, the repeat gets the stored answer;
// declined or dropped, its key is spent as declined, and the repeat fails
// with `connect.declined`.
//
// A held action is taken once: confirming and declining each delete its
// row, in one batch with their audit event, only while it is there, so of
// two decisions made at once exactly one wins (CN7). Confirming runs the
// call only after that, so a crash in between drops the action rather
// than running it twice; the call's idempotency key still guards against
// running it twice as ever. Unlike the reference design, a held action is
// bound to the one person it acts for (CN8).
//
// A repeat of the call in the moment between a confirmation taking the
// row and its call claiming the idempotency key finds neither, and is
// held again. Confirming that one only answers with the first call's
// stored answer (or its unknown outcome): the key runs it once.
//
// The account fence (CN15) compares the connection's provider account; a
// Composio connection has none recorded, so it never trips there.

type Row = typeof pendingActions.$inferSelect;

/** A held action, as connect keeps it: the row. */
export type HeldAction = Row;

const subjectOf = (row: Row) =>
  permissionSubjectSchema.parse(
    row.subjectType === "app"
      ? { type: "app", appId: row.subjectId }
      : { type: "agent", agentId: row.subjectId }
  );

/** The call a held action makes once confirmed. */
export const callOf = (row: Row): Omit<ConnectCall, "capability"> => {
  const input: unknown = JSON.parse(row.input);
  return connectCallSchema.omit({ capability: true }).parse({
    connectionId: row.connectionId,
    resource: row.resource ?? undefined,
    action: row.action,
    input,
    idempotencyKey: row.idempotencyKey,
  });
};

/** A held action with its connection, as a list reads them together. */
const withConnection = {
  row: pendingActions,
  connection: {
    provider: connections.provider,
    accountName: connections.accountName,
    serverKind: connections.serverKind,
    server: connections.server,
  },
};

/** What a held action's connection is, if connect still has it. */
type ShownConnection = Pick<
  Connection,
  "provider" | "accountName" | "serverKind" | "server"
> | null;

/** One value of a call's input, as a description shows it (`ActionDescription`). */
const shownValue = (value: Json): string | string[] => {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    const strings = value.filter((item) => typeof item === "string");
    if (strings.length === value.length) {
      return strings;
    }
  }
  return JSON.stringify(value, null, 2);
};

/**
 * The held call as its tool describes it: only a native connector's tool
 * does, in this release's manifest, which is ours and reviewed. The values
 * are the stored input's own, so the person reads what will run; whatever
 * a Composio server says of its tools is never shown as a description.
 */
const descriptionOf = (
  row: Row,
  connection: ShownConnection
): ActionDescription | undefined => {
  if (connection?.serverKind !== "native") {
    return undefined;
  }
  const manifest = nativeConnector(connection.server)?.manifest;
  if (
    manifest?.provider !== connection.provider ||
    !Object.hasOwn(manifest.actions, row.action)
  ) {
    return undefined;
  }
  const describe = manifest.actions[row.action]?.describe;
  if (describe === undefined) {
    return undefined;
  }
  const { input } = callOf(row);
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return undefined;
  }
  const held: Readonly<Record<string, Json | undefined>> = input;
  const shown = new Set(describe.fields.map((field) => field.input));
  return {
    title: describe.title,
    fields: describe.fields.flatMap((field) => {
      const value = Object.hasOwn(held, field.input)
        ? held[field.input]
        : undefined;
      return value === undefined
        ? []
        : [
            {
              input: field.input,
              label: field.label,
              value: shownValue(value),
            },
          ];
    }),
    complete: Object.keys(held).every((key) => shown.has(key)),
  };
};

/** The connection's name for people: what it reaches, and its account. */
const nameOf = (connection: ShownConnection): string | null => {
  if (connection === null) {
    return null;
  }
  const name = providerName(connection);
  return connection.accountName === null
    ? name
    : `${name} (${connection.accountName})`;
};

const summaryOf = ({
  row,
  connection,
}: {
  row: Row;
  connection: ShownConnection;
}): PendingAction => {
  const description = descriptionOf(row, connection);
  return {
    id: row.id,
    subject: subjectOf(row),
    appVersion: row.appVersion,
    mode: row.mode,
    context: workContextSchema.parse(JSON.parse(row.context)),
    restricted: row.restricted,
    permissionId: row.permissionId,
    connectionId: row.connectionId,
    connectionName: nameOf(connection),
    resource: row.resource,
    action: row.action,
    ...(description === undefined ? {} : { description }),
    idempotencyKey: row.idempotencyKey,
    input: row.input,
    inputHash: row.inputHash,
    requestedAt: row.createdAt.toISOString(),
  };
};

/**
 * What a held action's events say of it: identifiers, never its input;
 * `restricted` when it was asked for, or is confirmed, in a restricted
 * context.
 */
const detailOf = (
  row: Row,
  restricted = row.restricted
): Record<string, AuditDetailValue> => ({
  pendingActionId: row.id,
  action: row.action,
  resource: row.resource,
  subjectType: row.subjectType,
  subjectId: row.subjectId,
  onBehalfOf: row.onBehalfOf,
  mode: row.mode,
  inputHash: row.inputHash,
  ...(restricted ? { restricted: true } : {}),
});

/**
 * Deleting one held action with `entry`, its event, only while it is still
 * there. With `spentAs` (why it won't run), a workflow run's held action
 * spends its key in the same batch, so its step's retry fails
 * (`connect.declined`) rather than asking again. So does a chat's under a
 * key connect made (`madeKey`), so its chat can be told it was declined
 * (`heldCall`, `heldOutcome`): the key, never the input.
 */
const deletion = (
  env: Env,
  row: HeldAction,
  entry: AuditEntry,
  spentAs?: string
): GuardedChange => {
  const db = drizzle(env.DB);
  const still = eq(pendingActions.id, row.id);
  const spend = db
    .insert(idempotentCalls)
    .select(
      db
        .select({
          subjectType: pendingActions.subjectType,
          subjectId: pendingActions.subjectId,
          onBehalfOf: pendingActions.onBehalfOf,
          connectionId: pendingActions.connectionId,
          action: pendingActions.action,
          idempotencyKey: pendingActions.idempotencyKey,
          inputHash: pendingActions.inputHash,
          state: sql<"declined">`'declined'`.as("state"),
          output: sql<string | null>`${spentAs ?? null}`.as("output"),
          provenance: sql<null>`NULL`.as("provenance"),
          createdAt: sql<Date>`${Date.now()}`.as("created_at"),
          resource: pendingActions.resource,
        })
        .from(pendingActions)
        .where(
          and(
            still,
            or(
              eq(pendingActions.mode, "workflow"),
              sql`${pendingActions.idempotencyKey} = json_extract(${pendingActions.context}, '$.chatId') || ':' || ${pendingActions.id}`
            )
          )
        )
    )
    .onConflictDoNothing();
  const remove = db.delete(pendingActions).where(still);
  return {
    entry,
    from: pendingActions,
    where: sql`${still}`,
    writes: spentAs === undefined ? [remove] : [spend, remove],
  };
};

/** `deletion`, carried out: whether the held action was still there. */
const deleteWith = async (
  env: Env,
  row: HeldAction,
  entry: AuditEntry,
  spentAs?: string
): Promise<boolean> => {
  const [deleted = false] = await recordEventsIf(env, [
    deletion(env, row, entry, spentAs),
  ]);
  return deleted;
};

/**
 * Held actions one drop takes in one transaction: each its own few
 * statements (every one well within D1's 100 bound values), so a large
 * backlog goes in steady steps.
 */
const dropBatchSize = 50;

/**
 * Drops every held action `where` selects, each with a
 * `connection.action.dropped` event saying why: when its connection is
 * disconnected, or the person it waits for was removed. The rows hold
 * exact inputs, which nothing may keep once nobody can confirm them.
 * By `person`, or by core itself (`null`).
 */
export const dropPendingActions = async (
  env: Env,
  where: SQL,
  reason: string,
  person: ConnectionPerson | null
): Promise<void> => {
  const actor = person === null ? { type: "system" as const } : actorOf(person);
  // A batch at a time until none are left: each batch deletes its rows with
  // their events in one transaction, and a drop that fails part way leaves
  // the rest for a retry (a disconnect again, or core's offboarding retry).
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- one batch at a time
    const rows = await drizzle(env.DB)
      .select()
      .from(pendingActions)
      .where(where)
      .orderBy(asc(pendingActions.createdAt))
      .limit(dropBatchSize);
    const [first, ...more] = rows.map((row) =>
      deletion(
        env,
        row,
        {
          actor,
          action: "connection.action.dropped",
          target: { type: "connection", id: row.connectionId },
          detail: { ...detailOf(row), reason },
        },
        reason
      )
    );
    if (first === undefined) {
      return;
    }
    // oxlint-disable-next-line no-await-in-loop -- one batch at a time
    await recordEventsIf(env, [first, ...more]);
    if (rows.length < dropBatchSize) {
      return;
    }
  }
};

/** A value to insert, as a column of the select that inserts it. */
const value = <T>(literal: T, column: string) => sql<T>`${literal}`.as(column);

/**
 * The idempotency key connect makes for a side effect held without one: a
 * chat's carries the chat, so the chat can later be told how the action
 * ended by the held action's ID alone (`heldCall`), and no other chat
 * can.
 */
const madeKey = (context: WorkContext, id: string): string =>
  context.type === "chat" ? `${context.chatId}:${id}` : id;

/**
 * Holds a side effect for the person `claims` act for: the reference to
 * it, the one already held for this call if there is one. The same call
 * repeated with the same key finds the same held action; with another
 * input, it is refused.
 *
 * A call a person is there for may come without a key (`idempotencyKey`
 * null; call.ts refuses a workflow run's): it is held and taken exactly
 * once whatever its key, so connect makes one (`madeKey`). While it waits,
 * the same call made again (the same App or agent, person, context,
 * connection, action, resource and input) finds that held action rather
 * than holding a second: a model that asks twice doesn't get the person
 * two cards, and one slip of theirs two sends. Once it is decided, the
 * same call is a new action.
 */
export const hold = async (
  env: Env,
  claims: CapabilityClaims,
  connection: Connection,
  {
    input,
    inputHash,
    idempotencyKey,
  }: {
    input: Record<string, Json>;
    inputHash: string;
    idempotencyKey: string | null;
  }
): Promise<PendingReference> => {
  const { authority, origin } = claims;
  const db = drizzle(env.DB);
  const { subject } = authority;
  const subjectType = subject.type;
  const subjectId = subject.type === "app" ? subject.appId : subject.agentId;
  const id = crypto.randomUUID();
  const context = JSON.stringify(origin.context);
  const sameCaller = and(
    eq(pendingActions.subjectType, subjectType),
    eq(pendingActions.subjectId, subjectId),
    eq(pendingActions.onBehalfOf, authority.onBehalfOf),
    eq(pendingActions.connectionId, connection.id),
    eq(pendingActions.action, claims.action)
  );
  // The call this one repeats: by its key, or, without one, by what it
  // would do and where it was asked.
  const sameCall =
    idempotencyKey === null
      ? and(
          sameCaller,
          eq(pendingActions.inputHash, inputHash),
          eq(pendingActions.context, context)
        )
      : and(sameCaller, eq(pendingActions.idempotencyKey, idempotencyKey));
  // Only while the connection is still active: a disconnect that dropped
  // its held actions a moment ago must not find a new one behind it.
  const [inserted] = await db
    .insert(pendingActions)
    .select(
      db
        .select({
          id: value(id, "id"),
          subjectType: value(subjectType, "subject_type"),
          subjectId: value(subjectId, "subject_id"),
          onBehalfOf: value(authority.onBehalfOf, "on_behalf_of"),
          mode: value(authority.mode, "mode"),
          appVersion: value(authority.appVersion ?? null, "app_version"),
          connectionId: value(connection.id, "connection_id"),
          accountId: value(connection.accountId, "account_id"),
          resource: value(claims.resource, "resource"),
          action: value(claims.action, "action"),
          idempotencyKey: value(
            idempotencyKey ?? madeKey(origin.context, id),
            "idempotency_key"
          ),
          input: value(JSON.stringify(input), "input"),
          inputHash: value(inputHash, "input_hash"),
          permissionId: value(origin.permissionId, "permission_id"),
          context: value(context, "context"),
          restricted: value(claims.restricted ? 1 : 0, "restricted"),
          createdAt: value(Date.now(), "created_at"),
        })
        .from(connections)
        .where(
          and(
            eq(connections.id, connection.id),
            eq(connections.status, "active"),
            // In the one statement, so of two such calls at once one is
            // held and the other finds it. A call with a key is kept to
            // one by the unique index on it.
            idempotencyKey === null
              ? notExists(db.select().from(pendingActions).where(sameCall))
              : undefined
          )
        )
    )
    .onConflictDoNothing()
    .returning({ id: pendingActions.id });
  if (inserted !== undefined) {
    return inserted;
  }
  // The same call, held before: the same action, unless its input changed.
  const held = await db.select().from(pendingActions).where(sameCall).get();
  if (held === undefined) {
    // Nothing inserted and nothing held: the connection went inactive, or
    // the held call was taken (decided) a moment ago, and a repeat finds
    // its outcome.
    const now = await db
      .select({ status: connections.status })
      .from(connections)
      .where(eq(connections.id, connection.id))
      .get();
    throw connectErrors.create(
      now?.status === "active"
        ? "connect.call_in_progress"
        : "connect.connection_inactive"
    );
  }
  if (held.inputHash !== inputHash) {
    throw connectErrors.create("connect.idempotency_conflict");
  }
  return { id: held.id };
};

type Decision = "confirm" | "decline";

const decisionEvent = (
  person: ConnectionPerson,
  action: string,
  connectionId: string | undefined,
  detail: Record<string, AuditDetailValue>
): AuditEntry => ({
  actor: actorOf(person),
  action,
  target:
    connectionId === undefined
      ? undefined
      : { type: "connection", id: connectionId },
  detail,
});

/**
 * Records a decision that was refused (not the person's, gone, changed);
 * if that fails too, it is logged: the person learns why it was refused.
 */
export const auditRefusedDecision = async (
  env: Env,
  person: ConnectionPerson,
  decision: Decision,
  id: string,
  reason: string,
  row?: HeldAction,
  restricted = false
): Promise<void> => {
  try {
    await recordEvents(env, [
      decisionEvent(
        person,
        `connection.action.${decision}_refused`,
        row?.connectionId,
        {
          ...(row === undefined
            ? {}
            : detailOf(row, row.restricted || restricted)),
          pendingActionId: id,
          reason,
        }
      ),
    ]);
  } catch (error) {
    log.error("audit.record_failed", errorFields(error));
  }
};

/**
 * The held action `id`, waiting for `person`: only their own, never for
 * Grasp staff, who decide nothing for a client's people. Refused (and
 * recorded) as not found otherwise, so nobody learns of another's.
 */
export const heldFor = async (
  env: Env,
  person: ConnectionPerson,
  id: string,
  decision: Decision
): Promise<HeldAction> => {
  const row = await drizzle(env.DB)
    .select()
    .from(pendingActions)
    .where(eq(pendingActions.id, id))
    .get();
  const theirs =
    row !== undefined && !person.staff && row.onBehalfOf === person.userId;
  if (!theirs) {
    // The log names what was tried on; the caller learns nothing of it.
    await auditRefusedDecision(
      env,
      person,
      decision,
      id,
      "connect.pending_not_found",
      row
    );
    throw connectErrors.create("connect.pending_not_found");
  }
  return row;
};

/**
 * Takes the held action out of waiting, with its event, in one batch: only
 * while it is there, so it is taken at most once. Refused as not found
 * when a concurrent decision took it first. `restricted`: confirmed for a
 * context in restricted mode by now.
 */
export const take = async (
  env: Env,
  person: ConnectionPerson,
  row: HeldAction,
  decision: Decision,
  restricted = false
): Promise<void> => {
  const taken = await deleteWith(
    env,
    row,
    decisionEvent(
      person,
      decision === "confirm"
        ? "connection.action.confirmed"
        : "connection.action.declined",
      row.connectionId,
      detailOf(row, row.restricted || restricted)
    ),
    decision === "decline" ? "declined" : undefined
  );
  if (!taken) {
    await auditRefusedDecision(
      env,
      person,
      decision,
      row.id,
      "connect.pending_not_found",
      row
    );
    throw connectErrors.create("connect.pending_not_found");
  }
};

/** Most held actions one list answers: the newest. */
const listLimit = 200;

/**
 * The held actions waiting for `person`, newest first, at most
 * {@link listLimit}: older ones wait on, and show once newer ones are
 * decided.
 */
export const listPendingActions = async (
  env: Env,
  request: unknown
): Promise<PendingAction[]> => {
  const parsed = connectionPersonSchema.safeParse(request);
  if (!parsed.success) {
    throw connectErrors.create("connect.invalid");
  }
  // Staff act for nobody here: nothing waits for them.
  if (parsed.data.staff) {
    return [];
  }
  const rows = await drizzle(env.DB)
    .select(withConnection)
    .from(pendingActions)
    .leftJoin(connections, eq(connections.id, pendingActions.connectionId))
    .where(eq(pendingActions.onBehalfOf, parsed.data.userId))
    .orderBy(desc(pendingActions.createdAt), desc(pendingActions.id))
    .limit(listLimit);
  return rows.map(summaryOf);
};

/**
 * The held action `id` waiting for `person`, or `null`: never another's,
 * and never one for Grasp staff.
 */
export const pendingActionFor = async (
  env: Env,
  request: unknown
): Promise<PendingAction | null> => {
  const parsed = heldRequestSchema.safeParse(request);
  if (!parsed.success) {
    throw connectErrors.create("connect.invalid");
  }
  const { person, id } = parsed.data;
  if (person.staff) {
    return null;
  }
  const held = await drizzle(env.DB)
    .select(withConnection)
    .from(pendingActions)
    .leftJoin(connections, eq(connections.id, pendingActions.connectionId))
    .where(
      and(
        eq(pendingActions.id, id),
        eq(pendingActions.onBehalfOf, person.userId)
      )
    )
    .get();
  return held === undefined ? null : summaryOf(held);
};

/**
 * Which call a held action of a chat was (`ConnectApi.heldCall`), for the
 * chat whose agent asked for it. A chat's code has only the ID its held
 * call was answered with, so that finds it: while it waits, the held
 * action itself; once decided, the stored call under the key connect made
 * for it, which carries the chat (`madeKey`). Anything else is not found:
 * another chat's, agent's or person's, one held under its caller's own
 * key, and one taken by a confirmation whose call hasn't claimed its key
 * yet, which a moment later is found. It says nothing of how the call
 * ended: that is read with a capability for the call (`heldOutcome`).
 */
export const heldCall = async (
  env: Env,
  request: unknown
): Promise<HeldCall> => {
  const parsed = heldCallRequestSchema.safeParse(request);
  if (!parsed.success) {
    throw connectErrors.create("connect.invalid");
  }
  const { agentId, onBehalfOf, workspaceId, chatId, id } = parsed.data;
  const db = drizzle(env.DB);
  const idempotencyKey = madeKey({ type: "chat", workspaceId, chatId }, id);
  const waiting = await db
    .select({
      connectionId: pendingActions.connectionId,
      resource: pendingActions.resource,
      action: pendingActions.action,
    })
    .from(pendingActions)
    .where(
      and(
        eq(pendingActions.id, id),
        eq(pendingActions.subjectType, "agent"),
        eq(pendingActions.subjectId, agentId),
        eq(pendingActions.onBehalfOf, onBehalfOf),
        eq(pendingActions.idempotencyKey, idempotencyKey)
      )
    )
    .get();
  const found =
    waiting ??
    (await db
      .select({
        connectionId: idempotentCalls.connectionId,
        resource: idempotentCalls.resource,
        action: idempotentCalls.action,
      })
      .from(idempotentCalls)
      .where(
        and(
          eq(idempotentCalls.idempotencyKey, idempotencyKey),
          eq(idempotentCalls.subjectType, "agent"),
          eq(idempotentCalls.subjectId, agentId),
          eq(idempotentCalls.onBehalfOf, onBehalfOf)
        )
      )
      .get());
  if (found === undefined) {
    throw connectErrors.create("connect.pending_not_found");
  }
  return { ...found, idempotencyKey };
};

/**
 * The held action waiting under the call `claims` name, if one still is:
 * its ID.
 */
export const waitingUnder = async (
  env: Env,
  {
    authority,
    connectionId,
    resource,
    action,
    idempotencyKey,
  }: CapabilityClaims
): Promise<string | undefined> => {
  if (idempotencyKey === null) {
    return undefined;
  }
  const { subject } = authority;
  const held = await drizzle(env.DB)
    .select({ id: pendingActions.id, resource: pendingActions.resource })
    .from(pendingActions)
    .where(
      and(
        eq(pendingActions.subjectType, subject.type),
        eq(
          pendingActions.subjectId,
          subject.type === "app" ? subject.appId : subject.agentId
        ),
        eq(pendingActions.onBehalfOf, authority.onBehalfOf),
        eq(pendingActions.connectionId, connectionId),
        eq(pendingActions.action, action),
        eq(pendingActions.idempotencyKey, idempotencyKey)
      )
    )
    .get();
  return held?.resource === resource ? held.id : undefined;
};

/** Most held actions one round of `declineChatActions` reads and declines. */
const declineChunk = 100;

/**
 * Declines every held action of one chat waiting for the person, as the
 * person declines one (`take`, each with its event): a chunk at a time,
 * until none is left, so however many there are, none is missed and no
 * read is unbounded. One decided meanwhile is gone already, which is what
 * this wants. How many it declined; none for Grasp staff.
 */
export const declineChatActions = async (
  env: Env,
  request: unknown
): Promise<number> => {
  const parsed = declineChatActionsSchema.safeParse(request);
  if (!parsed.success) {
    throw connectErrors.create("connect.invalid");
  }
  const { person, workspaceId, chatId } = parsed.data;
  if (person.staff) {
    return 0;
  }
  let declined = 0;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- a chunk at a time
    const rows = await drizzle(env.DB)
      .select()
      .from(pendingActions)
      .where(
        and(
          eq(pendingActions.onBehalfOf, person.userId),
          sql`json_extract(${pendingActions.context}, '$.type') = 'chat'`,
          sql`json_extract(${pendingActions.context}, '$.workspaceId') = ${workspaceId}`,
          sql`json_extract(${pendingActions.context}, '$.chatId') = ${chatId}`
        )
      )
      .limit(declineChunk);
    if (rows.length === 0) {
      return declined;
    }
    for (const row of rows) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- one at a time, each recorded
        await take(env, person, row, "decline");
        declined += 1;
      } catch (error) {
        if (connectErrors.codeOf(error) !== "connect.pending_not_found") {
          throw error;
        }
      }
    }
  }
};

/**
 * Drops the held action `id` of a workflow run that has ended, which core
 * found when `person` came to confirm it: it can no longer run for the
 * run, so nothing keeps its input. Recorded as `connection.action.dropped`
 * with reason `run.ended`.
 */
export const dropForEndedRun = async (
  env: Env,
  request: unknown
): Promise<void> => {
  const parsed = heldRequestSchema.safeParse(request);
  if (!parsed.success) {
    throw connectErrors.create("connect.invalid");
  }
  const { person, id } = parsed.data;
  await dropPendingActions(
    env,
    sql`${pendingActions.id} = ${id} AND ${pendingActions.onBehalfOf} = ${person.userId} AND ${pendingActions.mode} = 'workflow'`,
    "run.ended",
    person
  );
};

/**
 * Drops every held action of the workflow runs core names, whose
 * retention is over (core's src/workflows/retention.ts): a run that ended
 * while a side effect of it was held leaves the action, with its exact
 * input, until its person comes to confirm it (`dropForEndedRun`), which
 * they may never do. A held action's idempotency key starts with its
 * run's ID (`stepIdempotencyKey`), and its subject is the run's App: one
 * read per App, by the index of its held actions. Each is recorded as
 * `connection.action.dropped` with reason `run.ended`, by core itself.
 */
export const dropForEndedRuns = async (
  env: Env,
  request: unknown
): Promise<void> => {
  const parsed = endedRunsSchema.safeParse(request);
  if (!parsed.success) {
    throw connectErrors.create("connect.invalid");
  }
  const byApp = new Map<string, string[]>();
  for (const { appId, runId } of parsed.data.runs) {
    byApp.set(appId, [...(byApp.get(appId) ?? []), encodeURIComponent(runId)]);
  }
  for (const [appId, runs] of byApp) {
    // oxlint-disable-next-line no-await-in-loop -- one App at a time, each recorded
    await dropPendingActions(
      env,
      sql`${pendingActions.subjectType} = 'app' AND ${pendingActions.subjectId} = ${appId} AND ${pendingActions.mode} = 'workflow' AND substr(${pendingActions.idempotencyKey}, 1, instr(${pendingActions.idempotencyKey}, ':') - 1) IN ${runs}`,
      "run.ended",
      null
    );
  }
};

/**
 * Records a confirmation core refused before signing it (the permission is
 * gone, the person has left, the context is invalid), under the person
 * core names from their session: the held action keeps waiting.
 */
export const refuseConfirmation = async (
  env: Env,
  request: unknown
): Promise<void> => {
  const parsed = refuseConfirmationSchema.safeParse(request);
  if (!parsed.success) {
    throw connectErrors.create("connect.invalid");
  }
  const { person, id, reason } = parsed.data;
  const row = await drizzle(env.DB)
    .select()
    .from(pendingActions)
    .where(eq(pendingActions.id, id))
    .get();
  await auditRefusedDecision(env, person, "confirm", id, reason, row);
};

/**
 * Whether any side effect with the idempotency key `idempotencyKey`,
 * acting for `onBehalfOf`, still waits for that person. Core asks for a
 * workflow run that waits before running a step whose side effect was held
 * again: the step's key (the run's ID and the step's name) is the run's
 * own, whichever of its App's code made the call.
 */
export const anyPending = async (
  env: Env,
  request: unknown
): Promise<boolean> => {
  const parsed = pendingKeySchema.safeParse(request);
  if (!parsed.success) {
    throw connectErrors.create("connect.invalid");
  }
  const waiting = await drizzle(env.DB)
    .select({ id: pendingActions.id })
    .from(pendingActions)
    .where(
      and(
        eq(pendingActions.onBehalfOf, parsed.data.onBehalfOf),
        eq(pendingActions.idempotencyKey, parsed.data.idempotencyKey),
        eq(pendingActions.mode, "workflow")
      )
    )
    .limit(1);
  return waiting.length > 0;
};
