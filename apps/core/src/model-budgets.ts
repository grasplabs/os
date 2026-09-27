import type { AuditActor, AuditEntry } from "@grasp-os/shared/audit";
import { errorFields, log } from "@grasp-os/shared/log";
import type { Authority } from "@grasp-os/shared/permissions";
import { and, eq, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { auditedBatch, outboxedWhere } from "./audit-outbox.ts";
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
// threshold or its limit. The addition is one statement per budget, and
// the alert is stored in the same batch only when that addition crossed
// the threshold, so concurrent calls never lose each other's cost, and
// each threshold alerts once a month, whichever call crossed it.
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

/** What `chargeBudgets` runs per budget: the addition, then two alerts. */
const statementsPerBudget = 3;

/** What the addition to a budget returns: its spend now. */
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

/** The budgets the deployment sets that a call made now counts against. */
export const budgetsFor = (
  budgets: Budgets,
  input: BudgetInput,
  now = new Date()
): Budgeted[] => {
  if (budgets === undefined) {
    return [];
  }
  const period = now.toISOString().slice(0, "yyyy-mm".length);
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

const spentOf = (db: ReturnType<typeof drizzle>, budget: Budgeted) =>
  db
    .select({ spent: modelSpend.spentMicros })
    .from(modelSpend)
    .where(
      and(
        eq(modelSpend.scope, budget.scope),
        eq(modelSpend.key, budget.key),
        eq(modelSpend.period, budget.period)
      )
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
    .where(
      or(
        ...budgeted.map(({ scope, key, period }) =>
          and(
            eq(modelSpend.scope, scope),
            eq(modelSpend.key, key),
            eq(modelSpend.period, period)
          )
        )
      )
    );
  return budgeted.find((budget) =>
    rows.some(
      (row) =>
        row.scope === budget.scope &&
        row.key === budget.key &&
        row.spentMicros >= budget.limitMicros
    )
  );
};

/** What admins are alerted to when a budget's spend crosses `threshold`. */
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
  db: ReturnType<typeof drizzle>,
  budget: Budgeted,
  added: number,
  threshold: number
): SQL => {
  const spent = spentOf(db, budget);
  return sql`(${spent}) >= ${threshold} AND (${spent}) - ${added} < ${threshold}`;
};

/**
 * Adds a request's `cost` (US dollars) to each budget it counts against,
 * and alerts admins to each threshold it crossed. Never throws: it runs
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
  // Rounded up, so many small calls never add up to nothing.
  const added = Math.ceil(cost * microsPerDollar);
  const [first, ...rest] = budgeted;
  if (first === undefined || added <= 0) {
    return;
  }
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
      outboxedWhere(
        db,
        alertEntry(trigger, budget, "exhausted"),
        crossed(db, budget, added, budget.limitMicros)
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
  // By the same test the batch stored the alerts by, for the logs.
  for (const [index, budget] of budgeted.entries()) {
    const spent = spentSchema.safeParse(results[index * statementsPerBudget])
      .data?.[0]?.spent;
    for (const [kind, threshold] of [
      ["alert", budget.alertMicros],
      ["exhausted", budget.limitMicros],
    ] as const) {
      if (
        spent !== undefined &&
        spent >= threshold &&
        spent - added < threshold
      ) {
        log.warn(`model.budget_${kind}`, {
          scope: budget.scope,
          period: budget.period,
        });
      }
    }
  }
};
