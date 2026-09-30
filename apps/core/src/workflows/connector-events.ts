import {
  connectorEventActions,
  eventListenerSchema,
  eventListenersMax,
} from "@grasp-os/shared/connect";
import type {
  EventListener,
  OutboxedConnectorEvent,
} from "@grasp-os/shared/connect";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { featureErrors } from "@grasp-os/shared/errors";
import { appIdSchema, workflowIdSchema } from "@grasp-os/shared/ids";
import { errorFields, log } from "@grasp-os/shared/log";
import {
  connectorEventSchema,
  matchesFilter,
  workflowErrors,
} from "@grasp-os/shared/workflows";
import type { ConnectorEvent } from "@grasp-os/shared/workflows";
import { and, eq, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { apps, permissions, workflowTriggers } from "../db/core/schema.ts";
import { featureEnabled } from "../features.ts";
import {
  allowingPermissionSql,
  listeningPermissionSql,
} from "../permissions.ts";
import { deliveryRoom, startRun } from "./runs.ts";

// Events connections report, to workflows' event triggers
// (trigger-registry.ts). Connect can't reach core, so core drives it, as
// it drains connect's audit outbox: every minute, while
// `connector_events`, `triggers` and `workflows` are on, the cron trigger
// tells connect who listens for events where (`listenersOf`), which is
// where connect listens and nowhere else, then takes the events connect
// read, delivers each here, and settles them (`pumpConnectorEvents`).
// The event types and their read actions are `connectorEventActions`;
// connect reads them (its events.ts).
//
// An event starts the workflows of Apps' current versions whose trigger
// names its type and whose filter its payload matches, and only in Apps
// that could read what it says, by the one rule calls are authorized by
// (`allowingPermissionSql`, permissions.ts, which `authorize` uses too):
// - an active permission on its connection: on exactly the part of it
//   (`resource`) the event is about, or, for an event of the account's own
//   mailbox or drive (no `resource`), on the whole connection. A
//   permission on the whole connection doesn't hear events of mailboxes
//   connect reads for other Apps' permissions;
// - that allows the read action the event names (`action`);
// - from the App's current version only if an admin approved it, as for
//   any call on a connection;
// - for a personal connection, only in Apps whose owner (whom a triggered
//   run acts for) is its owner, as connect lets only calls for its owner
//   use it.
// Each run gets the event as input, keyed by the trigger and a hash of
// the connection and the source's ID of the event: the same event
// delivered again starts no second run. Events start at most
// `triggeredRunsPerHour` runs of a workflow an hour (runs.ts); past that
// the event waits in connect's outbox and is delivered again later. A
// start that fails fails the delivery, after every other has been tried,
// so the event is delivered again and starts only what didn't start.

/**
 * The event triggers of Apps' current versions for `event`'s type, in
 * Apps whose permissions let them read it.
 */
const receiversOf = async (env: Env, event: ConnectorEvent) =>
  await drizzle(env.DB)
    .select({
      appId: workflowTriggers.appId,
      version: workflowTriggers.version,
      workflowId: workflowTriggers.workflowId,
      filter: workflowTriggers.filter,
    })
    .from(workflowTriggers)
    .innerJoin(
      apps,
      and(
        eq(apps.id, workflowTriggers.appId),
        eq(apps.currentVersion, workflowTriggers.version)
      )
    )
    .where(
      and(
        eq(workflowTriggers.type, "event"),
        eq(workflowTriggers.event, event.type),
        event.owner === null ? undefined : eq(apps.ownerId, event.owner),
        sql`EXISTS (SELECT 1 FROM ${permissions} WHERE ${allowingPermissionSql(
          { type: "app", appId: workflowTriggers.appId },
          workflowTriggers.version,
          {
            type: "connection",
            connectionId: event.connection,
            ...(event.resource === undefined
              ? {}
              : { resource: event.resource }),
          },
          event.action
        )} AND ${
          event.resource === undefined
            ? isNull(permissions.resource)
            : eq(permissions.resource, event.resource)
        })`
      )
    );

/**
 * Starts the runs an event a connection reported starts; how many
 * workflows it started (or had started, delivered before).
 */
export const deliverConnectorEvent = async (
  env: Env,
  input: unknown
): Promise<{ runs: number }> => {
  for (const feature of ["triggers", "workflows"] as const) {
    if (!featureEnabled(env, feature)) {
      throw featureErrors.create("feature.disabled", { feature });
    }
  }
  const event = workflowErrors.parse(
    "workflow.invalid",
    connectorEventSchema,
    input
  );
  const triggered = await receiversOf(env, event);
  // Each workflow once, however many of its triggers match: the event
  // starts one run of it (its key is by workflow), counted once, and two
  // starts of it at once would find each other's run still starting.
  const receivers = [
    ...new Map(
      triggered
        .filter(({ filter }) => matchesFilter(filter, event.payload))
        .map((receiver) => [
          `${receiver.appId}:${receiver.workflowId}`,
          receiver,
        ])
    ).values(),
  ];
  // A hash, so the key (in the audit log too) stays short and says
  // nothing of the event.
  const same = await sha256Hex(JSON.stringify([event.connection, event.id]));
  // By workflow, not by trigger row: the rows are written anew each time
  // a version is made current.
  const keyOf = ({
    appId,
    workflowId,
  }: {
    appId: string;
    workflowId: string;
  }) => `event:${appId}:${workflowId}:${same}`;
  // Each workflow's limit is its own: the event goes to those with room
  // now or its run already, and the others get it when it's delivered
  // again.
  const rooms = await Promise.all(
    receivers.map(
      async (receiver) =>
        await deliveryRoom(
          env,
          receiver.appId,
          receiver.workflowId,
          keyOf(receiver),
          "event"
        )
    )
  );
  const withRoom = receivers.filter((_, index) => rooms[index] !== "capped");
  const started = await Promise.allSettled(
    withRoom.map(
      async (receiver) =>
        await startRun(env, {
          app: appIdSchema.parse(receiver.appId),
          workflow: workflowIdSchema.parse(receiver.workflowId),
          input: event,
          startedBy: null,
          actor: { type: "system" },
          trigger: {
            type: "event",
            key: keyOf(receiver),
            version: receiver.version,
          },
        })
    )
  );
  const failures = started.flatMap((result): unknown[] =>
    result.status === "rejected" ? [result.reason] : []
  );
  for (const failure of failures) {
    log.error("workflow.trigger_failed", {
      type: "event",
      event: event.type,
      ...errorFields(failure),
    });
  }
  if (failures.length > 0) {
    throw new Error(`Event ${event.type} didn't start every run it should`);
  }
  if (withRoom.length < receivers.length) {
    // Fails for now, so it's delivered again once the hour allows: the
    // runs started now are the same runs then (their keys), and the
    // workflows at their limit start theirs.
    log.warn("workflow.trigger_rate_limited", {
      type: "event",
      event: event.type,
      capped: receivers.length - withRoom.length,
    });
    throw new Error(`Event ${event.type} is over a workflow's hourly limit`);
  }
  return { runs: receivers.length };
};

/**
 * Who listens for events of `type` where: each active permission on a connection that allows the type's read action
 * (`action`), held by an App whose current version has an event trigger
 * for `type` and was approved (`listeningPermissionSql`), with the App's
 * owner. One row per permission, however many of the App's workflows
 * listen, so the rows are as many as such permissions at most.
 */
const listenersFor = async (env: Env, type: string, action: string) =>
  await drizzle(env.DB)
    .select({
      connection: permissions.objectId,
      resource: permissions.resource,
      owner: apps.ownerId,
    })
    .from(permissions)
    .innerJoin(apps, eq(apps.id, permissions.subjectId))
    .where(
      and(
        listeningPermissionSql(apps.id, apps.currentVersion),
        sql`EXISTS (SELECT 1 FROM json_each(${permissions.actions}) WHERE value = ${action})`,
        sql`EXISTS (SELECT 1 FROM ${workflowTriggers} WHERE ${workflowTriggers.appId} = ${apps.id} AND ${workflowTriggers.version} = ${apps.currentVersion} AND ${workflowTriggers.type} = 'event' AND ${workflowTriggers.event} = ${type})`
      )
    )
    .limit(eventListenersMax + 1);

/**
 * Who listens for events where, for every event type connections report:
 * each listener once. Past `eventListenersMax` the rest are left out and
 * logged: connect stops listening for them (and says so in the audit
 * log), while everyone else goes on hearing their events.
 */
export const listenersOf = async (env: Env): Promise<EventListener[]> => {
  const listeners = new Map<string, EventListener>();
  for (const [type, action] of Object.entries(connectorEventActions)) {
    // oxlint-disable-next-line no-await-in-loop -- one query per event type, few
    const rows = await listenersFor(env, type, action);
    for (const row of rows) {
      const listener = eventListenerSchema.safeParse({ type, ...row });
      if (listener.success) {
        listeners.set(JSON.stringify(listener.data), listener.data);
      }
    }
  }
  const all = [...listeners.values()];
  if (all.length > eventListenersMax) {
    log.error("workflow.event_listeners_capped", {
      listeners: all.length,
      kept: eventListenersMax,
    });
  }
  return all.slice(0, eventListenersMax);
};

/** Events one cron run delivers, at most: one take's worth. */
const defaultEventsPerRun = 100;

/** Events one cron run delivers: fewer in tests (`CONNECTOR_EVENTS_PER_RUN`). */
const eventsPerRun = (env: Env): number => {
  const configured = Number(env.CONNECTOR_EVENTS_PER_RUN);
  return Number.isInteger(configured) && configured > 0
    ? configured
    : defaultEventsPerRun;
};

/**
 * Delivers one event connect read: `done` once it started its runs,
 * `rejected` when it never will be taken (`workflow.invalid`, or not
 * JSON), `failed` otherwise, to be delivered again later.
 */
const deliverOne = async (
  env: Env,
  { event }: OutboxedConnectorEvent
): Promise<"done" | "failed" | "rejected"> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(event);
  } catch {
    log.error("workflow.event_invalid", {});
    return "rejected";
  }
  try {
    await deliverConnectorEvent(env, parsed);
    return "done";
  } catch (error) {
    if (workflowErrors.codeOf(error) === "workflow.invalid") {
      log.error("workflow.event_invalid", errorFields(error));
      return "rejected";
    }
    return "failed";
  }
};

