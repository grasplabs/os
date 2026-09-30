import { appErrors } from "@grasp-os/shared/apps";
import { delegateActorOf } from "@grasp-os/shared/audit";
import { isExpectedError } from "@grasp-os/shared/errors";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { AppId, PermissionId } from "@grasp-os/shared/ids";
import { canonicalJson } from "@grasp-os/shared/json";
import { permissionErrors } from "@grasp-os/shared/permissions";
import type { Authority } from "@grasp-os/shared/permissions";
import {
  isPlatformMeasure,
  statisticErrors,
  statisticMaxApps,
  statisticMaxGroups,
  statisticPointSchema,
  statisticQuerySchema,
  statisticRowsPerDay,
} from "@grasp-os/shared/statistics";
import type {
  PlatformMeasure,
  StatisticAnswer,
  StatisticGroup,
} from "@grasp-os/shared/statistics";
import { runOfStepKey } from "@grasp-os/shared/workflows";
import {
  and,
  asc,
  count,
  eq,
  gte,
  isNull,
  lte,
  max,
  min,
  sql,
  sum,
} from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { z } from "zod";

import { appFor } from "./apps.ts";
import { keepAuditEvent } from "./audit-outbox.ts";
import { memberRole, teamsOf } from "./auth/identity.ts";
import {
  apps as appsTable,
  appStatistics,
  improvementSignalComputations,
  improvementSignals,
  workflowRuns,
} from "./db/core/schema.ts";
import { inList } from "./db/d1.ts";
import { featureEnabled, requireFeature } from "./features.ts";
import { authorize } from "./permissions.ts";

// Statistics (@grasp-os/shared/statistics): an App's server code records
// named measures with a few dimensions, and reads aggregates of them over
// the last days, through its `STATISTICS` stub (app-bindings.ts). Points
// are added up as they come, by the UTC day (`app_statistics`), so a read
// never counts more rows than a day holds for each day it covers.
//
// An App reads its own measures only, with no permission. The platform's
// (`platform.` ones) it reads only under a permission an admin grants it
// (`{ type: "platform" }`, action `statistics`), for one App at a time,
// whose runs the person its call acts for may see added up: an admin, or
// a builder of that App, as for the improvement signals (signals-rpc.ts). They are worked out from the
// platform's own tables as they are read, by their indexes: counts and
// sums, never a run or who started it. Each such read is audited, and
// each refused one with why; an App's reads and points of its own aren't,
// as its own storage isn't. What an App reads here it may show to anyone
// who uses it, even people who can't open the counted App: the grant
// exists to publish these counts company-wide, and the admin's grant
// screen says so before they approve.

/** Days the added-up points are kept: a year's reads, and a margin. */
export const statisticRetentionDays = 400;

/** Rows past the retention one statement of a sweep deletes. */
const sweptPerStatement = 1000;

/** How long one sweep goes on deleting, in milliseconds. */
const sweepBudgetMs = 5000;

const dayMs = 24 * 60 * 60 * 1000;

/** The UTC day of `date`, `YYYY-MM-DD`. */
const dayOf = (date: Date): string => date.toISOString().slice(0, 10);

/** Whether the run of the step `stepKey` hasn't ended. */
const runGoesOn = async (env: Env, stepKey: string): Promise<boolean> => {
  const live = await env.DB.prepare(
    "SELECT 1 FROM workflow_runs WHERE id = ? AND ended_at IS NULL"
  )
    .bind(runOfStepKey(stepKey) ?? "")
    .first();
  return live !== null;
};

/** A workflow run's step, and the attempt of it a point comes from. */
export interface StepAttemptRef {
  /** The step's idempotency key (`stepIdempotencyKey`). */
  key: string;
  /** The attempt, as the run's engine names it. */
  attempt: string;
}

/**
 * Records one point (`statisticPointSchema`) of App `app`'s, on the UTC
 * day of `now`: added to that day's row of its measure and dimensions,
 * one statement. A point that would make a new row once the App has
 * `statisticRowsPerDay` rows that day is refused (`statistics.too_many`);
 * two landing at once may each make the last one, so the bound is that
 * or a few over.
 *
 * A point of a workflow run's step (`step`) isn't added up here: it is
 * kept with its attempt (`app_statistic_steps`), and the points of the
 * attempt that completes the step are added up then, once, by the run's
 * engine (`commitStepStatistics`, statistic-steps.ts). So a step that
 * runs again, after a retry, a replay or a held side effect, counts once,
 * and a step that never completes counts nothing. The day's bound is
 * checked when they are added up, where a point past it is left out; here
 * the call succeeds, and is refused only once one attempt holds as many
 * rows for the App as a day does. Nothing is kept for a run that has
 * ended (a late call of an attempt the engine gave up on): its points
 * can't be added up any more, and the run's rows were deleted as it
 * ended.
 */
