import type { AppFiles } from "@grasp-os/shared/apps";
import type { AuditDetailValue } from "@grasp-os/shared/audit";
import { identifierMaxLength } from "@grasp-os/shared/ids";
import type { AppId, WorkflowId } from "@grasp-os/shared/ids";
import {
  defaultTimeZone,
  nextScheduledRun,
  workflowErrors,
} from "@grasp-os/shared/workflows";
import { and, eq, getTableColumns, ne, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";

import {
  apps,
  workflowParamValues,
  workflowTriggers,
} from "../db/core/schema.ts";
import { inList } from "../db/d1.ts";
import { declaredParams, declaredTriggers, workflowIdsIn } from "./code.ts";
import { valueRows, valuesOf } from "./param-values.ts";

// Which triggers are registered (triggers.ts starts their runs): the SDK's
// `Trigger`, declared in a workflow's code. Only workflows declare them;
// screens can't. The triggers of an App's current version are rows in
// `workflow_triggers`, written in the batch that makes a version current
// (apps.ts), which removes those of every other version: a version's
// triggers work only while it is current, whatever its code says, and a
// workflow a version drops, or whose trigger it drops, is deactivated.
//
// The rows are worked out before that batch, from the version's code and
// the schedule parameters' values as they are then. The update that makes
// the version current applies only if nothing they depend on changed
// meanwhile (`registrationHolds`, in its WHERE, next to the current
// version it replaces): no schedule parameter it read was set since, and
// no other App took one of its email addresses since. The batch's event
// is stored only if that update applied, and every trigger write only if
// the event was (`storedEvent`): otherwise nothing is written and the
// activation is refused as a conflict, to try again. A batch is one
// transaction, so no other write lands in between.

/** The types of trigger core starts runs for. */
export type TriggerType = (typeof workflowTriggers.$inferSelect)["type"];

type TriggerRow = typeof workflowTriggers.$inferInsert;

/** The email addresses of `rows`. */
const addressesOf = (rows: readonly TriggerRow[]): string[] =>
  rows.flatMap(({ address }) =>
    address === null || address === undefined ? [] : [address]
  );

/**
 * Whether another App's current version receives mail at one of
 * `addresses`.
 */
const takenElsewhere = (
  app: AppId,
  addresses: readonly string[]
) => sql`EXISTS (
  SELECT 1 FROM ${workflowTriggers}
  JOIN ${apps} ON ${apps.id} = ${workflowTriggers.appId}
    AND ${apps.currentVersion} = ${workflowTriggers.version}
  WHERE ${workflowTriggers.type} = 'email'
    AND ${workflowTriggers.appId} <> ${app}
    AND ${inList(workflowTriggers.address, addresses)})`;

/**
 * A schedule parameter's value as a registration read it: the stored JSON
 * text, or null when none was stored and the default applied.
 */
interface ParamRead {
  workflow: WorkflowId;
  param: string;
  stored: string | null;
}

/** An App version's triggers, as rows, and the values they were read from. */
export interface TriggerRegistration {
  rows: TriggerRow[];
  reads: ParamRead[];
}

/**
 * Refuses email triggers at an address another App's current version
 * receives mail at (`workflow.email_taken`): the first App to take an
 * address keeps it, so no App reads mail meant for another. The App's own
 * current version gives its addresses up to the version replacing it. An
 * App that takes one after this check, before the activation's batch,
 * makes that batch change nothing (`registrationHolds`).
 */
const requireFreeAddresses = async (
  env: Env,
  app: AppId,
  rows: readonly TriggerRow[]
): Promise<void> => {
  const addresses = addressesOf(rows);
  if (addresses.length === 0) {
    return;
  }
  const taken = await drizzle(env.DB)
    .select({ address: workflowTriggers.address })
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
        eq(workflowTriggers.type, "email"),
        ne(workflowTriggers.appId, app),
        inList(workflowTriggers.address, addresses)
      )
    )
    .get();
  if (taken) {
    throw workflowErrors.create("workflow.email_taken", {
      address: taken.address,
    });
  }
};

/**
 * The triggers of an App version's workflows (with its `files`), to
 * register if it is made current now: each schedule with the cron
 * expression its parameter holds now, and when it next fires after `now`;
 * each email trigger with its address, which no other App may have; each
 * event trigger with its event type and filter.
 */
