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
import { z } from "zod";

import { auditedBatch, outboxed, outboxedIfChanged } from "../audit-outbox.ts";
import { notRemoved, organizationId } from "../auth/auth.ts";
import { signInConfig } from "../auth/config.ts";
import {
  apps,
  members,
  teamMembers,
  teams,
  users,
  workflowDecisions,
  workflowRuns,
} from "../db/core/schema.ts";
import { requireFeature } from "../features.ts";

// Decisions workflow runs wait for (`step.decision`), and the only ways to
// answer one. Threat model R3, R8 and WF1 to WF4:
//
// - Only a signed-in member the decision is from answers it, as they are
//   at that moment: who may answer is part of the one conditional update
//   that takes the answer (`mayAnswer`), so someone removed, demoted or
//   taken out of the team since they were asked can't, even mid-request.
//   Grasp staff never answer a client's decisions.
// - A decision link is plain (`/decisions/<id>`) and grants nothing: it
//   only leads there. Whoever opens it must still be signed in and one the
//   decision is from. The person who started the run may answer when it's
//   from them; every answer is audited under who gave it (R8).
// - The first answer is the decision: the same update moves the row from
//   `open`, only before its deadline and while its run hasn't ended.
//   A run that stops waiting closes its decision the same way, so an answer
//   and a timeout can't both count.
// - The run takes the answer from the row, never from the event that wakes
//   it: the event only says "look now".
// - Who answered is taken from the session, never from the request. The
//   audit log records the answer under them, without its payload (R16).

type DecisionRow = typeof workflowDecisions.$inferSelect;

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

/** That the decision's run hasn't ended, as a condition. */
const runUnended = (): SQL => sql`EXISTS (
  SELECT 1 FROM ${workflowRuns}
  WHERE ${workflowRuns.id} = ${workflowDecisions.runId}
    AND ${workflowRuns.status} IN ('running', 'paused')
)`;

// Run side: the host (workflows/host.ts) calls these for its run only.

/**
 * Opens the run's decision for `step`, or finds the one it opened: a step
 * that runs again after a crash opens nothing new. Its deadline is set
 * here, once, and is the one the run and every answer go by. While
 * decisions are switched off, the run waits before the step that opens
 * one (host.ts); one that got past that just as the switch went is
 * refused here with `feature.disabled`, which its retries try again.
 */
export const openDecision = async (
  env: Env,
  run: DecisionRun,
  request: { step: string; from: string; description: string; timeout: number }
): Promise<{ decision: string; deadline: number }> => {
  requireFeature(env, "decisions");
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
    decidedVia: null,
    payload: null,
  };
  await auditedBatch(env, db, [
    db
      .insert(workflowDecisions)
      .values(row)
      .onConflictDoNothing({
        target: [workflowDecisions.runId, workflowDecisions.step],
      }),
    outboxedIfChanged(
      db,
      decisionEntry(runActorOf(run), "workflow.decision.opened", run, row, {
        from: request.from,
      })
    ),
  ]);
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
 * active members of the organization its deciders name. The one place
 * these rules live: who is asked, and who may answer, both go by it.
 */
const eligibleMembers = (deciders: string): SQL =>
  and(
    eq(members.organizationId, organizationId),
    notRemoved(members.userId),
    decidersCondition(deciders)
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
        .where(and(eq(members.userId, userId), eligibleMembers(deciders)))
    )
  ) ?? sql`0`;

/**
 * The people an open decision asks now, each with the decision's link:
 * the members who may answer it at this moment (`eligibleMembers`). An
 * answered or closed decision asks nobody, and nor does one past its
 * deadline. More than {@link maxDeciders} (everyone who may answer, the
 * run's starter included) is refused. Who was asked is audited: their IDs, never their emails.
 * While decisions are switched off, nobody is asked: the run waits
 * before the step that asks (host.ts), and a call that got past that just
 * as the switch went is refused with `feature.disabled`, which the ask
 * step's retries try again.
 */
export const decisionRecipients = async (
  env: Env,
  run: DecisionRun,
  decision: string,
  reminder: boolean
): Promise<DecisionRecipient[]> => {
  requireFeature(env, "decisions");
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
    .where(eligibleMembers(row.deciders))
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
    await auditedBatch(env, db, [
      db
        .update(workflowDecisions)
        .set({ status: "timed_out" })
        .where(
          and(
            eq(workflowDecisions.id, found.id),
            eq(workflowDecisions.status, "open")
          )
        ),
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
const unended: ReadonlySet<string> = new Set(["running", "paused"]);

const toView = ({
  decision,
  app,
  workflow,
  runStatus,
  decidedByName,
}: DecisionWithRun): DecisionView => ({
  id: decision.id,
  app: { id: appIdSchema.parse(app.id), name: app.name },
  workflow: workflowIdSchema.parse(workflow),
  run: runIdSchema.parse(decision.runId),
  description: decision.description,
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
): Promise<DecisionView> => toView(await allowedDecision(env, by, decision));

/**
 * Wakes the run waiting on the decision. A run that misses it still finds
 * the answer: when its wait ends, it reads the decision again.
 */
const wake = async (env: Env, row: DecisionRow): Promise<void> => {
  try {
    const instance = await env.WORKFLOWS.get(row.runId);
    await instance.sendEvent({
      type: decisionEventType(row.id),
      payload: null,
    });
  } catch (error) {
    log.warn("decision.wake_failed", {
      decision: row.id,
      run: row.runId,
      ...errorFields(error),
    });
  }
};

/**
 * Answers a decision for `by`, if they may, once: the first answer, before
 * the deadline and while the run goes on, is the decision, and anything
 * after it is `decision.closed`.
 */
export const answerDecision = async (
  env: Env,
  by: Identity,
  decision: unknown,
  answer: unknown
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
        // Only so the previous release, which shows an answer only with a
        // channel, still reads this row as answered after a rollback. It
        // goes with the column in the contract release.
        decidedVia: "rpc",
        payload: payload ?? null,
      })
      .where(
        and(
          eq(workflowDecisions.id, row.id),
          eq(workflowDecisions.status, "open"),
          gt(workflowDecisions.expiresAt, now),
          runUnended(),
          mayAnswer(db, by.userId, row.deciders)
        )
      )
      .returning(),
    outboxedIfChanged(
      db,
      decisionEntry(actorOf(by), `workflow.decision.${status}`, run, row)
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
  return toView({
    ...found,
    decision: answered,
    decidedByName: by.name,
  });
};
