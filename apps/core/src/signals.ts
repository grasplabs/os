import { auditFilterSchema } from "@grasp-os/shared/audit-log";
import {
  collectionIdSchema,
  documentIdSchema,
  runIdSchema,
} from "@grasp-os/shared/ids";
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
  isNull,
  lt,
  sql,
} from "drizzle-orm";
import type { SQL, SQLWrapper } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";

import { auditLog } from "./audit-log.ts";
import { auditedBatch, outboxedIfChanged } from "./audit-outbox.ts";
import {
  improvementSignalComputations as computations,
  improvementSignals,
  workflowDecisions,
  workflowRuns,
} from "./db/core/schema.ts";
import { documents, versions } from "./db/knowledge/schema.ts";
import { featureEnabled } from "./features.ts";
import { parseFrontmatter } from "./knowledge/frontmatter.ts";
import { playbookCollectionId } from "./knowledge/playbook.ts";
import { collectionsPerQuestion } from "./signal-tally.ts";
import type { SignalTally } from "./signal-tally.ts";
import { auditableCode } from "./workflows/host.ts";

// Improvement signals, level 1: where the Playbook's Evaluate step should
// look (@grasp-os/shared/signals has what each one means). Each is a query
// over runs and decisions (the core database), the audit log (model calls'
// cost, Knowledge searches that found nothing) and the Playbook's workflow
// records, over the last `signalWindowDays` days.
//
// They're computed once a UTC day and kept in `improvement_signals`, so
// reading them is a few indexed queries. A cron trigger of their own runs
// every 15 minutes (`signalsCron`), never in the same invocation as the
// every-minute jobs, and the first run of a day that claims it computes
// them: a claim is a row in `improvement_signal_computations`, inserted
// only while the day has no finished computation, no claim younger than
// `leaseMs` and fewer than `attemptsPerDay` claims, in one statement, so
// two cron runs never both claim, and a computation that failed is claimed
// again once its lease is up, a few times a day at most.
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

/** How long a claimed computation has before another may claim its day. */
// Longer than the 15 minutes between cron runs, so a run that starts a
// little early never finds a claim lapsed that is still running.
const leaseMs = 20 * 60 * 1000;

/** The most computations one day claims: one that keeps failing stops. */
const attemptsPerDay = 3;

/**
 * The subject of a workflow's waits for single people, added up; no
 * decision's deciders are ever just `person`.
 */
export const peopleSubject = "person";

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

/** Playbook records read at a time, with their text (up to 1 MB each). */
const recordsPerPage = 10;

