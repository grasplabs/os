import { auditProvenanceMaxItems } from "@grasp-os/shared/audit";
import type { AuditEntry } from "@grasp-os/shared/audit";
import {
  connectErrors,
  connectorEventActions,
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
// for a permission on the whole connection; and on a personal connection
// only for its owner's Apps. Core sends only permissions that allow the
// event type's read action (`connectorEventActions`), and checks every
// event again as it delivers it, by the rule calls are authorized by.
//
// Reads use the connection's token, which never leaves connect. A read
// stops once it has `readMaxItems` items (at most a page more); more waits
// for the next read, which is due at once. A read that fails, or whose
// result can't be kept, waits longer after each failure, up to an hour, or
// as long as the provider asks; one refused access (401, 403, 404)
// `refusedLimit` times in a row is recorded in the audit log and read only
// daily from then on. While the outbox holds `outboxMax` events, nothing
// is read: the sources' cursors keep their place, and nothing is lost.

/** Every event type connect reports, by type. */
const kinds: Readonly<Record<string, EventKind>> = {
  ...microsoftEventKinds,
};

/** The type `type` names, if connect reports it. */
const kindOf = (type: string): EventKind | undefined =>
  Object.hasOwn(kinds, type) ? kinds[type] : undefined;

/** The read action whose data an event of `type` carries. */
const actionOf = (type: string): string | undefined =>
  Object.entries(connectorEventActions).find(([name]) => name === type)?.[1];

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
/** Refusals in a row after which a source is read only daily. */
export const refusedLimit = 10;
/** How long a source refused that often waits. */
const refusedWaitMs = 24 * 60 * 60_000;
/** The statuses that say the connection can't read the source. */
const refusedStatuses = new Set([401, 403, 404]);

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

type SourceKey = Pick<EventSource, "connectionId" | "type" | "resource">;

/** What the audit log says of a source: its connection, type and resource. */
const sourceEntry = (
  action:
    | "connection.events.started"
    | "connection.events.stopped"
    | "connection.events.refused",
  { connectionId, type, resource }: SourceKey,
  detail: Record<string, number> = {}
): AuditEntry => ({
  actor: { type: "system" },
  action,
  target: { type: "connection", id: connectionId },
  detail: { type, ...(resource === "" ? {} : { resource }), ...detail },
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
  const wanted = new Map<string, SourceKey>();
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

/** Longest provider ID an event takes (core's `connectorEventSchema`). */
const eventIdMaxLength = 200;

/**
 * What a read found, kept: the events in the outbox, where to read on
 * from and when, in one batch with its audit events, one per hundred
 * events, so each names every item it read.
 */
const keepRead = async (
  env: Env,
  source: EventSource,
  connection: Connection,
  found: ReadEvents,
  readAt: Date
): Promise<void> => {
  const db = drizzle(env.DB);
  const action = actionOf(source.type) ?? "";
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
      readAt,
      pollAt: new Date(done.getTime() + (found.more ? 0 : pollIntervalMs)),
      updatedAt: done,
    })
    .where(eq(eventSources.id, source.id));
  const inserts: BatchItem<"sqlite">[] = events.map((event: ReadEvent) =>
    db
      .insert(connectorEvents)
      .values({
        id: crypto.randomUUID(),
        key: JSON.stringify([source.id, event.id]),
        event: JSON.stringify({
          id: event.id,
          connection: connection.id,
          owner: connection.ownerUserId,
          ...(source.resource === "" ? {} : { resource: source.resource }),
          action,
          type: source.type,
          payload: event.payload,
        }),
        retryAt: done,
        createdAt: done,
      })
      .onConflictDoNothing()
  );
  const entries: AuditEntry[] = [];
  for (let at = 0; at < events.length; at += auditProvenanceMaxItems) {
    const group = events.slice(at, at + auditProvenanceMaxItems);
    entries.push({
      actor: { type: "system" },
      action: "connection.events.read",
      target: { type: "connection", id: connection.id },
      provenance: group.map(({ id }) => id),
      detail: {
        type: source.type,
        ...(source.resource === "" ? {} : { resource: source.resource }),
        count: group.length,
      },
    });
  }
  const [first, ...rest] = entries;
  if (first === undefined) {
    await update;
    return;
  }
  await recordEvents(env, [first, ...rest], [...inserts, update]);
};

/**
 * A read that failed, or whose result couldn't be kept: the source waits
 * longer, or as long as the provider asked, and starts over when its
 * cursor is gone (from its last read, where the provider can). Refused
 * `refusedLimit` times in a row, it's recorded in the audit log and read
 * only daily from then on.
 */
const failRead = async (
  env: Env,
  source: EventSource,
  error: unknown
): Promise<void> => {
  const db = drizzle(env.DB);
  const failures = source.failures + 1;
  const sourceError = error instanceof SourceError ? error : undefined;
  const refused =
    sourceError?.status !== undefined &&
    refusedStatuses.has(sourceError.status) &&
    failures >= refusedLimit;
  let wait = sourceError?.retryAfterMs ?? backoffMs(failures);
  if (refused) {
    wait = refusedWaitMs;
  }
  log.warn("events.read_failed", {
    type: source.type,
    failures,
    ...(sourceError?.status === undefined
      ? {}
      : { status: sourceError.status }),
    ...errorFields(error),
  });
  const update = db
    .update(eventSources)
    .set({
      failures,
      pollAt: new Date(Date.now() + wait),
      ...(sourceError?.resync === true ? { cursor: null } : {}),
      updatedAt: new Date(),
    })
    .where(eq(eventSources.id, source.id));
  if (refused && failures === refusedLimit) {
    await recordEvents(
      env,
      [
        sourceEntry("connection.events.refused", source, {
          status: sourceError?.status ?? 0,
          failures,
        }),
      ],
      [update]
    );
    return;
  }
  await update;
};

/** Reads one source that is due, and keeps what it found. */
const readSource = async (
  env: Env,
  source: EventSource,
  connection: Connection
): Promise<void> => {
  const now = Date.now();
  const kind = kindOf(source.type);
  if (kind === undefined || connection.status !== "active") {
    await drizzle(env.DB)
      .update(eventSources)
      .set({ pollAt: new Date(now + inactiveWaitMs) })
      .where(eq(eventSources.id, source.id));
    return;
  }
  if (!(await takeSource(env.DB, source, now))) {
    return;
  }
  try {
    const token = await accessTokenFor(env, connection.id);
    const found = await kind.read({
      source,
      connection,
      pages: pagesWith(token),
    });
    await keepRead(env, source, connection, found, new Date(now));
  } catch (error) {
    await failRead(env, source, error);
  }
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

/** An event dropped, and why, for the audit log. */
const droppedEntry = (
  event: string,
  detail: Record<string, string | number>
): AuditEntry => {
  let parsed: z.infer<typeof outboxedEventSchema> | undefined;
  try {
    parsed = outboxedEventSchema.safeParse(JSON.parse(event)).data;
  } catch {
    parsed = undefined;
  }
  return {
    actor: { type: "system" },
    action: "connection.events.dropped",
    ...(parsed === undefined
      ? {}
      : { target: { type: "connection", id: parsed.connection } }),
    detail: {
      ...(parsed === undefined ? {} : { type: parsed.type }),
      ...detail,
    },
  };
};

/** The outboxed events `ids` name, with their attempts so far. */
const outboxedRows = async (db: D1Database, ids: readonly string[]) => {
  const rows: { id: string; event: string; attempts: number }[] = [];
  for (let at = 0; at < ids.length; at += idsPerQuery) {
    // oxlint-disable-next-line no-await-in-loop -- one chunk at most, in practice
    const found = await drizzle(db)
      .select({
        id: connectorEvents.id,
        event: connectorEvents.event,
        attempts: connectorEvents.attempts,
      })
      .from(connectorEvents)
      .where(inArray(connectorEvents.id, ids.slice(at, at + idsPerQuery)));
    rows.push(...found);
  }
  return rows;
};

/**
 * `ConnectApi.ackConnectorEvents`: removes the events done, and has each
 * that failed wait before it is taken again, longer after each attempt,
 * up to an hour: a workflow at its hourly limit, say, gets it later. One
 * that failed `maxDeliveryAttempts` times, or that core will never take
 * (`rejected`), is dropped, and the audit log says so, so it doesn't hold
 * its place in the outbox for ever.
 */
export const ackConnectorEvents = async (
  env: Env,
  request: unknown
): Promise<void> => {
  const { done, failed, rejected } = connectErrors.parse(
    "connect.invalid",
    connectorEventsAckSchema,
    request
  );
  const db = drizzle(env.DB);
  const now = Date.now();
  const statements: BatchItem<"sqlite">[] = [];
  const dropped: AuditEntry[] = [];
  const remove = (ids: readonly string[]): void => {
    for (let at = 0; at < ids.length; at += idsPerQuery) {
      statements.push(
        db
          .delete(connectorEvents)
          .where(inArray(connectorEvents.id, ids.slice(at, at + idsPerQuery)))
      );
    }
  };
  remove(done);
  const refusedRows = await outboxedRows(env.DB, rejected);
  for (const { event } of refusedRows) {
    dropped.push(droppedEntry(event, { reason: "invalid" }));
  }
  remove(refusedRows.map(({ id }) => id));
  const failedRows = await outboxedRows(env.DB, failed);
  const last = failedRows.filter(
    ({ attempts }) => attempts + 1 >= maxDeliveryAttempts
  );
  for (const { event, attempts } of last) {
    log.error("events.dropped", { attempts: attempts + 1 });
    dropped.push(droppedEntry(event, { attempts: attempts + 1 }));
  }
  remove(last.map(({ id }) => id));
  const retried = failedRows
    .filter(({ attempts }) => attempts + 1 < maxDeliveryAttempts)
    .map(({ id }) => id);
  for (let at = 0; at < retried.length; at += idsPerQuery) {
    statements.push(
      db
        .update(connectorEvents)
        .set({
          attempts: sql`${connectorEvents.attempts} + 1`,
          retryAt: sql`${now} + min(60000 * (1 << min(${connectorEvents.attempts}, 6)), ${maxWaitMs})`,
        })
        .where(inArray(connectorEvents.id, retried.slice(at, at + idsPerQuery)))
    );
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