export const recordStatistic = async (
  env: Env,
  app: AppId,
  input: unknown,
  { now = new Date(), step }: { now?: Date; step?: StepAttemptRef } = {}
): Promise<void> => {
  requireFeature(env, "statistics");
  const { measure, value, dimensions } = statisticErrors.parse(
    "statistics.invalid",
    statisticPointSchema,
    input
  );
  const day = dayOf(now);
  const key = canonicalJson(dimensions);
  const statement =
    step === undefined
      ? env.DB.prepare(
          `INSERT INTO app_statistics (app_id, measure, day, dimensions, count, sum, min, max)
           SELECT ?1, ?2, ?3, ?4, 1, ?5, ?5, ?5
           WHERE EXISTS (
               SELECT 1 FROM app_statistics
               WHERE app_id = ?1 AND measure = ?2 AND day = ?3 AND dimensions = ?4
             )
             OR (
               SELECT count(*) FROM (
                 SELECT 1 FROM app_statistics WHERE app_id = ?1 AND day = ?3 LIMIT ?6
               )
             ) < ?6
           ON CONFLICT (app_id, measure, day, dimensions) DO UPDATE SET
             count = count + 1,
             sum = sum + excluded.sum,
             min = min(min, excluded.min),
             max = max(max, excluded.max)`
        ).bind(app, measure, day, key, value, statisticRowsPerDay)
      : env.DB.prepare(
          `INSERT INTO app_statistic_steps
             (step_key, attempt, app_id, measure, day, dimensions, count, sum, min, max, committed)
           SELECT ?7, ?8, ?1, ?2, ?3, ?4, 1, ?5, ?5, ?5, 0
           WHERE EXISTS (
               SELECT 1 FROM workflow_runs WHERE id = ?9 AND ended_at IS NULL
             )
             AND (
               EXISTS (
                 SELECT 1 FROM app_statistic_steps
                 WHERE step_key = ?7 AND attempt = ?8 AND app_id = ?1
                   AND measure = ?2 AND day = ?3 AND dimensions = ?4
               )
               OR (
                 SELECT count(*) FROM (
                   SELECT 1 FROM app_statistic_steps
                   WHERE step_key = ?7 AND attempt = ?8 AND app_id = ?1 LIMIT ?6
                 )
               ) < ?6
             )
           ON CONFLICT (step_key, attempt, app_id, measure, day, dimensions) DO UPDATE SET
             count = count + 1,
             sum = sum + excluded.sum,
             min = min(min, excluded.min),
             max = max(max, excluded.max)`
        ).bind(
          app,
          measure,
          day,
          key,
          value,
          statisticRowsPerDay,
          step.key,
          step.attempt,
          runOfStepKey(step.key) ?? ""
        );
  const result = await statement.run();
  if (result.meta.changes === 0) {
    // Nothing kept: for a run that has ended, as it should be.
    if (step !== undefined && !(await runGoesOn(env, step.key))) {
      return;
    }
    throw statisticErrors.create("statistics.too_many", {
      maxRows: statisticRowsPerDay,
    });
  }
};

/** A read, its input checked. */
type Query = z.output<typeof statisticQuerySchema>;

/** A dimension of an App's own point, by name. */
const dimension = (name: string): SQL =>
  sql`json_extract(${appStatistics.dimensions}, ${`$.${name}`})`;

/** The values a row is grouped by, as one JSON array. */
const groupsOf = (grouped: readonly (SQL | SQLiteColumn)[]): SQL<string> =>
  sql<string>`json_array(${sql.join(
    grouped.length === 0 ? [sql`NULL`] : [...grouped],
    sql`, `
  )})`;

/** The values `groupsOf` gave a row. */
const groupValues = (json: string): (string | null)[] => {
  const parsed: unknown = JSON.parse(json);
  return z.array(z.string().nullable()).parse(parsed);
};

/** A group's values, as a query answers them: named, then added up. */
const groupRowSchema = z.object({
  groups: z.array(z.string().nullable()),
  count: z.number(),
  sum: z.number().nullable(),
  min: z.number().nullable(),
  max: z.number().nullable(),
});

