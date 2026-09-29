import { z } from "zod";

import { defineErrorFamily } from "./errors.ts";
import { appIdSchema } from "./ids.ts";

// Statistics: named measures an App records from its server code, with a
// few dimensions, and reads back as aggregates over the last days, by the
// UTC day. Each App reads only its own, and, once an admin grants it the
// platform's statistics (a `{ type: "platform" }` permission), the
// measures the platform publishes (`platform.` ones, such as the runs its
// workflows start) of an App whose runs the person it acts for may see:
// counts and sums, never one run in detail. What an App keeps for itself stays in the App (its
// own storage); what the company should remember goes in Knowledge.

/** A measure's name: `invoices_booked`. `platform.` ones are the platform's. */
export const measureNameSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9_]{0,63}$/u,
    "Lowercase letters, digits and _, starting with a letter"
  );

/** Most dimensions one point has. */
export const statisticMaxDimensions = 3;

/** Longest value of one dimension. */
export const dimensionValueMaxLength = 128;

/** A dimension's name: `supplier`. */
export const dimensionNameSchema = z
  .string()
  .regex(
    /^[a-z][A-Za-z0-9_]{0,31}$/u,
    "A letter, then up to 31 letters, digits and _"
  );

/** What one point is recorded against: at most three names and values. */
export const dimensionsSchema = z
  .record(dimensionNameSchema, z.string().min(1).max(dimensionValueMaxLength))
  .refine(
    (dimensions) => Object.keys(dimensions).length <= statisticMaxDimensions,
    { message: `At most ${statisticMaxDimensions} dimensions` }
  )
  .default({});
export type Dimensions = z.infer<typeof dimensionsSchema>;

/** Largest value one point has, either way. */
export const statisticValueMax = 1e12;

/** One point to record: a measure, its value, and its dimensions. */
export const statisticPointSchema = z.strictObject({
  measure: measureNameSchema,
  value: z.number().min(-statisticValueMax).max(statisticValueMax),
  dimensions: dimensionsSchema,
});
export type StatisticPoint = z.input<typeof statisticPointSchema>;

/**
 * Most rows an App's points make in one UTC day: one per measure and
 * distinct dimensions. A point of a new one past it is refused
 * (`statistics.too_many`); points of the day's existing ones still count.
 */
export const statisticRowsPerDay = 1000;

/** Most points one call of an App's method records. */
export const statisticPointsPerCall = 100;

/** Most points an App records in one minute, all its calls together. */
export const statisticPointsPerMinute = 1000;

/** `set` if it is a bound lower than `most`, else `most`. */
const lower = (set: number | undefined, most: number): number =>
  set !== undefined && Number.isInteger(set) && set > 0 && set < most
    ? set
    : most;

/**
 * Most reads one call of an App's method makes: a board page's snapshot
 * makes a few, as one read counts many Apps (`apps`).
 */
export const statisticReadsPerCall = 100;

/** Most reads an App makes in one minute, all its calls together. */
export const statisticReadsPerMinute = 500;

/** What a statistics stub call is: a point recorded, or a read. */
export type StatisticUse = "point" | "read";

/**
 * The bounds on points or reads (`statisticPointsPerCall`,
 * `statisticPointsPerMinute`, `statisticReadsPerCall`,
 * `statisticReadsPerMinute`), or lower ones a test sets as `perCall/
 * perMinute` (core's `STATISTICS_POINT_LIMITS` and
 * `STATISTICS_READ_LIMITS`); never higher.
 */
export const statisticLimitsOf = (
  use: StatisticUse,
  value: string | undefined
): { perCall: number; perMinute: number } => {
  const [perCall, perMinute] = (value ?? "").split("/").map(Number);
  return use === "point"
    ? {
        perCall: lower(perCall, statisticPointsPerCall),
        perMinute: lower(perMinute, statisticPointsPerMinute),
      }
    : {
        perCall: lower(perCall, statisticReadsPerCall),
        perMinute: lower(perMinute, statisticReadsPerMinute),
      };
};

/** Most days one read looks back over, today included. */
export const statisticMaxDays = 366;

/** Most groups one read answers. */
export const statisticMaxGroups = 100;

/**
 * Most Apps one platform read counts (`apps`): as many as its audit event
 * names as provenance, so the log says which Apps each read counted.
 */
export const statisticMaxApps = 100;

/** Furthest into a read's groups a page starts (`offset`). */
export const statisticMaxOffset = 10_000;

