import { log } from "@grasp-os/shared/log";

import { archiveStretch, auditLog, auditRetentionDays } from "./audit-log.ts";
import { featureEnabled } from "./features.ts";

// Retention of the audit log: how long the log keeps an event where admins
// search it. After that the event moves to the archive in R2 (in the EU),
// as it was stored, and the chain carries on (src/audit-log.ts), so an
// archived event still counts when the chain is verified. The archive keeps
// it until the log purges it, once the deployment's archive retention has
// passed (`AUDIT_ARCHIVE_RETENTION_DAYS`, the event's total age, worked out
// by the log itself; see `AuditLog.purge`), and never while that is unset.
// Both are parsed in src/audit-log.ts, where the log reads them. Verification reports a
// purged stretch as purged. Deleting archived objects any other way
// (outside the product) makes verification report them missing.
//
// The console sets it per deployment with the `AUDIT_RETENTION_DAYS` var:
// 180 days unless set, at least 30 (so an admin always has the last month
// to search), at most ten years. A value outside that, or one that isn't a
// whole number of days, is logged as `config.invalid` and archives nothing:
// events stay searchable until the config is fixed. It's deployment config,
// not an in-product setting, so a compromised admin session can't shorten
// it. Archiving and purging run only while the `audit_retention` feature
// is on (not `audit`, which gates reading the log).

const dayMs = 24 * 60 * 60 * 1000;

/** Most stretches one run of the cron trigger archives. */
const stretchesPerRun = 10;

/** Archives what is past retention, up to {@link stretchesPerRun} stretches. */
const archiveExpired = async (env: Env): Promise<void> => {
  const days = auditRetentionDays(env);
  if (days === undefined) {
    return;
  }
  const cutoff = new Date(Date.now() - days * dayMs).toISOString();
  for (let run = 0; run < stretchesPerRun; run += 1) {
    // One stretch after another: each starts where the last one ended.
    // oxlint-disable-next-line no-await-in-loop
    const stretch = await auditLog(env).archive(cutoff, days);
    if (stretch === null) {
      return;
    }
    const { from, through } = stretch;
    log.info("audit.archived", { from, through });
    if (through - from + 1 < archiveStretch) {
      return;
    }
  }
};

/**
 * Archives the events the log received longer ago than the deployment's
 * retention, oldest first, a stretch at a time; the log records each
 * stretch as `audit.archived`, in the same transaction. Then purges the
 * archived stretches past archive retention, likewise recorded as
 * `audit.purged`. The cron trigger calls it; a backlog is worked off over
 * several runs. Only while `audit_retention` is switched on: a flag of its
 * own, so switching audit search off (`audit`) doesn't stop retention.
 */
export const archiveAuditLog = async (env: Env): Promise<void> => {
  if (!featureEnabled(env, "audit_retention")) {
    // Most likely a deployment that switched the log on before retention
    // had a flag of its own: events are kept, not archived, until it's on.
    if (featureEnabled(env, "audit")) {
      log.warn("audit.retention_off", {});
    }
    return;
  }
  await archiveExpired(env);
  for (let run = 0; run < stretchesPerRun; run += 1) {
    // One stretch after another, oldest first.
    // oxlint-disable-next-line no-await-in-loop
    const stretch = await auditLog(env).purge();
    if (stretch === null) {
      return;
    }
    log.info("audit.purged", { from: stretch.from, through: stretch.through });
  }
};
