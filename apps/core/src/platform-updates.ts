import type { AuditDetailValue } from "@grasp-os/shared/audit";
import { deploymentConfig } from "@grasp-os/shared/config";
import { errorFields, log } from "@grasp-os/shared/log";
import { platformChangeSchema } from "@grasp-os/shared/platform-change";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";

import { outboxedIfChanged } from "./audit-outbox.ts";
import { platformVersions } from "./db/core/schema.ts";

// Platform updates in the client's Activity: every version the console
// deploys carries a `PLATFORM_CHANGE` var (@grasp-os/shared/platform-change)
// saying who changed what. The every-minute cron inserts the version
// running now (the `CF_VERSION_METADATA` binding) into `platform_versions`,
// one row per version ever recorded, and stores `platform.updated` in the
// same batch only if that insert added the row. So each version is
// recorded at most once, however many cron runs see it at the same time,
// and however often isolates of two versions alternate on the cron during
// a gradual rollout. A rollback to a version already recorded is not
// recorded again here: the console's own audit log records rollbacks. The
// event waits in core's outbox for the cron's drain, this run's or the
// next.
//
// `platform_version`, the one row the first release of this job kept, is
// no longer written; a later release drops it. The migration that added
// `platform_versions` copied that row in, so the version running then
// isn't recorded twice.
//
// A version made outside the console (a `wrangler deploy`, which keeps the
// vars) carries the previous version's `PLATFORM_CHANGE`; the event names
// the version's own ID and creation time, so a reader can tell. Without
// the var, or with one that doesn't parse, the change is `unknown`.
// Where there is no version metadata (plain workerd, on-prem), nothing is
// recorded. Nor is anything while `platform_versions` doesn't exist yet
// (a version deployed before its migration ran): that is logged once per
// isolate as a warning, and the first run after the migration records the
// version then running.

/** What recording platform updates needs. */
export type PlatformUpdateEnv = Pick<Env, "DB" | "PLATFORM_CHANGE"> &
  Partial<Pick<Env, "CF_VERSION_METADATA">>;

/** Who, what and which release, when `PLATFORM_CHANGE` doesn't say. */
const unknown = "unknown";

/** Whether this isolate has warned that `platform_versions` is missing. */
let warnedMissingTable = false;

/** Whether `error`, or what it wraps, says `platform_versions` is missing. */
const isMissingTable = (error: unknown): boolean =>
  error instanceof Error &&
  (error.message.includes("no such table: platform_versions") ||
    isMissingTable(error.cause));

/** The insert of the running version, if new, and its event. */
const record = async (
  db: DrizzleD1Database,
  version: WorkerVersionMetadata,
  detail: Record<string, AuditDetailValue>
): Promise<void> => {
  await db.batch([
    db
      .insert(platformVersions)
      .values({ versionId: version.id, recordedAt: new Date() })
      .onConflictDoNothing(),
    // `changes()` is the insert's: core's database has no FTS index, whose
    // flush would set it (see `outboxedIfChanged`).
    outboxedIfChanged(db, {
      actor: { type: "system" },
      action: "platform.updated",
      target: { type: "version", id: version.id },
      detail,
    }),
  ]);
};

/**
 * Records the running version as `platform.updated` if it has never been
 * recorded. The cron trigger calls it every minute.
 */
export const recordPlatformUpdate = async (
  env: PlatformUpdateEnv
): Promise<void> => {
  const version = env.CF_VERSION_METADATA;
  if (version === undefined || version.id === "") {
    return;
  }
  const change = deploymentConfig(
    platformChangeSchema,
    "PLATFORM_CHANGE",
    env.PLATFORM_CHANGE
  );
  const detail: Record<string, AuditDetailValue> = {
    versionId: version.id,
    versionCreatedAt: version.timestamp === "" ? null : version.timestamp,
    by: change?.by ?? unknown,
    what: change?.what ?? unknown,
    release: change?.release ?? unknown,
    changedAt: change?.at ?? null,
  };
  const db = drizzle(env.DB);
  try {
    await record(db, version, detail);
  } catch (error) {
    if (!isMissingTable(error)) {
      throw error;
    }
    if (!warnedMissingTable) {
      warnedMissingTable = true;
      log.warn("platform.update.table_missing", errorFields(error));
    }
  }
};
