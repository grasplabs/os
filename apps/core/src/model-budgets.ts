import type { AuditActor, AuditEntry } from "@grasp-os/shared/audit";
import { errorFields, log } from "@grasp-os/shared/log";
import type { Authority } from "@grasp-os/shared/permissions";
import { and, eq, gte, isNull, ne, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { z } from "zod";

import { auditedBatch, outboxedIfChanged } from "./audit-outbox.ts";
import type { OutboxEnv } from "./audit-outbox.ts";
import { modelSpend } from "./db/core/schema.ts";

// Model budgets, one of the client's rules for model calls (model-rules.ts):
// what the deployment's calls may cost in a UTC month, all together, per
// workflow and per person, in US dollars at the providers' list prices.
// A call's cost is what its provider reported it used (tokens in and out)
// at the prices in the model catalog (models.ts), the same cost its audit
// event records.
//
// Before each request a call sends (a retry too), it is refused once any
// of its budgets is used up: the call stops at 100%. After each request,
// its cost is added to each of its budgets with one statement per budget,
// so concurrent calls never lose each other's cost. Admins are alerted
// when a budget's spend reaches its alert threshold or its limit. Each
// alert is stored with a conditional update that marks the budget's row
// with the threshold value it alerted at, in the batch that reached it:
// so each value alerts once, whichever call reached it, and a threshold
// or limit changed below what was already spent alerts once too, with
// the next call that checks it.
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

/** What marking a budget as alerted returns: its spend, if it marked it. */
const spentSchema = z.array(z.object({ spent: z.number() }));

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

/** The two thresholds a budget alerts at, and the column each is marked in. */
const thresholds = [
  {
    kind: "alert",
    of: (budget: Budgeted) => budget.alertMicros,
    marked: modelSpend.alertedAtMicros,
    field: "alertedAtMicros",
  },
  {
    kind: "exhausted",
    of: (budget: Budgeted) => budget.limitMicros,
    marked: modelSpend.exhaustedAtMicros,
    field: "exhaustedAtMicros",
  },
] as const;
type Threshold = (typeof thresholds)[number];

/** What admins are alerted to when a budget's spend reaches a threshold. */
const alertEntry = (
  trigger: AuditActor,
  budget: Budgeted,
  threshold: Threshold
): AuditEntry => ({
  actor: trigger,
  action: `model.budget.${threshold.kind}`,
  detail: {
    scope: budget.scope,
    period: budget.period,
    limit: budget.limitMicros / microsPerDollar,
    threshold: threshold.of(budget) / microsPerDollar,
    ...budget.names,
  },
});

/**
 * Alerts admins, once per threshold value, that `budget`'s spend has
 * reached `threshold`: marks its row with the value it was reached at, if
 * the spend has reached it and the row isn't marked at that value yet,
 * and stores the alert only if that changed the row. So each value alerts
 * once, whether an addition reached it or it was lowered below what was
 * already spent, and a changed value alerts again once reached.
 */
const alertStatements = (
  db: DrizzleD1Database,
  trigger: AuditActor,
  budget: Budgeted,
  threshold: Threshold
) => {
  const value = threshold.of(budget);
  return [
    db
      .update(modelSpend)
      .set({ [threshold.field]: value })
      .where(
        and(
          rowOf(budget),
          gte(modelSpend.spentMicros, value),
          or(isNull(threshold.marked), ne(threshold.marked, value))
        )
      )
      .returning({ spent: modelSpend.spentMicros }),
    outboxedIfChanged(db, alertEntry(trigger, budget, threshold)),
  ] as const;
};

/** What `alertStatements` runs per threshold. */
const statementsPerThreshold = 2;

/** Logs each alert a batch of `alertStatements` stored. */
const logAlerts = (
  alerted: readonly { budget: Budgeted; threshold: Threshold }[],
  results: readonly unknown[],
  offset: (index: number) => number
): void => {
  for (const [index, { budget, threshold }] of alerted.entries()) {
    const marked = spentSchema.safeParse(results[offset(index)]).data ?? [];
    if (marked.length > 0) {
      log.warn(`model.budget_${threshold.kind}`, {
        scope: budget.scope,
        period: budget.period,
      });
    }
  }
};

/**
 * Checks `budgeted` before a request is sent, in one read: returns the
 * first that is used up, if any. Alerts admins first to every threshold a
 * budget has reached without an alert at its value yet: a threshold or
 * limit lowered below this month's spend, which no addition reached, and
 * every budget used up, not just the one that refuses. Nothing is written
 * while no budget needs an alert; the write, when one does, is the same
 * conditional one an addition runs, so two calls alert once between them.
 * An alert that can't be stored is logged, and the next call tries again.
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
  const rows = await db
    .select()
    .from(modelSpend)
    .where(or(...budgeted.map(rowOf)));
  const rowFor = (budget: Budgeted) =>
    rows.find((row) => row.scope === budget.scope && row.key === budget.key);
  const due = budgeted.flatMap((budget) => {
    const row = rowFor(budget);
    return row === undefined
      ? []
      : thresholds
          .filter(
            (threshold) =>
              row.spentMicros >= threshold.of(budget) &&
              row[threshold.field] !== threshold.of(budget)
          )
          .map((threshold) => ({ budget, threshold }));
  });
  const [first, ...rest] = due;
  if (first !== undefined) {
    const statements = ({
      budget,
      threshold,
    }: {
      budget: Budgeted;
      threshold: Threshold;
    }) => alertStatements(db, trigger, budget, threshold);
    try {
      const results = await auditedBatch(env, db, [
        ...statements(first),
        ...rest.flatMap(statements),
      ]);
      logAlerts(due, results, (index) => index * statementsPerThreshold);
    } catch (error) {
      log.error("model.budget_alert_failed", errorFields(error));
    }
  }
  return budgeted.find(
    (budget) => (rowFor(budget)?.spentMicros ?? 0) >= budget.limitMicros
  );
};

/**
 * Adds a request's `cost` (US dollars) to each budget it counts against,
 * and alerts admins to each threshold it reached. Never throws: it runs
 * after the request was answered and paid for, and a caller that lost
 * the answer would ask (and pay) again. A spend that can't be stored is
 * logged, and the budget counts it short.
 */
export const chargeBudgets = async (
  env: OutboxEnv & Pick<Env, "DB">,
  trigger: AuditActor,
  budgeted: readonly Budgeted[],
  cost: number
): Promise<void> => {
  const [first, ...rest] = budgeted;
  if (first === undefined || !(cost > 0)) {
    return;
  }
  // At least one, so many tiny calls never add up to nothing.
  const added = Math.max(1, Math.round(cost * microsPerDollar));
  const db = drizzle(env.DB);
  const statements = (budget: Budgeted) =>
    [
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
        }),
      ...thresholds.flatMap((threshold) =>
        alertStatements(db, trigger, budget, threshold)
      ),
    ] as const;
  let results: readonly unknown[] = [];
  try {
    results = await auditedBatch(env, db, [
      ...statements(first),
      ...rest.flatMap(statements),
    ]);
  } catch (error) {
    log.error("model.spend_lost", {
      ...errorFields(error),
      micros: added,
      budgets: budgeted.map(({ scope }) => scope).join(" "),
    });
    return;
  }
  const alerted = budgeted.flatMap((budget) =>
    thresholds.map((threshold) => ({ budget, threshold }))
  );
  const perBudget = 1 + thresholds.length * statementsPerThreshold;
  logAlerts(alerted, results, (index) => {
    const budgetIndex = Math.floor(index / thresholds.length);
    const thresholdIndex = index % thresholds.length;
    return (
      budgetIndex * perBudget + 1 + thresholdIndex * statementsPerThreshold
    );
  });
};
