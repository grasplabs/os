import { collectionIdSchema, runIdSchema } from "@grasp-os/shared/ids";
import type { Json } from "@grasp-os/shared/json";
import { log } from "@grasp-os/shared/log";
import { signalWindowDays } from "@grasp-os/shared/signals";
import type { ImprovementSignal, SignalKind } from "@grasp-os/shared/signals";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  lt,
  sql,
} from "drizzle-orm";
import type { SQL, SQLWrapper } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";

import { auditedBatch, outboxedIfChanged } from "./audit-outbox.ts";
import {
  claimComputation,
  claimedBefore,
  finishComputation,
  isFinished,
  latestFinished,
  newComputation,
  unfinishedBefore,
} from "./daily-claims.ts";
import type { Computation } from "./daily-claims.ts";
import {
  improvementSignalComputations as computations,
  improvementSignals,
  workflowDecisions,
  workflowRuns,
} from "./db/core/schema.ts";
import { chunks, inList } from "./db/d1.ts";
import { featureEnabled } from "./features.ts";
import { collectionsPerQuestion } from "./signal-tally.ts";
import type { SignalTally } from "./signal-tally.ts";
import { auditableCode } from "./workflows/host.ts";

// Improvement signals, level 1: where to look to improve the Apps'
// workflows (@grasp-os/shared/signals has what each one means). Each is a
// query over runs and decisions (the core database) and the audit log
// (model calls' cost, Knowledge searches that found nothing), over the
// last `signalWindowDays` days.
//
// They're computed once a UTC day and kept in `improvement_signals`, so
// reading them is a few indexed queries. The first run of the 15-minute
// cron trigger of a day that claims it (src/daily-claims.ts) computes
// them, reading the audit log in the same pass as Knowledge's usage
// signals (src/daily-signals.ts).
//
// A computation writes its signals under its own ID, in as many batches
// as they take, and then finishes in one batch: it marks itself finished
// and deletes every computation started before it, with their signals.
// Readers take the finished computation started last, in the same batch
// as its signals, so they see one computation whole or the one before
// it. A computation that outlived its lease and was finished past has
// lost its row: its next write of signals fails on the foreign key, and
// its finishing batch changes nothing, as every statement in it goes by
// its row (the update finds none, so no audit event, and the deletes run
// only once it is marked finished).
// Computing again is idempotent: another row, the same signals.
//
// Every App and workflow is covered, reading all of their runs and
// decisions a page at a time. Only unanswered questions are capped, at the
// most asked `questionsPerScope` of each App's workflow (and of the
// deployment's), as a search's words make a key of their own. Evidence
// holds IDs and counts only (a few rows' worth each), well within D1's
// row limit.

const dayMs = 24 * 60 * 60 * 1000;

/**
 * The subject of a workflow's waits for single people, added up; no
 * decision's deciders are ever just `person`.
 */
export const peopleSubject = "person";

/**
 * The finished computation started last, whose signals are the current
 * ones: read in the same batch as them, so one finishing meanwhile can't
 * empty them.
 */
export const latestComputation = latestFinished(computations);

/** Rows one read of runs or decisions returns. */
const pageRows = 500;

/** The runs, decisions or costliest runs a signal names as evidence. */
const samples = 5;

/** The most unanswered questions kept for each App workflow, or the deployment. */
const questionsPerScope = 20;

/** Signals one insert writes: 7 columns each, within D1's 100 parameters. */
const rowsPerInsert = 14;

/** Inserts one batch writes. */
const insertsPerBatch = 50;

/** Statuses of a run that hasn't ended. */
const unended: (typeof workflowRuns.$inferSelect)["status"][] = [
  "starting",
  "running",
  "paused",
];

/** One signal as it is stored: `app_id` and `workflow_id` empty for none. */
interface SignalRow {
  kind: SignalKind;
  appId: string;
  workflowId: string;
  subject: string;
  value: number;
  evidence: Json;
}

type EvidenceOf<Kind extends SignalKind> = Extract<
  ImprovementSignal,
  { kind: Kind }
>["evidence"];

/** A row, with its evidence checked against its kind's at compile time. */
const signalRow = <Kind extends SignalKind>(
  kind: Kind,
  where: { appId: string; workflowId: string; subject: string },
  value: number,
  evidence: EvidenceOf<Kind>
): SignalRow => ({ kind, ...where, value, evidence });

