/**
 * What staff do with rollouts (src/rollout/workflow.ts): start one, and
 * approve its next ring.
 *
 * One rollout runs at a time: a rollout waiting for approval still owns
 * the rings after, which a second rollout would deploy something else
 * to. Starting one inserts it only while no other is running or waiting,
 * with its targets and audit event, in one batch.
 */
import { log } from "@grasp-os/shared/log";
import { releaseIdSchema } from "@grasp-os/shared/release";
import { and, eq, gt, inArray, min, sql } from "drizzle-orm";
import { z } from "zod";

import type { Staff } from "../access.ts";
import { actIfChanged, audit, consoleDatabase } from "../db/act.ts";
import type { ConsoleDatabase } from "../db/act.ts";
import { releases, rollouts, rolloutTargets } from "../db/schema.ts";
import { clientDomain } from "../deploy/context.ts";
import { errorCode } from "../deploy/deploy.ts";
import { importedManifest } from "../deploy/release.ts";
import { hasEnded, instanceStatus } from "../runners.ts";
import { RolloutError } from "./errors.ts";
import { rolloutScopeSchema, targetsOf } from "./targets.ts";
import { approvalEvent, rolloutSteps, stepBudget } from "./workflow.ts";
import type { RolloutParams } from "./workflow.ts";

/** What staff choose to start a rollout: a release, and whom it reaches after ring 0. */
export const startRolloutSchema = z.object({
  releaseId: releaseIdSchema,
  scope: rolloutScopeSchema,
});
export type StartRolloutInput = z.infer<typeof startRolloutSchema>;

/** The statuses of a rollout that still has rings to deploy. */
const activeStatuses = ["running", "waiting"] as const;

/**
 * Marks rollout `id` failed with `error`, audited, if it's still running
 * or waiting. A failure to record it is logged, not thrown, so the
 * caller's own error stands.
 */
const failRollout = async (
  db: ConsoleDatabase,
  id: string,
  error: string
): Promise<void> => {
  try {
    await actIfChanged(
      db,
      "system",
      db
        .update(rollouts)
        .set({ status: "failed", updatedAt: new Date() })
        .where(
          and(
            eq(rollouts.id, id),
            inArray(rollouts.status, [...activeStatuses])
          )
        ),
      { action: "rollout.fail", target: id, detail: { error } }
    );
  } catch (recordError) {
    log.error("rollout.fail_unrecorded", {
      rollout: id,
      error: errorCode(recordError),
    });
  }
};

/**
 * Marks failed each rollout still running or waiting whose run has ended
 * without saying so (terminated from the dashboard, or never created): so
 * it doesn't hold the console's one rollout forever.
 */
const settleEnded = async (env: Env, db: ConsoleDatabase): Promise<void> => {
  const active = await db
    .select({ id: rollouts.id, createdAt: rollouts.createdAt })
    .from(rollouts)
    .where(inArray(rollouts.status, [...activeStatuses]));
  for (const { id, createdAt } of active) {
    // oxlint-disable-next-line no-await-in-loop -- one, as a rule
    const { status } = await instanceStatus(env.ROLLOUT, id, createdAt);
    if (hasEnded(status)) {
      // oxlint-disable-next-line no-await-in-loop -- one, as a rule
      await failRollout(db, id, "run_ended");
    }
  }
};

/**
 * Starts rolling release `input.releaseId` out, as `staff`, to ring 0
 * then `input.scope`, and returns the rollout's id. Refused while another
 * rollout is running or waiting (`rollout_running`), when no active
 * client is in scope, and when its run would take more steps than
 * `stepBudget` (`too_large`).
 */
