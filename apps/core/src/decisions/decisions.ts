import type { AuditActor, AuditEntry } from "@grasp-os/shared/audit";
import { actorOf, runActorOf } from "@grasp-os/shared/audit";
import { decisionErrors, maxDeciders } from "@grasp-os/shared/decisions";
import type {
  DecisionAnswerInput,
  DecisionView,
} from "@grasp-os/shared/decisions";
import {
  appIdSchema,
  identifierSchema,
  runIdSchema,
  workflowIdSchema,
} from "@grasp-os/shared/ids";
import type { Json } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import type { Identity } from "@grasp-os/shared/rpc";
import { and, eq, exists, gt, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { z } from "zod";

import { auditedBatch, outboxed, outboxedIfChanged } from "../audit-outbox.ts";
import { notRemoved, organizationId } from "../auth/auth.ts";
import { signInConfig } from "../auth/config.ts";
import type { Member } from "../auth/identity.ts";
import {
  apps,
  members,
  teamMembers,
  teams,
  users,
  workflowDecisions,
  workflowRuns,
} from "../db/core/schema.ts";
import { inList } from "../db/d1.ts";
import { runEngine } from "../workflows/engine.ts";
import { removedText } from "../workflows/retention.ts";
import { tellScreens } from "../workflows/run-changes.ts";

// Decisions workflow runs wait for (`step.decision`), and the only ways to
// answer one. Threat model R3, R8 and WF1 to WF4:
//
// - Only a signed-in member the decision is from answers it, as they are
//   at that moment: who may answer is part of the one conditional update
//   that takes the answer (`mayAnswer`), so someone removed, demoted or
//   taken out of the team since they were asked can't, even mid-request.
//   Grasp staff never answer a client's decisions.
// - Nobody answers their own request (R8): the person who started the run
//   can't answer its decisions, unless the decision names exactly them
//   (`person:<them>`), which is their own explicit confirmation. A run a
//   trigger started has no starter, so its App's owner isn't held back.
// - A decision link is plain (`/decisions/<id>`) and grants nothing: it
//   only leads there. Whoever opens it must still be signed in and one who
//   may answer. Every answer is audited under who gave it.
// - The first answer is the decision: the same update moves the row from
//   `open`, only before its deadline and while its run hasn't ended.
//   A run that stops waiting closes its decision the same way, so an answer
//   and a timeout can't both count.
// - The run takes the answer from the row, never from the event that wakes
//   it: the event only says "look now".
// - Who answered is taken from the session, never from the request. The
//   audit log records the answer under them, without its payload (R16).

type DecisionRow = typeof workflowDecisions.$inferSelect;

/** The run a decision belongs to, as `tellScreens` names it. */
const changed = (run: DecisionRun) => ({
  id: run.runId,
  appId: run.app,
  workflowId: run.workflow,
});

/** The run a decision belongs to, as the host serves it. */
export interface DecisionRun {
  runId: string;
  app: string;
  workflow: string;
  version: number;
}

/** A person a decision asks, and the link that leads them to it. */
export interface DecisionRecipient {
  userId: string;
  name: string;
  email: string;
  link: string;
}

/** How a decision stands for the run waiting on it. */
export type DecisionOutcome =
  | { answered: true; approved: boolean; by: string; payload: Json | null }
  | { answered: false };

/** The event that wakes a run waiting on `decision`: core's own type. */
export const decisionEventType = (decision: string): string =>
  `grasp-decision-${decision}`;

/** The longest description of a decision kept; the rest is cut. */
const maxDescription = 500;

/** The largest payload an answer carries, in bytes of JSON text. */
const maxPayloadBytes = 4096;

const answerSchema = z.strictObject({
  approved: z.boolean(),
  payload: z.json().optional(),
});

const notFound = () => decisionErrors.create("decision.not_found");

/** The audit entry of something that happened to a decision. */
const decisionEntry = (
  actor: AuditActor,
  action: `workflow.decision.${string}`,
  run: DecisionRun,
  row: Pick<DecisionRow, "id" | "step">,
  detail: Record<string, string | number | boolean> = {}
): AuditEntry => ({
  actor,
  action,
  target: { type: "workflow_decision", id: row.id },
  detail: {
    app: run.app,
    workflow: run.workflow,
    version: run.version,
    run: run.runId,
    step: row.step,
    ...detail,
  },
});

/** A table of decisions, or an alias of it, as `stillOpen` reads it. */
interface DecisionColumns {
  status: SQLiteColumn;
  expiresAt: SQLiteColumn;
}

/**
 * That a decision can still be answered at `now`, as a condition on
 * `decisions` (the table, or an alias of it): it is open, and its deadline
 * hasn't passed. One the run hasn't timed out yet, past its deadline, is
 * answered by nobody. The one place this rule lives: answering, and
 * whether a run waits for anyone (workflows/overview.ts), go by it.
 */
export const stillOpen = (decisions: DecisionColumns, now: Date): SQL =>
  and(eq(decisions.status, "open"), gt(decisions.expiresAt, now)) ?? sql`0`;

/** That the decision's run hasn't ended, as a condition. */
const runUnended = (): SQL => sql`EXISTS (
  SELECT 1 FROM ${workflowRuns}
  WHERE ${workflowRuns.id} = ${workflowDecisions.runId}
    AND ${workflowRuns.status} IN ('starting', 'running', 'paused')
)`;

// Run side: the host (workflows/host.ts) calls these for its run only.

/**
 * Opens the run's decision for `step`, or finds the one it opened: a step
 * that runs again after a crash opens nothing new. Its deadline is set
 * here, once, and is the one the run and every answer go by.
 */
export const openDecision = async (
  env: Env,
  run: DecisionRun,
  request: { step: string; from: string; description: string; timeout: number }
): Promise<{ decision: string; deadline: number }> => {
  const db = drizzle(env.DB);
  const now = Date.now();
  const row: DecisionRow = {
    id: crypto.randomUUID(),
    runId: run.runId,
    step: request.step,
    deciders: request.from,
    description: request.description.slice(0, maxDescription),
    status: "open",
    openedAt: new Date(now),
    expiresAt: new Date(now + request.timeout),
    decidedBy: null,
    decidedAt: null,
    payload: null,
  };
  const [[inserted]] = await auditedBatch(env, db, [
    db
      .insert(workflowDecisions)
      .values(row)
      .onConflictDoNothing({
        target: [workflowDecisions.runId, workflowDecisions.step],
      })
      .returning({ id: workflowDecisions.id }),
    outboxedIfChanged(
      db,
      decisionEntry(runActorOf(run), "workflow.decision.opened", run, row, {
        from: request.from,
      })
    ),
  ]);
  // The run now waits for it; a step run again after a crash opened
  // nothing, and tells no one.
  if (inserted) {
    await tellScreens(env, changed(run));
  }
  const opened = await db
    .select({
      id: workflowDecisions.id,
      expiresAt: workflowDecisions.expiresAt,
    })
    .from(workflowDecisions)
    .where(
      and(
        eq(workflowDecisions.runId, run.runId),
        eq(workflowDecisions.step, request.step)
      )
    )
    .get();
  if (!opened) {
    throw new Error(`Decision ${request.step} of run ${run.runId} is missing`);
  }
  return { decision: opened.id, deadline: opened.expiresAt.getTime() };
};

/** The run's decision `decision`; `decision.not_found` for any other. */
const runDecision = async (
  env: Env,
  run: DecisionRun,
  decision: string
): Promise<DecisionRow> => {
  const row = await drizzle(env.DB)
    .select()
    .from(workflowDecisions)
    .where(
      and(
        eq(workflowDecisions.id, decision),
        eq(workflowDecisions.runId, run.runId)
      )
    )
    .get();
  if (!row) {
    throw notFound();
  }
  return row;
};

/** The deadline of the run's decision `decision`, in milliseconds. */
export const decisionDeadline = async (
  env: Env,
  run: DecisionRun,
  decision: string
): Promise<number> => {
  const row = await runDecision(env, run, decision);
  return row.expiresAt.getTime();
};

/**
 * Stored deciders (`role:admin`, `decidersSchema`) as their kind and ID:
 * the ID is everything after the first `:`.
 */
const decidersOf = (deciders: string): { kind: string; id: string } => {
  const colon = deciders.indexOf(":");
  return colon === -1
    ? { kind: "", id: "" }
    : { kind: deciders.slice(0, colon), id: deciders.slice(colon + 1) };
};

/** Members the deciders name, as a condition on `members`. */
const decidersCondition = (deciders: string): SQL => {
  const { kind, id } = decidersOf(deciders);
  switch (kind) {
    case "person": {
      return eq(members.userId, id);
    }
    case "role": {
      return eq(members.role, id);
    }
    case "team": {
      return sql`EXISTS (
        SELECT 1 FROM ${teamMembers}
        INNER JOIN ${teams} ON ${teams.id} = ${teamMembers.teamId}
        WHERE ${teamMembers.userId} = ${members.userId}
          AND ${teamMembers.teamId} = ${id}
          AND ${teams.organizationId} = ${organizationId}
      )`;
    }
    default: {
      return sql`0`;
    }
  }
};

/**
 * The members who may answer a decision now, as a condition on `members`:
 * active members of the organization its deciders name, but never whoever
 * started its run (R8). A `person:` decision names one person, so it only
 * leaves out its starter by naming someone else; one naming exactly the
 * starter is their own confirmation, and stands. The one place these rules
 * live: who is asked, who counts toward the cap, and who may answer all go
 * by it.
 */
const eligibleMembers = (deciders: string, runId: string | SQLiteColumn): SQL =>
  and(
    eq(members.organizationId, organizationId),
    notRemoved(members.userId),
    decidersCondition(deciders),
    decidersOf(deciders).kind === "person"
      ? undefined
      : sql`NOT EXISTS (
          SELECT 1 FROM ${workflowRuns}
          WHERE ${workflowRuns.id} = ${runId}
            AND ${workflowRuns.startedBy} = ${members.userId}
        )`
  ) ?? sql`0`;

/**
 * That `userId` may answer the decision now, as a condition on its row
 * (`eligibleMembers`), so it holds in the very statement that answers.
 */
const mayAnswer = (
  db: DrizzleD1Database,
  userId: string,
  deciders: string
): SQL =>
  and(
    eq(workflowDecisions.deciders, deciders),
    exists(
      db
        .select({ one: sql`1` })
        .from(members)
        .where(
          and(
            eq(members.userId, userId),
            eligibleMembers(deciders, workflowDecisions.runId)
          )
        )
    )
  ) ?? sql`0`;

/**
 * The people an open decision asks now, each with the decision's link:
 * the members who may answer it at this moment (`eligibleMembers`). An
 * answered or closed decision asks nobody, and nor does one past its
 * deadline. More than {@link maxDeciders} of them is refused; the run's
 * starter counts only when the decision names exactly them, as only then
 * may they answer. Who was asked is audited: their IDs, never their
 * emails.
 */
export const decisionRecipients = async (
  env: Env,
  run: DecisionRun,
  decision: string,
  reminder: boolean
): Promise<DecisionRecipient[]> => {
  const row = await runDecision(env, run, decision);
  // Past its deadline, nobody can answer it, so nobody is asked: a link
  // sent then would lead to a decision that takes no answer.
  if (row.status !== "open" || row.expiresAt.getTime() <= Date.now()) {
    return [];
  }
  const origin = signInConfig(env)?.origin;
  if (origin === undefined) {
    throw new Error("Sign-in isn't set up, so nobody can answer a decision");
  }
  const db = drizzle(env.DB);
  const people = await db
    .select({ userId: users.id, name: users.name, email: users.email })
    .from(members)
    .innerJoin(users, eq(users.id, members.userId))
    .where(eligibleMembers(row.deciders, row.runId))
    .orderBy(users.name, users.id)
    .limit(maxDeciders + 1);
  if (people.length > maxDeciders) {
    throw decisionErrors.create("decision.too_many_deciders");
  }
  await auditedBatch(env, db, [
    outboxed(db, {
      ...decisionEntry(runActorOf(run), "workflow.decision.asked", run, row, {
        recipients: people.length,
        reminder,
      }),
      provenance: people.map(({ userId }) => userId),
    }),
  ]);
  const link = new URL(`/decisions/${encodeURIComponent(row.id)}`, origin);
  return people.map((person) => ({ ...person, link: link.href }));
};

/**
 * How the run's decision stands now. With `close`, an open one is closed
 * first, timed out, in the same one conditional update an answer uses: an
 * answer that lands first is the outcome instead.
 */
export const decisionOutcome = async (
  env: Env,
  run: DecisionRun,
  decision: string,
  close: boolean
): Promise<DecisionOutcome> => {
  const found = await runDecision(env, run, decision);
  if (close && found.status === "open") {
    const db = drizzle(env.DB);
    const [[closed]] = await auditedBatch(env, db, [
      db
        .update(workflowDecisions)
        .set({ status: "timed_out" })
        .where(
          and(
            eq(workflowDecisions.id, found.id),
            eq(workflowDecisions.status, "open")
          )
        )
        .returning({ id: workflowDecisions.id }),
      outboxedIfChanged(
        db,
        decisionEntry(
          runActorOf(run),
          "workflow.decision.timed_out",
          run,
          found
        )
      ),
    ]);
    if (closed) {
      await tellScreens(env, changed(run));
    }
  }
  const row = close ? await runDecision(env, run, decision) : found;
  if (
    (row.status === "approved" || row.status === "rejected") &&
    row.decidedBy !== null
  ) {
    return {
      answered: true,
      approved: row.status === "approved",
      by: row.decidedBy,
      payload: row.payload ?? null,
    };
  }
  return { answered: false };
};

// Person side: the `decisions` RPC (rpc.ts).

/** A decision with what the people who answer it see of it. */
const decisionWithRun = async (env: Env, decision: unknown) => {
  const id = identifierSchema.safeParse(decision);
  if (!id.success) {
    throw notFound();
  }
  const found = await drizzle(env.DB)
    .select({
      decision: workflowDecisions,
      app: { id: workflowRuns.appId, name: apps.name },
      workflow: workflowRuns.workflowId,
      version: workflowRuns.version,
      runStatus: workflowRuns.status,
      decidedByName: users.name,
    })
    .from(workflowDecisions)
    .innerJoin(workflowRuns, eq(workflowRuns.id, workflowDecisions.runId))
    .innerJoin(apps, eq(apps.id, workflowRuns.appId))
    .leftJoin(users, eq(users.id, workflowDecisions.decidedBy))
    .where(eq(workflowDecisions.id, id.data))
    .get();
  if (!found) {
    throw notFound();
  }
  return found;
};
type DecisionWithRun = Awaited<ReturnType<typeof decisionWithRun>>;

/** Whether `by` may answer the decision now (`mayAnswer`); never staff. */
const mayAnswerNow = async (
  env: Env,
  by: Identity,
  row: DecisionRow
): Promise<boolean> => {
  if (by.staff) {
    return false;
  }
  const db = drizzle(env.DB);
  const found = await db
    .select({ id: workflowDecisions.id })
    .from(workflowDecisions)
    .where(
      and(
        eq(workflowDecisions.id, row.id),
        mayAnswer(db, by.userId, row.deciders)
      )
    )
    .get();
  return found !== undefined;
};

/** The decision, if `by` may answer it now. */
const allowedDecision = async (
  env: Env,
  by: Identity,
  decision: unknown
): Promise<DecisionWithRun> => {
  const found = await decisionWithRun(env, decision);
  if (!(await mayAnswerNow(env, by, found.decision))) {
    throw decisionErrors.create("decision.forbidden");
  }
  return found;
};

/** Statuses of a run that hasn't ended. */
const unended: ReadonlySet<string> = new Set(["starting", "running", "paused"]);

const toView = (
  env: Env,
  { decision, app, workflow, runStatus, decidedByName }: DecisionWithRun
): DecisionView => ({
  id: decision.id,
  app: { id: appIdSchema.parse(app.id), name: app.name },
  workflow: workflowIdSchema.parse(workflow),
  run: runIdSchema.parse(decision.runId),
  // None is asked with an empty description: one that is empty went with
  // its run's details (workflows/retention.ts), and says so.
  description:
    decision.description === "" ? removedText(env) : decision.description,
  // An open decision of a run that has ended takes no answer.
  status:
    decision.status === "open" && !unended.has(runStatus)
      ? "closed"
      : decision.status,
  expiresAt: decision.expiresAt.toISOString(),
  ...(decision.decidedBy !== null && decision.decidedAt !== null
    ? {
        decided: {
          by: { userId: decision.decidedBy, name: decidedByName ?? "" },
          at: decision.decidedAt.toISOString(),
        },
      }
    : {}),
});

/** A decision `by` may answer. */
export const decisionFor = async (
  env: Env,
  by: Identity,
  decision: unknown
): Promise<DecisionView> =>
  toView(env, await allowedDecision(env, by, decision));

/**
 * Wakes the run waiting on the decision. A run that misses it still finds
 * the answer: when its wait ends, it reads the decision again.
 */
const wake = async (env: Env, row: DecisionRow): Promise<void> => {
  try {
    await runEngine(env).sendEvent(row.runId, decisionEventType(row.id));
  } catch (error) {
    log.warn("decision.wake_failed", {
      decision: row.id,
      run: row.runId,
      ...errorFields(error),
    });
  }
};

/**
 * Of `decisions`, the ones `by` may answer now (`mayAnswer`): none for
 * Grasp staff. One query per distinct set of deciders among them, all in
 * one batch: one round trip, and one snapshot.
 */
export const answerableBy = async (
  env: Env,
  by: Member,
  decisions: readonly { id: string; deciders: string }[]
): Promise<Set<string>> => {
  if (by.staff || decisions.length === 0) {
    return new Set();
  }
  const byDeciders = new Map<string, string[]>();
  for (const { id, deciders } of decisions) {
    byDeciders.set(deciders, [...(byDeciders.get(deciders) ?? []), id]);
  }
  const db = drizzle(env.DB);
  const [first, ...rest] = [...byDeciders].map(([deciders, ids]) =>
    db
      .select({ id: workflowDecisions.id })
      .from(workflowDecisions)
      .where(
        and(
          inList(workflowDecisions.id, ids),
          mayAnswer(db, by.userId, deciders)
        )
      )
  );
  // Never without one: there is a decision (see above).
  if (first === undefined) {
    return new Set();
  }
  const found = await db.batch([first, ...rest]);
  return new Set(found.flat().map(({ id }) => id));
};

/**
 * Answers a decision for `by`, if they may, once: the first answer, before
 * the deadline and while the run goes on, is the decision, and anything
 * after it is `decision.closed`. `via` says where they answered, when not
 * on the decision's own page: on one of the App's screens (`screen`). The
 * audit log says so.
 */
export const answerDecision = async (
  env: Env,
  by: Identity,
  decision: unknown,
  answer: unknown,
  via?: "screen"
): Promise<DecisionView> => {
  const found = await allowedDecision(env, by, decision);
  const { approved, payload }: DecisionAnswerInput = decisionErrors.parse(
    "decision.invalid",
    answerSchema,
    answer
  );
  if (
    payload !== undefined &&
    new TextEncoder().encode(JSON.stringify(payload)).length > maxPayloadBytes
  ) {
    throw decisionErrors.create("decision.invalid", {
      issues: [`payload: at most ${maxPayloadBytes} bytes of JSON`],
    });
  }
  const row = found.decision;
  const run: DecisionRun = {
    runId: row.runId,
    app: found.app.id,
    workflow: found.workflow,
    version: found.version,
  };
  const status = approved ? "approved" : "rejected";
  const now = new Date();
  const db = drizzle(env.DB);
  const [[answered]] = await auditedBatch(env, db, [
    db
      .update(workflowDecisions)
      .set({
        status,
        decidedBy: by.userId,
        decidedAt: now,
        payload: payload ?? null,
      })
      .where(
        and(
          eq(workflowDecisions.id, row.id),
          stillOpen(workflowDecisions, now),
          runUnended(),
          mayAnswer(db, by.userId, row.deciders)
        )
      )
      .returning(),
    outboxedIfChanged(
      db,
      decisionEntry(
        actorOf(by),
        `workflow.decision.${status}`,
        run,
        row,
        via === undefined ? {} : { via }
      )
    ),
  ]);
  if (!answered) {
    // Who may answer can have changed since it was checked above.
    throw decisionErrors.create(
      (await mayAnswerNow(env, by, row))
        ? "decision.closed"
        : "decision.forbidden"
    );
  }
  await wake(env, answered);
  await tellScreens(env, changed(run));
  return toView(env, {
    ...found,
    decision: answered,
    decidedByName: by.name,
  });
};
