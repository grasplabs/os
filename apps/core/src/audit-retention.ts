import { log } from "@grasp-os/shared/log";
import { z } from "zod";

import { archiveStretch, auditLog } from "./audit-log.ts";
import { audit } from "./audit.ts";
import { deploymentConfig } from "./deployment-config.ts";
import { featureEnabled } from "./features.ts";

// Retention of the audit log: how long the log keeps an event where admins
// search it. After that the event moves to the archive in R2 (in the EU),
// as it was stored, and the chain carries on (src/audit-log.ts), so an
// archived event still counts when the chain is verified. Nothing here
// deletes an archived event: the archive keeps it for as long as the bucket
// does.
//
// The console sets it per deployment with the `AUDIT_RETENTION_DAYS` var:
// 180 days unless set, at least 30 (so an admin always has the last month
// to search), at most ten years. A value outside that, or one that isn't a
// whole number of days, is logged as `config.invalid` and archives nothing:
// events stay searchable until the config is fixed. It's deployment config,
// not an in-product setting, so a compromised admin session can't shorten
// it. Archiving runs only while the `audit` feature is on.

/** Days the log keeps an event where admins search it, unless set. */
const auditRetentionDefaultDays = 180;
/** Fewest days the console may set. */
const auditRetentionMinDays = 30;
/** Most days the console may set. */
const auditRetentionMaxDays = 3650;

const retentionSchema = z
  .int()
  .min(auditRetentionMinDays)
  .max(auditRetentionMaxDays);

const dayMs = 24 * 60 * 60 * 1000;

/** Most stretches one run of the cron trigger archives. */
const stretchesPerRun = 10;

/** The deployment's retention in days, or `undefined` if its config is invalid. */
const retentionDays = (env: Env): number | undefined =>
  env.AUDIT_RETENTION_DAYS === undefined
    ? auditRetentionDefaultDays
    : deploymentConfig(
        retentionSchema,
        "AUDIT_RETENTION_DAYS",
        env.AUDIT_RETENTION_DAYS
      );

/**
 * Archives the events the log received longer ago than the deployment's
 * retention, oldest first, a stretch at a time, and records each stretch
 * in the log. The cron trigger calls it; a backlog is worked off over
 * several runs.
 */
export const archiveAuditLog = async (env: Env): Promise<void> => {
  const days = retentionDays(env);
  if (!featureEnabled(env, "audit") || days === undefined) {
    return;
  }
  const cutoff = new Date(Date.now() - days * dayMs).toISOString();
  for (let run = 0; run < stretchesPerRun; run += 1) {
    // One stretch after another: each starts where the last one ended.
    // oxlint-disable-next-line no-await-in-loop
    const stretch = await auditLog(env).archive(cutoff);
    if (stretch === null) {
      return;
    }
    const { from, through, key } = stretch;
    log.info("audit.archived", { from, through });
    // oxlint-disable-next-line no-await-in-loop
    await audit(env).log({
      actor: { type: "system" },
      action: "audit.archived",
      detail: { from, through, key, retentionDays: days },
    });
    if (through - from + 1 < archiveStretch) {
      return;
    }
  }
};
