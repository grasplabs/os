import {
  connectorEventsTakeMax,
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
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { apps, permissions, workflowTriggers } from "../db/core/schema.ts";
import { featureEnabled } from "../features.ts";
import {
  allowingPermissionSql,
  listeningPermissionSql,
} from "../permissions.ts";
import { atHourlyCap, startRun } from "./runs.ts";

// Events connections report, to workflows' event triggers
// (trigger-registry.ts). Connect can't reach core, so core drives it, as
// it drains connect's audit outbox: every minute, while
// `connector_events`, `triggers` and `workflows` are on, the cron trigger
// tells connect who listens for events where (`listenersOf`), which is
// where connect listens and nowhere else, then takes the events connect
// read, delivers each here, and settles them (`pumpConnectorEvents`).
// Which connectors report which events is connect's to say (its
// events.ts).
//
// An event starts the workflows of Apps' current versions whose trigger
// names its type and whose filter its payload matches, and only in Apps
// that could read what it says, by the one rule calls are authorized by
// (`allowingPermissionSql`, permissions.ts, which `authorize` uses too):
// - an active permission on its connection: on the whole connection, or
//   on the part of it (`resource`) the event is about;
// - that allows the read action the event names (`action`);
// - from the App's current version only if an admin approved it, as for
//   any call on a connection;
// - that masks nothing: masking applies to a call's results, and events
//   aren't masked yet, so a masked permission hears no events;
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

/** A permission that masks nothing, as SQL on `permissions`. */
const unmaskedSql = sql`(${permissions.mask} IS NULL OR json_array_length(${permissions.mask}) = 0)`;

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
        )} AND ${unmaskedSql})`
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
  const capped = await Promise.all(
    receivers.map(
      async (receiver) =>
        await atHourlyCap(
          env,
          receiver.appId,
          receiver.workflowId,
          keyOf(receiver),
          "event"
        )
    )
  );
  const withRoom = receivers.filter((_, index) => capped[index] !== true);
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
 * Who listens for events where: every App's current version's event
 * trigger, with each permission on a connection that could let the App
 * hear it (`listeningPermissionSql`) and masks nothing, and the App's
 * owner. Connect narrows it to the event types' read actions and
 * personal connections' owners.
 */
export const listenersOf = async (env: Env): Promise<EventListener[]> => {
  const rows = await drizzle(env.DB)
    .select({
      type: workflowTriggers.event,
      connection: permissions.objectId,
      resource: permissions.resource,
      owner: apps.ownerId,
      actions: permissions.actions,
    })
    .from(workflowTriggers)
    .innerJoin(
      apps,
      and(
        eq(apps.id, workflowTriggers.appId),
        eq(apps.currentVersion, workflowTriggers.version)
      )
    )
    .innerJoin(
      permissions,
      and(
        listeningPermissionSql(
          workflowTriggers.appId,
          workflowTriggers.version
        ),
        unmaskedSql
      )
    )
    .where(
      and(eq(workflowTriggers.type, "event"), isNotNull(workflowTriggers.event))
    )
    .limit(eventListenersMax + 1);
  // Never a list cut short: connect would stop listening for the rest.
  if (rows.length > eventListenersMax) {
    throw new Error("More event listeners than connect takes at once");
  }
  const listeners = new Map<string, EventListener>();
  for (const { actions, ...row } of rows) {
    const parsed: unknown = JSON.parse(actions);
    const listener = eventListenerSchema.safeParse({
      ...row,
      actions: parsed,
    });
    if (listener.success) {
      listeners.set(JSON.stringify(listener.data), listener.data);
    }
  }
  return [...listeners.values()];
};

/** Most batches of events one cron run delivers: 1,000 events. */
const pumpMaxBatches = 10;

/**
 * Delivers one event connect read: done once it started its runs, or when
 * it never will be taken (`workflow.invalid`); failed otherwise, to be
 * delivered again later.
 */
const deliverOne = async (
  env: Env,
  { event }: OutboxedConnectorEvent
): Promise<boolean> => {
  try {
    await deliverConnectorEvent(env, JSON.parse(event));
    return true;
  } catch (error) {
    if (workflowErrors.codeOf(error) === "workflow.invalid") {
      log.error("workflow.event_invalid", errorFields(error));
      return true;
    }
    return false;
  }
};

/**
 * Every minute, from the cron trigger: tells connect who listens for
 * events where, then delivers the events it read, a batch at a time, and
 * settles each batch; those read before are delivered even when telling
 * connect fails. Nothing while `connector_events`, `triggers` or
 * `workflows` is off: connect then reads nothing, and the events it holds
 * wait.
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
  for (let batch = 0; batch < pumpMaxBatches; batch += 1) {
    // oxlint-disable-next-line no-await-in-loop -- each batch settled before the next
    const taken = await env.CONNECT.takeConnectorEvents();
    if (taken.length === 0) {
      return;
    }
    const done: string[] = [];
    const failed: string[] = [];
    for (const outboxed of taken) {
      // oxlint-disable-next-line no-await-in-loop -- one event at a time
      const delivered = await deliverOne(env, outboxed);
      (delivered ? done : failed).push(outboxed.id);
    }
    // oxlint-disable-next-line no-await-in-loop -- each batch settled before the next
    await env.CONNECT.ackConnectorEvents({ done, failed });
    if (taken.length < connectorEventsTakeMax) {
      return;
    }
  }
};
