import type { AuditActor, AuditEntry } from "@grasp-os/shared/audit";
import { errorFields, log } from "@grasp-os/shared/log";
import type { Authority } from "@grasp-os/shared/permissions";
import { and, eq, gte, isNull, ne, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { z } from "zod";

import {
  auditedBatch,
  outboxedIfChanged,
  outboxedWhere,
} from "./audit-outbox.ts";
import type { OutboxEnv } from "./audit-outbox.ts";
import { modelSpend } from "./db/core/schema.ts";

// Model budgets, one of the client's rules for model calls (model-rules.ts):
// what the deployment's calls may cost in a UTC month, all together, per
// workflow and per person, in US dollars at the providers' list prices.
// A call's cost is what its provider reported it used (tokens in and out)
// at the prices in the model catalog (models.ts), the same cost its audit
// event records.
//
// Before a call is sent, it is refused once any of its budgets is used up:
// the call stops at 100%. After each request, its cost is added to each of
// its budgets, and admins are alerted when that crosses the budget's alert
// threshold or reaches its limit. The addition is one statement per
// budget, and each alert is stored in the same batch only by the addition
// that crossed its threshold, so concurrent calls never lose each other's
// cost, and each threshold alerts once a month, whichever call crossed
// it. The limit's alert is marked on the row with the limit it was for:
// a limit lowered below what was already spent alerts once too, with the
// first call it refuses, and a raised one alerts again when reached.
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

/**
 * What `chargeBudgets` runs per budget: the addition, the alert, and the
 * two of `exhaustedStatements`.
 */
const statementsPerBudget = 4;

/** What an addition to a budget, or marking it used up, returns. */
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

/** The first of `budgeted` that is used up, if any: one query. */
export const usedUpBudget = async (
  env: Pick<Env, "DB">,
  budgeted: readonly Budgeted[]
): Promise<Budgeted | undefined> => {
  if (budgeted.length === 0) {
    return undefined;
  }
  const rows = await drizzle(env.DB)
    .select()
    .from(modelSpend)
    .where(or(...budgeted.map(rowOf)));
  return budgeted.find((budget) =>
    rows.some(
      (row) =>
        row.scope === budget.scope &&
        row.key === budget.key &&
        row.spentMicros >= budget.limitMicros
    )
  );
};

/** What admins are alerted to when a budget's spend reaches `threshold`. */
const alertEntry = (
  trigger: AuditActor,
  budget: Budgeted,
  kind: "alert" | "exhausted"
): AuditEntry => ({
  actor: trigger,
  action: `model.budget.${kind}`,
  detail: {
    scope: budget.scope,
    period: budget.period,
    limit: budget.limitMicros / microsPerDollar,
    threshold:
      (kind === "alert" ? budget.alertMicros : budget.limitMicros) /
      microsPerDollar,
    ...budget.names,
  },
});

/**
 * Whether the batch's addition of `added` to `budget` took its spend from
 * below `threshold` to it or past it: read in the same batch, right after
 * the addition, so only the call whose addition crossed it sees it.
 */
const crossed = (
  db: DrizzleD1Database,
  budget: Budgeted,
  added: number,
  threshold: number
): SQL => {
  const spent = db
    .select({ spent: modelSpend.spentMicros })
    .from(modelSpend)
    .where(rowOf(budget));
  return sql`(${spent}) >= ${threshold} AND (${spent}) - ${added} < ${threshold}`;
};

/**
 * Alerts admins, once per limit, that `budget` is used up: marks its row
 * with the limit it was used up at, if it is used up and isn't marked at
 * that limit yet, and stores the alert only if that changed the row. So
 * the alert comes once whether an addition reached the limit or the limit
 * was lowered below what was already spent, and again only for a new
 * limit.
 */
const exhaustedStatements = (
  db: DrizzleD1Database,
  trigger: AuditActor,
  budget: Budgeted
) =>
  [
    db
      .update(modelSpend)
      .set({ exhaustedAtMicros: budget.limitMicros })
      .where(
        and(
          rowOf(budget),
          gte(modelSpend.spentMicros, budget.limitMicros),
          or(
            isNull(modelSpend.exhaustedAtMicros),
            ne(modelSpend.exhaustedAtMicros, budget.limitMicros)
          )
        )
      )
      .returning({ spent: modelSpend.spentMicros }),
    outboxedIfChanged(db, alertEntry(trigger, budget, "exhausted")),
  ] as const;

/** Logs the alert `exhaustedStatements` stored, if its marking changed a row. */
const logExhausted = (budget: Budgeted, marked: unknown): void => {
  if ((spentSchema.safeParse(marked).data ?? []).length > 0) {
    log.warn("model.budget_exhausted", {
      scope: budget.scope,
      period: budget.period,
    });
  }
};

/**
 * Alerts admins that `budget`, which just refused a call, is used up,
 * unless they were already for its limit: for a limit lowered below this
 * month's spend, which no addition reached. Never throws: the call is
 * refused either way.
 */
export const noteUsedUp = async (
  env: OutboxEnv & Pick<Env, "DB">,
  trigger: AuditActor,
  budget: Budgeted
): Promise<void> => {
  const db = drizzle(env.DB);
  try {
    const [marked] = await auditedBatch(
      env,
      db,
      exhaustedStatements(db, trigger, budget)
    );
    logExhausted(budget, marked);
  } catch (error) {
    log.error("model.budget_note_failed", errorFields(error));
  }
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
        })
        .returning({ spent: modelSpend.spentMicros }),
      outboxedWhere(
        db,
        alertEntry(trigger, budget, "alert"),
        crossed(db, budget, added, budget.alertMicros)
      ),
      ...exhaustedStatements(db, trigger, budget),
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
  for (const [index, budget] of budgeted.entries()) {
    const at = index * statementsPerBudget;
    // By the same test the batch stored the alert by.
    const spent = spentSchema.safeParse(results[at]).data?.[0]?.spent;
    if (
      spent !== undefined &&
      spent >= budget.alertMicros &&
      spent - added < budget.alertMicros
    ) {
      log.warn("model.budget_alert", {
        scope: budget.scope,
        period: budget.period,
      });
    }
    logExhausted(budget, results[at + 2]);
  }
};