/**
 * The groups of `rows` (one past the most, to tell whether it truncated),
 * with each group's dimensions named as `groupBy` names them.
 */
const answerOf = (
  measure: string,
  from: string,
  to: string,
  groupBy: readonly string[],
  rows: readonly z.infer<typeof groupRowSchema>[]
): StatisticAnswer => {
  const groups: StatisticGroup[] = rows
    .slice(0, statisticMaxGroups)
    .map((row) => ({
      dimensions: Object.fromEntries(
        groupBy.map((name, index) => [name, row.groups[index] ?? null])
      ),
      count: row.count,
      sum: row.sum ?? 0,
      min: row.min ?? 0,
      max: row.max ?? 0,
    }));
  return {
    measure,
    from,
    to,
    groups,
    truncated: rows.length > statisticMaxGroups,
  };
};

/** The window of the last `days` UTC days before `now`, today included. */
const windowOf = (now: Date, days: number) => ({
  to: dayOf(now),
  from: dayOf(new Date(now.getTime() - (days - 1) * dayMs)),
});

/** App `app`'s own measure, as `query` asks, over `from` to `to`. */
const ownMeasure = async (
  env: Env,
  app: AppId,
  query: Query,
  from: string,
  to: string
): Promise<StatisticAnswer> => {
  const { measure, where, groupBy } = query;
  const grouped = groupBy.map((name) => dimension(name));
  const rows = await drizzle(env.DB)
    .select({
      groups: groupsOf(grouped),
      count: sql<number>`sum(${appStatistics.count})`,
      sum: sum(appStatistics.sum).mapWith(Number),
      min: min(appStatistics.min),
      max: max(appStatistics.max),
    })
    .from(appStatistics)
    .where(
      and(
        eq(appStatistics.appId, app),
        eq(appStatistics.measure, measure),
        gte(appStatistics.day, from),
        sql`${appStatistics.day} <= ${to}`,
        ...Object.entries(where).map(
          ([name, value]) => sql`${dimension(name)} = ${value}`
        )
      )
    )
    .groupBy(...grouped)
    // Without a group, no points still makes one row: none, then.
    .having(sql`count(*) > 0`)
    // By the groups' values, never their counts: pages stay put.
    .orderBy(...grouped.map((group) => asc(group)))
    .limit(statisticMaxGroups + 1)
    .offset(query.offset);
  return answerOf(
    measure,
    from,
    to,
    groupBy,
    rows.map((row) =>
      groupRowSchema.parse({ ...row, groups: groupValues(row.groups) })
    )
  );
};

/** A column a platform measure's dimension is read from. */
type Columns = Readonly<Record<string, SQLiteColumn>>;

/** The runs of the Apps `apps` started from `start` to `now`, as `query` asks. */
const workflowRunsMeasure = async (
  env: Env,
  apps: readonly string[],
  { where, groupBy, offset }: Query,
  start: Date,
  now: Date
) => {
  const columns: Columns = {
    app: workflowRuns.appId,
    workflow: workflowRuns.workflowId,
  };
  const grouped = groupBy.flatMap((name) => columns[name] ?? []);
  const rows = await drizzle(env.DB)
    .select({
      groups: groupsOf(grouped),
      count: count(),
    })
    .from(workflowRuns)
    .where(
      and(
        inList(workflowRuns.appId, apps),
        where.workflow === undefined
          ? undefined
          : eq(workflowRuns.workflowId, where.workflow),
        gte(workflowRuns.createdAt, start),
        lte(workflowRuns.createdAt, now)
      )
    )
    .groupBy(...grouped)
    // Without a group, no points still makes one row: none, then.
    .having(sql`count(*) > 0`)
    // By the groups' values, never their counts: pages stay put.
    .orderBy(...grouped.map((group) => asc(group)))
    .limit(statisticMaxGroups + 1)
    .offset(offset);
  // Each run is a point of value 1.
  return rows.map(({ groups, count: runs }) => ({
    groups: groupValues(groups),
    count: runs,
    sum: runs,
    min: 1,
    max: 1,
  }));
};

/**
 * The computation of improvement signals started last among those
 * finished by `end` (a read's `until`, or now): one subquery, so every
 * page of a read held at `until` reads the same computation, whatever
 * finishes after it.
 */
