import type { ReleaseManifest } from "@grasp-os/shared/release";
import { describe, expect, it } from "vite-plus/test";

import { databaseMigrations } from "../src/deploy/migrations.ts";
import { buildRelease } from "./releases.ts";

/** The release's manifest with connect binding core's database, with `migrations`. */
const sharingCoreDatabase = (
  manifest: ReleaseManifest,
  migrations: ReleaseManifest["workers"][string]["d1Databases"][number]["migrations"]
): ReleaseManifest => {
  const { connect } = manifest.workers;
  if (connect === undefined) {
    throw new Error("expected connect");
  }
  return {
    ...manifest,
    workers: {
      ...manifest.workers,
      connect: {
        ...connect,
        d1Databases: [
          { binding: "DB", databaseName: "grasp-os-core", migrations },
        ],
      },
    },
  };
};

describe("each database's migrations", () => {
  it("lists a database two Workers bind once", async () => {
    const { manifest } = await buildRelease({ notes: "feat(core): shared" });
    const core = manifest.workers.core?.d1Databases.find(
      ({ databaseName }) => databaseName === "grasp-os-core"
    );

    const databases = databaseMigrations(
      sharingCoreDatabase(manifest, core?.migrations ?? [])
    );

    expect([...databases.keys()].toSorted()).toStrictEqual([
      "grasp-os-core",
      "grasp-os-knowledge",
    ]);
  });

  it("refuses two Workers that give one database different migrations", async () => {
    const { manifest } = await buildRelease({ notes: "feat(core): differ" });

    expect(() => databaseMigrations(sharingCoreDatabase(manifest, []))).toThrow(
      expect.objectContaining({ code: "migration_lists_differ" })
    );
  });
});