/**
 * Every minute, from the cron trigger: tells connect who listens for
 * events where, then delivers at most `eventsPerRun` of the events it
 * read and settles them; the rest wait for the next run. Those read
 * before are delivered even when telling connect fails. Nothing while
 * `connector_events`, `triggers` or `workflows` is off: connect then reads
 * nothing, and the events it holds wait.
 */
export const pumpConnectorEvents = async (env: Env): Promise<void> => {
  const on = (["connector_events", "triggers", "workflows"] as const).every(
    (feature) => featureEnabled(env, feature)
  );
  if (!on) {
    return;
  }
  try {
    await env.CONNECT.syncEventSources(await listenersOf(env));
  } catch (error) {
    log.error("workflow.event_sync_failed", errorFields(error));
  }
  const taken = await env.CONNECT.takeConnectorEvents();
  const settled: Record<"done" | "failed" | "rejected", string[]> = {
    done: [],
    failed: [],
    rejected: [],
  };
  for (const outboxed of taken.slice(0, eventsPerRun(env))) {
    // oxlint-disable-next-line no-await-in-loop -- one event at a time
    settled[await deliverOne(env, outboxed)].push(outboxed.id);
  }
  if (taken.length > 0) {
    await env.CONNECT.ackConnectorEvents(settled);
  }
};