const latestFinishedBy = (end: Date): SQL => sql`(
  SELECT ${improvementSignalComputations.id} FROM ${improvementSignalComputations}
  WHERE ${improvementSignalComputations.finishedAt} IS NOT NULL
    AND ${improvementSignalComputations.finishedAt} <= ${end.getTime()}
  ORDER BY ${improvementSignalComputations.startedAt} DESC, ${improvementSignalComputations.id} DESC
  LIMIT 1
)`;

/**
 * The improvement signals of the Apps `apps` of the latest computation,
 * if it started within the window, from `start` to `now`, as `query`
 * asks; none while they are off.
 */
const signalsMeasure = async (
  env: Env,
  apps: readonly string[],
  { where, groupBy, offset }: Query,
  start: Date,
  now: Date
): Promise<{
  rows: z.infer<typeof groupRowSchema>[];
  computation: string | null;
}> => {
  if (!featureEnabled(env, "improvement_signals")) {
    return { rows: [], computation: null };
  }
  const db = drizzle(env.DB);
  // Its computation's start, within the window.
  const inWindow = sql`${improvementSignalComputations.startedAt} >= ${start.getTime()} AND ${improvementSignalComputations.startedAt} <= ${now.getTime()}`;
  const columns: Columns = {
    app: improvementSignals.appId,
    workflow: improvementSignals.workflowId,
    kind: improvementSignals.kind,
  };
  const grouped = groupBy.flatMap((name) => columns[name] ?? []);
  const read = db
    .select({
      groups: groupsOf(grouped),
      count: count(),
      sum: sum(improvementSignals.value).mapWith(Number),
      min: min(improvementSignals.value),
      max: max(improvementSignals.value),
    })
    .from(improvementSignals)
    .where(
      and(
        eq(improvementSignals.computation, latestFinishedBy(now)),
        inList(improvementSignals.appId, apps),
        where.workflow === undefined
          ? undefined
          : eq(improvementSignals.workflowId, where.workflow),
        where.kind === undefined
          ? undefined
          : sql`${improvementSignals.kind} = ${where.kind}`,
        // Its computation's start, within the window, by its primary key.
        sql`EXISTS (SELECT 1 FROM ${improvementSignalComputations} WHERE ${improvementSignalComputations.id} = ${improvementSignals.computation} AND ${inWindow})`
      )
    )
    .groupBy(...grouped)
    // Without a group, no points still makes one row: none, then.
    .having(sql`count(*) > 0`)
    // By the groups' values, never their counts: pages stay put.
    .orderBy(...grouped.map((group) => asc(group)))
    .limit(statisticMaxGroups + 1)
    .offset(offset);
  // The computation it reads, in the same batch as its signals.
  const which = db
    .select({ id: improvementSignalComputations.id })
    .from(improvementSignalComputations)
    .where(
      and(eq(improvementSignalComputations.id, latestFinishedBy(now)), inWindow)
    );
  const [computations, rows] = await db.batch([which, read]);
  return {
    rows: rows.map((row) =>
      groupRowSchema.parse({ ...row, groups: groupValues(row.groups) })
    ),
    computation: computations[0]?.id ?? null,
  };
};

/** Refusals of `appFor` that make one App of many unavailable. */
const unavailableCodes: ReadonlySet<string> = new Set([
  "app.not_found",
  "role.forbidden",
]);

/**
 * Of the Apps `apps`, those whose runs the person `authority` acts for
 * may see added up (an admin, or a builder of it, `appFor`), and the rest,
 * which they may not see or which no longer exist. `permission.person_inactive`
 * for someone no longer a member.
 */
const runsVisible = async (
  env: Env,
  authority: Authority,
  apps: readonly string[]
): Promise<{ visible: string[]; unavailable: string[] }> => {
  const userId = authority.onBehalfOf;
  const role = await memberRole(env.DB, userId);
  if (!role) {
    throw permissionErrors.create("permission.person_inactive");
  }
  if (role === "admin") {
    const rows = await drizzle(env.DB)
      .select({ id: appsTable.id })
      .from(appsTable)
      .where(and(inList(appsTable.id, apps), isNull(appsTable.pendingSince)));
    const existing = new Set(rows.map(({ id }) => id));
    return {
      visible: apps.filter((app) => existing.has(app)),
      unavailable: apps.filter((app) => !existing.has(app)),
    };
  }
  const member = { userId, role, teams: await teamsOf(env.DB, userId) };
  const visible: string[] = [];
  const unavailable: string[] = [];
  for (const app of apps) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- a few Apps, one at a time
      await appFor(env, member, app, "builder");
      visible.push(app);
    } catch (error) {
      if (!isExpectedError(error) || !unavailableCodes.has(error.code)) {
        throw error;
      }
      unavailable.push(app);
    }
  }
  return { visible, unavailable };
};