export const startRollout = async (
  env: Env,
  staff: Staff,
  input: StartRolloutInput
): Promise<string> => {
  const db = consoleDatabase(env.DB);
  const { releaseId, scope } = startRolloutSchema.parse(input);
  if (clientDomain(env) === null) {
    throw new RolloutError(
      "domain_not_set",
      "Set CLIENT_DOMAIN on the console before rolling out"
    );
  }
  const [release] = await db
    .select({ id: releases.id })
    .from(releases)
    .where(eq(releases.id, releaseId));
  if (release === undefined) {
    throw new RolloutError(
      "release_not_imported",
      `Release ${releaseId} isn't imported`
    );
  }
  await settleEnded(env, db);
  const targets = await targetsOf(db, scope);
  const [first] = targets;
  if (first === undefined) {
    throw new RolloutError("no_targets", "No active client is in scope");
  }
  // Refused rather than left to stop part way at Workflows' step limit.
  const manifest = await importedManifest(db, releaseId);
  const steps = rolloutSteps(
    new Set(targets.map(({ ring }) => ring)).size,
    targets.length,
    Object.keys(manifest?.workers ?? {}).length
  );
  if (steps > stepBudget) {
    throw new RolloutError(
      "too_large",
      `${targets.length} clients would take about ${steps} steps, over ${stepBudget}: roll out one ring or client at a time`
    );
  }
  const id = crypto.randomUUID();
  const now = Date.now();
  const active = sql.join(
    activeStatuses.map((status) => sql`${status}`),
    sql`, `
  );
  const created = await actIfChanged(
    db,
    staff,
    db
      .insert(rollouts)
      .select(
        sql`SELECT ${id}, 'release', ${releaseId}, 'running', ${first.ring}, ${staff.email}, ${now}, ${now} WHERE NOT EXISTS (SELECT 1 FROM ${rollouts} WHERE ${rollouts.status} IN (${active}))`
      ),
    {
      action: "rollout.start",
      target: id,
      detail: {
        release: releaseId,
        scope: scope.scope,
        ...(scope.scope === "ring" ? { ring: scope.ring } : {}),
        ...(scope.scope === "client" ? { client: scope.clientId } : {}),
        targets: targets.length,
      },
    },
    // Only with the rollout: its id is new, so it exists only if inserted.
    targets.map(({ clientId, ring }) =>
      db
        .insert(rolloutTargets)
        .select(
          sql`SELECT ${id}, ${clientId}, ${ring}, 'pending', NULL, NULL, NULL, ${now} WHERE EXISTS (SELECT 1 FROM ${rollouts} WHERE ${rollouts.id} = ${id})`
        )
    )
  );
  if (!created) {
    throw new RolloutError(
      "rollout_running",
      "Another rollout is running or waiting for approval"
    );
  }
  const params: RolloutParams = {
    rolloutId: id,
    releaseId,
    startedBy: { email: staff.email, sub: staff.sub },
  };
  try {
    await env.ROLLOUT.create({ id, params });
  } catch (error) {
    // Its run never started: it no longer holds the console's one rollout.
    await failRollout(db, id, "run_not_created");
    throw error;
  }
  return id;
};

/**
 * Sends rollout `rolloutId`'s approval of ring `ring` to its run again,
 * as `staff`, audited, when the approval is recorded (the rollout moved
 * on to that ring, past its first) and the run hasn't ended: its event
 * may not have reached it. Harmless when it did: the run waits for each
 * ring's event once, so a second one is never taken. Returns whether it
 * sent it.
 */
const resendApproval = async (
  env: Env,
  staff: Staff,
  rollout: { id: string; ring: number; createdAt: Date }
): Promise<boolean> => {
  const db = consoleDatabase(env.DB);
  const [first] = await db
    .select({ ring: min(rolloutTargets.ring) })
    .from(rolloutTargets)
    .where(eq(rolloutTargets.rolloutId, rollout.id));
  const { instance, status } = await instanceStatus(
    env.ROLLOUT,
    rollout.id,
    rollout.createdAt
  );
  if (
    first?.ring === null ||
    first === undefined ||
    rollout.ring <= first.ring ||
    instance === null ||
    hasEnded(status)
  ) {
    return false;
  }
  await audit(db, staff, {
    action: "rollout.approve_resend",
    target: rollout.id,
    detail: { ring: rollout.ring },
  });
  await instance.sendEvent({ type: approvalEvent(rollout.ring), payload: {} });
  return true;
};

/**
 * Approves rollout `rolloutId`'s next ring, as `staff`: moves it on to
 * that ring, audited, then tells its run. Of two staff approving at
 * once, one does. Approving again once the rollout moved on sends the
 * approval again if its run still waits for it (`resendApproval`), so an
 * approval whose event was lost can be given again. Refused otherwise.
 */
export const approveRollout = async (
  env: Env,
  staff: Staff,
  rolloutId: string
): Promise<void> => {
  const db = consoleDatabase(env.DB);
  const notWaiting = new RolloutError(
    "not_waiting",
    `Rollout ${rolloutId} isn't waiting for approval`
  );
  const [row] = await db
    .select({
      status: rollouts.status,
      ring: rollouts.ring,
      createdAt: rollouts.createdAt,
    })
    .from(rollouts)
    .where(eq(rollouts.id, rolloutId));
  if (
    row?.status === "running" &&
    (await resendApproval(env, staff, { id: rolloutId, ...row }))
  ) {
    return;
  }
  if (row?.status !== "waiting") {
    throw notWaiting;
  }
  const [after] = await db
    .select({ ring: min(rolloutTargets.ring) })
    .from(rolloutTargets)
    .where(
      and(
        eq(rolloutTargets.rolloutId, rolloutId),
        gt(rolloutTargets.ring, row.ring)
      )
    );
  const next = after?.ring ?? null;
  if (next === null) {
    throw notWaiting;
  }
  const approved = await actIfChanged(
    db,
    staff,
    db
      .update(rollouts)
      .set({ status: "running", ring: next, updatedAt: new Date() })
      .where(
        and(
          eq(rollouts.id, rolloutId),
          eq(rollouts.status, "waiting"),
          eq(rollouts.ring, row.ring)
        )
      ),
    { action: "rollout.approve", target: rolloutId, detail: { ring: next } }
  );
  if (!approved) {
    throw notWaiting;
  }
  const instance = await env.ROLLOUT.get(rolloutId);
  await instance.sendEvent({ type: approvalEvent(next), payload: {} });
};
