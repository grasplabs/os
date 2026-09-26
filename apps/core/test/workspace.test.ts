import { workspaceIdSchema } from "@grasp-os/shared/ids";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { migrateOnWake } from "../src/db/migrate.ts";
import type { Migrations } from "../src/db/migrate.ts";
import migrations from "../src/db/workspace/migrations/migrations.js";
import { workspace } from "../src/workspace.ts";

const newWorkspace = () =>
  workspace(env, workspaceIdSchema.parse(crypto.randomUUID()));

/** The migrations the previous release shipped: all but the newest. */
const previousRelease: Migrations = {
  journal: { entries: migrations.journal.entries.slice(0, -1) },
  migrations: migrations.migrations,
};

/** A release that adds one migration after this release's. */
const withMigration = (tag: string, sql: string, idx?: number): Migrations => {
  const next = idx ?? migrations.journal.entries.length;
  return {
    journal: { entries: [...migrations.journal.entries, { idx: next, tag }] },
    migrations: {
      ...migrations.migrations,
      [`m${String(next).padStart(4, "0")}`]: sql,
    },
  };
};

/** A release after this one, which adds a column the code doesn't know yet. */
const nextRelease = (): Migrations =>
  withMigration(
    "next_release",
    "ALTER TABLE `chats` ADD `pinned` integer DEFAULT 0 NOT NULL;"
  );

/** Replaces the object's storage with what `release` would have left. */
const migrateTo = async (
  stub: ReturnType<typeof newWorkspace>,
  release: Migrations,
  { fromScratch }: { fromScratch: boolean }
) => {
  await runInDurableObject(stub, async (_instance, state) => {
    if (fromScratch) {
      await state.storage.deleteAll();
    }
    migrateOnWake(state, release);
  });
  await evictDurableObject(stub);
};

describe("Workspace schema", () => {
  it("migrates a fresh workspace before its first call", async () => {
    const chat = await newWorkspace().createChat("Plans", "person-1");
    expect(chat).toMatchObject({ title: "Plans" });
  });

  it("migrates a workspace on the previous release's schema when it wakes up", async () => {
    const stub = newWorkspace();
    await migrateTo(stub, previousRelease, { fromScratch: true });

    const chat = await stub.createChat("Plans", "person-1");
    expect(chat).toMatchObject({ title: "Plans" });
  });

  it("keeps working when the code is rolled back after an additive migration", async () => {
    const stub = newWorkspace();
    const before = await stub.createChat("Before the release", "person-1");
    await migrateTo(stub, nextRelease(), { fromScratch: false });

    // Waking up again on this release's code leaves the newer schema alone.
    const after = await stub.createChat("After the rollback", "person-1");
    expect(after).toMatchObject({ title: "After the rollback" });
    await runInDurableObject(stub, (_instance, state) => {
      const rows = state.storage.sql
        .exec("SELECT title, pinned FROM chats ORDER BY rowid")
        .toArray();
      expect(rows).toStrictEqual([
        { title: before.title, pinned: 0 },
        { title: after.title, pinned: 0 },
      ]);
    });
  });

  it("rolls back a failing migration and reports its error", async () => {
    const stub = newWorkspace();
    await stub.createChat("Before the release", "person-1");
    const broken = withMigration(
      "broken",
      "ALTER TABLE `chats` ADD `pinned` integer;\n--> statement-breakpoint\nALTER TABLE `missing` ADD `x` integer;"
    );

    await runInDurableObject(stub, (_instance, state) => {
      expect(() => {
        migrateOnWake(state, broken);
      }).toThrow(/no such table: missing/u);
      // Nothing of the failed migration stays, not even its first statement.
      const columns = state.storage.sql
        .exec("SELECT name FROM pragma_table_info('chats')")
        .toArray()
        .map(({ name }) => name);
      expect(columns).not.toContain("pinned");
    });
    const after = await stub.createChat("After the failure", "person-1");
    expect(after).toMatchObject({ title: "After the failure" });
  });

  it("refuses a migration history that doesn't match the code", async () => {
    const stub = newWorkspace();
    await migrateTo(stub, withMigration("ours", "SELECT 1;"), {
      fromScratch: false,
    });

    await runInDurableObject(stub, (_instance, state) => {
      expect(() => {
        migrateOnWake(state, withMigration("theirs", "SELECT 1;"));
      }).toThrow(/applied as ours/u);
    });
  });

  it("refuses a migration that comes before one already applied", async () => {
    const stub = newWorkspace();
    const next = migrations.journal.entries.length;
    await migrateTo(stub, withMigration("later", "SELECT 1;", next + 1), {
      fromScratch: false,
    });

    await runInDurableObject(stub, (_instance, state) => {
      expect(() => {
        migrateOnWake(state, withMigration("earlier", "SELECT 1;", next));
      }).toThrow(/comes before/u);
    });
  });
});
