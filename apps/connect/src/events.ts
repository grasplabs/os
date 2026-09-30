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
import {
  and,
  eq,
  inArray,
  isNull,
  lte,
  not,
  notExists,
  sql,
} from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { recordEventIf, recordEvents } from "./audit.ts";
import type { Connection } from "./connections.ts";
import { connections, connectorEvents, eventSources } from "./db/schema.ts";
import {
  SourceError,
  maxWaitMs,
  readMaxItems,
  requestBudget,
} from "./event-kinds.ts";
import type {
  EventKind,
  ProviderAccess,
  RequestBudget,
  EventSource,
  ReadEvent,
  ReadEvents,
  SourceRead,
} from "./event-kinds.ts";
import { googleEventKinds } from "./google-events.ts";
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
// as long as the provider asks; a source that failed `failedLimit` times
// in a row is recorded in the audit log, and, when it was refused access
// (401, 403, 404), read only daily from then on. An event whose ID is
// longer than core takes is dropped, which the audit log says too. A
// source is read only while the outbox has room for all a read can find,
// so it never holds more than `outboxMax` events: the sources' cursors
// keep their place meanwhile, and nothing is lost. Events of a connection
// disconnected before core took them are never delivered, and are dropped.
// One sync sends at most `requestsPerSync` requests to providers, of every
// source together: once too few are left for another read, it stops, and
// the sources still due are read by the next.

/** Every event type connect reports, by type. */
const kinds: Readonly<Record<string, EventKind>> = {
  ...microsoftEventKinds,
  ...googleEventKinds,
};

/** The types whose sources are primed before they're read. */
const primedTypes = Object.entries(kinds).flatMap(([type, kind]) =>
  kind.prime === undefined ? [] : [type]
);

/** An unprimed source of a type that is primed first, as SQL. */
const unprimedSql = and(
  isNull(eventSources.cursor),
  inArray(eventSources.type, primedTypes)
);

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
/**
 * Requests one sync sends out, at most, priming and reading together,
 * whichever the provider, each access token too (it may be refreshed):
 * well inside a Worker invocation's 1,000 subrequests, with room for the
 * rest of the sync. A hard bound: a read that would pass it stops there
 * and keeps its cursor (`RequestBudget.spend`).
 */
export const requestsPerSync = 400;
/**
 * Requests a read takes, as a rule: its token, a few pages, and a batch
 * request per 50 of Gmail's messages. A source is read only while this
 * much of the sync's budget is left, so a read is rarely cut off; one
 * that is keeps its cursor, and the sources left are read by the next
 * sync, from where they are.
 */
const requestsPerRead = 20;
/** Events the outbox holds before sources stop being read. */
export const outboxMax = 10_000;
/**
 * Failures in a row after which the audit log says a source is failing:
 * one refused access is read only daily from then on, any other goes on
 * being tried hourly.
 */
export const failedLimit = 10;
/** How long a source refused that often waits. */
const refusedWaitMs = 24 * 60 * 60_000;
/** The statuses that say the connection can't read the source. */
const refusedStatuses = new Set([401, 403, 404]);

/** The wait after `failures` failures in a row: a minute, doubling, to an hour. */
const backoffMs = (failures: number): number =>
  Math.min(60_000 * 2 ** Math.max(failures - 1, 0), maxWaitMs);

/**
 * That `source`'s cursor is still the one it was read with, as SQL: every
 * write of a cursor is conditional on it, so a sync never clears or
 * replaces a position another one saved since.
 */
