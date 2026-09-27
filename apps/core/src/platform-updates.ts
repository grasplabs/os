import type { AuditDetailValue } from "@grasp-os/shared/audit";
import { deploymentConfig } from "@grasp-os/shared/config";
import { errorFields, log } from "@grasp-os/shared/log";
import { platformChangeSchema } from "@grasp-os/shared/platform-change";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";

import { outboxedIfChanged } from "./audit-outbox.ts";
import { platformVersion } from "./db/core/schema.ts";

// Platform updates in the client's Activity: every version the console
// deploys carries a `PLATFORM_CHANGE` var (@grasp-os/shared/platform-change)
// saying who changed what. The every-minute cron compares the version
// running now (the `CF_VERSION_METADATA` binding) with the one it last
// recorded, one row in `platform_version`, and on a version it hasn't
// seen replaces the row and stores `platform.updated` in the same batch:
// the replace is conditional, so however many cron runs see the new
// version at once, one changes the row and one event is stored. A
// rollback to an earlier version is a version the row doesn't hold, so it
// is recorded too, with the change that version was made with. The event
// waits in core's outbox for the cron's drain, this run's or the next.
//
// A version made outside the console (a `wrangler deploy`, which keeps the
// vars) carries the previous version's `PLATFORM_CHANGE`; the event names
// the version's own ID and creation time, so a reader can tell. Without
// the var, or with one that doesn't parse, the change is `unknown`.
// Where there is no version metadata (plain workerd, on-prem), nothing is
// recorded. Nor is anything while `platform_version` doesn't exist yet
// (a version deployed before its migration ran): that is logged once per
// isolate as a warning, and the first run after the migration records the
// version then running.

/** What recording platform updates needs. */
export type PlatformUpdateEnv = Pick<Env, "DB" | "PLATFORM_CHANGE"> &
  Partial<Pick<Env, "CF_VERSION_METADATA">>;

/** Who, what and which release, when `PLATFORM_CHANGE` doesn't say. */
const unknown = "unknown";

/** Whether this isolate has warned that `platform_version` is missing. */
let warnedMissingTable = false;

/** Whether `error`, or what it wraps, says `platform_version` is missing. */
const isMissingTable = (error: unknown): boolean =>
  error instanceof Error &&
  (error.message.includes("no such table: platform_version") ||
    isMissingTable(error.cause));

/** The conditional replace of the recorded version, and its event. */
const record = async (
  db: DrizzleD1Database,
  version: WorkerVersionMetadata,
  detail: Record<string, AuditDetailValue>
): Promise<void> => {
  await db.batch([
    db
      .insert(platformVersion)
      .values({ id: 1, versionId: version.id, recordedAt: new Date() })
      .onConflictDoUpdate({
        target: platformVersion.id,
        set: {
          versionId: sql`excluded.version_id`,
          recordedAt: sql`excluded.recorded_at`,
        },
        setWhere: sql`${platformVersion.versionId} <> excluded.version_id`,
      }),
    outboxedIfChanged(db, {
      actor: { type: "system" },
      action: "platform.updated",
      target: { type: "version", id: version.id },
      detail,
    }),
  ]);
};

/**
 * Records the running version as `platform.updated` if it isn't the one
 * last recorded. The cron trigger calls it every minute.
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
