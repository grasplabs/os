import type { AuditActor, AuditEntry } from "@grasp-os/shared/audit";
import { errorFields, log } from "@grasp-os/shared/log";
import type { Authority } from "@grasp-os/shared/permissions";
import { and, eq, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { z } from "zod";

import { auditedBatch, outboxedIfChanged } from "./audit-outbox.ts";
import type { OutboxEnv } from "./audit-outbox.ts";
import { modelBudgetAlerts, modelSpend } from "./db/core/schema.ts";

// Model budgets, one of the client's rules for model calls (model-rules.ts):
// what the deployment's calls may cost in a UTC month, all together, per
// workflow and per person, in US dollars at the providers' list prices.
// A call's cost is what its provider reported it used (tokens in and out)
// at the prices in the model catalog (models.ts), the same cost its audit
// event records.
//
// Before each request a call sends (a retry too), in the month it is
// sent in, it is refused once any of its budgets is used up: the call
// stops at 100%. After each request, its cost is added to each of its
// budgets with one statement per budget, so concurrent calls never lose
// each other's cost. Admins are alerted when a budget's spend reaches its
// alert threshold or its limit, once per month and threshold value: the
// alert is a row in `model_budget_alerts`, keyed by that value and
// inserted only if the spend has reached it and the row isn't there yet,
// and its event is stored only if the insert added the row, in the same
// batch. It runs with every addition, and before each request for a
// budget whose spend has reached a value with no alert yet. So whichever
// call reaches a value, however many run at once, and in whatever order
// the config changes a threshold, each value alerts once a month.
//
// A budget is only checked before a call, whose cost isn't known until it
// is answered: calls already under way when the budget runs out still
// finish, and are counted, so a month's spend can pass its limit by what
// those calls cost.
//
// The alert is an audit event (`model.budget.alert` and
// `model.budget.exhausted`) that admins find in the audit log, and a log
// line: there is no other path to admins yet.

/** Millionths of a US dollar, which the spend is counted in. */
const microsPerDollar = 1_000_000;

const budgetSchema = z.strictObject({
  /** US dollars a month: a cent at least, and well within an integer. */
  limit: z.number().min(0.01).max(1_000_000_000),
  /** The percent of the limit at which admins are alerted. */
  alertAt: z.int().min(1).max(99).default(80),
});

/** The budgets' part of the gateway config. */
export const budgetsSchema = z
  .strictObject({
    /** All the deployment's calls together. */
    deployment: budgetSchema.optional(),
    /** Each workflow's AI steps, each workflow on its own. */
    workflow: budgetSchema.optional(),
    /** The calls made by or for each person, each on their own. */
    user: budgetSchema.optional(),
  })
  .optional();
type Budgets = z.output<typeof budgetsSchema>;

/** Whose spend a budget counts. */
export type BudgetScope = "deployment" | "workflow" | "user";

/** One budget a call counts against, this month. */
export interface Budgeted {
  scope: BudgetScope;
  /** What it counts within its scope: the deployment, a workflow, a person. */
  key: string;
  /** The UTC month the call was made in, such as `2026-09`. */
  period: string;
  limitMicros: number;
  alertMicros: number;
  /** What its alerts name, as audit detail: the workflow or the person. */
  names: Record<string, string>;
}

/** What budgets count a call by. */
export interface BudgetInput {
  trigger: AuditActor;
  work?: { authority: Authority };
}

/** The person a call is made by or for, if any. */
const personOf = ({ trigger, work }: BudgetInput): string | undefined => {
  if (trigger.type === "person" || trigger.type === "staff") {
    return trigger.userId;
  }
  if (trigger.type === "agent") {
    return trigger.onBehalfOf;
  }
  return work?.authority.onBehalfOf;
};

const monthPattern = /^\d{4}-(?:0[1-9]|1[0-2])$/u;

/**
 * The UTC month budgets count in now, such as `2026-09`; tests set it
 * with `MODEL_BUDGET_MONTH`.
 */
export const budgetMonth = (
  env: Pick<Env, "MODEL_BUDGET_MONTH">,
  now = new Date()
): string =>
  env.MODEL_BUDGET_MONTH !== undefined &&
  monthPattern.test(env.MODEL_BUDGET_MONTH)
    ? env.MODEL_BUDGET_MONTH
    : now.toISOString().slice(0, "yyyy-mm".length);

/** The budgets the deployment sets that a call counts against in `period`. */
export const budgetsFor = (
  budgets: Budgets,
  input: BudgetInput,
  period: string
): Budgeted[] => {
  if (budgets === undefined) {
    return [];
  }
  const { trigger } = input;
  const person = personOf(input);
  const scopes: {
    scope: BudgetScope;
    key: string;
    names: Record<string, string>;
  }[] = [
    { scope: "deployment", key: "deployment", names: {} },
    ...(trigger.type === "workflow"
      ? [
          {
            scope: "workflow" as const,
            key: JSON.stringify([trigger.appId, trigger.workflowId]),
            names: { app: trigger.appId, workflow: trigger.workflowId },
          },
        ]
      : []),
    ...(person === undefined
      ? []
      : [{ scope: "user" as const, key: person, names: { user: person } }]),
  ];
  return scopes.flatMap(({ scope, key, names }) => {
    const budget = budgets[scope];
    if (budget === undefined) {
      return [];
    }
    const limitMicros = Math.round(budget.limit * microsPerDollar);
    return [
      {
        scope,
        key,
        period,
        limitMicros,
        alertMicros: Math.ceil((limitMicros * budget.alertAt) / 100),
        names,
      },
    ];
  });
};

/** The row that counts `budget`'s spend this month. */
const rowOf = (budget: Budgeted) =>
  and(
    eq(modelSpend.scope, budget.scope),
    eq(modelSpend.key, budget.key),
    eq(modelSpend.period, budget.period)
  );

/** The alerts `budget` got this month. */
const alertsOf = (budget: Budgeted) =>
  and(
    eq(modelBudgetAlerts.scope, budget.scope),
    eq(modelBudgetAlerts.key, budget.key),
    eq(modelBudgetAlerts.period, budget.period)
  );

/** The two thresholds a budget alerts at. */
const thresholds = [
  { kind: "alert", of: (budget: Budgeted) => budget.alertMicros },
  { kind: "exhausted", of: (budget: Budgeted) => budget.limitMicros },
] as const;
type Threshold = (typeof thresholds)[number];

/** One alert a budget may be due. */
interface Due {
  budget: Budgeted;
  threshold: Threshold;
}

/** What admins are alerted to when a budget's spend reaches a threshold. */
const alertEntry = (trigger: AuditActor, { budget, threshold }: Due) =>
  ({
    actor: trigger,
    action: `model.budget.${threshold.kind}`,
    detail: {
      scope: budget.scope,
      period: budget.period,
      limit: budget.limitMicros / microsPerDollar,
      threshold: threshold.of(budget) / microsPerDollar,
      ...budget.names,
    },
  }) satisfies AuditEntry;

/**
 * Alerts admins that a budget's spend has reached a threshold, once per
 * month and threshold value: records the alert in `model_budget_alerts`
 * if the spend has reached the value, and stores its event only if that
 * added the row. The row's key is the value, so a threshold lowered below
 * what was already spent alerts once, and changing it back and forth
 * never alerts twice for one value.
 */
const alertStatements = (
  db: DrizzleD1Database,
  trigger: AuditActor,
  due: Due
) => {
  const { budget, threshold } = due;
  const value = threshold.of(budget);
  const spent = db
    .select({ spent: modelSpend.spentMicros })
    .from(modelSpend)
    .where(rowOf(budget));
  return [
    db
      .insert(modelBudgetAlerts)
      .select(
        sql`SELECT ${budget.scope}, ${budget.key}, ${budget.period}, ${threshold.kind}, ${value} WHERE (${spent}) >= ${value}`
      )
      .onConflictDoNothing()
      .returning({
        kind: modelBudgetAlerts.kind,
        scope: modelBudgetAlerts.scope,
        period: modelBudgetAlerts.period,
      }),
    outboxedIfChanged(db, alertEntry(trigger, due)),
  ] as const;
};

/** An alert `alertStatements` recorded, as its insert returns it. */
const recordedSchema = z.array(
  z.object({ kind: z.string(), scope: z.string(), period: z.string() })
);

/** Logs each alert a batch's `alertStatements` recorded. */
const logAlerts = (results: readonly unknown[]): void => {
  for (const result of results) {
    for (const { kind, scope, period } of recordedSchema.safeParse(result)
      .data ?? []) {
      log.warn(`model.budget_${kind}`, { scope, period });
    }
  }
};

/** Every alert `budgeted` may be due. */
const everyAlert = (budgeted: readonly Budgeted[]): Due[] =>
  budgeted.flatMap((budget) =>
    thresholds.map((threshold) => ({ budget, threshold }))
  );

/**
 * Checks `budgeted` before a request is sent: returns the first that is
 * used up, if any. Alerts admins first to every threshold a budget has
 * reached without an alert at that value this month: a threshold or limit
 * lowered below this month's spend, which no addition reached, and every
 * budget used up, not just the one that refuses. Nothing is written while
 * none is due; the write, when one is, is the same conditional insert an
 * addition runs, so two calls alert once between them. An alert that
 * can't be stored is logged, and the next call tries again.
 */
export const checkBudgets = async (
  env: OutboxEnv & Pick<Env, "DB">,
  trigger: AuditActor,
  budgeted: readonly Budgeted[]
): Promise<Budgeted | undefined> => {
  if (budgeted.length === 0) {
    return undefined;
  }
  const db = drizzle(env.DB);
  const [spends, alerts] = await Promise.all([
    db
      .select()
      .from(modelSpend)
      .where(or(...budgeted.map(rowOf))),
    db
      .select()
      .from(modelBudgetAlerts)
      .where(or(...budgeted.map(alertsOf))),
  ]);
  const spentOn = (budget: Budgeted): number =>
    spends.find((row) => row.scope === budget.scope && row.key === budget.key)
      ?.spentMicros ?? 0;
  const due = everyAlert(budgeted).filter(
    ({ budget, threshold }) =>
      spentOn(budget) >= threshold.of(budget) &&
      !alerts.some(
        (row) =>
          row.scope === budget.scope &&
          row.key === budget.key &&
          row.kind === threshold.kind &&
          row.thresholdMicros === threshold.of(budget)
      )
  );
  const [head, ...rest] = due.flatMap((one) =>
    alertStatements(db, trigger, one)
  );
  if (head !== undefined) {
    try {
      logAlerts(await auditedBatch(env, db, [head, ...rest]));
    } catch (error) {
      log.error("model.budget_alert_failed", errorFields(error));
    }
  }
  return budgeted.find((budget) => spentOn(budget) >= budget.limitMicros);
};

/**
 * Adds a request's `cost` (US dollars) to each budget it counts against,
 * and alerts admins to each threshold it reached, in one batch. Never
 * throws: it runs after the request was answered and paid for, and a
 * caller that lost the answer would ask (and pay) again. A spend that
 * can't be stored is logged, and the budget counts it short.
 */
export const chargeBudgets = async (
  env: OutboxEnv & Pick<Env, "DB">,
  trigger: AuditActor,
  budgeted: readonly Budgeted[],
  cost: number
): Promise<void> => {
  if (budgeted.length === 0 || !(cost > 0)) {
    return;
  }
  // At least one, so many tiny calls never add up to nothing.
  const added = Math.max(1, Math.round(cost * microsPerDollar));
  const db = drizzle(env.DB);
  const additions = budgeted.map((budget) =>
    db
      .insert(modelSpend)
      .values({
        scope: budget.scope,
        key: budget.key,
        period: budget.period,
        spentMicros: added,
      })
      .onConflictDoUpdate({
        target: [modelSpend.scope, modelSpend.key, modelSpend.period],
        set: {
          spentMicros: sql`${modelSpend.spentMicros} + excluded.spent_micros`,
        },
      })
  );
  const statements = [
    ...additions,
    ...everyAlert(budgeted).flatMap((due) => alertStatements(db, trigger, due)),
  ];
  const [head, ...rest] = statements;
  if (head === undefined) {
    return;
  }
  let results: readonly unknown[] = [];
  try {
    results = await auditedBatch(env, db, [head, ...rest]);
  } catch (error) {
    log.error("model.spend_lost", {
      ...errorFields(error),
      micros: added,
      budgets: budgeted.map(({ scope }) => scope).join(" "),
    });
    return;
  }
  logAlerts(results);
};
