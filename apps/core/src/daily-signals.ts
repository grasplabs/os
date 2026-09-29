import { auditFilterSchema } from "@grasp-os/shared/audit-log";
import { errorFields, log } from "@grasp-os/shared/log";

import { auditLog } from "./audit-log.ts";
import type { SearchRange, TallyWanted } from "./audit-log.ts";
import {
  addKnowledgeTally,
  claimKnowledgeSignals,
  knowledgeWindow,
  storeKnowledgeSignals,
} from "./knowledge/signals.ts";
import type { KnowledgeTotals } from "./knowledge/signals.ts";
import {
  addSignalTally,
  claimImprovementSignals,
  noSignalTotals,
  signalsFrom,
  storeImprovementSignals,
} from "./signals.ts";
import type { SignalTotals } from "./signals.ts";

// What is computed once a UTC day from the audit log: the improvement
// signals (signals.ts) and Knowledge's usage signals (knowledge/signals.ts).
// The 15-minute cron trigger claims each one's day (daily-claims.ts), and
// whatever it claimed is computed from one pass over the audit log, the
// object tallying a stretch at a time for each of them
// (`AuditLog.tallyStretch`). One failing doesn't stop the other.

/**
 * Where retention archived what a pass would read next: carries on from
 * the first entry of the window the log still holds, or where it was, if
 * that's later. What was archived before it was read is left out.
 * `undefined` once the log holds nothing more of the range, or nothing it
 * could carry on from.
 */
const pastArchived = async (
  env: Env,
  filter: { from: string; to: string },
  range: SearchRange,
  after: number | undefined
): Promise<number | undefined> => {
  const held = await auditLog(env).range(auditFilterSchema.parse(filter));
  const next = Math.max(after ?? 0, held.low - 1);
  if (held.low > held.high || next >= range.high || next === after) {
    return undefined;
  }
  return next;
};

/**
 * One pass over the audit log of the window `wanted` asks for, up to
 * `now`, added up for each that wants it. `complete` says whether the log
 * held every entry since `holdsFrom` throughout.
 */
const auditPass = async (
  env: Env,
  now: Date,
  wanted: TallyWanted,
  totals: { signals?: SignalTotals; knowledge?: KnowledgeTotals },
  holdsFrom: string | undefined
): Promise<{ complete: boolean }> => {
  const audit = auditLog(env);
  const [from] = [wanted.signals?.from, wanted.knowledge?.readsFrom]
    .filter((at) => at !== undefined)
    .toSorted();
  const filter = { from: from ?? now.toISOString(), to: now.toISOString() };
  // Worked out once, so events appended meanwhile don't stretch it.
  const range = await audit.range(auditFilterSchema.parse(filter));
  let complete =
    holdsFrom === undefined ? true : await audit.holdsSince(holdsFrom);
  let after: number | undefined;
  for (;;) {
    // One stretch after another: each starts where the last ended.
    // oxlint-disable-next-line no-await-in-loop
    const stretch = await audit.tallyStretch(range, wanted, after);
    if (stretch === null) {
      complete = false;
      // oxlint-disable-next-line no-await-in-loop
      const next = await pastArchived(env, filter, range, after);
      if (next === undefined) {
        return { complete };
      }
      after = next;
      continue;
    }
    if (stretch.signals !== undefined && totals.signals !== undefined) {
      addSignalTally(totals.signals, stretch.signals);
    }
    if (stretch.knowledge !== undefined && totals.knowledge !== undefined) {
      addKnowledgeTally(totals.knowledge, stretch.knowledge);
    }
    if (stretch.next === null) {
      return { complete };
    }
    after = stretch.next;
  }
};

/** The reason of the first of `results` that failed, if any. */
const firstFailure = (
  results: readonly PromiseSettledResult<unknown>[]
): unknown => results.find((result) => result.status === "rejected")?.reason;

/**
 * Computes the day's improvement signals and Knowledge usage signals of
 * `now`'s UTC day, those that are due and switched on. Its cron trigger
 * calls it every 15 minutes. Throws the first failure once both are done.
 */
export const refreshDailySignals = async (
  env: Env,
  now = new Date()
): Promise<void> => {
  const claims = await Promise.allSettled([
    claimImprovementSignals(env, now),
    claimKnowledgeSignals(env, now),
  ]);
  const [improvement, knowledge] = claims.map((claim) =>
    claim.status === "fulfilled" ? claim.value : undefined
  );
  const failures = [firstFailure(claims)];
  if (improvement !== undefined || knowledge !== undefined) {
    const window =
      knowledge === undefined ? undefined : knowledgeWindow(env, now);
    const totals = {
      signals: improvement === undefined ? undefined : noSignalTotals(),
      knowledge: window?.totals(),
    };
    const { complete } = await auditPass(
      env,
      now,
      {
        signals:
          improvement === undefined
            ? undefined
            : { from: signalsFrom(now).toISOString() },
        knowledge: window && {
          readsFrom: window.readsFrom,
          questionsFrom: window.questionsFrom,
        },
      },
      totals,
      window?.readsFrom
    );
    const stored = await Promise.allSettled([
      improvement !== undefined && totals.signals !== undefined
        ? storeImprovementSignals(env, improvement, totals.signals)
        : undefined,
      knowledge !== undefined && totals.knowledge !== undefined
        ? storeKnowledgeSignals(env, knowledge, {
            ...totals.knowledge,
            read: complete ? totals.knowledge.read : null,
          })
        : undefined,
    ]);
    failures.push(firstFailure(stored));
  }
  const [failure, ...others] = failures.filter(
    (reason) => reason !== undefined
  );
  for (const other of others) {
    log.error("signals.failed", errorFields(other));
  }
  if (failure !== undefined) {
    throw failure instanceof Error
      ? failure
      : new Error("The daily signals failed", { cause: failure });
  }
};