/** The measures the platform publishes, and the dimensions of each. */
export const platformMeasures = {
  /**
   * Each run of an App's workflow started, by its App and workflow: a
   * point of value 1, on the day it started.
   */
  "platform.workflow_runs": ["app", "workflow"],
  /**
   * Each improvement signal of the latest daily computation, by its App,
   * workflow and kind: its value (`@grasp-os/shared/signals`), on the day
   * it was computed. Its subject and evidence stay with who may read them.
   */
  "platform.improvement_signals": ["app", "workflow", "kind"],
} as const satisfies Record<string, readonly string[]>;
export type PlatformMeasure = keyof typeof platformMeasures;

/** Whether `measure` is one the platform publishes. */
export const isPlatformMeasure = (
  measure: string
): measure is PlatformMeasure => Object.hasOwn(platformMeasures, measure);

/**
 * What to read: a measure, over the last `days` UTC days up to `until`
 * (now when not given, and never later; that day included; a platform
 * measure over exactly the last `days` × 24 hours before it), only points
 * whose dimensions are `where`, added up by the dimensions in `groupBy`
 * (all together without), the page of groups from `offset` on. Groups are
 * ordered by their values, never by count, so with a fixed `until` pages
 * neither overlap nor skip one as points arrive. A platform measure is
 * read for one App (`where.app`), or for up to `statisticMaxApps` in one
 * read (`apps`, grouped by `app` to tell them apart).
 */
export const statisticQuerySchema = z
  .strictObject({
    measure: z.union([
      measureNameSchema,
      z.enum(["platform.workflow_runs", "platform.improvement_signals"]),
    ]),
    days: z.int().min(1).max(statisticMaxDays),
    where: dimensionsSchema,
    apps: z
      .array(appIdSchema)
      .min(1)
      .max(statisticMaxApps)
      .refine((apps) => new Set(apps).size === apps.length, {
        message: "Each App once",
      })
      .optional(),
    offset: z.int().min(0).max(statisticMaxOffset).default(0),
    until: z.iso.datetime().optional(),
    groupBy: z
      .array(dimensionNameSchema)
      .max(statisticMaxDimensions)
      .default([])
      .refine((names) => new Set(names).size === names.length, {
        message: "Each dimension once",
      }),
  })
  .superRefine(({ measure, where, apps, groupBy }, context) => {
    if (!isPlatformMeasure(measure)) {
      if (apps !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["apps"],
          message: "Only a platform measure is read for Apps",
        });
      }
      return;
    }
    const known: readonly string[] = platformMeasures[measure];
    const oneApp =
      where.app !== undefined && appIdSchema.safeParse(where.app).success;
    if (oneApp === (apps !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["where", "app"],
        message: "A platform measure is read for one App, or for `apps`",
      });
    }
    for (const [index, name] of [...Object.keys(where), ...groupBy].entries()) {
      if (!known.includes(name)) {
        context.addIssue({
          code: "custom",
          path: [index < Object.keys(where).length ? "where" : "groupBy"],
          message: `${measure} has the dimensions ${known.join(", ")}`,
        });
      }
    }
  });
export type StatisticQuery = z.input<typeof statisticQuerySchema>;

/** The points of one group, added up. */
export interface StatisticGroup {
  /** The values of the dimensions it is grouped by. */
  dimensions: Record<string, string | null>;
  count: number;
  sum: number;
  min: number;
  max: number;
}

/** What a read answers. */
export interface StatisticAnswer {
  measure: string;
  /** The first and last UTC day it covers, `YYYY-MM-DD`. */
  from: string;
  to: string;
  /** The groups, by their values, at most `statisticMaxGroups`. */
  groups: StatisticGroup[];
  /** Whether more groups had points than it answers. */
  truncated: boolean;
  /**
   * For a platform read of `apps`: those whose runs the person the read
   * acts for may not see, or that no longer exist, which it doesn't count.
   */
  unavailable?: string[];
  /**
   * For `platform.improvement_signals`: the computation it read (null for
   * none), so a reader of several pages can tell they read the same one.
   */
  computation?: string | null;
}

/** Why recording or reading statistics was refused. */
export const statisticErrors = defineErrorFamily({
  "statistics.invalid": "That isn't a valid statistic or read of one.",
  "statistics.too_many":
    "The App recorded as many different statistics today as a day holds.",
  "statistics.rate_limited":
    "The App recorded or read more statistics than it may in one call or one minute. Try again in a minute.",
});