/** An App's workflow, as a map key. */
export const workflowKey = (appId: string, workflowId: string): string =>
  JSON.stringify([appId, workflowId]);

/** Money rounded to millionths of a dollar, as model spend is counted. */
const dollars = (amount: number): number => Math.round(amount * 1e6) / 1e6;

/**
 * A step's name without the key of a keyed step or the part of a
 * decision (`review:<key>#ask`), whose key can come from what the run
 * read; empty for none, or a name that isn't one.
 */
const stepName = (step: string | null): string =>
  /^[A-Za-z][\w-]{0,63}(?=$|[:#])/u.exec(step ?? "")?.[0] ?? "";

/** The entries of `counts`, most first, then by name. */
const mostFirst = (counts: ReadonlyMap<string, number>) =>
  [...counts].toSorted(([a, x], [b, y]) => y - x || a.localeCompare(b));

/**
 * Reads every row `read` finds, a page at a time: `read` is given the last
 * row of the page before, and returns the rows after it, in its order.
 */
const eachPage = async <Row>(
  read: (after: Row | undefined) => Promise<Row[]>,
  each: (row: Row) => void
): Promise<void> => {
  let after: Row | undefined;
  for (;;) {
    // One page after another: each starts where the last ended.
    // oxlint-disable-next-line no-await-in-loop
    const rows = await read(after);
    for (const row of rows) {
      each(row);
    }
    if (rows.length < pageRows) {
      return;
    }
    after = rows.at(-1);
  }
};

/** Rows after `after` in `(at, id)` order, ascending or descending. */
const pastCursor = (
  at: SQLWrapper,
  id: SQLWrapper,
  after: { at: Date; id: string } | undefined,
  order: "asc" | "desc"
): SQL | undefined => {
  if (after === undefined) {
    return undefined;
  }
  return order === "asc"
    ? sql`(${at}, ${id}) > (${after.at.getTime()}, ${after.id})`
    : sql`(${at}, ${id}) < (${after.at.getTime()}, ${after.id})`;
};

/**
 * Each workflow's decisions that wait for one person (`person:<id>`), as
 * one signal whose subject is `person`: the people added up, valued at the
 * longest wait. An App's builders read it instead of the per-person
 * signals, which name the people (signals-rpc.ts); admins read those.
 */
const waitingForPeople = (
  groups: readonly {
    appId: string;
    workflowId: string;
    deciders: string;
    open: number;
    oldest: { openedAt: string }[];
  }[],
  waited: (oldest: { openedAt: string }[]) => number
): SignalRow[] => {
  const people = groups.filter(({ deciders }) =>
    deciders.startsWith("person:")
  );
  const workflows = Map.groupBy(people, ({ appId, workflowId }) =>
    workflowKey(appId, workflowId)
  );
  return [...workflows.values()].flatMap((group) => {
    const [first] = group;
    if (first === undefined) {
      return [];
    }
    return [
      signalRow(
        "waiting_for_person",
        {
          appId: first.appId,
          workflowId: first.workflowId,
          subject: peopleSubject,
        },
        Math.max(...group.map(({ oldest }) => waited(oldest))),
        { open: group.reduce((sum, { open }) => sum + open, 0) }
      ),
    ];
  });
};

/**
 * Runs waiting longest for a person: each workflow's open decisions, by
 * the deciders they're from, valued at how long the oldest has waited.
 */
const waitingSignals = async (
  db: DrizzleD1Database,
  now: Date
): Promise<SignalRow[]> => {
  const groups = new Map<
    string,
    {
      appId: string;
      workflowId: string;
      deciders: string;
      open: number;
      oldest: NonNullable<EvidenceOf<"waiting_for_person">["oldest"]>;
    }
  >();
  await eachPage(
    async (after: { id: string; openedAt: Date } | undefined) =>
      await db
        .select({
          id: workflowDecisions.id,
          runId: workflowDecisions.runId,
          step: workflowDecisions.step,
          deciders: workflowDecisions.deciders,
          openedAt: workflowDecisions.openedAt,
          appId: workflowRuns.appId,
          workflowId: workflowRuns.workflowId,
        })
        .from(workflowDecisions)
        .innerJoin(workflowRuns, eq(workflowRuns.id, workflowDecisions.runId))
        // Every decision still open, however long ago it opened: not only
        // the window's. This is a snapshot of who is waited for now, and a
        // decision open for months is the worst wait there is, the one
        // this signal is for; cutting it off at the window would hide it.
        // Open decisions are bounded by the runs still waiting on them.
        .where(
          and(
            eq(workflowDecisions.status, "open"),
            gt(workflowDecisions.expiresAt, now),
            inArray(workflowRuns.status, unended),
            pastCursor(
              workflowDecisions.openedAt,
              workflowDecisions.id,
              after && { at: after.openedAt, id: after.id },
              "asc"
            )
          )
        )
        .orderBy(asc(workflowDecisions.openedAt), asc(workflowDecisions.id))
        .limit(pageRows),
    (row) => {
      const key = JSON.stringify([row.appId, row.workflowId, row.deciders]);
      const group = groups.get(key) ?? {
        appId: row.appId,
        workflowId: row.workflowId,
        deciders: row.deciders,
        open: 0,
        oldest: [],
      };
      group.open += 1;
      // Read oldest first, so the first are the oldest.
      if (group.oldest.length < samples) {
        group.oldest.push({
          decision: row.id,
          run: runIdSchema.parse(row.runId),
          step: stepName(row.step),
          openedAt: row.openedAt.toISOString(),
        });
      }
      groups.set(key, group);
    }
  );
  const waited = (oldest: { openedAt: string }[]): number =>
    now.getTime() - Date.parse(oldest[0]?.openedAt ?? now.toISOString());
  const rows = [...groups.values()].map(
    ({ appId, workflowId, deciders, open, oldest }) =>
      signalRow(
        "waiting_for_person",
        { appId, workflowId, subject: deciders },
        waited(oldest),
        { open, oldest }
      )
  );
  return [...rows, ...waitingForPeople([...groups.values()], waited)];
};

/** An App workflow's runs started in the window. */
interface Started {
  appId: string;
  workflowId: string;
  runs: number;
}

/** How many runs of each App workflow started since `from`. */
const runsSince = async (
  db: DrizzleD1Database,
  from: Date
): Promise<Map<string, Started>> => {
  const rows = await db
    .select({
      appId: workflowRuns.appId,
      workflowId: workflowRuns.workflowId,
      runs: count(),
    })
    .from(workflowRuns)
    .where(gte(workflowRuns.createdAt, from))
    .groupBy(workflowRuns.appId, workflowRuns.workflowId);
  return new Map(
    rows.map((row) => [workflowKey(row.appId, row.workflowId), row])
  );
};

/**
 * Of the runs `ids`, those started before `from`: looked up by ID, a page
 * at a time. Only runs that made model calls in the window are asked
 * about, which the audit tally holds already, so this holds no more.
 */
const startedBefore = async (
  db: DrizzleD1Database,
  from: Date,
  ids: readonly string[]
): Promise<Set<string>> => {
  const before = new Set<string>();
  for (let start = 0; start < ids.length; start += pageRows) {
    // One page after another, so a large tally never floods D1.
    // oxlint-disable-next-line no-await-in-loop
    const found = await db
      .select({ id: workflowRuns.id })
      .from(workflowRuns)
      .where(
        and(
          inList(workflowRuns.id, ids.slice(start, start + pageRows)),
          lt(workflowRuns.createdAt, from)
        )
      );
    for (const { id } of found) {
      before.add(id);
    }
  }
  return before;
};

/**
 * Steps failing most: runs that failed since `from`, by the step they
 * stopped at (empty for none), with their error codes. Only the step's
 * name and the error's code, never its message or the step's input.
 */
const failingSignals = async (
  db: DrizzleD1Database,
  from: Date,
  runs: ReadonlyMap<string, Started>
): Promise<SignalRow[]> => {
  const groups = new Map<
    string,
    {
      appId: string;
      workflowId: string;
      step: string;
      failures: number;
      codes: Map<string, number>;
      recent: NonNullable<EvidenceOf<"failing_step">["recent"]>;
    }
  >();
  const endedAt = sql<number>`${workflowRuns.endedAt}`;
  await eachPage(
    async (after: { id: string; endedAt: Date | null } | undefined) =>
      await db
        .select({
          id: workflowRuns.id,
          appId: workflowRuns.appId,
          workflowId: workflowRuns.workflowId,
          endedAt: workflowRuns.endedAt,
          step: sql<
            string | null
          >`json_extract(${workflowRuns.failure}, '$.step')`,
          code: sql<
            string | null
          >`json_extract(${workflowRuns.failure}, '$.error.code')`,
        })
        .from(workflowRuns)
        .where(
          and(
            eq(workflowRuns.status, "failed"),
            gte(workflowRuns.endedAt, from),
            pastCursor(
              endedAt,
              workflowRuns.id,
              after?.endedAt ? { at: after.endedAt, id: after.id } : undefined,
              "desc"
            )
          )
        )
        .orderBy(desc(workflowRuns.endedAt), desc(workflowRuns.id))
        .limit(pageRows),
    (row) => {
      const step = stepName(row.step);
      const key = JSON.stringify([row.appId, row.workflowId, step]);
      const group = groups.get(key) ?? {
        appId: row.appId,
        workflowId: row.workflowId,
        step,
        failures: 0,
        codes: new Map<string, number>(),
        recent: [],
      };
      group.failures += 1;
      const code = auditableCode(row.code) ?? "workflow.run_failed";
      group.codes.set(code, (group.codes.get(code) ?? 0) + 1);
      // Read latest first.
      if (group.recent.length < samples) {
        group.recent.push(runIdSchema.parse(row.id));
      }
      groups.set(key, group);
    }
  );
  return [...groups.values()].map((group) =>
    signalRow(
      "failing_step",
      {
        appId: group.appId,
        workflowId: group.workflowId,
        subject: group.step,
      },
      group.failures,
      {
        failures: group.failures,
        runs: runs.get(workflowKey(group.appId, group.workflowId))?.runs ?? 0,
        errors: mostFirst(group.codes)
          .slice(0, samples)
          .map(([code, times]) => ({ code, count: times })),
        recent: group.recent,
      }
    )
  );
};

/**
 * Where corrections keep happening: each step's decisions answered since
 * `from`, where any was rejected, changing what the workflow proposed.
 * Who answered, and with what, stays out.
 */
const correctionSignals = async (
  db: DrizzleD1Database,
  from: Date
): Promise<SignalRow[]> => {
  const groups = new Map<
    string,
    {
      appId: string;
      workflowId: string;
      step: string;
      answered: number;
      rejected: number;
      recent: NonNullable<EvidenceOf<"correction">["recent"]>;
    }
  >();
  const decidedAt = sql<number>`${workflowDecisions.decidedAt}`;
  await eachPage(
    async (after: { id: string; decidedAt: Date | null } | undefined) =>
      await db
        .select({
          id: workflowDecisions.id,
          runId: workflowDecisions.runId,
          step: workflowDecisions.step,
          status: workflowDecisions.status,
          decidedAt: workflowDecisions.decidedAt,
          appId: workflowRuns.appId,
          workflowId: workflowRuns.workflowId,
        })
        .from(workflowDecisions)
        .innerJoin(workflowRuns, eq(workflowRuns.id, workflowDecisions.runId))
        .where(
          and(
            // Only an answer sets it (approved or rejected), and so the
            // read goes by its index alone.
            gte(workflowDecisions.decidedAt, from),
            pastCursor(
              decidedAt,
              workflowDecisions.id,
              after?.decidedAt
                ? { at: after.decidedAt, id: after.id }
                : undefined,
              "desc"
            )
          )
        )
        .orderBy(desc(workflowDecisions.decidedAt), desc(workflowDecisions.id))
        .limit(pageRows),
    (row) => {
      if (row.status !== "approved" && row.status !== "rejected") {
        return;
      }
      const step = stepName(row.step);
      const key = JSON.stringify([row.appId, row.workflowId, step]);
      const group = groups.get(key) ?? {
        appId: row.appId,
        workflowId: row.workflowId,
        step,
        answered: 0,
        rejected: 0,
        recent: [],
      };
      group.answered += 1;
      if (row.status === "rejected") {
        group.rejected += 1;
        // Read latest first.
        if (group.recent.length < samples) {
          group.recent.push({
            decision: row.id,
            run: runIdSchema.parse(row.runId),
          });
        }
      }
      groups.set(key, group);
    }
  );
  return [...groups.values()]
    .filter(({ rejected }) => rejected > 0)
    .map(({ appId, workflowId, step, answered, rejected, recent }) =>
      signalRow("correction", { appId, workflowId, subject: step }, rejected, {
        answered,
        rejected,
        recent,
      })
    );
};

/** What the audit log holds of the window, added up across its stretches. */
export interface SignalTotals {
  /** Each App workflow's model cost, in total and per run. */
  costs: Map<string, { cost: number; perRun: Map<string, number> }>;
  /** Each unanswered question, by App workflow (or none) and key. */
  questions: Map<
    string,
    {
      appId: string;
      workflowId: string;
      queryKey: string;
      searches: number;
      askers: Set<string>;
      terms: number;
      collections: Set<string>;
      lastAt: string;
    }
  >;
}

/** Totals of nothing yet, to add stretches to. */
export const noSignalTotals = (): SignalTotals => ({
  costs: new Map(),
  questions: new Map(),
});

/** Adds a stretch's partial totals (`AuditLog.tallyStretch`) to `totals`. */
export const addSignalTally = (
  totals: SignalTotals,
  tally: SignalTally
): void => {
  for (const { appId, workflowId, runId, cost } of tally.costs) {
    const key = workflowKey(appId, workflowId);
    const found = totals.costs.get(key) ?? { cost: 0, perRun: new Map() };
    found.cost += cost;
    found.perRun.set(runId, (found.perRun.get(runId) ?? 0) + cost);
    totals.costs.set(key, found);
  }
  for (const question of tally.questions) {
    const key = JSON.stringify([
      question.appId,
      question.workflowId,
      question.queryKey,
    ]);
    const found = totals.questions.get(key) ?? {
      appId: question.appId,
      workflowId: question.workflowId,
      queryKey: question.queryKey,
      searches: 0,
      askers: new Set<string>(),
      terms: question.terms,
      collections: new Set<string>(),
      lastAt: question.lastAt,
    };
    found.searches += question.searches;
    found.askers.add(question.asker);
    for (const collection of question.collections) {
      if (found.collections.size < collectionsPerQuestion) {
        found.collections.add(collection);
      }
    }
    // The latest of its askers': each asker's is its own latest.
    found.lastAt =
      question.lastAt > found.lastAt ? question.lastAt : found.lastAt;
    totals.questions.set(key, found);
  }
};

/**
 * Cost per run, for each App workflow with runs started in the window:
 * the cost of those runs' model calls in the window, over them.
 *
 * A run started before the window counts neither as a run nor for what it
 * spent, so the cost and `costliest` name the same runs. The window rolls
 * (the last `signalWindowDays` days), while model budgets
 * (model-budgets.ts) count a UTC calendar month: the two don't match.
 */
const costSignals = (
  { costs }: SignalTotals,
  runs: ReadonlyMap<string, Started>,
  before: ReadonlySet<string>
): SignalRow[] =>
  [...runs].map(([key, { appId, workflowId, runs: started }]) => {
    const perRun = new Map(
      [...(costs.get(key)?.perRun ?? [])].filter(([run]) => !before.has(run))
    );
    const cost = [...perRun.values()].reduce((sum, amount) => sum + amount, 0);
    const costPerRun = cost / started;
    return signalRow(
      "cost_per_run",
      { appId, workflowId, subject: "" },
      dollars(costPerRun),
      {
        runs: started,
        cost: dollars(cost),
        costliest: mostFirst(perRun)
          .slice(0, samples)
          .map(([run, amount]) => ({
            run: runIdSchema.parse(run),
            cost: dollars(amount),
          })),
      }
    );
  });

/**
 * Unanswered Knowledge questions: searches that found nothing the asker
 * could read, by their key (an HMAC of their words), for the App workflow
 * or App whose code asked, or the deployment for people and agents. The
 * most asked of each, at most `questionsPerScope`.
 */
const unansweredSignals = ({ questions }: SignalTotals): SignalRow[] => {
  const scopes = Map.groupBy(questions.values(), ({ appId, workflowId }) =>
    workflowKey(appId, workflowId)
  );
  return [...scopes.values()].flatMap((scope) =>
    scope
      .toSorted(
        (a, b) =>
          b.searches - a.searches || a.queryKey.localeCompare(b.queryKey)
      )
      .slice(0, questionsPerScope)
      .map((question) =>
        signalRow(
          "unanswered_question",
          {
            appId: question.appId,
            workflowId: question.workflowId,
            subject: question.queryKey,
          },
          question.searches,
          {
            searches: question.searches,
            askers: question.askers.size,
            terms: question.terms,
            collections: [...question.collections].map((id) =>
              collectionIdSchema.parse(id)
            ),
            lastAt: question.lastAt,
          }
        )
      )
  );
};

/** The days before `now` whose audit events the signals read. */
export const signalsFrom = (now: Date): Date =>
  new Date(now.getTime() - signalWindowDays * dayMs);

/** Every signal, as of `now`, over the window before it. */
const computeSignals = async (
  env: Env,
  now: Date,
  totals: SignalTotals
): Promise<SignalRow[]> => {
  const db = drizzle(env.DB);
  const from = signalsFrom(now);
  const runs = await runsSince(db, from);
  const [waiting, failing, corrections] = await Promise.all([
    waitingSignals(db, now),
    failingSignals(db, from, runs),
    correctionSignals(db, from),
  ]);
  const before = await startedBefore(
    db,
    from,
    [...totals.costs.values()].flatMap(({ perRun }) => [...perRun.keys()])
  );
  return [
    ...waiting,
    ...failing,
    ...corrections,
    ...costSignals(totals, runs, before),
    ...unansweredSignals(totals),
  ];
};

/**
 * Claims the improvement signals of `now`'s UTC day (src/daily-claims.ts),
 * unless `improvement_signals` is off. In the same batch, the unfinished
 * claims of earlier days go, with anything they wrote: a computation still
 * running on one then stops at its next write, or finishes nothing (see
 * `storeImprovementSignals`).
 */
export const claimImprovementSignals = async (
  env: Env,
  now: Date
): Promise<Computation | undefined> => {
  if (!featureEnabled(env, "improvement_signals")) {
    return undefined;
  }
  const db = drizzle(env.DB);
  const computation = newComputation(now);
  const stale = unfinishedBefore(computations, computation);
  const [, removed, claimed] = await db.batch([
    db
      .delete(improvementSignals)
      .where(
        inArray(
          improvementSignals.computation,
          db.select({ id: computations.id }).from(computations).where(stale)
        )
      ),
    db.delete(computations).where(stale),
    claimComputation(db, computations, computation),
  ]);
  if (removed.meta.changes > 0) {
    log.warn("signals.claims_dropped", { claims: removed.meta.changes });
  }
  return claimed.length === 0 ? undefined : computation;
};

/**
 * Computes the claimed day's signals from `totals` (what the audit log
 * holds of the window) and the databases, writes them, then finishes the
 * computation in one batch, with its audit event: marks it finished, and
 * deletes every computation started before it, with their signals, only if
 * it is still there to mark.
 */
export const storeImprovementSignals = async (
  env: Env,
  computation: Computation,
  totals: SignalTotals
): Promise<void> => {
  const rows = await computeSignals(env, computation.startedAt, totals);
  const db = drizzle(env.DB);
  const inserts = chunks(rows, rowsPerInsert).map((chunk) =>
    db
      .insert(improvementSignals)
      .values(chunk.map((row) => ({ ...row, computation: computation.id })))
  );
  for (const [first, ...rest] of chunks(inserts, insertsPerBatch)) {
    if (first !== undefined) {
      // Batches one after another, each within D1's limits.
      // oxlint-disable-next-line no-await-in-loop
      await db.batch([first, ...rest]);
    }
  }
  const finished = isFinished(computations, computation);
  const before = claimedBefore(computations, computation);
  await auditedBatch(env, db, [
    finishComputation(db, computations, computation),
    outboxedIfChanged(db, {
      actor: { type: "system" },
      action: "improvement.signals.computed",
      target: { type: "improvement_signals", id: computation.id },
      detail: { day: computation.day, signals: rows.length },
    }),
    db
      .delete(improvementSignals)
      .where(
        and(
          finished,
          inArray(
            improvementSignals.computation,
            db.select({ id: computations.id }).from(computations).where(before)
          )
        )
      ),
    db.delete(computations).where(and(finished, before)),
  ]);
};