/** Statuses of a run that hasn't ended. */
const unended: (typeof workflowRuns.$inferSelect)["status"][] = [
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
const workflowKey = (appId: string, workflowId: string): string =>
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
interface AuditTotals {
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

/** Adds a stretch's partial totals (`AuditLog.tallySignals`) to `totals`. */
const addTally = (totals: AuditTotals, tally: SignalTally): void => {
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
 * Model calls' cost and unanswered questions in the window, from the audit
 * log: the object tallies one stretch at a time, a few thousand entries
 * each, and only partial totals cross over (src/signal-tally.ts). Stops
 * early where retention archived what it would read next: only what the
 * log holds counts.
 */
const auditTotals = async (
  env: Env,
  window: { from: string; to: string }
): Promise<AuditTotals> => {
  const audit = auditLog(env);
  const totals: AuditTotals = { costs: new Map(), questions: new Map() };
  // Worked out once, so events appended meanwhile don't stretch it.
  const range = await audit.range(auditFilterSchema.parse(window));
  let after: number | undefined;
  for (;;) {
    // One stretch after another: each starts where the last ended.
    // oxlint-disable-next-line no-await-in-loop
    const stretch = await audit.tallySignals(range, after);
    if (stretch === null) {
      return totals;
    }
    addTally(totals, stretch.tally);
    if (stretch.next === null) {
      return totals;
    }
    after = stretch.next;
  }
};

/** What a Playbook workflow record says its App workflow saves. */
interface Saving {
  record: string;
  /** Minutes a run saves, by the record's automated steps. */
  stepMinutes: number | null;
  gainHoursPerWeek: number | null;
}

/** Steps whose work Grasp does, and so no longer a person. */
const automatedKinds: ReadonlySet<string> = new Set([
  "automated",
  "ai_checked",
]);

/** The App workflow a record links to, and what it saves; none unlinked. */
const savingOf = (
  record: string,
  path: string,
  text: string
): { key: string; saving: Saving } | undefined => {
  let parsed: ReturnType<typeof parseFrontmatter>;
  try {
    parsed = parseFrontmatter(path, text);
  } catch {
    return undefined;
  }
  const { frontmatter } = parsed;
  if (!("steps" in frontmatter && "app" in frontmatter) || !frontmatter.app) {
    return undefined;
  }
  const timed = frontmatter.steps.filter(
    ({ kind, numbers }) =>
      kind !== undefined &&
      automatedKinds.has(kind) &&
      numbers?.minutes !== undefined
  );
  const stepMinutes = timed.reduce(
    (sum, { numbers }) =>
      sum + (numbers?.minutes?.value ?? 0) * (numbers?.people?.value ?? 1),
    0
  );
  return {
    key: workflowKey(frontmatter.app.appId, frontmatter.app.workflowId),
    saving: {
      record,
      stepMinutes: timed.length === 0 ? null : stepMinutes,
      gainHoursPerWeek: frontmatter.gain?.hoursPerWeek ?? null,
    },
  };
};

/**
 * What each App workflow saves, by the Playbook workflow record linked to
 * it (the first by ID where several are): a record that no longer reads
 * as a workflow is left out.
 */
const savings = async (env: Env): Promise<Map<string, Saving>> => {
  const db = drizzle(env.KNOWLEDGE);
  const found = new Map<string, Saving>();
  let after = "";
  for (;;) {
    // One page after another: each starts where the last ended.
    // oxlint-disable-next-line no-await-in-loop
    const records = await db
      .select({ id: documents.id, path: documents.path, text: versions.text })
      .from(documents)
      .innerJoin(
        versions,
        and(
          eq(versions.documentId, documents.id),
          eq(versions.number, documents.currentVersion)
        )
      )
      .where(
        and(
          eq(documents.collectionId, playbookCollectionId),
          eq(documents.type, "workflow"),
          gt(documents.id, after)
        )
      )
      .orderBy(asc(documents.id))
      .limit(recordsPerPage);
    for (const { id, path, text } of records) {
      const saving = savingOf(id, path, text);
      if (saving !== undefined && !found.has(saving.key)) {
        found.set(saving.key, saving.saving);
      }
    }
    if (records.length < recordsPerPage) {
      return found;
    }
    after = records.at(-1)?.id ?? after;
  }
};

/**
 * The minutes each of `runs` runs in the window saves, by `saving`: its
 * automated steps' minutes, or else its weekly gain over the runs a week.
 */
const minutesSaved = (
  saving: Saving | undefined,
  runs: number
): Pick<EvidenceOf<"cost_per_run">, "minutesSavedPerRun" | "savedFrom"> => {
  if (saving?.stepMinutes !== undefined && saving.stepMinutes !== null) {
    return { minutesSavedPerRun: saving.stepMinutes, savedFrom: "steps" };
  }
  if (
    saving?.gainHoursPerWeek !== undefined &&
    saving.gainHoursPerWeek !== null
  ) {
    const runsPerWeek = runs / (signalWindowDays / 7);
    return {
      minutesSavedPerRun: (saving.gainHoursPerWeek * 60) / runsPerWeek,
      savedFrom: "gain",
    };
  }
  return { minutesSavedPerRun: null, savedFrom: null };
};

/**
 * Cost per run against minutes saved, for each App workflow with runs
 * started in the window: its model calls' cost over them, and the minutes
 * a run saves by its Playbook record, from its automated steps' minutes
 * (times the people each took), or else its weekly gain over the runs a
 * week it had.
 */
const costSignals = (
  { costs }: AuditTotals,
  saved: ReadonlyMap<string, Saving>,
  runs: ReadonlyMap<string, Started>
): SignalRow[] =>
  [...runs].map(([key, { appId, workflowId, runs: started }]) => {
    const spent = costs.get(key);
    const cost = spent?.cost ?? 0;
    const costPerRun = cost / started;
    const saving = saved.get(key);
    const { minutesSavedPerRun, savedFrom } = minutesSaved(saving, started);
    return signalRow(
      "cost_per_run",
      { appId, workflowId, subject: "" },
      dollars(costPerRun),
      {
        runs: started,
        cost: dollars(cost),
        minutesSavedPerRun,
        savedFrom,
        record:
          saving === undefined ? null : documentIdSchema.parse(saving.record),
        costPerHourSaved:
          minutesSavedPerRun === null || minutesSavedPerRun <= 0
            ? null
            : dollars(costPerRun / (minutesSavedPerRun / 60)),
        costliest: mostFirst(spent?.perRun ?? new Map())
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
const unansweredSignals = ({ questions }: AuditTotals): SignalRow[] => {
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

/** Every signal, as of `now`, over the window before it. */
const computeSignals = async (env: Env, now: Date): Promise<SignalRow[]> => {
  const db = drizzle(env.DB);
  const from = new Date(now.getTime() - signalWindowDays * dayMs);
  const window = { from: from.toISOString(), to: now.toISOString() };
  const runs = await runsSince(db, from);
  const [waiting, failing, corrections, totals, saved] = await Promise.all([
    waitingSignals(db, now),
    failingSignals(db, from, runs),
    correctionSignals(db, from),
    auditTotals(env, window),
    savings(env),
  ]);
  return [
    ...waiting,
    ...failing,
    ...corrections,
    ...costSignals(totals, saved, runs),
    ...unansweredSignals(totals),
  ];
};

/** A claimed computation. */
interface Computation {
  id: string;
  day: string;
  startedAt: Date;
}

/**
 * Claims the computation of `now`'s UTC day, unless it has a finished one,
 * one claimed less than `leaseMs` before, or `attemptsPerDay` claims
 * already: in one statement, so of two claims at once only one lands. In
 * the same batch, the unfinished claims of earlier days go, with anything
 * they wrote: a computation still running on one then stops at its next
 * write, or finishes nothing (see `store`).
 */
const claim = async (env: Env, now: Date): Promise<Computation | undefined> => {
  const db = drizzle(env.DB);
  const computation: Computation = {
    id: crypto.randomUUID(),
    day: now.toISOString().slice(0, 10),
    startedAt: now,
  };
  const stale = and(
    lt(computations.day, computation.day),
    isNull(computations.finishedAt)
  );
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
    db
      .insert(computations)
      .select(
        sql`SELECT ${computation.id}, ${computation.day}, ${now.getTime()}, NULL
            WHERE NOT EXISTS (
              SELECT 1 FROM ${computations}
              WHERE ${computations.day} = ${computation.day}
                AND (${computations.finishedAt} IS NOT NULL
                  OR ${computations.startedAt} > ${now.getTime() - leaseMs})
            )
            AND (
              SELECT count(*) FROM ${computations}
              WHERE ${computations.day} = ${computation.day}
            ) < ${attemptsPerDay}`
      )
      .returning({ id: computations.id }),
  ]);
  if (removed.meta.changes > 0) {
    log.warn("signals.claims_dropped", { claims: removed.meta.changes });
  }
  return claimed.length === 0 ? undefined : computation;
};

/** Splits `items` into runs of `size`. */
const chunks = <T>(items: readonly T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, (index + 1) * size)
  );

/**
 * Writes the computation's signals, then finishes it in one batch, with
 * its audit event: marks it finished, and deletes every computation
 * started before it, with their signals, only if it is still there to
 * mark.
 */
const store = async (
  env: Env,
  computation: Computation,
  rows: readonly SignalRow[]
): Promise<void> => {
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
  const finished = sql`EXISTS (
    SELECT 1 FROM ${computations}
    WHERE ${computations.id} = ${computation.id}
      AND ${computations.finishedAt} IS NOT NULL
  )`;
  const before = lt(computations.startedAt, computation.startedAt);
  await auditedBatch(env, db, [
    db
      .update(computations)
      .set({ finishedAt: new Date() })
      .where(eq(computations.id, computation.id)),
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

/** The cron trigger of the improvement signals (wrangler.jsonc). */
export const signalsCron = "*/15 * * * *";

/**
 * Computes the improvement signals of `now`'s UTC day, unless that day's
 * are computed or being computed (see above). Does nothing while
 * `improvement_signals` is off. Its cron trigger calls it every 15 minutes.
 */
export const refreshSignalsIfDue = async (
  env: Env,
  now = new Date()
): Promise<void> => {
  if (!featureEnabled(env, "improvement_signals")) {
    return;
  }
  const computation = await claim(env, now);
  if (computation === undefined) {
    return;
  }
  await store(env, computation, await computeSignals(env, now));
};