export const triggerRegistration = async (
  env: Env,
  app: AppId,
  version: number,
  files: AppFiles,
  now = new Date()
): Promise<TriggerRegistration> => {
  const rows: TriggerRow[] = [];
  const reads: ParamRead[] = [];
  for (const workflow of workflowIdsIn(files)) {
    // oxlint-disable-next-line no-await-in-loop -- one isolate at a time
    const triggers = await declaredTriggers(env, app, version, workflow, files);
    for (const [position, trigger] of triggers.entries()) {
      if (trigger.type === "email") {
        rows.push({
          id: crypto.randomUUID(),
          appId: app,
          version,
          workflowId: workflow,
          position,
          type: "email",
          address: trigger.address,
          createdAt: now,
        });
      }
      if (trigger.type === "event") {
        rows.push({
          id: crypto.randomUUID(),
          appId: app,
          version,
          workflowId: workflow,
          position,
          type: "event",
          event: trigger.event,
          filter: trigger.filter ?? null,
          createdAt: now,
        });
      }
    }
    if (!triggers.some(({ type }) => type === "schedule")) {
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- one isolate at a time
    const params = await declaredParams(env, app, version, workflow, files);
    // One read: the values the cron is worked out from are the ones the
    // batch checks are unchanged (stored as JSON text by params.ts).
    // oxlint-disable-next-line no-await-in-loop -- one read per workflow
    const stored = await valueRows(env, app, workflow);
    const values = valuesOf(params, stored);
    for (const [position, trigger] of triggers.entries()) {
      if (trigger.type === "schedule") {
        const declared = params.find(({ name }) => name === trigger.param);
        const cron = String(values.get(trigger.param) ?? declared?.default);
        const timeZone = trigger.timeZone ?? defaultTimeZone;
        const row = stored.find(({ param }) => param === trigger.param);
        reads.push({
          workflow,
          param: trigger.param,
          stored: row ? JSON.stringify(row.value) : null,
        });
        rows.push({
          id: crypto.randomUUID(),
          appId: app,
          version,
          workflowId: workflow,
          position,
          type: "schedule",
          param: trigger.param,
          cron,
          timeZone,
          nextRunAt: nextScheduledRun({ cron, timeZone }, now) ?? null,
          createdAt: now,
        });
      }
    }
  }
  await requireFreeAddresses(env, app, rows);
  return { rows, reads };
};

/**
 * What a registration registers, for the audit event of the version made
 * current: how many schedules, the addresses it receives mail at, and the
 * event types it starts on.
 */
export const triggerSummary = ({
  rows,
}: TriggerRegistration): Record<string, AuditDetailValue> => ({
  schedules: rows.filter(({ type }) => type === "schedule").length,
  // Each address once, space-separated, cut to what a detail value holds.
  emails: [...new Set(addressesOf(rows))]
    .join(" ")
    .slice(0, identifierMaxLength),
  // Each event type once, the same way.
  events: [
    ...new Set(
      rows.flatMap(({ event }) =>
        event === null || event === undefined ? [] : [event]
      )
    ),
  ]
    .join(" ")
    .slice(0, identifierMaxLength),
});

/** The columns of `workflow_triggers`, in the order an insert names them. */
const triggerColumns = Object.keys(getTableColumns(workflowTriggers));

/**
 * A row as JSON: times as milliseconds, what's missing as null. A new
 * row's schedule has failed no start yet.
 */
const asJson = (row: TriggerRow): Record<string, unknown> =>
  Object.fromEntries(
    triggerColumns.map((column) => {
      const value: unknown = Reflect.get({ failedStarts: 0, ...row }, column);
      return [
        column,
        value instanceof Date ? value.getTime() : (value ?? null),
      ];
    })
  );

/**
 * Inserts `rows` with one bound parameter, their JSON, whatever their
 * number: D1 binds at most 100 values to one statement, and each row has
 * a value per column.
 */
const insertRows = (
  db: DrizzleD1Database,
  rows: readonly TriggerRow[],
  made: SQL
) =>
  db.insert(workflowTriggers).select(
    sql`SELECT ${sql.join(
      triggerColumns.map(
        (column) => sql`json_extract(value, ${`$.${column}`})`
      ),
      sql`, `
    )} FROM json_each(${JSON.stringify(rows.map(asJson))}) WHERE ${made}`
  );

/** Whether the parameter value `read` saw has been set since. */
const setSince = (app: AppId, { workflow, param, stored }: ParamRead) => {
  const value = sql`SELECT 1 FROM ${workflowParamValues}
    WHERE ${workflowParamValues.appId} = ${app}
      AND ${workflowParamValues.workflowId} = ${workflow}
      AND ${workflowParamValues.param} = ${param}`;
  return stored === null
    ? sql`EXISTS (${value})`
    : sql`NOT EXISTS (${value} AND ${workflowParamValues.value} = ${stored})`;
};

/**
 * That what `registration` was worked out from still holds, as SQL for
 * the WHERE of the update that makes its version current: no schedule
 * parameter it read has been set since, and no other App's current
 * version has taken one of its email addresses since.
 */
export const registrationHolds = (
  app: AppId,
  { rows, reads }: TriggerRegistration
): SQL => {
  const addresses = addressesOf(rows);
  return (
    and(
      sql`1`,
      ...reads.map((read) => sql`NOT ${setSince(app, read)}`),
      ...(addresses.length === 0
        ? []
        : [sql`NOT ${takenElsewhere(app, addresses)}`])
    ) ?? sql`1`
  );
};

/**
 * The writes that register version `version` of App `app`'s triggers, for
 * the batch that makes it current, each only if `made` holds (the batch
 * made the version current, `storedEvent` of its event):
 * - the version's rows, in place of any it has (left over, say, by a
 *   release that made versions current without them);
 * - the removal of the triggers of every version that isn't current.
 */
export const registerTriggers = (
  db: DrizzleD1Database,
  app: AppId,
  version: number,
  { rows }: TriggerRegistration,
  made: SQL
) => [
  db
    .delete(workflowTriggers)
    .where(
      and(
        eq(workflowTriggers.appId, app),
        eq(workflowTriggers.version, version),
        made
      )
    ),
  ...(rows.length === 0 ? [] : [insertRows(db, rows, made)]),
  db
    .delete(workflowTriggers)
    .where(
      and(
        eq(workflowTriggers.appId, app),
        sql`${workflowTriggers.version} IS NOT (SELECT ${apps.currentVersion} FROM ${apps} WHERE ${apps.id} = ${app})`,
        made
      )
    ),
];