/**
 * Refuses a read of App `app`'s platform measures for the person
 * `authority` acts for unless they may see its runs added up, as `appFor`
 * does, without saying whether it exists.
 */
const requireRunsVisible = async (
  env: Env,
  authority: Authority,
  app: string
): Promise<void> => {
  const { unavailable } = await runsVisible(env, authority, [app]);
  if (unavailable.length > 0) {
    throw appErrors.create("app.not_found");
  }
};

/** A platform read as its audit event names it. */
interface PlatformRead {
  measure: string;
  /** The App whose measure it reads: none when the read names none. */
  app?: string;
  /** The Apps it reads for in one read (`apps`), as far as they are IDs. */
  apps?: string[];
  /** Of `apps`, those it didn't count (`unavailable`). */
  unavailable?: string[];
  days?: number;
}

/** A read's input, as far as it asks for a platform measure. */
const platformReadSchema = z.looseObject({
  measure: z.string().startsWith("platform."),
  days: z.unknown().optional(),
  where: z.looseObject({ app: z.unknown().optional() }).optional(),
  apps: z.array(z.unknown()).optional(),
});

/**
 * The platform read `input` asks for, as far as it says, valid or not:
 * any measure named `platform.` (an App's own measure never has a dot).
 * Undefined for a read of an App's own measure. Only a known measure and
 * a valid App ID are kept, never other text of the App's.
 */
export const platformReadOf = (input: unknown): PlatformRead | undefined => {
  const parsed = platformReadSchema.safeParse(input);
  if (!parsed.success) {
    return undefined;
  }
  const { measure, days, where, apps } = parsed.data;
  const app = appIdSchema.safeParse(where?.app);
  const named = (apps ?? []).slice(0, statisticMaxApps).flatMap((entry) => {
    const id = appIdSchema.safeParse(entry);
    return id.success ? [id.data] : [];
  });
  return {
    measure: isPlatformMeasure(measure) ? measure : "platform.unknown",
    ...(app.success ? { app: app.data } : {}),
    ...(apps === undefined ? {} : { apps: named }),
    ...(typeof days === "number" && Number.isInteger(days) ? { days } : {}),
  };
};

/**
 * Audits a platform read by App code acting as `authority`: allowed, or
 * refused with why (`refused`, an error's code).
 */
export const auditPlatformRead = async (
  env: Env,
  authority: Authority,
  read: PlatformRead,
  refused?: string
): Promise<void> => {
  await keepAuditEvent(env, drizzle(env.DB), {
    actor: delegateActorOf(authority),
    action: "statistics.read",
    // Every App one read asks for, by ID (at most as many as provenance
    // holds): those it counted, then the `unavailable` ones it didn't.
    ...(read.apps === undefined
      ? {}
      : {
          provenance: [
            ...read.apps.filter(
              (app) => !(read.unavailable ?? []).includes(app)
            ),
            ...(read.unavailable ?? []),
          ],
        }),
    ...(read.app === undefined
      ? {}
      : { target: { type: "app", id: read.app } }),
    detail: {
      measure: read.measure,
      ...(read.apps === undefined ? {} : { apps: read.apps.length }),
      ...(read.unavailable === undefined
        ? {}
        : { unavailable: read.unavailable.length }),
      ...(read.days === undefined ? {} : { days: read.days }),
      onBehalfOf: authority.onBehalfOf,
      ...(refused === undefined ? {} : { refused }),
    },
  });
};

/**
 * Refuses a platform read by App code acting as `authority` unless under
 * the permission `permissionId` (`{ type: "platform" }`, `statistics`),
 * for a person who may see the runs of the one App it reads (`where.app`).
 * Of many (`apps`), the Apps the person may see: the rest are unavailable,
 * and don't refuse it.
 */
const requirePlatformRead = async (
  env: Env,
  authority: Authority,
  permissionId: PermissionId | undefined,
  query: Query
): Promise<{ visible: string[]; unavailable?: string[] }> => {
  if (permissionId === undefined) {
    throw permissionErrors.create("permission.denied", {
      action: "statistics",
    });
  }
  await authorize(
    env,
    authority,
    { type: "platform" },
    "statistics",
    permissionId
  );
  if (query.apps === undefined) {
    const app = query.where.app ?? "";
    await requireRunsVisible(env, authority, app);
    return { visible: [app] };
  }
  return await runsVisible(env, authority, query.apps);
};