const sameCursor = (source: EventSource) =>
  and(
    eq(eventSources.id, source.id),
    source.cursor === null
      ? isNull(eventSources.cursor)
      : eq(eventSources.cursor, source.cursor)
  );

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
  (listener.resource === null
    ? kind.wholeConnection
    : kind.isResource(listener.resource));

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
    | "connection.events.refused"
    | "connection.events.failed"
    | "connection.events.primed_late",
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
  (access: ProviderAccess): SourceRead["pages"] =>
  async (page, start) => {
    const items: Awaited<ReturnType<typeof page>>["items"] = [];
    let url = start;
    for (let read = 0; read < readMaxPages; read += 1) {
      // oxlint-disable-next-line no-await-in-loop -- each page names the next
      const { items: found, next, end } = await page(access, url);
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
 * events, so each names every item it read, and one for the events it
 * had to drop, if any: those whose ID is longer than core takes.
 *
 * `read_at` moves only with a read that reached the end of what the
 * provider had: a read that stopped with more to come leaves it, so the
 * reads that take the rest still count as new what arrived since the last
 * one that caught up (`newSince`), however long ago that was. An item
 * read twice meanwhile is the same event (the outbox's key, and core's).
 */
const keepRead = async (
  env: Env,
  source: EventSource,
  connection: Connection,
  found: ReadEvents,
  readAt: Date
): Promise<number> => {
  const db = drizzle(env.DB);
  const action = actionOf(source.type) ?? "";
  const events = found.events.filter(({ id }) => id.length <= eventIdMaxLength);
  const tooLong = found.events.length - events.length;
  const done = new Date();
  const update = db
    .update(eventSources)
    .set({
      cursor: found.cursor,
      failures: 0,
      ...(found.more ? {} : { readAt }),
      pollAt: new Date(done.getTime() + (found.more ? 0 : pollIntervalMs)),
      updatedAt: done,
    })
    .where(sameCursor(source));
  const inserts: BatchItem<"sqlite">[] = events.map((event: ReadEvent) =>
    db
      .insert(connectorEvents)
      .values({
        id: crypto.randomUUID(),
        key: JSON.stringify([source.id, event.id]),
        connectionId: connection.id,
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
  if (tooLong > 0) {
    log.warn("events.id_too_long", { type: source.type, count: tooLong });
    entries.push({
      actor: { type: "system" },
      action: "connection.events.dropped",
      target: { type: "connection", id: connection.id },
      detail: {
        reason: "id_too_long",
        type: source.type,
        ...(source.resource === "" ? {} : { resource: source.resource }),
        count: tooLong,
      },
    });
  }
  const [first, ...rest] = entries;
  if (first === undefined) {
    await update;
    return 0;
  }
  await recordEvents(env, [first, ...rest], [...inserts, update]);
  return events.length;
};

/**
 * A read that failed, or whose result couldn't be kept: the source waits
 * longer, or as long as the provider asked, and starts over when its
 * cursor is gone (from its last read, where the provider can). Its
 * `failedLimit`th failure in a row is recorded in the audit log, once: as
 * refused when the provider refused access, and the source is read only
 * daily for as long as it is; as failed for any other reason, and it goes
 * on being tried.
 */
const failRead = async (
  env: Env,
  source: EventSource,
  error: unknown,
  maxWait = maxWaitMs
): Promise<void> => {
  const db = drizzle(env.DB);
  const failures = source.failures + 1;
  const sourceError = error instanceof SourceError ? error : undefined;
  const refused =
    sourceError?.status !== undefined &&
    refusedStatuses.has(sourceError.status) &&
    failures >= failedLimit;
  // The provider's own wait as it gave it; only a computed one is capped.
  let wait =
    sourceError?.retryAfterMs ?? Math.min(backoffMs(failures), maxWait);
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
      ...(sourceError?.resync === true
        ? { cursor: null, lostAt: new Date() }
        : {}),
      updatedAt: new Date(),
    })
    .where(sameCursor(source));
  if (failures === failedLimit) {
    await recordEvents(
      env,
      [
        sourceEntry(
          refused ? "connection.events.refused" : "connection.events.failed",
          source,
          {
            ...(sourceError?.status === undefined
              ? {}
              : { status: sourceError.status }),
            failures,
          }
        ),
      ],
      [update]
    );
    return;
  }
  await update;
};

/**
 * Reads one source that is due, and keeps what it found, if the outbox
 * has `room` for it: how many events it kept, or `null` when it had no
 * room (the source is left as it was, due, for a later sync).
 */
const readSource = async (
  env: Env,
  source: EventSource,
  connection: Connection,
  room: number,
  budget: RequestBudget
): Promise<number | null> => {
  const db = drizzle(env.DB);
  const now = Date.now();
  const kind = kindOf(source.type);
  // An unprimed source is primed first (`primeSources`), and read once
  // it has a position; `readDue` never picks one.
  if (kind?.prime !== undefined && source.cursor === null) {
    return 0;
  }
  if (kind === undefined || connection.status !== "active") {
    await db
      .update(eventSources)
      .set({ pollAt: new Date(now + inactiveWaitMs) })
      .where(eq(eventSources.id, source.id));
    return 0;
  }
  if (!(await takeSource(env.DB, source, now))) {
    return 0;
  }
  try {
    // The token may be refreshed: a request of its own.
    budget.spend();
    const access = { token: await accessTokenFor(env, connection.id), budget };
    const found = await kind.read({
      source,
      connection,
      access,
      pages: pagesWith(access),
    });
    if (found.events.length > room) {
      // Kept nothing, nor moved on: read again once there's room.
      await db
        .update(eventSources)
        .set({ pollAt: source.pollAt })
        .where(eq(eventSources.id, source.id));
      return null;
    }
    return await keepRead(env, source, connection, found, new Date(now));
  } catch (error) {
    if (error instanceof SourceError && error.spent) {
      // Not the source's failure: read again by the next sync.
      await db
        .update(eventSources)
        .set({ pollAt: source.pollAt })
        .where(eq(eventSources.id, source.id));
      return null;
    }
    await failRead(env, source, error);
    return 0;
  }
};

/** Most sources one sync primes. */
const primesPerSync = 25;

/**
 * The longest a source waits to be primed again after a failure that
 * isn't a refusal: the provider can't replay what arrives before its
 * position is taken, so priming is tried again soon.
 */
export const primeMaxWaitMs = 5 * 60_000;

/**
 * Takes where each new source of a type that reads on from a position
 * (`EventKind.prime`) stands now, as its first cursor: a request each,
 * on top of the reads, and before them, so it marks when the source
 * started however late its first read comes. The longest due first,
 * each under the same lease as a read, so two syncs never prime one
 * source at once.
 *
 * Such a provider can't replay what arrived before its position was
 * taken. So a prime that fails is tried again after at most
 * `primeMaxWaitMs` (a refusal still waits daily, as a read does), and one
 * that succeeds after failing records the gap, how long the source went
 * without a position, as `connection.events.primed_late`. A failing
 * source never holds up the others, and reads nothing meanwhile.
 */
const primeSources = async (env: Env, budget: RequestBudget): Promise<void> => {
  if (primedTypes.length === 0) {
    return;
  }
  const db = drizzle(env.DB);
  const due = await db
    .select({ source: eventSources, connection: connections })
    .from(eventSources)
    .innerJoin(connections, eq(connections.id, eventSources.connectionId))
    .where(
      and(
        unprimedSql,
        eq(connections.status, "active"),
        lte(eventSources.pollAt, new Date())
      )
    )
    .orderBy(eventSources.pollAt)
    .limit(primesPerSync);
  for (const { source, connection } of due) {
    const prime = kindOf(source.type)?.prime;
    const now = Date.now();
    if (
      prime === undefined ||
      budget.left < 1 ||
      // oxlint-disable-next-line no-await-in-loop -- sources in turn, bounded
      !(await takeSource(env.DB, source, now))
    ) {
      continue;
    }
    try {
      budget.spend();
      // oxlint-disable-next-line no-await-in-loop -- sources in turn, bounded
      const token = await accessTokenFor(env, connection.id);
      const access = { token, budget };
      // oxlint-disable-next-line no-await-in-loop -- sources in turn, bounded
      const cursor = await prime({
        source,
        connection,
        access,
        pages: pagesWith(access),
      });
      const primed = db
        .update(eventSources)
        .set({
          cursor,
          failures: 0,
          lostAt: null,
          pollAt: new Date(now),
          updatedAt: new Date(),
        })
        .where(sameCursor(source));
      if (source.failures === 0) {
        // oxlint-disable-next-line no-await-in-loop -- sources in turn, bounded
        await primed;
        continue;
      }
      // Since it lost its cursor, or, never primed, since it started.
      const since = (source.lostAt ?? source.createdAt).getTime();
      // oxlint-disable-next-line no-await-in-loop -- sources in turn, bounded
      await recordEventIf(
        env,
        sourceEntry("connection.events.primed_late", source, {
          failures: source.failures,
          delayMs: now - since,
        }),
        { from: eventSources, where: sameCursor(source) ?? sql`0` },
        [primed]
      );
    } catch (error) {
      if (error instanceof SourceError && error.spent) {
        // oxlint-disable-next-line no-await-in-loop -- once, then stop
        await db
          .update(eventSources)
          .set({ pollAt: source.pollAt })
          .where(eq(eventSources.id, source.id));
        return;
      }
      // oxlint-disable-next-line no-await-in-loop -- sources in turn, bounded
      await failRead(env, source, error, primeMaxWaitMs);
    }
  }
};

/**
 * A read's events at most: `readMaxItems` items and a page past them, of
 * no more than 50 (the page size connect asks providers for); a Gmail
 * read takes exactly `readMaxItems` at most. A read that still found
 * more than the room left would keep nothing (`readSource`).
 */
const eventsPerRead = readMaxItems + 50;

/** The events the outbox holds, up to `outboxMax`. */
const outboxHeld = async (db: D1Database): Promise<number> => {
  const row = await db
    .prepare(
      "SELECT count(*) AS held FROM (SELECT 1 FROM connector_events LIMIT ?)"
    )
    .bind(outboxMax)
    .first<{ held: number }>();
  return row?.held ?? 0;
};

/**
 * Reads the sources that are due, the longest due first, each only while
 * the outbox has room for all a read can find, so it never holds more
 * than `outboxMax`, and while the sync's request budget lasts.
 */
const readDue = async (env: Env, budget: RequestBudget): Promise<void> => {
  let room = outboxMax - (await outboxHeld(env.DB));
  const due = await drizzle(env.DB)
    .select({ source: eventSources, connection: connections })
    .from(eventSources)
    .innerJoin(connections, eq(connections.id, eventSources.connectionId))
    .where(
      and(
        lte(eventSources.pollAt, new Date()),
        primedTypes.length === 0 ? undefined : not(unprimedSql ?? sql`0`)
      )
    )
    .orderBy(eventSources.pollAt)
    .limit(readsPerSync);
  for (const { source, connection } of due) {
    if (room < eventsPerRead) {
      log.warn("events.outbox_full", { room });
      return;
    }
    if (budget.left < requestsPerRead) {
      log.info("events.budget_spent", { left: budget.left });
      return;
    }
    try {
      // oxlint-disable-next-line no-await-in-loop -- sources in turn, bounded
      const kept = await readSource(env, source, connection, room, budget);
      if (kept === null) {
        log.warn("events.read_stopped", { room, left: budget.left });
        return;
      }
      room -= kept;
    } catch (error) {
      log.error("events.source_failed", {
        type: source.type,
        ...errorFields(error),
      });
    }
  }
};

/**
 * Drops the events of connections that were disconnected (or no longer
 * exist) before core took them, recorded in the audit log, one event per
 * connection. Core never gets them meanwhile (`takeConnectorEvents`).
 */
const dropDisconnected = async (env: Env): Promise<void> => {
  const db = drizzle(env.DB);
  const gone = await db
    .select({
      connectionId: connectorEvents.connectionId,
      count: sql<number>`count(*)`,
    })
    .from(connectorEvents)
    .leftJoin(connections, eq(connections.id, connectorEvents.connectionId))
    .where(
      sql`${connections.id} IS NULL OR ${connections.status} = 'disconnected'`
    )
    .groupBy(connectorEvents.connectionId);
  for (const { connectionId, count } of gone) {
    // oxlint-disable-next-line no-await-in-loop -- one connection at a time, each audited
    await recordEvents(
      env,
      [
        {
          actor: { type: "system" },
          action: "connection.events.dropped",
          target: { type: "connection", id: connectionId },
          detail: { reason: "disconnected", count },
        },
      ],
      [
        db
          .delete(connectorEvents)
          .where(eq(connectorEvents.connectionId, connectionId)),
      ]
    );
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
  await dropDisconnected(env);
  const budget = requestBudget(requestsPerSync);
  await primeSources(env, budget);
  await readDue(env, budget);
};

/**
 * `ConnectApi.takeConnectorEvents`: the oldest due, in order, of active
 * connections only: a disconnected connection's events never start a run.
 */
export const takeConnectorEvents = async (
  env: Env
): Promise<OutboxedConnectorEvent[]> =>
  await drizzle(env.DB)
    .select({ id: connectorEvents.id, event: connectorEvents.event })
    .from(connectorEvents)
    .innerJoin(connections, eq(connections.id, connectorEvents.connectionId))
    .where(
      and(
        lte(connectorEvents.retryAt, new Date()),
        eq(connections.status, "active")
      )
    )
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
