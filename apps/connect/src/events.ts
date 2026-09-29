import type { AuditEntry } from "@grasp-os/shared/audit";
import {
  connectErrors,
  connectorEventsAckSchema,
  connectorEventsTakeMax,
  eventListenersSchema,
} from "@grasp-os/shared/connect";
import type {
  EventListener,
  OutboxedConnectorEvent,
} from "@grasp-os/shared/connect";
import { errorFields, log } from "@grasp-os/shared/log";
import { and, eq, inArray, lte, notExists, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { recordEventIf, recordEvents } from "./audit.ts";
import type { Connection } from "./connections.ts";
import { connections, connectorEvents, eventSources } from "./db/schema.ts";
import { SourceError, maxWaitMs, readMaxItems } from "./event-kinds.ts";
import type {
  EventKind,
  EventSource,
  ReadEvent,
  ReadEvents,
  SourceRead,
} from "./event-kinds.ts";
import { microsoftEventKinds } from "./graph-events.ts";
import { accessTokenFor } from "./tokens.ts";

// Events connections report, which start workflows (core's
// workflows/connector-events.ts). Connect can't reach core, so core drives
// it, as it drains connect's audit outbox: every minute its cron trigger
// sends the listeners, every App whose current version has an event
// trigger and a permission that lets it hear it (`syncEventSources`);
// connect listens exactly there, reads what changed at the sources that
// are due, and keeps the events it read in its outbox; core then takes
// them, delivers them, and settles them.
//
// Where connect listens is only ever what a listener's permission
// covers: the mailbox or drive the permission names, or the account's own
// for a permission on the whole connection; only for event types whose
// read action (such as `mail.list`) the permission allows; and on a
// personal connection only for its owner's Apps. Core checks every event
// again as it delivers it, by the rule calls are authorized by.
//
// Reads use the connection's token, which never leaves connect. A read
// takes at most `readMaxItems` items; more waits for the next read, which
// is due at once. A source that fails waits longer after each failure,
// up to an hour, or as long as the provider asks. While the outbox holds
// `outboxMax` events, nothing is read: the sources' cursors keep their
// place, and nothing is lost.

/** Every event type connect reports, by type. */
const kinds: Readonly<Record<string, EventKind>> = {
  ...microsoftEventKinds,
};

/** The type `type` names, if connect reports it. */
const kindOf = (type: string): EventKind | undefined =>
  Object.hasOwn(kinds, type) ? kinds[type] : undefined;

/** Most pages one read goes through. */
const readMaxPages = 5;
/** How often a source is read, at most. */
export const pollIntervalMs = 60_000;
/** How long a read holds its source, so no other reads it at once. */
const readLeaseMs = 2 * 60_000;
/** How long a source of a connection that isn't active waits. */
const inactiveWaitMs = 15 * 60_000;
/** Most sources one sync reads. */
const readsPerSync = 25;
/** Events the outbox holds before sources stop being read. */
export const outboxMax = 10_000;

/** The wait after `failures` failures in a row: a minute, doubling, to an hour. */
const backoffMs = (failures: number): number =>
  Math.min(60_000 * 2 ** Math.max(failures - 1, 0), maxWaitMs);

/** A source's key: its connection, type and resource. */
const keyOf = (connectionId: string, type: string, resource: string): string =>
  JSON.stringify([connectionId, type, resource]);

/** Whether `listener` may have connect listen on `connection` for it. */
const mayListen = (
  listener: EventListener,
  kind: EventKind,
  connection: Connection | undefined
): connection is Connection =>
  connection !== undefined &&
  connection.status !== "disconnected" &&
  connection.serverKind === "native" &&
  connection.provider === kind.provider &&
  connection.server === kind.server &&
  (connection.scope === "shared" ||
    connection.ownerUserId === listener.owner) &&
  listener.actions.includes(kind.action) &&
  (listener.resource === null || kind.isResource(listener.resource));

/** D1 binds at most 100 values a statement. */
const idsPerQuery = 90;

/** The connections `ids` name. */
const connectionsOf = async (
  db: D1Database,
  ids: readonly string[]
): Promise<Map<string, Connection>> => {
  const found = new Map<string, Connection>();
  for (let at = 0; at < ids.length; at += idsPerQuery) {
    // oxlint-disable-next-line no-await-in-loop -- a few chunks, in turn
    const rows = await drizzle(db)
      .select()
      .from(connections)
      .where(inArray(connections.id, ids.slice(at, at + idsPerQuery)));
    for (const row of rows) {
      found.set(row.id, row);
    }
  }
  return found;
};

/** Where connect starts or stops listening, for the audit log. */
const sourceEntry = (
  action: "connection.events.started" | "connection.events.stopped",
  {
    connectionId,
    type,
    resource,
  }: Pick<EventSource, "connectionId" | "type" | "resource">
): AuditEntry => ({
  actor: { type: "system" },
  action,
  target: { type: "connection", id: connectionId },
  detail: { type, ...(resource === "" ? {} : { resource }) },
});

/**
 * Starts listening where the listeners want it and connect doesn't yet,
 * and stops where no listener is left, each recorded in the audit log
 * exactly when it happens.
 */
const reconcile = async (
  env: Env,
  listeners: readonly EventListener[]
): Promise<void> => {
  const db = drizzle(env.DB);
  const found = await connectionsOf(env.DB, [
    ...new Set(listeners.map(({ connection }) => connection)),
  ]);
  const wanted = new Map<
    string,
    Pick<EventSource, "connectionId" | "type" | "resource">
  >();
  for (const listener of listeners) {
    const kind = kindOf(listener.type);
    const connection = found.get(listener.connection);
    if (kind !== undefined && mayListen(listener, kind, connection)) {
      const resource = listener.resource ?? "";
      wanted.set(keyOf(connection.id, listener.type, resource), {
        connectionId: connection.id,
        type: listener.type,
        resource,
      });
    }
  }
  const existing = await db.select().from(eventSources);
  const kept = new Set<string>();
  for (const source of existing) {
    const key = keyOf(source.connectionId, source.type, source.resource);
    if (wanted.has(key)) {
      kept.add(key);
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- one change at a time, each audited
    await recordEventIf(
      env,
      sourceEntry("connection.events.stopped", source),
      { from: eventSources, where: eq(eventSources.id, source.id) },
      [db.delete(eventSources).where(eq(eventSources.id, source.id))]
    );
  }
  const now = new Date();
  for (const [key, source] of wanted) {
    if (kept.has(key)) {
      continue;
    }
    const same = and(
      eq(eventSources.connectionId, source.connectionId),
      eq(eventSources.type, source.type),
      eq(eventSources.resource, source.resource)
    );
    // oxlint-disable-next-line no-await-in-loop -- one change at a time, each audited
    await recordEventIf(
      env,
      sourceEntry("connection.events.started", source),
      {
        from: connections,
        where:
          and(
            eq(connections.id, source.connectionId),
            notExists(db.select().from(eventSources).where(same))
          ) ?? sql`0`,
      },
      [
        db
          .insert(eventSources)
          .values({
            id: crypto.randomUUID(),
            ...source,
            pollAt: now,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing(),
      ]
    );
  }
};

/** Whether the outbox holds `outboxMax` events. */
const outboxFull = async (db: D1Database): Promise<boolean> => {
  const row = await db
    .prepare(
      "SELECT count(*) AS held FROM (SELECT 1 FROM connector_events LIMIT ?)"
    )
    .bind(outboxMax)
    .first<{ held: number }>();
  return (row?.held ?? 0) >= outboxMax;
};

/**
 * Takes the source for one read: moves its next read past the lease, only
 * if no one else did first. Whether it was taken.
 */
const takeSource = async (
  db: D1Database,
  source: EventSource,
  now: number
): Promise<boolean> => {
  const taken = await drizzle(db)
    .update(eventSources)
    .set({ pollAt: new Date(now + readLeaseMs) })
    .where(
      and(
        eq(eventSources.id, source.id),
        eq(eventSources.pollAt, source.pollAt)
      )
    )
    .returning({ id: eventSources.id });
  return taken.length > 0;
};

/** Goes through a provider's pages, as `SourceRead.pages` says. */
const pagesWith =
  (token: string): SourceRead["pages"] =>
  async (page, start) => {
    const items: Awaited<ReturnType<typeof page>>["items"] = [];
    let url = start;
    for (let read = 0; read < readMaxPages; read += 1) {
      // oxlint-disable-next-line no-await-in-loop -- each page names the next
      const { items: found, next, end } = await page(token, url);
      items.push(...found);
      if (end !== undefined) {
        return { items, cursor: end, more: false };
      }
      if (next === undefined) {
        throw new SourceError("The provider handed back no link to go on");
      }
      url = next;
      if (items.length >= readMaxItems) {
        break;
      }
    }
    return { items, cursor: url, more: true };
  };

/** The event core gets for what a read of `source` found. */
const eventOf = (
  kind: EventKind,
  source: EventSource,
  connection: Connection,
  { id, payload }: ReadEvent
) => ({
  id,
  connection: connection.id,
  owner: connection.ownerUserId,
  ...(source.resource === "" ? {} : { resource: source.resource }),
  action: kind.action,
  type: source.type,
  payload,
});

/** Longest provider ID an event takes (core's `connectorEventSchema`). */
const eventIdMaxLength = 200;

/**
 * Reads one source that is due, and keeps what it found in the outbox,
 * with where to read on from and when, in one batch with its audit event.
 */
const readSource = async (
  env: Env,
  source: EventSource,
  connection: Connection
): Promise<void> => {
  const db = drizzle(env.DB);
  const now = Date.now();
  const kind = kindOf(source.type);
  if (kind === undefined || connection.status !== "active") {
    await db
      .update(eventSources)
      .set({ pollAt: new Date(now + inactiveWaitMs) })
      .where(eq(eventSources.id, source.id));
    return;
  }
  if (!(await takeSource(env.DB, source, now))) {
    return;
  }
  let found: ReadEvents;
  try {
    const token = await accessTokenFor(env, connection.id);
    found = await kind.read({ source, connection, pages: pagesWith(token) });
  } catch (error) {
    const failures = source.failures + 1;
    const wait =
      error instanceof SourceError && error.retryAfterMs !== undefined
        ? error.retryAfterMs
        : backoffMs(failures);
    log.warn("events.read_failed", {
      type: source.type,
      failures,
      ...errorFields(error),
    });
    await db
      .update(eventSources)
      .set({
        failures,
        pollAt: new Date(Date.now() + wait),
        ...(error instanceof SourceError && error.resync
          ? { cursor: null, createdAt: new Date() }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(eventSources.id, source.id));
    return;
  }
  const events = found.events.filter(({ id }) => {
    const fits = id.length <= eventIdMaxLength;
    if (!fits) {
      log.warn("events.id_too_long", { type: source.type });
    }
    return fits;
  });
  const done = new Date();
  const update = db
    .update(eventSources)
    .set({
      cursor: found.cursor,
      failures: 0,
      pollAt: new Date(done.getTime() + (found.more ? 0 : pollIntervalMs)),
      updatedAt: done,
    })
    .where(eq(eventSources.id, source.id));
  if (events.length === 0) {
    await update;
    return;
  }
  const inserts: BatchItem<"sqlite">[] = events.map((event) =>
    db
      .insert(connectorEvents)
      .values({
        id: crypto.randomUUID(),
        key: JSON.stringify([source.id, event.id]),
        event: JSON.stringify(eventOf(kind, source, connection, event)),
        retryAt: done,
        createdAt: done,
      })
      .onConflictDoNothing()
  );
  await recordEvents(
    env,
    [
      {
        actor: { type: "system" },
        action: "connection.events.read",
        target: { type: "connection", id: connection.id },
        provenance: events.map(({ id }) => id),
        detail: {
          type: source.type,
          ...(source.resource === "" ? {} : { resource: source.resource }),
          count: events.length,
        },
      },
    ],
    [...inserts, update]
  );
};

/** Reads the sources that are due, the longest due first. */
const readDue = async (env: Env): Promise<void> => {
  if (await outboxFull(env.DB)) {
    log.warn("events.outbox_full", {});
    return;
  }
  const due = await drizzle(env.DB)
    .select({ source: eventSources, connection: connections })
    .from(eventSources)
    .innerJoin(connections, eq(connections.id, eventSources.connectionId))
    .where(lte(eventSources.pollAt, new Date()))
    .orderBy(eventSources.pollAt)
    .limit(readsPerSync);
  for (const { source, connection } of due) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- sources in turn, bounded
      await readSource(env, source, connection);
    } catch (error) {
      log.error("events.source_failed", {
        type: source.type,
        ...errorFields(error),
      });
    }
  }
};

/** `ConnectApi.syncEventSources`. */
export const syncEventSources = async (
  env: Env,
  request: unknown
): Promise<void> => {
  const listeners = connectErrors.parse(
    "connect.invalid",
    eventListenersSchema,
    request
  );
  await reconcile(env, listeners);
  await readDue(env);
};

/** `ConnectApi.takeConnectorEvents`: the oldest due, in order. */
export const takeConnectorEvents = async (
  env: Env
): Promise<OutboxedConnectorEvent[]> =>
  await drizzle(env.DB)
    .select({ id: connectorEvents.id, event: connectorEvents.event })
    .from(connectorEvents)
    .where(lte(connectorEvents.retryAt, new Date()))
    .orderBy(connectorEvents.retryAt)
    .limit(connectorEventsTakeMax);

/** Deliveries an event gets before it is dropped: about two days of tries. */
export const maxDeliveryAttempts = 48;

const outboxedEventSchema = z.object({
  connection: z.string(),
  type: z.string(),
});

/** An event dropped after its last try, for the audit log. */
const droppedEntry = (event: string, attempts: number): AuditEntry => {
  const parsed = outboxedEventSchema.safeParse(JSON.parse(event));
  return {
    actor: { type: "system" },
    action: "connection.events.dropped",
    ...(parsed.success
      ? { target: { type: "connection", id: parsed.data.connection } }
      : {}),
    detail: {
      ...(parsed.success ? { type: parsed.data.type } : {}),
      attempts,
    },
  };
};

/**
 * `ConnectApi.ackConnectorEvents`: removes the events done, and has each
 * that failed wait before it is taken again, longer after each attempt,
 * up to an hour: a workflow at its hourly limit, say, gets it later. One
 * that failed `maxDeliveryAttempts` times is dropped, and the audit log
 * says so, so an event that can never start its runs doesn't hold its
 * place in the outbox for ever.
 */
export const ackConnectorEvents = async (
  env: Env,
  request: unknown
): Promise<void> => {
  const { done, failed } = connectErrors.parse(
    "connect.invalid",
    connectorEventsAckSchema,
    request
  );
  const db = drizzle(env.DB);
  const now = Date.now();
  const statements: BatchItem<"sqlite">[] = [];
  const dropped: AuditEntry[] = [];
  for (let at = 0; at < done.length; at += idsPerQuery) {
    statements.push(
      db
        .delete(connectorEvents)
        .where(inArray(connectorEvents.id, done.slice(at, at + idsPerQuery)))
    );
  }
  for (let at = 0; at < failed.length; at += idsPerQuery) {
    // oxlint-disable-next-line no-await-in-loop -- one chunk at most, in practice
    const rows = await db
      .select({
        id: connectorEvents.id,
        event: connectorEvents.event,
        attempts: connectorEvents.attempts,
      })
      .from(connectorEvents)
      .where(inArray(connectorEvents.id, failed.slice(at, at + idsPerQuery)));
    const last = rows.filter(
      ({ attempts }) => attempts + 1 >= maxDeliveryAttempts
    );
    const retried = rows
      .filter(({ attempts }) => attempts + 1 < maxDeliveryAttempts)
      .map(({ id }) => id);
    for (const { id, event, attempts } of last) {
      log.error("events.dropped", { attempts: attempts + 1 });
      dropped.push(droppedEntry(event, attempts + 1));
      statements.push(
        db.delete(connectorEvents).where(eq(connectorEvents.id, id))
      );
    }
    if (retried.length > 0) {
      statements.push(
        db
          .update(connectorEvents)
          .set({
            attempts: sql`${connectorEvents.attempts} + 1`,
            retryAt: sql`${now} + min(60000 * (1 << min(${connectorEvents.attempts}, 6)), ${maxWaitMs})`,
          })
          .where(inArray(connectorEvents.id, retried))
      );
    }
  }
  const [firstDropped, ...moreDropped] = dropped;
  if (firstDropped !== undefined) {
    await recordEvents(env, [firstDropped, ...moreDropped], statements);
    return;
  }
  const [first, ...rest] = statements;
  if (first !== undefined) {
    await db.batch([first, ...rest]);
  }
};
