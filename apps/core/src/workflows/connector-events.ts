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
import { WorkerEntrypoint } from "cloudflare:workers";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { apps, permissions, workflowTriggers } from "../db/core/schema.ts";
import { featureEnabled } from "../features.ts";
import { allowingPermissionSql } from "../permissions.ts";
import { startRun } from "./runs.ts";

// Events connections report, to workflows' event triggers
// (trigger-registry.ts). Connect calls `ConnectorEvents.deliver` over a
// service binding when a connection reports an event; which connectors
// report which events is theirs to say, and none does yet. Nothing else
// can reach it: it isn't on core's HTTP routes, and only a Worker bound
// to it can call it.
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
// delivered again starts no second run. A start that fails fails the
// delivery, after every other has been tried, so connect can deliver it
// again and start only what didn't start.
//
// While `triggers` or `workflows` is off, delivery is refused with
// `feature.disabled`: connect must treat that as "try again later" and
// keep the event, not drop it.

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
        )} AND (${permissions.mask} IS NULL OR json_array_length(${permissions.mask}) = 0))`
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
  const receivers = triggered.filter(({ filter }) =>
    matchesFilter(filter, event.payload)
  );
  // A hash, so the key (in the audit log too) stays short and says
  // nothing of the event.
  const same = await sha256Hex(JSON.stringify([event.connection, event.id]));
  const started = await Promise.allSettled(
    receivers.map(
      async (receiver) =>
        await startRun(env, {
          app: appIdSchema.parse(receiver.appId),
          workflow: workflowIdSchema.parse(receiver.workflowId),
          input: event,
          startedBy: null,
          actor: { type: "system" },
          trigger: {
            type: "event",
            // By workflow, not by trigger row: the rows are written anew
            // each time a version is made current.
            key: `event:${receiver.appId}:${receiver.workflowId}:${same}`,
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
  return { runs: receivers.length };
};

/**
 * Where connect delivers the events connections report (bound as a
 * service, entrypoint `ConnectorEvents`). `feature.disabled` means try
 * again later; `workflow.invalid` means the event will never be taken.
 */
export class ConnectorEvents extends WorkerEntrypoint<Env> {
  async deliver(event: unknown): Promise<{ runs: number }> {
    return await deliverConnectorEvent(this.env, event);
  }
}
