/** Reading imported releases from the console's database. */
import { releaseManifestSchema } from "@grasp-os/shared/release";
import type { ReleaseManifest } from "@grasp-os/shared/release";
import { and, count, desc, eq, gt, lte, sql } from "drizzle-orm";

import type { ConsoleDatabase } from "../db/act.ts";
import { releases } from "../db/schema.ts";
import { diffReleases } from "./diff.ts";
import type { ReleaseDiff } from "./diff.ts";

/** How many releases the list shows: the newest. */
export const RELEASE_LIST_LIMIT = 100;

/** A release as the list shows it. */
export interface ReleaseSummary {
  id: string;
  commitSha: string;
  /** Its release note: the merged pull request's title. */
  notes: string;
  builtAt: Date;
  importedAt: Date;
}

/** A release with its whole manifest. */
interface StoredRelease extends ReleaseSummary {
  manifestSha256: string;
  manifest: ReleaseManifest;
}

/** One Worker of a release, as its page shows it. */
export interface WorkerView {
  app: string;
  name: string;
  mainModule: string;
  compatibilityFlags: string[];
  crons: string[];
  requiredSecrets: string[];
  /** Their tags, in order. */
  durableObjectMigrations: string[];
  modules: { name: string; type: string; size: number; sha256: string }[];
  d1Databases: {
    binding: string;
    databaseName: string;
    /** Their file names, in order. */
    migrations: string[];
  }[];
  assetCount: number;
}

/** A release as its page shows it. */
export interface ReleaseView extends ReleaseSummary {
  manifestSha256: string;
  compatibilityDate: string;
  wranglerVersion: string;
  packages: Record<string, string>;
  workers: WorkerView[];
}

const summaryColumns = {
  id: releases.id,
  commitSha: releases.commitSha,
  notes: sql<string>`coalesce(json_extract(${releases.manifest}, '$.notes'), '')`,
  builtAt: releases.builtAt,
  importedAt: releases.importedAt,
};

/**
 * The newest releases, newest first, and the release before the oldest of
 * them, if there is one: the list's last "since" link, and the sign that
 * there are more.
 */
export const listReleases = async (
  db: ConsoleDatabase
): Promise<{ releases: ReleaseSummary[]; older: ReleaseSummary | null }> => {
  const rows = await db
    .select(summaryColumns)
    .from(releases)
    .orderBy(desc(releases.builtAt), desc(releases.id))
    .limit(RELEASE_LIST_LIMIT + 1);
  return {
    releases: rows.slice(0, RELEASE_LIST_LIMIT),
    older: rows[RELEASE_LIST_LIMIT] ?? null,
  };
};

/** Release `id` with its manifest, or null when it isn't imported. */
const getStoredRelease = async (
  db: ConsoleDatabase,
  id: string
): Promise<StoredRelease | null> => {
  const [row] = await db
    .select({
      ...summaryColumns,
      manifestSha256: releases.manifestSha256,
      manifest: releases.manifest,
    })
    .from(releases)
    .where(eq(releases.id, id));
  if (row === undefined) {
    return null;
  }
  return {
    ...row,
    manifest: releaseManifestSchema.parse(JSON.parse(row.manifest)),
  };
};

/** Release `id` as its page shows it, or null when it isn't imported. */
export const getRelease = async (
  db: ConsoleDatabase,
  id: string
): Promise<ReleaseView | null> => {
  const stored = await getStoredRelease(db, id);
  if (stored === null) {
    return null;
  }
  const { manifest, ...release } = stored;
  return {
    ...release,
    compatibilityDate: manifest.compatibilityDate,
    wranglerVersion: manifest.wranglerVersion,
    packages: manifest.packages,
    workers: Object.entries(manifest.workers).map(([app, worker]) => ({
      app,
      name: worker.name,
      mainModule: worker.mainModule,
      compatibilityFlags: worker.compatibilityFlags,
      crons: worker.crons,
      requiredSecrets: worker.requiredSecrets,
      durableObjectMigrations: worker.durableObjectMigrations.map(
        (migration) => migration.tag
      ),
      modules: worker.modules.map(({ name, type, size, sha256 }) => ({
        name,
        type,
        size,
        sha256,
      })),
      d1Databases: worker.d1Databases.map((database) => ({
        binding: database.binding,
        databaseName: database.databaseName,
        migrations: database.migrations.map((migration) => migration.name),
      })),
      assetCount: Object.keys(worker.assets?.manifest ?? {}).length,
    })),
  };
};

const summaryOf = ({
  manifest: _manifest,
  manifestSha256: _manifestSha256,
  ...summary
}: StoredRelease): ReleaseSummary => summary;

/** Two releases compared, and the releases that lead from one to the other. */
export interface ReleaseComparison {
  from: ReleaseSummary;
  to: ReleaseSummary;
  diff: ReleaseDiff;
  /**
   * The releases built after the older one, up to and including the newer
   * one, newest first, at most {@link RELEASE_LIST_LIMIT}: their notes are
   * what changes between the two.
   */
  between: ReleaseSummary[];
  /** How many more releases lie between them than `between` holds. */
  moreBetween: number;
}

/**
 * Compares releases `fromId` and `toId`, in that direction (a newer
 * `fromId` shows what going back removes). Null when either isn't imported.
 */
export const compareReleases = async (
  db: ConsoleDatabase,
  fromId: string,
  toId: string
): Promise<ReleaseComparison | null> => {
  const [from, to] = await Promise.all([
    getStoredRelease(db, fromId),
    getStoredRelease(db, toId),
  ]);
  if (from === null || to === null) {
    return null;
  }
  const [older, newer] =
    from.builtAt.getTime() <= to.builtAt.getTime() ? [from, to] : [to, from];
  const inBetween = and(
    gt(releases.builtAt, older.builtAt),
    lte(releases.builtAt, newer.builtAt)
  );
  const [between, [counted]] = await Promise.all([
    db
      .select(summaryColumns)
      .from(releases)
      .where(inBetween)
      .orderBy(desc(releases.builtAt), desc(releases.id))
      .limit(RELEASE_LIST_LIMIT),
    db.select({ total: count() }).from(releases).where(inBetween),
  ]);
  return {
    from: summaryOf(from),
    to: summaryOf(to),
    diff: diffReleases(from.manifest, to.manifest),
    between,
    moreBetween: Math.max((counted?.total ?? 0) - between.length, 0),
  };
};