/**
 * A platform measure, as `query` asks, for the Apps `apps` (those of the
 * read the person may see), over exactly the last `query.days` × 24 hours
 * before `end`.
 */
const platformMeasure = async (
  env: Env,
  measure: PlatformMeasure,
  query: Query,
  apps: readonly string[],
  end: Date
): Promise<StatisticAnswer> => {
  const start = new Date(end.getTime() - query.days * dayMs);
  if (apps.length === 0) {
    return answerOf(measure, dayOf(start), dayOf(end), query.groupBy, []);
  }
  if (measure === "platform.workflow_runs") {
    const rows = await workflowRunsMeasure(env, apps, query, start, end);
    return answerOf(measure, dayOf(start), dayOf(end), query.groupBy, rows);
  }
  const { rows, computation } = await signalsMeasure(
    env,
    apps,
    query,
    start,
    end
  );
  return {
    ...answerOf(measure, dayOf(start), dayOf(end), query.groupBy, rows),
    computation,
  };
};

/** When a read's window ends: its `until`, but never after `now`. */
const endOf = (query: Query, now: Date): Date =>
  query.until === undefined
    ? now
    : new Date(Math.min(Date.parse(query.until), now.getTime()));

/**
 * Reads statistics (`statisticQuerySchema`) for the App whose code acts as
 * `authority`: a measure of its own, over the last `days` UTC days before
 * `now`, today included; or, under the permission `platform` (its ID), one
 * the platform publishes of an App whose runs the person it acts for may
 * see (see above). A platform measure without it is `permission.denied`.
 * Every platform read is audited, allowed or refused, and why.
 */
export const readStatistics = async (
  env: Env,
  authority: Authority,
  input: unknown,
  platform?: PermissionId,
  now = new Date()
): Promise<StatisticAnswer> => {
  const read = platformReadOf(input);
  if (read === undefined) {
    requireFeature(env, "statistics");
    const query = statisticErrors.parse(
      "statistics.invalid",
      statisticQuerySchema,
      input
    );
    if (authority.subject.type !== "app") {
      throw permissionErrors.create("permission.denied");
    }
    const { from, to } = windowOf(endOf(query, now), query.days);
    return await ownMeasure(env, authority.subject.appId, query, from, to);
  }
  let query: Query;
  let measure: PlatformMeasure;
  let counted: { visible: string[]; unavailable?: string[] };
  try {
    requireFeature(env, "statistics");
    query = statisticErrors.parse(
      "statistics.invalid",
      statisticQuerySchema,
      input
    );
    if (authority.subject.type !== "app" || !isPlatformMeasure(query.measure)) {
      throw permissionErrors.create("permission.denied");
    }
    ({ measure } = query);
    counted = await requirePlatformRead(env, authority, platform, query);
  } catch (error) {
    await auditPlatformRead(
      env,
      authority,
      read,
      isExpectedError(error) ? error.code : "internal.unexpected"
    );
    throw error;
  }
  const { visible, unavailable } = counted;
  await auditPlatformRead(env, authority, {
    ...read,
    days: query.days,
    ...(unavailable === undefined ? {} : { unavailable }),
  });
  const answer = await platformMeasure(
    env,
    measure,
    query,
    visible,
    endOf(query, now)
  );
  return unavailable === undefined ? answer : { ...answer, unavailable };
};

/**
 * Deletes rows past the retention, `sweptPerStatement` at a time, by the
 * index of their day, until none are left or `budgetMs` has passed: what a
 * cron run leaves, the next deletes.
 */
export const sweepStatistics = async (
  env: Env,
  now = new Date(),
  budgetMs = sweepBudgetMs
): Promise<void> => {
  const before = dayOf(
    new Date(now.getTime() - statisticRetentionDays * dayMs)
  );
  const ends = Date.now() + budgetMs;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- one bounded delete after another
    const { meta } = await env.DB.prepare(
      `DELETE FROM app_statistics WHERE rowid IN (
         SELECT rowid FROM app_statistics WHERE day < ? LIMIT ?
       )`
    )
      .bind(before, sweptPerStatement)
      .run();
    if (meta.changes < sweptPerStatement || Date.now() >= ends) {
      return;
    }
  }
};
