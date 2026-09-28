import { actorOf } from "@grasp-os/shared/audit";
import { isAdmin, requireAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import {
  improvementSignalSchema,
  signalErrors,
  signalFilterSchema,
  signalKinds,
  signalsPerKind,
} from "@grasp-os/shared/signals";
import type {
  ImprovementSignal,
  ImprovementSignals,
  SignalFilter,
  SignalsApi,
} from "@grasp-os/shared/signals";
import { RpcTarget } from "capnweb";
import { and, asc, desc, eq, ne, notLike } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { appContents, appFor } from "./apps.ts";
import { keepAuditEvent } from "./audit-outbox.ts";
import {
  improvementSignalComputations as computations,
  improvementSignals,
} from "./db/core/schema.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";
import { latestComputation, peopleSubject } from "./signals.ts";

// Reading the improvement signals (signals.ts). Admins read every one
// whole: they read the audit log and every run's details already. An
// App's builders read that App's as they see its runs, where a run's
// details are its person's and admins' (`seesDetails` in
// workflows/runs.ts): counts, and the step names and error codes, which
// are literals of the App's own code, added up; but no run's or
// decision's ID and no person a decision waits for (`forBuilders`, and
// `waitsFor`, which gives them each workflow's waits for people added up
// instead of each person's). The
// deployment's own signals (people's unanswered questions) stay with
// admins. No evidence holds what a run read, returned or failed with.
// Every read is audited, never refused for it (the outbox keeps the
// event).

type Row = typeof improvementSignals.$inferSelect;

/** A stored signal as the API returns it; none that no longer reads as one. */
const toSignal = (row: Row): ImprovementSignal[] => {
  const parsed = improvementSignalSchema.safeParse({
    kind: row.kind,
    value: row.value,
    evidence: row.evidence,
    app: row.appId === "" ? null : row.appId,
    workflow: row.workflowId === "" ? null : row.workflowId,
    subject: row.subject === "" ? null : row.subject,
  });
  return parsed.success ? [parsed.data] : [];
};

/** A signal as an App's builders see it: no run, decision or person IDs. */
const forBuilders = (signal: ImprovementSignal): ImprovementSignal => {
  switch (signal.kind) {
    case "waiting_for_person": {
      const { oldest: _oldest, ...evidence } = signal.evidence;
      return { ...signal, evidence };
    }
    case "failing_step": {
      const { recent: _recent, ...evidence } = signal.evidence;
      return { ...signal, evidence };
    }
    case "correction": {
      const { recent: _recent, ...evidence } = signal.evidence;
      return { ...signal, evidence };
    }
    case "cost_per_run": {
      const { costliest: _costliest, ...evidence } = signal.evidence;
      return { ...signal, evidence };
    }
    case "unanswered_question": {
      return signal;
    }
    default: {
      return signal;
    }
  }
};

/**
 * Which waits for people `by` reads: admins each person's
 * (`person:<id>`), builders only each workflow's added up (`person`,
 * signals.ts). Chosen in the query, so the limit counts only those.
 */
const waitsFor = (by: Identity) =>
  isAdmin(by.role)
    ? ne(improvementSignals.subject, peopleSubject)
    : notLike(improvementSignals.subject, "person:%");

/**
 * Refuses a workflow the App's running version doesn't have: a filter that
 * could never match anything is a mistake, not an empty list.
 */
const requireWorkflow = async (
  env: Env,
  by: Identity,
  app: string,
  workflow: string
): Promise<void> => {
  const { workflows } = await appContents(env, by, app);
  if (!workflows.includes(workflow)) {
    throw signalErrors.create("signal.invalid", {
      issues: [
        `workflow: the version of App ${app} that runs has no workflow ${workflow}`,
      ],
    });
  }
};

/**
 * The signals `by` asked for, as of the latest finished computation: all
 * of them for an admin, whole; an App's (or one workflow of it) for its
 * builders, as `forBuilders` has them.
 */
export const listSignals = async (
  env: Env,
  by: Identity,
  filter: unknown
): Promise<ImprovementSignals> => {
  const { app, workflow } = signalErrors.parse(
    "signal.invalid",
    signalFilterSchema,
    filter
  );
  if (app === undefined) {
    requireAdmin(by);
  } else {
    await appFor(env, by, app, "builder");
    if (workflow !== undefined) {
      await requireWorkflow(env, by, app, workflow);
    }
  }
  const db = drizzle(env.DB);
  await keepAuditEvent(env, db, {
    actor: actorOf(by),
    action: "improvement.signals.read",
    detail: { app: app ?? null, workflow: workflow ?? null },
  });
  // The computation and its signals in one batch (`latestComputation`).
  const [current, ...kinds] = await db.batch([
    db
      .select({ finishedAt: computations.finishedAt })
      .from(computations)
      .where(eq(computations.id, latestComputation)),
    ...signalKinds.map((kind) =>
      db
        .select()
        .from(improvementSignals)
        .where(
          and(
            eq(improvementSignals.computation, latestComputation),
            eq(improvementSignals.kind, kind),
            kind === "waiting_for_person" ? waitsFor(by) : undefined,
            app === undefined ? undefined : eq(improvementSignals.appId, app),
            workflow === undefined
              ? undefined
              : eq(improvementSignals.workflowId, workflow)
          )
        )
        .orderBy(
          desc(improvementSignals.value),
          asc(improvementSignals.appId),
          asc(improvementSignals.workflowId),
          asc(improvementSignals.subject)
        )
        .limit(signalsPerKind)
    ),
  ]);
  const finishedAt = current[0]?.finishedAt;
  const signals = kinds.flat().flatMap(toSignal);
  return {
    computedAt: finishedAt?.toISOString() ?? null,
    signals: isAdmin(by.role) ? signals : signals.map(forBuilders),
  };
};

/**
 * A signed-in person's `signals`. Every call checks the session (and the
 * flag) first and hands the identity that check returned to `listSignals`,
 * which checks their role.
 */
export class SignalsRpc extends RpcTarget implements SignalsApi {
  readonly #env: Env;
  readonly #check: SessionCheck;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
  }

  async list(filter?: SignalFilter): Promise<ImprovementSignals> {
    return await withPerson(
      this.#check,
      async (by) => await listSignals(this.#env, by, filter)
    );
  }
}
